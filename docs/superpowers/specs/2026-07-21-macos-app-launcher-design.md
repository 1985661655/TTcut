# TTcut macOS Local App Launcher Design

## Goal

Install a local-only `/Applications/TTcut.app` that starts the existing Apple
Silicon development checkout by double-clicking an icon. The launcher must run
without opening Terminal, reuse the already installed Python/model/FFmpeg
dependencies, and provide useful diagnostics when startup fails.

This is not a distributable macOS release. It intentionally depends on this
Mac's existing checkout and development environment. Bundling Python, PyTorch,
FFmpeg, the model, code signing, and notarization remain future work.

## Chosen Approach

Build a small native macOS app bundle whose executable is a shell launcher. An
installer script in the repository creates or replaces the bundle, its
`Info.plist`, executable, and ping-pong icon under `/Applications/TTcut.app`.

This approach is preferred over Automator because it gives the project explicit
control over validation, logging, and duplicate-start behavior. It is preferred
over packaging Electron because the current packaged-mode component resolver
does not use development-only external Python and model paths.

## Installed Bundle

The app bundle contains only the launcher and icon. It does not copy application
source or runtime dependencies.

- Install location: `/Applications/TTcut.app`
- Bundle identifier: `com.weiye.ttcut.local-launcher`
- Display name: `TTcut`
- Launcher process: hidden UI accessory that exits after starting TTcut
- Project checkout: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port`
- Python: `<project>/.venv312/bin/python`
- TrackNet weights: `/Users/xkkx6/Downloads/TrackNet_best.pt`
- FFmpeg: `/opt/homebrew/bin/ffmpeg`
- ffprobe: `/opt/homebrew/bin/ffprobe`

The absolute paths are deliberate because this first version is for one Mac.
Re-running the installer updates the bundle if any path changes later.

## Startup Flow

1. Finder or Launchpad starts `/Applications/TTcut.app`.
2. The launcher creates `~/Library/Logs/TTcut` and
   `~/Library/Application Support/TTcut` when needed.
3. It reads the stored PID. A live process causes a Chinese "TTcut is already
   running" notification and no second instance is started. A stale PID file is
   removed.
4. It validates the project directory, `package.json`, `node_modules`, npm,
   Python, TrackNet weights, FFmpeg, and ffprobe.
5. It constructs a Finder-safe `PATH` including Apple Silicon Homebrew and sets
   `TTCUT_PYTHON`, `TTCUT_TRACKNET_WEIGHTS`, `TTCUT_FFMPEG`, and
   `TTCUT_FFPROBE`.
6. It starts `npm start` from the project root as a detached background process,
   writes that process ID, and appends stdout/stderr to the launcher log.
7. The launcher briefly checks that the process stayed alive. On success the
   Electron TTcut window opens normally and the launcher exits.

The PID file tracks the long-lived `npm start` process. Normal application exit
ends that process; the next launch treats the remaining PID file as stale.

## Logging And Errors

Logs are appended to `~/Library/Logs/TTcut/launcher.log`, with a timestamp and
environment summary for each launch. When the log exceeds 5 MB, the launcher
rotates it once to `launcher.log.previous`.

Validation or immediate startup failures show a Chinese macOS dialog naming the
missing dependency and the log location. The dialog offers to open the log in
the default text editor. Successful launches do not display extra notifications.

Paths and shell values are quoted so spaces and Chinese characters in the
project path remain valid. The log must not contain secrets; only dependency
paths, versions, and process output are recorded.

## Repository Changes

- Add a versioned launcher template with dependency checks and startup logic.
- Add an idempotent installer that builds the app bundle under `/Applications`.
- Add a source icon and generate the `.icns` asset during installation or keep a
  generated `.icns` in the launcher resources.
- Document installation, launch, log location, updating, and removal in the Mac
  development section of the README.

The installer must not alter Python environments, download packages, move model
weights, or terminate an already running TTcut instance.

## Verification

Automated shell tests exercise validation, stale/live PID handling, environment
construction, log rotation, and detached command construction using temporary
directories and stub executables. They must not launch Electron or write to
`/Applications`.

An installer smoke test builds a bundle in a temporary destination and verifies
its `Info.plist`, executable permission, icon, and expected files. Final manual
verification installs `/Applications/TTcut.app`, opens it through macOS, confirms
that no Terminal window appears, checks the TTcut window opens, and verifies a
second click does not create another instance.

Existing TypeScript and Python test suites continue to run because the launcher
must not change TTcut's application behavior.
