const COLORS = {
  accent: "#1e3a8a",
  accent2: "#3454b4",
  aqua: "#19c38a",
  orange: "#e8732f",
  good: "#22c55e",
  warning: "#fab219",
  critical: "#e24b4b",
  grid: "rgba(255,255,255,0.06)",
};

function levelColor(pct) {
  if (pct < 60) return COLORS.good;
  if (pct < 85) return COLORS.warning;
  return COLORS.critical;
}

function fillGradient(ctx, hex) {
  const g = ctx.createLinearGradient(0, 0, 0, 56);
  g.addColorStop(0, hex + "55");
  g.addColorStop(1, hex + "02");
  return g;
}

function makeSpark(canvasId, lineColor) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const data = Array(40).fill(0);
  const chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data,
        borderColor: lineColor,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.35,
        fill: true,
        backgroundColor: fillGradient(ctx, lineColor),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      scales: {
        x: { display: false },
        y: { display: false, min: 0, max: 100 },
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      elements: { line: { capBezierPoints: true } },
    },
  });
  return {
    push(v) {
      chart.data.datasets[0].data.push(v);
      chart.data.datasets[0].data.shift();
      chart.data.labels.push(chart.data.labels.length);
      chart.data.labels.shift();
      chart.update("none");
    },
    setColor(hex) {
      chart.data.datasets[0].borderColor = hex;
      chart.data.datasets[0].backgroundColor = fillGradient(ctx, hex);
    },
  };
}

const sparkCpu = makeSpark("chart-cpu", COLORS.accent);
const sparkRam = makeSpark("chart-ram", COLORS.aqua);
const sparkDisk = makeSpark("chart-disk", COLORS.orange);

function makeDualSpark(canvasId, colorA, colorB) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const n = 40;
  const mk = (color) => ({
    data: Array(n).fill(0),
    borderColor: color,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 0,
    tension: 0.35,
    fill: false,
  });
  const chart = new Chart(ctx, {
    type: "line",
    data: { labels: Array(n).fill(0).map((_, i) => i), datasets: [mk(colorA), mk(colorB)] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      scales: { x: { display: false }, y: { display: false, min: 0 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });
  return {
    push(a, b) {
      const maxVal = Math.max(10, ...chart.data.datasets[0].data, ...chart.data.datasets[1].data, a, b) * 1.15;
      chart.options.scales.y.max = maxVal;
      chart.data.datasets[0].data.push(a);
      chart.data.datasets[0].data.shift();
      chart.data.datasets[1].data.push(b);
      chart.data.datasets[1].data.shift();
      chart.data.labels.push(chart.data.labels.length);
      chart.data.labels.shift();
      chart.update("none");
    },
  };
}

const sparkNet = makeDualSpark("chart-net", COLORS.aqua, COLORS.orange);
const sparkIo = makeDualSpark("chart-io", COLORS.accent, COLORS.warning);

// ---------------- Tabs ----------------
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "processes") refreshProcesses();
    if (btn.dataset.tab === "apps") refreshApps();
    if (btn.dataset.tab === "cleaning") { refreshCleaning(); refreshBigFolders(); refreshDiskBreakdown(); }
    if (btn.dataset.tab === "system") { refreshSystemTab(); refreshPodman(); }
    if (btn.dataset.tab === "files") { refreshScreenshots(); refreshAttachments(); refreshBrowserCaches(); }
  });
});

// ---------------- Meeting Mode ----------------
document.getElementById("meeting-mode-btn").addEventListener("click", openMeetingModal);

