#!/usr/bin/env python3
import hashlib
import json
import plistlib
import shlex
import shutil
import subprocess
import time
from pathlib import Path

import psutil
import webview

HOME = Path.home()
BASE = Path(__file__).parent
TRASH = HOME / ".Trash"
APP_NAME = "MaciTor+"

CLEAN_TARGETS = {
    "caches": ("User Cache", "~/Library/Caches", HOME / "Library" / "Caches"),
    "trash": ("Trash", "~/.Trash", HOME / ".Trash"),
    "xcode": ("Xcode DerivedData", "~/Library/Developer/Xcode/DerivedData", HOME / "Library" / "Developer" / "Xcode" / "DerivedData"),
    "pip": ("pip cache", "~/Library/Caches/pip", HOME / "Library" / "Caches" / "pip"),
    "brew": ("Homebrew Cache", "~/Library/Caches/Homebrew", HOME / "Library" / "Caches" / "Homebrew"),
}

BROWSER_CACHES = {
    "safari": ("Safari Cache", HOME / "Library" / "Caches" / "com.apple.Safari"),
    "chrome": ("Chrome Cache", HOME / "Library" / "Caches" / "Google" / "Chrome"),
    "firefox": ("Firefox Cache", HOME / "Library" / "Caches" / "Firefox"),
    "edge": ("Edge Cache", HOME / "Library" / "Caches" / "Microsoft Edge"),
    "arc": ("Arc Cache", HOME / "Library" / "Caches" / "company.thebrowser.Browser"),
}

DUPLICATE_SCAN_ROOTS = ["Desktop", "Downloads", "Documents"]


def run(cmd, timeout=15):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        class R:
            stdout = ""
            stderr = str(e)
        return R()


def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    r = run(["du", "-sk", str(path)], timeout=60)
    try:
        return int(r.stdout.split()[0]) * 1024
    except Exception:
        return 0


def human(n: float) -> str:
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


