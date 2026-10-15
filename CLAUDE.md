# CLAUDE.md

Guidance for Claude Code (or any agent) working in this repo.

## What this is

MaciTor+ — a native-feeling macOS system monitor, cleanup, and uninstaller app. Python backend
(`main.py`) exposes a `pywebview.Api` subclass to a local HTML/CSS/JS frontend (`web/`) rendered
in a native `WKWebView` with real OS vibrancy. No Electron, no server, no telemetry.

## Architecture

- `main.py` — single `Api` class. Every method on it is callable from JS as
  `window.pywebview.api.<method_name>(...)` (pywebview auto-bridges this). All system interaction
  (shell commands, psutil, file I/O) lives here — the frontend never touches the filesystem or
  shells out directly.
- `web/index.html` / `web/style.css` / `web/app.js` — the UI. Tabs are `<section class="tab">`
  elements toggled by `.nav-item` clicks in `app.js`; each tab has a `refresh*()` function called
  on tab-open and/or on a `setInterval` poll from `boot()`.
- `web/vendor/chart.umd.min.js` — Chart.js, vendored (not CDN) so the app works offline.

## Non-negotiable conventions

- **Destructive actions always go through Trash, never permanent delete.** See `_trash_move()` —
  every cleanup/uninstall/duplicate-removal path routes through it (or `trash_paths()` /
  `uninstall_app()` which wrap it). If you add a new delete-ish feature, reuse this pattern; don't
  call `os.remove`/`shutil.rmtree` directly on user files.
- **Confirm before destroying.** The uninstaller and duplicate-finder show the user exactly what
  was found (with sizes) before anything moves. Don't add silent bulk-delete actions.
- **UI language is English.** All user-facing strings in `web/*.html`/`web/*.js` and any
  `main.py` strings that reach the UI (e.g. `notify()` messages) must be English — this was a
  deliberate full-app translation pass, don't reintroduce Turkish strings.
- **Admin-privileged shell commands** go through `osascript -e 'do shell script "..." with
  administrator privileges'`, always with `shlex.quote()` on interpolated paths (see
  `_force_move_admin`, `quick_action`'s `flush_dns`, `install_software_update`). Never shell out
  with unescaped user-influenced strings.
- **Killing stuck apps**: `force_restart_app()` resolves the owning `.app` bundle from the PID's
  executable path, then `pkill -9 -f <bundle_path>` to catch every helper process under that
  bundle (not just the one PID), then relaunches with `open`. `uninstall_app()` uses the same
  bundle-wide kill before moving files, plus unloads matching LaunchAgents first — security/sync
  apps (Avast-style) otherwise recreate their support files mid-uninstall.
- **Duplicate finder excludes dev directories** (`DUPLICATE_EXCLUDE_DIRS` in `main.py`:
  `node_modules`, `venv`, `.git`, `site-packages`, build output dirs, …). Without this it surfaces
  false "duplicates" inside project dependency trees that are dangerous to bulk-delete. Keep this
  list if you touch `get_duplicates()`.
- **`dir_size()` uses a 60s timeout** on `du -sk` — large folders (`~/Library`, node_modules
  trees) can legitimately take a while. Don't drop this back to a short timeout; it silently
  returns 0 and under-reports size when it expires.

## Design system

- Dark glassmorphism: `--surface` translucent cards + `backdrop-filter: blur()`, real
  `NSVisualEffectView` vibrancy behind the transparent webview (`vibrancy=True, transparent=True`
  in `webview.create_window`, plus `background: transparent` / `systemTransparent`-equivalent in
  CSS).
- Accent color is "parliament blue" (`--accent: #1e3a8a`, `--accent-2: #3454b4`) — deliberate
  choice, don't revert to the earlier sky-blue.
- Status colors: green/amber/red via `levelColor()` in `app.js`, consistent across CPU/RAM/disk
  tiles, core bars, and the diagnosis card.
- Buttons use cubic-bezier transitions (`cubic-bezier(0.34, 1.56, 0.64, 1)` for a slight
  overshoot on hover, `cubic-bezier(0.4, 0, 0.2, 1)` for fades) — keep new interactive elements
  consistent with this, don't fall back to plain `ease`.
- Sparklines (`Sparkline`/`makeSpark`/`makeDualSpark` in `app.js`) are fixed-height
  (`.spark-wrap { height: 56px }`) — Chart.js `responsive: true` + `maintainAspectRatio: false`
  needs an explicitly-sized parent or it balloons to fill the grid row. If you add a new chart,
  wrap the canvas the same way.

## Running / testing

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python main.py
```

There's no test suite — this is a personal utility app. Sanity-check a change by running it
directly (`python main.py`) and clicking through the affected tab; for backend-only logic you can
also import and call `Api` methods directly from a `python -c` one-liner (see conversation history
for examples — e.g. `from main import Api; Api().get_duplicates()`).

## Packaging as a `.app`

No Xcode needed. A `.app` bundle is just:

```
MaciTor+.app/Contents/
  Info.plist          # CFBundleExecutable=launcher, CFBundleIconFile=AppIcon
  MacOS/launcher       # exec <path-to-venv>/bin/python <path-to>/main.py
  Resources/AppIcon.icns
```

Build the icon from a 1024×1024 PNG with `sips` (resize to the standard iconset sizes) +
`iconutil -c icns`.

## Known-sharp-edges

- `psutil.cpu_percent()` per-process needs two samples to be meaningful; since `process_iter`
  reuses `Process` objects across calls, this is fine as long as something is already polling
  (the 2.5–3s intervals in `boot()`) before you call a one-off diagnostic like `get_diagnosis()`.
- `purge` (used in `activate_meeting_mode`) requires admin privileges on current macOS — it's
  invoked via the same `osascript ... with administrator privileges` pattern, which will prompt
  the user for a password every time (expected, not a bug).
- WKWebView logs a harmless `-[WKWebView _setDrawsTransparentBackground:] is deprecated` warning
  on launch — ignore it, it doesn't affect vibrancy.