async function openMeetingModal() {
  const modal = document.getElementById("meeting-modal");
  const box = document.getElementById("meeting-modal-items");
  const title = document.getElementById("meeting-modal-title");
  const sub = document.getElementById("meeting-modal-sub");
  const confirmBtn = document.getElementById("meeting-modal-confirm");
  const cancelBtn = document.getElementById("meeting-modal-cancel");

  title.textContent = "Meeting Mode";
  sub.textContent = "Quit these background sync apps and free up memory before you share your screen. Teams/Zoom/communication apps are never touched.";
  confirmBtn.style.display = "";
  confirmBtn.disabled = false;
  confirmBtn.textContent = "Free Up Memory";
  box.innerHTML = `<div class="empty-note">Scanning for background sync apps…</div>`;
  modal.classList.add("active");

  const res = await window.pywebview.api.get_meeting_mode_candidates();

  if (!res.items.length) {
    box.innerHTML = `<div class="empty-note">No known background sync apps running — just freeing memory.</div>`;
  } else {
    box.innerHTML = res.items.map((it) => `
      <label class="leftover-row">
        <input type="checkbox" checked data-pids='${JSON.stringify(it.pids)}' />
        <span class="lpath">${it.name}</span>
        <span class="lsize">CPU ${it.cpu}% · RAM ${it.mem}%</span>
      </label>`).join("");
  }

  cancelBtn.onclick = () => modal.classList.remove("active");

  confirmBtn.onclick = async () => {
    const pids = [...box.querySelectorAll("input[type=checkbox]:checked")]
      .flatMap((cb) => JSON.parse(cb.dataset.pids || "[]"));
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Freeing memory…";
    const result = await window.pywebview.api.activate_meeting_mode(pids);
    title.textContent = "Meeting Mode active ✓";
    sub.textContent = `RAM: ${result.ram_before}% → ${result.ram_after}%  ·  Freed ${result.freed}. You're ready to share your screen.`;
    box.innerHTML = "";
    confirmBtn.style.display = "none";
    cancelBtn.textContent = "Close";
    cancelBtn.onclick = () => { modal.classList.remove("active"); cancelBtn.textContent = "Cancel"; };
  };
}

// ---------------- Diagnosis ----------------
document.getElementById("diagnose-btn").addEventListener("click", runDiagnosis);

async function runDiagnosis() {
  const btn = document.getElementById("diagnose-btn");
  const box = document.getElementById("diagnosis-results");
  btn.disabled = true;
  btn.textContent = "Analyzing…";
  box.innerHTML = `<div class="empty-note">Sampling CPU/memory…</div>`;

  const res = await window.pywebview.api.get_diagnosis();
  btn.disabled = false;
  btn.textContent = "Diagnose Now";

  const icon = { good: "✓", warning: "!", critical: "✕" };
  box.innerHTML = res.findings.map((f) => `
    <div class="diagnosis-row">
      <span class="diagnosis-icon ${f.severity}">${icon[f.severity] || "!"}</span>
      <span class="diagnosis-text">${f.text}</span>
      ${f.action ? `<button class="btn btn-ghost btn-sm diagnosis-action" data-diag-action='${JSON.stringify(f.action)}'>${f.action.label}</button>` : ""}
    </div>`).join("");

  box.querySelectorAll("button[data-diag-action]").forEach((b) => {
    b.addEventListener("click", async () => {
      const action = JSON.parse(b.dataset.diagAction);
      b.disabled = true;
      b.textContent = "Working…";
      if (action.type === "force_restart_app") {
        await window.pywebview.api.force_restart_app(action.target);
      } else if (action.type === "quick_action") {
        await window.pywebview.api.quick_action(action.target);
      } else if (action.type === "navigate") {
        document.querySelector(`.nav-item[data-tab="${action.target}"]`).click();
        return;
      }
      b.textContent = "Done ✓";
    });
  });
}

// ---------------- Overview ----------------
async function refreshOverview() {
  const d = await window.pywebview.api.get_overview();

  document.getElementById("cpu-value").textContent = d.cpu_percent + "%";
  document.getElementById("cpu-value").style.color = levelColor(d.cpu_percent);
  document.getElementById("cpu-caption").textContent = d.cpu_cores + " cores";
  sparkCpu.push(d.cpu_percent);
  sparkCpu.setColor(levelColor(d.cpu_percent) === COLORS.good ? COLORS.accent : levelColor(d.cpu_percent));

  document.getElementById("ram-value").textContent = d.ram_percent + "%";
  document.getElementById("ram-value").style.color = levelColor(d.ram_percent);
  document.getElementById("ram-caption").textContent = `${d.ram_used} / ${d.ram_total}`;
  sparkRam.push(d.ram_percent);
  sparkRam.setColor(levelColor(d.ram_percent) === COLORS.good ? COLORS.aqua : levelColor(d.ram_percent));

  document.getElementById("disk-value").textContent = d.disk_percent + "%";
  document.getElementById("disk-value").style.color = levelColor(d.disk_percent);
  document.getElementById("disk-caption").textContent = `${d.disk_used} / ${d.disk_total}`;
  sparkDisk.push(d.disk_percent);
  sparkDisk.setColor(levelColor(d.disk_percent) === COLORS.good ? COLORS.orange : levelColor(d.disk_percent));

  const swapRow = document.getElementById("swap-row");
  swapRow.className = "info-row" + (d.swap_percent > 70 ? " crit" : d.swap_percent > 40 ? " warn" : "");
  document.getElementById("swap-text").textContent =
    `${d.swap_used} / ${d.swap_total}` + (d.swap_percent > 50 ? "  ⚠ high — consider a reboot" : "");

  const uptimeRow = document.getElementById("uptime-row");
  uptimeRow.className = "info-row" + (d.uptime_days >= 10 ? " warn" : "");
  document.getElementById("uptime-text").textContent =
    `${d.uptime_days}d ${d.uptime_hours}h` + (d.uptime_days >= 10 ? "  ⚠ reboot recommended" : "");
}