class Api:
    def __init__(self):
        self._net_prev = None
        self._net_prev_t = None
        self._disk_prev = None
        self._disk_prev_t = None
        self._alerted = set()
        self._caffeinate_proc = None

    def notify(self, title, message):
        safe_title = title.replace('"', "'")
        safe_message = message.replace('"', "'")
        run(["osascript", "-e", f'display notification "{safe_message}" with title "{safe_title}"'])

    def _check_thresholds(self, cpu, ram, disk):
        checks = [("cpu", cpu, "CPU usage"), ("ram", ram, "Memory usage"), ("disk", disk, "Disk usage")]
        for key, val, label in checks:
            if val >= 90:
                if key not in self._alerted:
                    self._alerted.add(key)
                    self.notify("MaciTor+ Alert", f"{label} at {val:.0f}%")
            else:
                self._alerted.discard(key)

    def get_overview(self):
        cpu = psutil.cpu_percent(interval=None)
        vm = psutil.virtual_memory()
        du = shutil.disk_usage("/")
        sw = psutil.swap_memory()
        boot = psutil.boot_time()
        uptime_s = time.time() - boot
        disk_percent = du.used / du.total * 100
        self._check_thresholds(cpu, vm.percent, disk_percent)
        return {
            "cpu_percent": round(cpu, 1),
            "cpu_cores": psutil.cpu_count(),
            "ram_percent": round(vm.percent, 1),
            "ram_used": human(vm.used),
            "ram_total": human(vm.total),
            "disk_percent": round(disk_percent, 1),
            "disk_used": human(du.used),
            "disk_total": human(du.total),
            "swap_used": human(sw.used),
            "swap_total": human(sw.total),
            "swap_percent": round(sw.percent, 1),
            "uptime_days": int(uptime_s // 86400),
            "uptime_hours": int((uptime_s % 86400) // 3600),
        }

    def get_network(self):
        counters = psutil.net_io_counters()
        now = time.time()
        down_kbs = up_kbs = 0.0
        if self._net_prev is not None and self._net_prev_t is not None:
            dt = max(now - self._net_prev_t, 0.001)
            down_kbs = (counters.bytes_recv - self._net_prev.bytes_recv) / dt / 1024
            up_kbs = (counters.bytes_sent - self._net_prev.bytes_sent) / dt / 1024
        self._net_prev = counters
        self._net_prev_t = now
        return {
            "down_kbs": round(max(down_kbs, 0), 1),
            "up_kbs": round(max(up_kbs, 0), 1),
            "total_recv": human(counters.bytes_recv),
            "total_sent": human(counters.bytes_sent),
        }

    def get_disk_io(self):
        c = psutil.disk_io_counters()
        now = time.time()
        read_kbs = write_kbs = 0.0
        if c is not None and self._disk_prev is not None and self._disk_prev_t is not None:
            dt = max(now - self._disk_prev_t, 0.001)
            read_kbs = (c.read_bytes - self._disk_prev.read_bytes) / dt / 1024
            write_kbs = (c.write_bytes - self._disk_prev.write_bytes) / dt / 1024
        self._disk_prev = c
        self._disk_prev_t = now
        return {"read_kbs": round(max(read_kbs, 0), 1), "write_kbs": round(max(write_kbs, 0), 1)}

    def _top_processes(self):
        procs = []
        for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent"]):
            try:
                procs.append(p.info)
            except Exception:
                pass
        if not procs:
            return None, None
        top_cpu = max(procs, key=lambda x: x["cpu_percent"] or 0)
        top_ram = max(procs, key=lambda x: x["memory_percent"] or 0)
        return top_cpu, top_ram

    def get_top_consumers(self):
        top_cpu, top_ram = self._top_processes()
        if top_cpu is None:
            return {"top_cpu": None, "top_ram": None}
        return {
            "top_cpu": {"name": top_cpu["name"] or "?", "value": round(top_cpu["cpu_percent"] or 0, 1)},
            "top_ram": {"name": top_ram["name"] or "?", "value": round(top_ram["memory_percent"] or 0, 1)},
        }

    # ---------- Meeting Mode ----------
    MEETING_MODE_HEAVY = [
        "onedrive", "dropbox", "google drive", "creative cloud",
        "adobe desktop service", "backblaze", "crashplan", "resilio", "box sync",
    ]

    def get_meeting_mode_candidates(self):
        grouped = {}
        for p in psutil.process_iter(["pid", "name", "memory_percent", "cpu_percent"]):
            try:
                info = p.info
                name = info["name"] or ""
                low = name.lower()
                if not any(h in low for h in self.MEETING_MODE_HEAVY):
                    continue
                g = grouped.setdefault(name, {"name": name, "pids": [], "mem": 0.0, "cpu": 0.0})
                g["pids"].append(info["pid"])
                g["mem"] += info["memory_percent"] or 0
                g["cpu"] += info["cpu_percent"] or 0
            except Exception:
                pass
        items = [{"name": v["name"], "pids": v["pids"], "mem": round(v["mem"], 1), "cpu": round(v["cpu"], 1)}
                  for v in grouped.values()]
        items.sort(key=lambda x: x["mem"], reverse=True)
        return {"items": items}

    def activate_meeting_mode(self, pids):
        vm_before = psutil.virtual_memory()
        procs = []
        for pid in pids or []:
            try:
                p = psutil.Process(int(pid))
                p.terminate()
                procs.append(p)
            except Exception:
                pass
        for p in procs:
            try:
                p.wait(timeout=3)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        run(["osascript", "-e", 'do shell script "purge" with administrator privileges'], timeout=30)
        vm_after = psutil.virtual_memory()
        freed = max(vm_after.available - vm_before.available, 0)
        return {
            "freed": human(freed),
            "ram_before": round(vm_before.percent, 1),
            "ram_after": round(vm_after.percent, 1),
        }

    # ---------- Diagnosis ----------
    def get_diagnosis(self):
        cpu = psutil.cpu_percent(interval=0.6)
        vm = psutil.virtual_memory()
        sw = psutil.swap_memory()
        du = shutil.disk_usage("/")
        disk_percent = du.used / du.total * 100
        uptime_days = int((time.time() - psutil.boot_time()) // 86400)
        top_cpu, top_ram = self._top_processes()

        findings = []

        if cpu > 65 and top_cpu and (top_cpu["cpu_percent"] or 0) > 35:
            findings.append({
                "severity": "warning",
                "text": f"CPU is at {cpu:.0f}% — “{top_cpu['name']}” alone is using {top_cpu['cpu_percent']:.0f}% of it.",
                "action": {"label": f"Force Restart {top_cpu['name']}", "type": "force_restart_app", "target": top_cpu["pid"]},
            })

        if sw.percent > 40 and vm.percent > 75:
            findings.append({
                "severity": "critical" if sw.percent > 70 else "warning",
                "text": f"Memory is {vm.percent:.0f}% full and swap usage is {sw.percent:.0f}% — the system is paging to disk, which feels slow. "
                        f"“{top_ram['name']}” is using the most RAM ({top_ram['memory_percent']:.0f}%).",
                "action": {"label": f"Force Restart {top_ram['name']}", "type": "force_restart_app", "target": top_ram["pid"]},
            })
        elif vm.percent > 85:
            findings.append({
                "severity": "warning",
                "text": f"Memory is nearly full ({vm.percent:.0f}%). “{top_ram['name']}” is the biggest consumer ({top_ram['memory_percent']:.0f}%).",
                "action": {"label": f"Force Restart {top_ram['name']}", "type": "force_restart_app", "target": top_ram["pid"]},
            })

        if disk_percent > 90:
            findings.append({
                "severity": "critical",
                "text": f"Disk is {disk_percent:.0f}% full — low free space slows down the whole system, including swap.",
                "action": {"label": "Open Cleanup", "type": "navigate", "target": "cleaning"},
            })

        if uptime_days >= 10:
            findings.append({
                "severity": "warning",
                "text": f"This Mac has been running for {uptime_days} days without a restart — long uptimes can cause slowdowns and memory bloat.",
                "action": {"label": "Restart Mac", "type": "quick_action", "target": "restart_mac"},
            })

        if not findings:
            findings.append({"severity": "good", "text": "Everything looks healthy right now — no obvious bottleneck.", "action": None})

        return {"findings": findings}

    def toggle_caffeinate(self, enable):
        if enable:
            if self._caffeinate_proc is None or self._caffeinate_proc.poll() is not None:
                self._caffeinate_proc = subprocess.Popen(["caffeinate", "-d", "-i"])
        else:
            if self._caffeinate_proc is not None and self._caffeinate_proc.poll() is None:
                self._caffeinate_proc.terminate()
            self._caffeinate_proc = None
        return {"active": self._caffeinate_proc is not None and self._caffeinate_proc.poll() is None}

    def get_caffeinate_status(self):
        active = self._caffeinate_proc is not None and self._caffeinate_proc.poll() is None
        return {"active": active}

    def get_battery(self):
        b = psutil.sensors_battery()
        if b is None:
            return {"available": False}
        info = {
            "available": True,
            "percent": round(b.percent, 0),
            "plugged": b.power_plugged,
            "secsleft": b.secsleft if isinstance(b.secsleft, int) else None,
        }
        r = run(["system_profiler", "SPPowerDataType"], timeout=10)
        cycle_count = None
        condition = None
        max_capacity = None
        for line in r.stdout.splitlines():
            line = line.strip()
            if line.startswith("Cycle Count:"):
                cycle_count = line.split(":", 1)[1].strip()
            elif line.startswith("Condition:"):
                condition = line.split(":", 1)[1].strip()
            elif line.startswith("Maximum Capacity:"):
                max_capacity = line.split(":", 1)[1].strip()
        info.update({"cycle_count": cycle_count, "condition": condition, "max_capacity": max_capacity})
        return info

    def get_big_folders(self):
        targets = [HOME / d for d in ["Downloads", "Documents", "Desktop", "Movies", "Pictures", "Music", "Library"]]
        results = []
        for t in targets:
            if t.exists():
                results.append({"path": str(t), "name": t.name, "size": human(dir_size(t)), "bytes": dir_size(t)})
        results.sort(key=lambda x: x["bytes"], reverse=True)
        return results

    def reveal_in_finder(self, path):
        run(["open", "-R", path])
        return {"ok": True}

    def trash_paths(self, paths):
        results = {"removed": [], "failed": []}
        for p in paths or []:
            path_obj = Path(p)
            if not path_obj.exists():
                results["removed"].append(p)
                continue
            try:
                self._trash_move(path_obj)
                results["removed"].append(p)
            except Exception:
                results["failed"].append(p)
        return results

    # ---------- Duplicate file finder ----------
    def _quick_hash(self, path: Path, chunk=65536):
        h = hashlib.md5()
        size = path.stat().st_size
        with open(path, "rb") as f:
            h.update(f.read(chunk))
            if size > chunk:
                f.seek(max(size - chunk, chunk))
                h.update(f.read(chunk))
        return h.hexdigest()

    DUPLICATE_EXCLUDE_DIRS = {
        "node_modules", "venv", ".venv", "env", ".git", "__pycache__",
        "site-packages", ".next", "dist", "build", "target", ".cache",
        ".cargo", "vendor", "Pods",
    }

    def get_duplicates(self):
        by_size = {}
        for root_name in DUPLICATE_SCAN_ROOTS:
            root = HOME / root_name
            if not root.exists():
                continue
            try:
                for f in root.rglob("*"):
                    try:
                        if self.DUPLICATE_EXCLUDE_DIRS & set(f.relative_to(root).parts[:-1]):
                            continue
                        if f.is_file() and not f.is_symlink():
                            size = f.stat().st_size
                            if size == 0:
                                continue
                            by_size.setdefault(size, []).append(f)
                    except Exception:
                        continue
            except Exception:
                continue

        groups = []
        for size, files in by_size.items():
            if len(files) < 2:
                continue
            by_hash = {}
            for f in files:
                try:
                    h = self._quick_hash(f)
                    by_hash.setdefault(h, []).append(f)
                except Exception:
                    continue
            for h, flist in by_hash.items():
                if len(flist) > 1:
                    groups.append({
                        "size": human(size),
                        "bytes": size,
                        "files": [str(f) for f in flist],
                    })

        groups.sort(key=lambda g: g["bytes"] * (len(g["files"]) - 1), reverse=True)
        return {"groups": groups[:60]}

    # ---------- Screenshot cleaner ----------
    def get_screenshots(self):
        loc_r = run(["defaults", "read", "com.apple.screencapture", "location"])
        loc = loc_r.stdout.strip()
        loc_path = Path(loc).expanduser() if loc else (HOME / "Desktop")
        if not loc_path.exists():
            loc_path = HOME / "Desktop"

        items = []
        try:
            for f in loc_path.iterdir():
                name = f.name
                if not f.is_file():
                    continue
                if ("Screen Shot" in name or "Screenshot" in name) and name.lower().endswith((".png", ".jpg", ".jpeg")):
                    size = f.stat().st_size
                    items.append({"path": str(f), "name": name, "size": human(size), "bytes": size})
        except Exception:
            pass
        items.sort(key=lambda x: x["bytes"], reverse=True)
        total = sum(i["bytes"] for i in items)
        return {"items": items, "total": human(total), "count": len(items)}

    # ---------- Mail / Messages attachments ----------
    def get_attachments_size(self):
        candidates = {
            "Messages Attachments": HOME / "Library" / "Messages" / "Attachments",
            "Mail Downloads": HOME / "Library" / "Containers" / "com.apple.mail" / "Data" / "Library" / "Mail Downloads",
        }
        items = []
        for label, path in candidates.items():
            if path.exists():
                items.append({"label": label, "path": str(path), "size": human(dir_size(path))})
        return {"items": items}

    # ---------- Browser cache breakdown ----------
    def get_browser_caches(self):
        items = []
        for key, (label, path) in BROWSER_CACHES.items():
            if path.exists():
                items.append({"key": key, "label": label, "size": human(dir_size(path))})
        return {"items": items}

    def clean_browser_cache(self, key):
        if key not in BROWSER_CACHES:
            return {"ok": False}
        _, path = BROWSER_CACHES[key]
        if path.exists():
            for item in path.iterdir():
                try:
                    if item.is_dir() and not item.is_symlink():
                        shutil.rmtree(item, ignore_errors=True)
                    else:
                        item.unlink(missing_ok=True)
                except Exception:
                    pass
        return {"ok": True, "size": human(dir_size(path))}

    def quick_action(self, which):
        if which == "restart_finder":
            run(["killall", "Finder"])
        elif which == "restart_dock":
            run(["killall", "Dock"])
        elif which == "flush_dns":
            run(["osascript", "-e",
                 'do shell script "dscacheutil -flushcache; killall -HUP mDNSResponder" with administrator privileges'],
                timeout=30)
        elif which == "restart_mac":
            run(["osascript", "-e", 'tell application "System Events" to restart'])
        elif which == "sleep_mac":
            run(["pmset", "sleepnow"])
        else:
            return {"ok": False}
        return {"ok": True}

    # ---------- Sistem tab ----------
    def get_system_info(self):
        sw = run(["sw_vers"])
        hw = run(["system_profiler", "SPHardwareDataType"], timeout=10)
        info = {"os_version": "?", "model": "?", "chip": "?", "memory": "?", "serial": "?"}
        for line in sw.stdout.splitlines():
            if line.startswith("ProductVersion:"):
                info["os_version"] = "macOS " + line.split(":", 1)[1].strip()
        for line in hw.stdout.splitlines():
            line = line.strip()
            if line.startswith("Model Name:"):
                info["model"] = line.split(":", 1)[1].strip()
            elif line.startswith("Chip:"):
                info["chip"] = line.split(":", 1)[1].strip()
            elif line.startswith("Memory:"):
                info["memory"] = line.split(":", 1)[1].strip()
            elif line.startswith("Serial Number"):
                info["serial"] = line.split(":", 1)[1].strip()
        return info

    def get_security_status(self):
        fv = run(["fdesetup", "status"])
        gk = run(["spctl", "--status"])
        fw = run(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"])
        return {
            "filevault_on": "On" in fv.stdout,
            "gatekeeper_on": "enabled" in gk.stdout,
            "firewall_on": "enabled" in fw.stdout,
        }

    def get_wifi_info(self):
        ssid_r = run(["networksetup", "-getairportnetwork", "en0"])
        connected = "Current Wi-Fi Network:" in ssid_r.stdout
        ssid = ssid_r.stdout.split(":", 1)[1].strip() if connected else None
        ip_r = run(["ipconfig", "getifaddr", "en0"])
        ip = ip_r.stdout.strip() or None
        if not ip:
            for iface, addrs in psutil.net_if_addrs().items():
                if iface.startswith(("en", "utun")) is False:
                    continue
                for a in addrs:
                    if a.family.name == "AF_INET" and not a.address.startswith("127."):
                        ip = a.address
                        break
                if ip:
                    break
        return {"connected": connected, "ssid": ssid, "ip": ip}

    def get_login_items(self):
        r = run(["osascript", "-e", 'tell application "System Events" to get the name of every login item'])
        names = [n.strip() for n in r.stdout.strip().split(",") if n.strip()]
        return {"items": names, "self_enabled": APP_NAME in names}

    def remove_login_item(self, name):
        safe = name.replace('"', "'")
        run(["osascript", "-e", f'tell application "System Events" to delete login item "{safe}"'])
        return self.get_login_items()

    def toggle_self_login_item(self, enable):
        if enable:
            app_path = "/Applications/MaciTor+.app"
            run(["osascript", "-e",
                 f'tell application "System Events" to make login item at end with properties '
                 f'{{path:"{app_path}", name:"{APP_NAME}", hidden:false}}'])
        else:
            run(["osascript", "-e", f'tell application "System Events" to delete login item "{APP_NAME}"'])
        return self.get_login_items()

    def get_cpu_per_core(self):
        return [round(c, 1) for c in psutil.cpu_percent(interval=None, percpu=True)]

    def get_brew_outdated(self):
        r = run(["brew", "outdated", "--json=v2"], timeout=45)
        try:
            data = json.loads(r.stdout or "{}")
        except Exception:
            return {"ok": False, "items": []}
        items = []
        for f in data.get("formulae", []):
            items.append({
                "name": f["name"],
                "installed": ", ".join(f.get("installed_versions", [])),
                "current": f.get("current_version", "?"),
                "kind": "formula",
            })
        for c in data.get("casks", []):
            items.append({
                "name": c["name"],
                "installed": ", ".join(c.get("installed_versions", [])) if isinstance(c.get("installed_versions"), list) else str(c.get("installed_versions", "?")),
                "current": c.get("current_version", "?"),
                "kind": "cask",
            })
        return {"ok": True, "items": items}

    def brew_upgrade(self, name):
        run(["brew", "upgrade", name], timeout=180)
        return {"ok": True}

    def brew_upgrade_all(self):
        run(["brew", "upgrade"], timeout=1200)
        return {"ok": True}

    # ---------- Software Update ----------
    def get_software_updates(self):
        r = run(["softwareupdate", "-l"], timeout=90)
        items = []
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line.startswith("* Label:") and not line.startswith("*Label:"):
                continue
            label = line.split("Label:", 1)[1].strip()
            items.append({"label": label})
        return {"items": items}

    def install_software_update(self, label):
        run(["osascript", "-e",
             f'do shell script "softwareupdate -i {shlex.quote(label)} --agree-to-license" with administrator privileges'],
            timeout=1800)
        return {"ok": True}

    # ---------- Uninstaller ----------
    def get_installed_apps(self):
        dirs = [Path("/Applications"), HOME / "Applications"]
        apps = []
        seen = set()
        for d in dirs:
            if not d.exists():
                continue
            for item in d.iterdir():
                if item.suffix == ".app" and item.name not in seen:
                    seen.add(item.name)
                    apps.append({
                        "name": item.stem,
                        "path": str(item),
                        "system": str(item).startswith("/Applications") and item.stat().st_uid == 0,
                    })
        apps.sort(key=lambda a: a["name"].lower())
        return apps

    def get_app_size(self, path):
        return {"size": human(dir_size(Path(path)))}

    def _bundle_id(self, app_path: Path):
        plist_path = app_path / "Contents" / "Info.plist"
        try:
            with open(plist_path, "rb") as f:
                data = plistlib.load(f)
            return data.get("CFBundleIdentifier")
        except Exception:
            return None

    def get_app_leftovers(self, path):
        app_path = Path(path)
        app_name = app_path.stem
        bundle_id = self._bundle_id(app_path)
        L = HOME / "Library"

        candidates = [
            L / "Application Support" / app_name,
            L / "Caches" / app_name,
            L / "Logs" / app_name,
            L / "Saved Application State" / f"{app_name}.savedState",
            L / "HTTPStorages" / app_name,
            L / "WebKit" / app_name,
        ]
        if bundle_id:
            candidates += [
                L / "Application Support" / bundle_id,
                L / "Caches" / bundle_id,
                L / "Containers" / bundle_id,
                L / "HTTPStorages" / bundle_id,
                L / "WebKit" / bundle_id,
                L / "Preferences" / f"{bundle_id}.plist",
                L / "Saved Application State" / f"{bundle_id}.savedState",
            ]
            candidates += list((L / "LaunchAgents").glob(f"{bundle_id}*.plist"))
            short = bundle_id.split(".")[-1]
            if len(short) > 3:
                candidates += list((L / "Group Containers").glob(f"*{short}*"))

        found = []
        seen_paths = set()
        for c in candidates:
            c = Path(c)
            if c.exists() and str(c) not in seen_paths:
                seen_paths.add(str(c))
                found.append({"path": str(c), "size": human(dir_size(c) if c.is_dir() else c.stat().st_size)})
        return {"app_name": app_name, "bundle_id": bundle_id, "leftovers": found}

    def _trash_move(self, path: Path):
        TRASH.mkdir(exist_ok=True)
        dest = TRASH / path.name
        if dest.exists():
            dest = TRASH / f"{path.stem}-{int(time.time())}{path.suffix}"
        shutil.move(str(path), str(dest))

    def _force_move_admin(self, path: Path):
        TRASH.mkdir(exist_ok=True)
        dest = TRASH / path.name
        if dest.exists():
            dest = TRASH / f"{path.stem}-{int(time.time())}{path.suffix}"
        shell_cmd = f"mv -f {shlex.quote(str(path))} {shlex.quote(str(dest))}"
        run(["osascript", "-e", f'do shell script "{shell_cmd}" with administrator privileges'], timeout=60)

    def _stop_bundle_processes(self, app_path: str, bundle_id):
        run(["pkill", "-9", "-f", app_path])
        if bundle_id:
            run(["pkill", "-9", "-f", bundle_id])
        time.sleep(0.5)

    def _unload_launch_agents(self, bundle_id):
        if not bundle_id:
            return
        for base in [HOME / "Library" / "LaunchAgents"]:
            for plist in base.glob(f"{bundle_id}*.plist"):
                run(["launchctl", "unload", "-w", str(plist)], timeout=10)

    def uninstall_app(self, app_path, leftover_paths):
        bundle_id = self._bundle_id(Path(app_path))
        self._unload_launch_agents(bundle_id)
        self._stop_bundle_processes(app_path, bundle_id)

        results = {"removed": [], "failed": []}
        all_paths = [app_path] + list(leftover_paths or [])
        for p in all_paths:
            path_obj = Path(p)
            if not path_obj.exists():
                results["removed"].append(p)
                continue
            try:
                self._trash_move(path_obj)
            except Exception:
                try:
                    self._force_move_admin(path_obj)
                except Exception:
                    pass
            if path_obj.exists():
                results["failed"].append(p)
            else:
                results["removed"].append(p)

        return results

    # ---------- VPN / Avast ----------
    def get_vpn_status(self):
        r = run(["scutil", "--nc", "list"])
        services = []
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line or "VPN" not in line:
                continue
            connected = line.startswith("*") and "Connected" in line and "Disconnected" not in line
            name = line.split('"')[1] if '"' in line else line
            services.append({"name": name, "connected": connected})

        active_tunnel = False
        for iface, addrs in psutil.net_if_addrs().items():
            if not iface.startswith("utun"):
                continue
            for a in addrs:
                if a.family.name == "AF_INET":
                    active_tunnel = True
                    break

        avast_running = any(
            (p.info.get("name") or "") == "Avast"
            for p in psutil.process_iter(["name"])
        )

        return {"services": services, "active_tunnel": active_tunnel, "avast_running": avast_running}

    # ---------- Time Machine ----------
    def get_backup_status(self):
        status_r = run(["tmutil", "status"])
        dest_r = run(["tmutil", "destinationinfo"])
        configured = "No destinations configured" not in dest_r.stdout and dest_r.stdout.strip() != ""
        running = '"Running" = 1' in status_r.stdout.replace(" ", "") or "Running = 1" in status_r.stdout
        latest = None
        if configured:
            lb = run(["tmutil", "latestbackup"], timeout=10)
            if lb.stdout.strip() and "Error" not in lb.stdout:
                latest = lb.stdout.strip().split("/")[-1]
        return {"configured": configured, "running": running, "latest": latest}

    # ---------- Disk breakdown ----------
    def get_disk_breakdown(self):
        du = shutil.disk_usage("/")
        categories = {
            "Applications": Path("/Applications"),
            "Documents": HOME / "Documents",
            "Downloads": HOME / "Downloads",
            "Desktop": HOME / "Desktop",
            "Pictures": HOME / "Pictures",
            "Movies": HOME / "Movies",
            "User Library": HOME / "Library",
        }
        items = []
        known_total = 0
        for label, path in categories.items():
            size = dir_size(path) if path.exists() else 0
            known_total += size
            items.append({"label": label, "bytes": size, "size": human(size)})
        other = max(du.used - known_total, 0)
        items.append({"label": "Other / System", "bytes": other, "size": human(other)})
        items.sort(key=lambda x: x["bytes"], reverse=True)
        for it in items:
            it["percent"] = round(it["bytes"] / du.used * 100, 1) if du.used else 0
        return {"total": human(du.total), "used": human(du.used), "items": items}

    # ---------- Deep clean ----------
    def deep_clean(self):
        before = sum(dir_size(path) for _, _, path in CLEAN_TARGETS.values())
        for key in CLEAN_TARGETS:
            self.clean_target(key)
        run(["brew", "cleanup", "-s"], timeout=60)
        run(["podman", "system", "prune", "-f"], timeout=30)
        run(["osascript", "-e",
             'do shell script "dscacheutil -flushcache; killall -HUP mDNSResponder" with administrator privileges'],
            timeout=30)
        after = sum(dir_size(path) for _, _, path in CLEAN_TARGETS.values())
        freed = max(before - after, 0)
        return {"freed": human(freed)}

    def get_processes(self):
        procs = []
        for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent"]):
            try:
                procs.append(p.info)
            except Exception:
                pass
        procs.sort(key=lambda x: (x["memory_percent"] or 0), reverse=True)
        return [
            {
                "pid": p["pid"],
                "name": p["name"] or "?",
                "cpu": round(p["cpu_percent"] or 0, 1),
                "mem": round(p["memory_percent"] or 0, 1),
            }
            for p in procs[:25]
        ]

    def kill_process(self, pid):
        try:
            p = psutil.Process(int(pid))
            p.terminate()
            try:
                p.wait(timeout=2)
            except psutil.TimeoutExpired:
                p.kill()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def force_restart_app(self, pid):
        try:
            p = psutil.Process(int(pid))
            exe = p.exe()
        except Exception as e:
            return {"ok": False, "error": str(e)}

        bundle_path = None
        parts = Path(exe).parts
        for i, part in enumerate(parts):
            if part.endswith(".app"):
                bundle_path = str(Path(*parts[: i + 1]))
                break

        if bundle_path:
            run(["pkill", "-9", "-f", bundle_path])
        else:
            try:
                p.kill()
            except Exception:
                pass

        time.sleep(1)
        if bundle_path:
            run(["open", bundle_path])
        return {"ok": True, "bundle": bundle_path}

    def get_podman(self):
        machines = run(["podman", "machine", "list", "--format", "json"])
        containers = run(["podman", "ps", "-a", "--format", "json"])
        try:
            m = json.loads(machines.stdout or "[]")
        except Exception:
            m = []
        try:
            c = json.loads(containers.stdout or "[]")
        except Exception:
            c = []
        running = any(mm.get("Running") for mm in m) if m else False
        out_containers = []
        for cc in c:
            name = (cc.get("Names") or ["?"])[0] if isinstance(cc.get("Names"), list) else str(cc.get("Names"))
            status = cc.get("Status", "?")
            is_up = "Up" in status or "running" in status.lower()
            out_containers.append({
                "name": name,
                "image": cc.get("Image", "?"),
                "status": status,
                "running": is_up,
            })
        return {"machine_running": running, "containers": out_containers}

    def podman_machine_action(self, action):
        run(["podman", "machine", action])
        return self.get_podman()

    def podman_container_action(self, name, action):
        run(["podman", action, name])
        return self.get_podman()

    def get_clean_targets(self):
        return [
            {"key": k, "label": label, "sub": sub, "size": human(dir_size(path))}
            for k, (label, sub, path) in CLEAN_TARGETS.items()
        ]

    def clean_target(self, key):
        if key not in CLEAN_TARGETS:
            return {"ok": False}
        _, _, path = CLEAN_TARGETS[key]
        if path.exists():
            for item in path.iterdir():
                try:
                    if item.is_dir() and not item.is_symlink():
                        shutil.rmtree(item, ignore_errors=True)
                    else:
                        item.unlink(missing_ok=True)
                except Exception:
                    pass
        return {"ok": True, "size": human(dir_size(path))}

    def run_extra(self, which):
        cmds = {
            "brew": ["brew", "cleanup", "-s"],
            "podman_prune": ["podman", "system", "prune", "-f"],
        }
        cmd = cmds.get(which)
        if not cmd:
            return {"ok": False}
        run(cmd, timeout=60)
        return {"ok": True}


if __name__ == "__main__":
    api = Api()
    window = webview.create_window(
        APP_NAME,
        str(BASE / "web" / "index.html"),
        js_api=api,
        width=1040,
        height=700,
        min_size=(880, 580),
        background_color="#0d0d0d",
        transparent=True,
        vibrancy=True,
    )

    # Closing the window hides it instead of quitting — the app keeps running
    # (reopen from the Dock icon). Cmd+Q / right-click Dock icon > Quit still exits.
    window.events.closing += lambda: window.hide() or False

    webview.start()
