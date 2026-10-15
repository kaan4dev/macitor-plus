# MaciTor+

A native-feeling macOS system monitor and cleanup app, built with Python ([pywebview](https://pywebview.flowrl.com/)) and a glassmorphism HTML/CSS/JS UI with native vibrancy.

## Features

- **Overview** — live CPU, memory, disk, network, disk I/O, battery, per-core usage, top resource consumers, and a plain-language "Why is my Mac slow?" diagnosis
- **Meeting Mode** — one click quits background sync apps (OneDrive, Dropbox, etc.) and frees memory before a screen share
- **Processes** — search, stop, or force-restart (kill + relaunch) any running app, including all of its subprocesses
- **Apps** — uninstaller that finds related cache/preference/support files for an app and moves everything to Trash
- **Cleanup** — one-click deep clean (caches + Homebrew + Podman + DNS), disk breakdown by category, largest folders, quick actions (restart Finder/Dock, flush DNS, prevent sleep, restart/sleep the Mac)
- **Files** — screenshot cleanup, duplicate file finder (skips `node_modules`/`venv`/build folders), Mail/Messages attachment size, per-browser cache breakdown
- **System** — device info, FileVault/Gatekeeper/Firewall status, Wi-Fi/IP, login items, Homebrew & macOS Software Update checks, VPN/Avast conflict warning, Time Machine status, Podman machine/container controls

## Requirements

- macOS
- Python 3.10+
- [Homebrew](https://brew.sh) (optional, used by a few cleanup actions)

## Setup

```bash
git clone <this-repo>
cd macitor-plus
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python main.py
```

## Packaging as a `.app`

The app can be wrapped in a minimal `.app` bundle (no Xcode required) so it shows up in
Launchpad/Applications:

```
MaciTor+.app/
  Contents/
    Info.plist
    MacOS/launcher   # shell script that execs venv/bin/python main.py
    Resources/AppIcon.icns
```

## License

MIT — see [LICENSE](LICENSE).