// ---------------- Network ----------------
async function refreshNetwork() {
  const n = await window.pywebview.api.get_network();
  document.getElementById("net-down").textContent = n.down_kbs < 1024
    ? `${n.down_kbs.toFixed(0)} KB/s` : `${(n.down_kbs / 1024).toFixed(1)} MB/s`;
  document.getElementById("net-up").textContent = n.up_kbs < 1024
    ? `${n.up_kbs.toFixed(0)} KB/s` : `${(n.up_kbs / 1024).toFixed(1)} MB/s`;
  document.getElementById("net-caption").textContent = `Total: ↓ ${n.total_recv}  ↑ ${n.total_sent}`;
  sparkNet.push(n.down_kbs, n.up_kbs);
}

// ---------------- Battery ----------------
async function refreshBattery() {
  const b = await window.pywebview.api.get_battery();
  const tile = document.getElementById("tile-battery");
  if (!b.available) {
    tile.style.display = "none";
    return;
  }
  document.getElementById("battery-value").textContent = b.percent + "%";
  document.getElementById("battery-caption").textContent = b.plugged ? "Charging ⚡" : "On battery";
  const bar = document.getElementById("battery-bar");
  bar.style.width = b.percent + "%";
  bar.style.background = b.percent < 20
    ? `linear-gradient(90deg, ${COLORS.critical}, ${COLORS.warning})`
    : `linear-gradient(90deg, ${COLORS.aqua}, ${COLORS.good})`;
  if (b.cycle_count) {
    document.getElementById("battery-health").textContent =
      `Cycles: ${b.cycle_count}  ·  Condition: ${b.condition}  ·  Max Capacity: ${b.max_capacity}`;
  }
}

// ---------------- Disk I/O ----------------
async function refreshDiskIo() {
  const io = await window.pywebview.api.get_disk_io();
  document.getElementById("io-read").textContent = io.read_kbs < 1024
    ? `${io.read_kbs.toFixed(0)} KB/s` : `${(io.read_kbs / 1024).toFixed(1)} MB/s`;
  document.getElementById("io-write").textContent = io.write_kbs < 1024
    ? `${io.write_kbs.toFixed(0)} KB/s` : `${(io.write_kbs / 1024).toFixed(1)} MB/s`;
  sparkIo.push(io.read_kbs, io.write_kbs);
}

// ---------------- Top consumers ----------------
async function refreshTopConsumers() {
  const t = await window.pywebview.api.get_top_consumers();
  if (t.top_cpu) {
    document.getElementById("top-cpu-name").textContent = t.top_cpu.name;
    document.getElementById("top-cpu-val").textContent = t.top_cpu.value.toFixed(1) + "%";
  }
  if (t.top_ram) {
    document.getElementById("top-ram-name").textContent = t.top_ram.name;
    document.getElementById("top-ram-val").textContent = t.top_ram.value.toFixed(1) + "%";
  }
}

// ---------------- CPU cores ----------------
let coresInit = false;
async function refreshCores() {
  const cores = await window.pywebview.api.get_cpu_per_core();
  const grid = document.getElementById("cores-grid");
  if (!coresInit || grid.children.length !== cores.length) {
    grid.innerHTML = cores.map((_, i) => `
      <div class="core-item">
        <span class="core-label">C${i + 1}</span>
        <div class="core-bar-wrap"><div class="core-bar" id="core-bar-${i}"></div></div>
      </div>`).join("");
    coresInit = true;
  }
  cores.forEach((v, i) => {
    const bar = document.getElementById(`core-bar-${i}`);
    if (!bar) return;
    bar.style.width = v + "%";
    bar.style.background = levelColor(v);
  });
}

// ---------------- System tab ----------------
async function refreshSystemTab() {
  refreshSystemInfo();
  refreshSecurity();
  refreshWifi();
  refreshLoginItems();
  refreshVpn();
  refreshBackup();
}

async function refreshVpn() {
  const v = await window.pywebview.api.get_vpn_status();
  document.getElementById("dot-vpn").className = "status-dot" + (v.active_tunnel ? " on" : "");
  document.getElementById("dot-avast").className = "status-dot" + (v.avast_running ? " on" : "");
  const note = document.getElementById("vpn-note");
  if (v.avast_running && !v.active_tunnel) {
    note.textContent = "⚠ Avast is on — corporate VPN may fail to connect.";
  } else {
    note.textContent = "";
  }
}

async function refreshBackup() {
  const b = await window.pywebview.api.get_backup_status();
  document.getElementById("backup-status").textContent = !b.configured
    ? "Not configured" : (b.running ? "Backing up…" : "Ready");
  document.getElementById("backup-latest").textContent = b.latest || "—";
}

async function refreshSystemInfo() {
  const s = await window.pywebview.api.get_system_info();
  document.getElementById("sys-model").textContent = s.model;
  document.getElementById("sys-chip").textContent = s.chip;
  document.getElementById("sys-memory").textContent = s.memory;
  document.getElementById("sys-os").textContent = s.os_version;
  document.getElementById("sys-serial").textContent = s.serial;
}

async function refreshSecurity() {
  const s = await window.pywebview.api.get_security_status();
  document.getElementById("dot-filevault").className = "status-dot" + (s.filevault_on ? " on" : "");
  document.getElementById("dot-gatekeeper").className = "status-dot" + (s.gatekeeper_on ? " on" : "");
  document.getElementById("dot-firewall").className = "status-dot" + (s.firewall_on ? " on" : "");
}

async function refreshWifi() {
  const w = await window.pywebview.api.get_wifi_info();
  document.getElementById("sys-ssid").textContent = w.connected ? w.ssid : "Not connected";
  document.getElementById("sys-ip").textContent = w.ip || "—";
}

async function refreshLoginItems() {
  const d = await window.pywebview.api.get_login_items();
  const toggle = document.getElementById("self-login-toggle");
  toggle.checked = d.self_enabled;
  toggle.onchange = async () => {
    await window.pywebview.api.toggle_self_login_item(toggle.checked);
    refreshLoginItems();
  };

  const list = document.getElementById("login-items-list");
  const others = d.items.filter((n) => n !== "MaciTor+");
  if (!others.length) {
    list.innerHTML = `<div class="empty-note">No other login items.</div>`;
    return;
  }
  list.innerHTML = others.map((name) => `
    <div class="clean-row">
      <div class="meta"><span class="label">${name}</span></div>
      <div class="right">
        <button class="btn btn-danger btn-sm" data-remove-login="${name}">Remove</button>
      </div>
    </div>`).join("");

  list.querySelectorAll("button[data-remove-login]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await window.pywebview.api.remove_login_item(btn.dataset.removeLogin);
      refreshLoginItems();
    });
  });
}

document.getElementById("swupdate-refresh").addEventListener("click", async () => {
  const status = document.getElementById("swupdate-status");
  const list = document.getElementById("swupdate-list");
  status.textContent = "Checking…";
  list.innerHTML = "";
  const res = await window.pywebview.api.get_software_updates();
  if (!res.items.length) {
    status.textContent = "You're up to date ✓";
    return;
  }
  status.textContent = `${res.items.length} update(s) available.`;
  list.innerHTML = res.items.map((it) => `
    <div class="clean-row" id="swu-${CSS.escape(it.label)}">
      <div class="meta"><span class="label">${it.label}</span></div>
      <div class="right">
        <button class="btn btn-accent btn-sm" data-swu-install="${it.label}">Install</button>
      </div>
    </div>`).join("");

  list.querySelectorAll("button[data-swu-install]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Installing… (may restart)";
      await window.pywebview.api.install_software_update(btn.dataset.swuInstall);
      btn.textContent = "Done";
    });
  });
});

document.getElementById("brew-refresh").addEventListener("click", async () => {
  const status = document.getElementById("brew-status");
  const list = document.getElementById("brew-list");
  const upgradeAllBtn = document.getElementById("brew-upgrade-all");
  status.textContent = "Checking…";
  list.innerHTML = "";
  upgradeAllBtn.style.display = "none";
  const res = await window.pywebview.api.get_brew_outdated();
  if (!res.ok || !res.items.length) {
    status.textContent = "Everything is up to date ✓";
    return;
  }
  status.textContent = `${res.items.length} package(s) can be updated.`;
  upgradeAllBtn.style.display = "";
  list.innerHTML = res.items.map((it) => `
    <div class="clean-row" id="brew-${it.name}">
      <div class="meta">
        <span class="label">${it.name}</span>
        <span class="sub">${it.installed} → ${it.current}</span>
      </div>
      <div class="right">
        <button class="btn btn-accent btn-sm" data-brew-upgrade="${it.name}">Update</button>
      </div>
    </div>`).join("");

  list.querySelectorAll("button[data-brew-upgrade]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      await window.pywebview.api.brew_upgrade(btn.dataset.brewUpgrade);
      document.querySelector(`#brew-${btn.dataset.brewUpgrade}`).remove();
    });
  });
});

document.getElementById("brew-upgrade-all").addEventListener("click", async () => {
  const btn = document.getElementById("brew-upgrade-all");
  const status = document.getElementById("brew-status");
  btn.disabled = true;
  btn.textContent = "Updating all…";
  status.textContent = "Updating all packages… this can take a while.";
  await window.pywebview.api.brew_upgrade_all();
  status.textContent = "All packages updated ✓";
  btn.disabled = false;
  btn.textContent = "Update All";
  btn.style.display = "none";
  document.getElementById("brew-list").innerHTML = "";
});

// ---------------- Processes ----------------
async function refreshProcesses() {
  lastProcs = await window.pywebview.api.get_processes();
  renderProcs(lastProcs, document.getElementById("proc-search").value.trim().toLowerCase());
}

function renderProcs(procs, filter) {
  const list = document.getElementById("proc-list");
  const filtered = filter ? procs.filter((p) => p.name.toLowerCase().includes(filter)) : procs;
  list.innerHTML = filtered.map((p) => `
    <div class="list-row proc-row">
      <span class="pid">${p.pid}</span>
      <span class="name">${p.name}</span>
      <span class="num">${p.cpu.toFixed(1)}</span>
      <span class="num">${p.mem.toFixed(1)}</span>
      <div class="proc-actions">
        <button class="btn btn-ghost btn-sm" data-force-pid="${p.pid}" title="Kill all its subprocesses and relaunch">Force Restart</button>
        <button class="btn btn-danger btn-sm" data-pid="${p.pid}">Stop</button>
      </div>
    </div>`).join("");

  list.querySelectorAll("button[data-pid]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      await window.pywebview.api.kill_process(btn.dataset.pid);
      refreshProcesses();
    });
  });

  list.querySelectorAll("button[data-force-pid]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      await window.pywebview.api.force_restart_app(btn.dataset.forcePid);
      refreshProcesses();
    });
  });
}

// ---------------- Podman ----------------
async function refreshPodman() {
  const d = await window.pywebview.api.get_podman();
  renderPodman(d);
}

function renderPodman(d) {
  const dot = document.getElementById("podman-dot");
  const text = document.getElementById("podman-status-text");
  dot.className = "status-dot" + (d.machine_running ? " on" : "");
  text.textContent = "Machine " + (d.machine_running ? "running" : "stopped");

  const list = document.getElementById("podman-list");
  if (!d.containers.length) {
    list.innerHTML = `<div class="empty-note">No containers found.</div>`;
    return;
  }
  list.innerHTML = d.containers.map((c) => `
    <div class="list-row podman-row">
      <span class="pname">${c.name}</span>
      <span class="pimage">${c.image}</span>
      <span class="pstatus ${c.running ? "up" : "down"}">${c.status}</span>
      <button class="btn btn-sm ${c.running ? "btn-danger" : "btn-accent"}" data-container="${c.name}" data-action="${c.running ? "stop" : "start"}">
        ${c.running ? "Stop" : "Start"}
      </button>
    </div>`).join("");

  list.querySelectorAll("button[data-container]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const d2 = await window.pywebview.api.podman_container_action(btn.dataset.container, btn.dataset.action);
      renderPodman(d2);
    });
  });
}

document.getElementById("podman-refresh").addEventListener("click", refreshPodman);
document.getElementById("podman-start").addEventListener("click", async () => {
  renderPodman(await window.pywebview.api.podman_machine_action("start"));
});
document.getElementById("podman-stop").addEventListener("click", async () => {
  renderPodman(await window.pywebview.api.podman_machine_action("stop"));
});

// ---------------- Cleaning ----------------
async function refreshCleaning() {
  const targets = await window.pywebview.api.get_clean_targets();
  const list = document.getElementById("clean-list");
  list.innerHTML = targets.map((t) => `
    <div class="clean-row" id="clean-${t.key}">
      <div class="meta">
        <span class="label">${t.label}</span>
        <span class="sub">${t.sub}</span>
      </div>
      <div class="right">
        <span class="size">${t.size}</span>
        <button class="btn btn-accent btn-sm" data-clean="${t.key}">Clear</button>
      </div>
    </div>`).join("");

  list.querySelectorAll("button[data-clean]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.clean;
      const status = document.getElementById("clean-status");
      status.textContent = `Clearing ${key}…`;
      btn.disabled = true;
      const res = await window.pywebview.api.clean_target(key);
      document.querySelector(`#clean-${key} .size`).textContent = res.size;
      status.textContent = `${key} cleared ✓`;
      btn.disabled = false;
    });
  });
}

const DISK_COLORS = [COLORS.accent, COLORS.aqua, COLORS.orange, COLORS.warning, "#9085e9", "#e87ba4", "#4a3aa7", COLORS.critical];

async function refreshDiskBreakdown() {
  const d = await window.pywebview.api.get_disk_breakdown();
  const bar = document.getElementById("disk-breakdown-bar");
  const legend = document.getElementById("disk-breakdown-legend");
  bar.innerHTML = d.items.map((it, i) =>
    `<div class="seg" style="width:${it.percent}%;background:${DISK_COLORS[i % DISK_COLORS.length]}"></div>`).join("");
  legend.innerHTML = d.items.map((it, i) => `
    <div class="legend-item">
      <span class="legend-swatch" style="background:${DISK_COLORS[i % DISK_COLORS.length]}"></span>
      <span>${it.label}: <strong>${it.size}</strong> (${it.percent}%)</span>
    </div>`).join("");
}

document.getElementById("deep-clean-btn").addEventListener("click", async () => {
  const btn = document.getElementById("deep-clean-btn");
  const status = document.getElementById("deep-clean-status");
  btn.disabled = true;
  status.textContent = "Deep clean running… (includes brew/podman/DNS, may take a moment)";
  const res = await window.pywebview.api.deep_clean();
  status.textContent = `Done ✓ — freed ${res.freed}.`;
  btn.disabled = false;
  refreshCleaning();
  refreshBigFolders();
  refreshDiskBreakdown();
});

document.querySelectorAll("button[data-extra]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const status = document.getElementById("clean-status");
    status.textContent = `${btn.textContent} running…`;
    btn.disabled = true;
    await window.pywebview.api.run_extra(btn.dataset.extra);
    status.textContent = `${btn.textContent} done ✓`;
    btn.disabled = false;
  });
});

document.querySelectorAll("button[data-quick]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const status = document.getElementById("clean-status");
    status.textContent = `${btn.textContent} running…`;
    btn.disabled = true;
    await window.pywebview.api.quick_action(btn.dataset.quick);
    status.textContent = `${btn.textContent} done ✓`;
    btn.disabled = false;
  });
});

// ---------------- Apps / Uninstaller ----------------
let lastApps = [];

async function refreshApps() {
  lastApps = await window.pywebview.api.get_installed_apps();
  renderApps(lastApps, document.getElementById("apps-search").value.trim().toLowerCase());
}

function renderApps(apps, filter) {
  const list = document.getElementById("apps-list");
  const filtered = filter ? apps.filter((a) => a.name.toLowerCase().includes(filter)) : apps;
  list.innerHTML = filtered.map((a) => `
    <div class="clean-row app-row">
      <div class="meta">
        <span class="label">${a.name}${a.system ? '<span class="badge-system">system</span>' : ""}</span>
        <span class="apath">${a.path}</span>
      </div>
      <div class="right">
        <button class="btn btn-danger btn-sm" data-uninstall="${a.path}">Remove</button>
      </div>
    </div>`).join("");

  list.querySelectorAll("button[data-uninstall]").forEach((btn) => {
    btn.addEventListener("click", () => openUninstallModal(btn.dataset.uninstall));
  });
}

document.getElementById("apps-search").addEventListener("input", (e) => {
  renderApps(lastApps, e.target.value.trim().toLowerCase());
});

async function openUninstallModal(appPath) {
  const modal = document.getElementById("uninstall-modal");
  const leftoversBox = document.getElementById("modal-leftovers");
  document.getElementById("modal-title").textContent = "Scanning…";
  leftoversBox.innerHTML = `<div class="empty-note">Searching for leftover files…</div>`;
  modal.classList.add("active");

  const res = await window.pywebview.api.get_app_leftovers(appPath);
  document.getElementById("modal-title").textContent = `Remove ${res.app_name}?`;

  const rows = [{ path: appPath, size: "" }, ...res.leftovers];
  leftoversBox.innerHTML = rows.map((f, i) => `
    <label class="leftover-row">
      <input type="checkbox" ${i === 0 ? "checked disabled" : "checked"} data-leftover="${f.path}" />
      <span class="lpath">${f.path}</span>
      <span class="lsize">${f.size}</span>
    </label>`).join("");

  const confirmBtn = document.getElementById("modal-confirm");
  const cancelBtn = document.getElementById("modal-cancel");

  const close = () => modal.classList.remove("active");
  cancelBtn.onclick = close;

  confirmBtn.onclick = async () => {
    const checked = [...leftoversBox.querySelectorAll("input[type=checkbox]:checked")]
      .map((cb) => cb.dataset.leftover)
      .filter((p) => p !== appPath);
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Moving…";
    const result = await window.pywebview.api.uninstall_app(appPath, checked);
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Move to Trash";

    if (result.failed && result.failed.length) {
      document.getElementById("modal-title").textContent = `${result.removed.length} removed, ${result.failed.length} failed`;
      document.getElementById("modal-sub").textContent =
        "These items are still in use or protected — quit the app fully (check the menu bar) and try again:";
      leftoversBox.innerHTML = result.failed.map((p) => `
        <div class="leftover-row"><span class="lpath">${p}</span></div>`).join("");
      confirmBtn.style.display = "none";
      cancelBtn.textContent = "Close";
      cancelBtn.onclick = () => { close(); confirmBtn.style.display = ""; cancelBtn.textContent = "Cancel"; refreshApps(); };
    } else {
      close();
      refreshApps();
    }
  };
}

async function refreshBigFolders() {
  const folders = await window.pywebview.api.get_big_folders();
  const list = document.getElementById("big-folders-list");
  list.innerHTML = folders.map((f) => `
    <div class="clean-row">
      <div class="meta">
        <span class="label">${f.name}</span>
        <span class="sub">${f.path}</span>
      </div>
      <div class="right">
        <span class="size">${f.size}</span>
        <button class="btn btn-ghost btn-sm" data-reveal="${f.path}">Show in Finder</button>
      </div>
    </div>`).join("");

  list.querySelectorAll("button[data-reveal]").forEach((btn) => {
    btn.addEventListener("click", () => window.pywebview.api.reveal_in_finder(btn.dataset.reveal));
  });
}

// ---------------- Quick actions: caffeinate ----------------
const caffeinateBtn = document.getElementById("caffeinate-toggle");
caffeinateBtn.addEventListener("click", async () => {
  const active = caffeinateBtn.dataset.active === "true";
  const res = await window.pywebview.api.toggle_caffeinate(!active);
  caffeinateBtn.dataset.active = res.active;
  caffeinateBtn.textContent = "Prevent Sleep: " + (res.active ? "On" : "Off");
  caffeinateBtn.className = res.active ? "btn btn-accent" : "btn btn-ghost";
});

// ---------------- Process search ----------------
let lastProcs = [];
document.getElementById("proc-search").addEventListener("input", (e) => {
  renderProcs(lastProcs, e.target.value.trim().toLowerCase());
});

// ---------------- Boot ----------------
function boot() {
  refreshOverview();
  refreshNetwork();
  refreshDiskIo();
  refreshBattery();
  refreshCores();
  refreshTopConsumers();
  setInterval(refreshOverview, 2500);
  setInterval(refreshNetwork, 2500);
  setInterval(refreshDiskIo, 2500);
  setInterval(refreshBattery, 30000);
  setInterval(refreshCores, 2000);
  setInterval(refreshTopConsumers, 3000);
  setInterval(() => {
    if (document.getElementById("tab-processes").classList.contains("active")) refreshProcesses();
  }, 3000);
}

// ---------------- Files: Screenshots ----------------
document.getElementById("screenshots-refresh").addEventListener("click", refreshScreenshots);

async function refreshScreenshots() {
  const status = document.getElementById("screenshots-status");
  const list = document.getElementById("screenshots-list");
  status.textContent = "Scanning…";
  const res = await window.pywebview.api.get_screenshots();
  if (!res.count) {
    status.textContent = "No screenshots found.";
    list.innerHTML = "";
    return;
  }
  status.textContent = `${res.count} screenshot(s), ${res.total} total.`;
  list.innerHTML = `
    <div class="clean-row">
      <div class="meta"><span class="label">All screenshots</span><span class="sub">${res.count} files · ${res.total}</span></div>
      <div class="right"><button class="btn btn-danger btn-sm" id="screenshots-trash-all">Move All to Trash</button></div>
    </div>`;
  document.getElementById("screenshots-trash-all").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Moving…";
    await window.pywebview.api.trash_paths(res.items.map((i) => i.path));
    refreshScreenshots();
  });
}

// ---------------- Files: Duplicates ----------------
document.getElementById("duplicates-refresh").addEventListener("click", async () => {
  const status = document.getElementById("duplicates-status");
  const list = document.getElementById("duplicates-list");
  status.textContent = "Scanning (this can take a moment)…";
  list.innerHTML = "";
  const res = await window.pywebview.api.get_duplicates();
  if (!res.groups.length) {
    status.textContent = "No duplicates found ✓";
    return;
  }
  const totalWaste = res.groups.reduce((s, g) => s + g.bytes * (g.files.length - 1), 0);
  status.textContent = `${res.groups.length} duplicate group(s) found.`;
  list.innerHTML = res.groups.map((g, gi) => `
    <div class="glass-card dup-group">
      <div class="dup-group-head"><span class="label">${g.size} each · ${g.files.length} copies</span></div>
      ${g.files.map((f, fi) => `
        <label class="leftover-row">
          <input type="checkbox" ${fi === 0 ? "" : "checked"} data-dup-path="${f}" />
          <span class="lpath">${f}</span>
        </label>`).join("")}
    </div>`).join("");

  const trashBtn = document.createElement("button");
  trashBtn.className = "btn btn-danger";
  trashBtn.textContent = "Move Checked to Trash";
  trashBtn.style.marginTop = "12px";
  trashBtn.addEventListener("click", async () => {
    const paths = [...list.querySelectorAll("input[data-dup-path]:checked")].map((cb) => cb.dataset.dupPath);
    trashBtn.disabled = true;
    trashBtn.textContent = "Moving…";
    await window.pywebview.api.trash_paths(paths);
    document.getElementById("duplicates-refresh").click();
  });
  list.appendChild(trashBtn);
});

// ---------------- Files: Attachments ----------------
async function refreshAttachments() {
  const res = await window.pywebview.api.get_attachments_size();
  const list = document.getElementById("attachments-list");
  list.innerHTML = res.items.map((it) => `
    <div class="clean-row">
      <div class="meta"><span class="label">${it.label}</span><span class="sub">${it.path}</span></div>
      <div class="right">
        <span class="size">${it.size}</span>
        <button class="btn btn-ghost btn-sm" data-reveal="${it.path}">Show in Finder</button>
      </div>
    </div>`).join("");
  list.querySelectorAll("button[data-reveal]").forEach((btn) => {
    btn.addEventListener("click", () => window.pywebview.api.reveal_in_finder(btn.dataset.reveal));
  });
}

// ---------------- Files: Browser caches ----------------
async function refreshBrowserCaches() {
  const res = await window.pywebview.api.get_browser_caches();
  const list = document.getElementById("browser-cache-list");
  if (!res.items.length) {
    list.innerHTML = `<div class="empty-note">No known browser caches found.</div>`;
    return;
  }
  list.innerHTML = res.items.map((it) => `
    <div class="clean-row" id="bc-${it.key}">
      <div class="meta"><span class="label">${it.label}</span></div>
      <div class="right">
        <span class="size">${it.size}</span>
        <button class="btn btn-accent btn-sm" data-bc-clean="${it.key}">Clear</button>
      </div>
    </div>`).join("");
  list.querySelectorAll("button[data-bc-clean]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      const res2 = await window.pywebview.api.clean_browser_cache(btn.dataset.bcClean);
      document.querySelector(`#bc-${btn.dataset.bcClean} .size`).textContent = res2.size;
      btn.disabled = false;
      btn.textContent = "Clear";
    });
  });
}

if (window.pywebview) {
  boot();
} else {
  window.addEventListener("pywebviewready", boot);
}
