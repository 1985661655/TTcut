# TTcut macOS Local App Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a local `/Applications/TTcut.app` that launches the existing Apple Silicon development checkout in the background with dependency checks, logs, and duplicate-instance protection.

**Architecture:** A focused Zsh launcher owns runtime validation, PID handling, log rotation, environment construction, and detached `npm start`. A separate idempotent installer creates a conventional macOS app bundle, writes a path configuration file, and converts a source PNG into `.icns`; Vitest drives both scripts through temporary directories and stub executables.

**Tech Stack:** Zsh, macOS app bundles and `Info.plist`, `sips`, `iconutil`, Vitest/Node `child_process`, Electron Forge development runtime.

---

## File Map

- `scripts/macos-launcher/launcher.zsh`: executable copied into the app bundle; validates dependencies, manages logs/PID, displays errors, and starts TTcut.
- `scripts/install-macos-launcher.zsh`: creates or replaces the app bundle and generates its configuration and icon.
- `resources/macos/ttcut-launcher-icon.png`: 1024x1024 source artwork for the local app icon.
- `tests/macos-launcher.test.ts`: integration-style shell tests using temporary app/data directories and stub commands.
- `package.json`: exposes the repeatable `npm run install:macos-launcher` command.
- `README.md`: documents local installation, updating, logs, and removal.

### Task 1: Launcher Runtime Contract

**Files:**
- Create: `scripts/macos-launcher/launcher.zsh`
- Create: `tests/macos-launcher.test.ts`

- [ ] **Step 1: Write failing validation and environment tests**

Create a macOS-only Vitest suite that writes a temporary `launcher.conf`, fake project, and executable stubs. Invoke the launcher with isolated `HOME`, `TTCUT_LAUNCHER_CONFIG`, and `TTCUT_LAUNCHER_NO_UI=1`.

```ts
const runLauncher = (env: NodeJS.ProcessEnv = {}) => spawnSync('/bin/zsh', [launcherPath], {
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: tempHome,
    TTCUT_LAUNCHER_CONFIG: configPath,
    TTCUT_LAUNCHER_NO_UI: '1',
    TTCUT_LAUNCHER_STARTUP_WAIT: '0.1',
    ...env,
  },
});

it.runIf(process.platform === 'darwin')('reports a missing model before starting npm', () => {
  rmSync(weightsPath);
  const result = runLauncher();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('TrackNet 模型不存在');
  expect(readFileSync(npmCallsPath, 'utf8')).toBe('');
});

it.runIf(process.platform === 'darwin')('passes local component paths to npm start', () => {
  const result = runLauncher();
  expect(result.status).toBe(0);
  const call = readFileSync(npmCallsPath, 'utf8');
  expect(call).toContain('start');
  expect(call).toContain(`TTCUT_PYTHON=${pythonPath}`);
  expect(call).toContain(`TTCUT_TRACKNET_WEIGHTS=${weightsPath}`);
  expect(call).toContain(`TTCUT_FFMPEG=${ffmpegPath}`);
  expect(call).toContain(`TTCUT_FFPROBE=${ffprobePath}`);
});
```

Add cases for a missing project, missing `node_modules`, missing npm, missing Python, missing FFmpeg/ffprobe, and paths containing spaces and Chinese characters.

- [ ] **Step 2: Run the focused suite and verify RED**

Run: `npx vitest run tests/macos-launcher.test.ts`

Expected: FAIL because `scripts/macos-launcher/launcher.zsh` does not exist.

- [ ] **Step 3: Implement config loading and dependency validation**

The launcher must use strict shell mode, a Finder-safe path, and explicit readable/executable checks. It accepts test overrides but uses the app bundle configuration in production.

```zsh
#!/bin/zsh
set -eu
set -o pipefail

SELF_DIR="${0:A:h}"
CONFIG_FILE="${TTCUT_LAUNCHER_CONFIG:-$SELF_DIR/../Resources/launcher.conf}"
NO_UI="${TTCUT_LAUNCHER_NO_UI:-0}"
STARTUP_WAIT="${TTCUT_LAUNCHER_STARTUP_WAIT:-2}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

fail() {
  local message="$1"
  print -u2 -- "$message"
  append_log "启动失败：$message"
  show_error_dialog "$message"
  exit 1
}

[[ -r "$CONFIG_FILE" ]] || fail "启动器配置不存在：$CONFIG_FILE"
source "$CONFIG_FILE"
[[ -d "$PROJECT_DIR" ]] || fail "TTcut 项目目录不存在：$PROJECT_DIR"
[[ -f "$PROJECT_DIR/package.json" ]] || fail "项目缺少 package.json：$PROJECT_DIR"
[[ -d "$PROJECT_DIR/node_modules" ]] || fail "项目依赖尚未安装，请先在项目目录运行 npm install。"
[[ -x "$NPM_PATH" ]] || fail "找不到 npm：$NPM_PATH"
[[ -x "$PYTHON_PATH" ]] || fail "Python 环境不存在：$PYTHON_PATH"
[[ -f "$WEIGHTS_PATH" ]] || fail "TrackNet 模型不存在：$WEIGHTS_PATH"
[[ -x "$FFMPEG_PATH" ]] || fail "FFmpeg 不存在：$FFMPEG_PATH"
[[ -x "$FFPROBE_PATH" ]] || fail "ffprobe 不存在：$FFPROBE_PATH"
```

Configuration variable names are exactly `PROJECT_DIR`, `NPM_PATH`, `PYTHON_PATH`, `WEIGHTS_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH`.

- [ ] **Step 4: Run focused tests and verify validation is GREEN**

Run: `npx vitest run tests/macos-launcher.test.ts`

Expected: dependency and environment cases PASS; PID/log cases added next remain absent.

- [ ] **Step 5: Write failing PID, detached-start, and log-rotation tests**

Add tests that place a live `sleep` PID in the PID file and assert npm is not called, place a dead PID and assert startup proceeds, make a fake npm exit immediately and assert an error, and prefill a log larger than 5 MB and assert one rotation.

```ts
it('does not start a second instance while the recorded PID is alive', () => {
  const sleeper = spawn('sleep', ['30']);
  writeFileSync(pidPath, `${sleeper.pid}\n`);
  const result = runLauncher();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('TTcut 已经在运行');
  expect(readFileSync(npmCallsPath, 'utf8')).toBe('');
  sleeper.kill();
});

it('rotates a launcher log larger than 5 MB once', () => {
  writeFileSync(logPath, Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  expect(runLauncher().status).toBe(0);
  expect(existsSync(`${logPath}.previous`)).toBe(true);
  expect(statSync(logPath).size).toBeLessThan(5 * 1024 * 1024);
});
```

- [ ] **Step 6: Implement PID, log, UI, and detached launch behavior**

Use `~/Library/Application Support/TTcut/launcher.pid` and `~/Library/Logs/TTcut/launcher.log`, allowing `TTCUT_LAUNCHER_STATE_DIR` and `TTCUT_LAUNCHER_LOG_DIR` overrides in tests. Rotate once before appending. For live duplicate PIDs, write the message and optionally use `osascript` notification. On validation/startup errors, use an `osascript` dialog with buttons `好` and `查看日志`; choosing the latter opens the log.

Production startup must detach through `nohup` while preserving every path as an argument rather than interpolating it into executable shell text:

```zsh
/usr/bin/nohup /bin/zsh -c '
  project_dir="$1"
  shift
  cd "$project_dir" || exit 1
  exec "$@"
' _ "$PROJECT_DIR" /usr/bin/env \
  "PATH=$PATH" \
  "TTCUT_PYTHON=$PYTHON_PATH" \
  "TTCUT_TRACKNET_WEIGHTS=$WEIGHTS_PATH" \
  "TTCUT_FFMPEG=$FFMPEG_PATH" \
  "TTCUT_FFPROBE=$FFPROBE_PATH" \
  "$NPM_PATH" start >>"$LOG_FILE" 2>&1 </dev/null &

app_pid=$!
print -- "$app_pid" > "$PID_FILE"
sleep "$STARTUP_WAIT"
kill -0 "$app_pid" 2>/dev/null || fail "TTcut 未能启动，请查看日志：$LOG_FILE"
```

Test stubs record arguments and exported variables before sleeping long enough for the startup check. Tests always terminate spawned fake processes during cleanup.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/macos-launcher.test.ts`

Expected: all macOS launcher runtime tests PASS.

```bash
git add scripts/macos-launcher/launcher.zsh tests/macos-launcher.test.ts
git commit -m "feat: add macos launcher runtime"
```

### Task 2: Idempotent App Bundle Installer And Icon

**Files:**
- Modify: `tests/macos-launcher.test.ts`
- Create: `scripts/install-macos-launcher.zsh`
- Create: `resources/macos/ttcut-launcher-icon.png`

- [ ] **Step 1: Write failing installer smoke tests**

Run the installer into a temporary destination with explicit source paths. Verify the bundle contract and run it twice to prove replacement is idempotent.

```ts
const install = () => spawnSync('/bin/zsh', [installerPath], {
  encoding: 'utf8',
  env: {
    ...process.env,
    TTCUT_APP_DESTINATION: appDestination,
    TTCUT_PROJECT_DIR: projectRoot,
    TTCUT_PYTHON_PATH: pythonPath,
    TTCUT_WEIGHTS_PATH: weightsPath,
    TTCUT_FFMPEG_PATH: ffmpegPath,
    TTCUT_FFPROBE_PATH: ffprobePath,
    TTCUT_NPM_PATH: npmPath,
  },
});

expect(install().status).toBe(0);
expect(install().status).toBe(0);
expect(accessSync(join(appDestination, 'Contents/MacOS/TTcutLauncher'), constants.X_OK)).toBeUndefined();
expect(readFileSync(join(appDestination, 'Contents/Info.plist'), 'utf8')).toContain('com.weiye.ttcut.local-launcher');
expect(readFileSync(join(appDestination, 'Contents/Resources/launcher.conf'), 'utf8')).toContain(projectRoot);
expect(statSync(join(appDestination, 'Contents/Resources/TTcut.icns')).size).toBeGreaterThan(0);
```

- [ ] **Step 2: Run the focused suite and verify RED**

Run: `npx vitest run tests/macos-launcher.test.ts`

Expected: FAIL because the installer and icon do not exist.

- [ ] **Step 3: Create the 1024x1024 source icon**

Generate a clean square TTcut icon with a table-tennis paddle and white ball, high contrast at small sizes, no text, no transparency outside the rounded app-icon artwork, and no photographic background. Save the final 1024x1024 PNG at `resources/macos/ttcut-launcher-icon.png` and inspect it at both full size and 64x64.

- [ ] **Step 4: Implement the installer**

Use strict Zsh mode. Defaults target this Mac while environment variables support testing and future relocation:

```zsh
PROJECT_DIR="${TTCUT_PROJECT_DIR:-/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port}"
APP_DESTINATION="${TTCUT_APP_DESTINATION:-/Applications/TTcut.app}"
PYTHON_PATH="${TTCUT_PYTHON_PATH:-$PROJECT_DIR/.venv312/bin/python}"
WEIGHTS_PATH="${TTCUT_WEIGHTS_PATH:-/Users/xkkx6/Downloads/TrackNet_best.pt}"
FFMPEG_PATH="${TTCUT_FFMPEG_PATH:-/opt/homebrew/bin/ffmpeg}"
FFPROBE_PATH="${TTCUT_FFPROBE_PATH:-/opt/homebrew/bin/ffprobe}"
NPM_PATH="${TTCUT_NPM_PATH:-/opt/homebrew/bin/npm}"
```

Build in a sibling temporary directory and only replace the destination after every file and icon conversion succeeds. The installer writes an XML `Info.plist` with `CFBundleExecutable=TTcutLauncher`, `CFBundleIconFile=TTcut`, `CFBundleIdentifier=com.weiye.ttcut.local-launcher`, and `LSUIElement=true`. It copies the launcher executable, writes shell-escaped configuration values using `${(q)value}`, generates all standard iconset sizes with `sips`, and runs `iconutil -c icns`.

Validate source dependencies before replacing the existing app. Print the installed path and log path on success. Preserve an already running TTcut process.

- [ ] **Step 5: Run installer tests and commit**

Run: `npx vitest run tests/macos-launcher.test.ts`

Expected: launcher and installer tests PASS, including two consecutive installs.

```bash
git add scripts/install-macos-launcher.zsh resources/macos/ttcut-launcher-icon.png tests/macos-launcher.test.ts
git commit -m "feat: install local macos app launcher"
```

### Task 3: Developer Command And Documentation

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add the installer npm command**

Add one script without changing existing packaging commands:

```json
"install:macos-launcher": "zsh scripts/install-macos-launcher.zsh"
```

- [ ] **Step 2: Document the one-click launcher**

Under the Apple Silicon source-running section, document:

```zsh
npm run install:macos-launcher
open /Applications/TTcut.app
```

State that it is local-only, launches in the background, depends on this checkout, writes `~/Library/Logs/TTcut/launcher.log`, can be refreshed by rerunning the installer, and can be removed with:

```zsh
rm -rf /Applications/TTcut.app
```

Also state that changing the project, model, Python, or FFmpeg path requires rerunning the installer with the corresponding `TTCUT_*` environment override.

- [ ] **Step 3: Run static and focused verification**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npx vitest run tests/macos-launcher.test.ts`

Expected: all launcher tests PASS.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "docs: add macos launcher installation"
```

### Task 4: Install And End-To-End Verification

**Files:**
- No repository changes expected.

- [ ] **Step 1: Run the complete automated suites**

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm test`

Expected: all applicable Vitest tests PASS; existing platform-specific skips remain documented.

Run: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -m pytest worker/tests -q`

Expected: all Python worker tests PASS.

- [ ] **Step 2: Synchronize the local launch checkout**

After commits are pushed to the existing remote development branch, fast-forward `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port` so the launcher opens the reviewed code. Do not update while an active TTcut analysis or export is running.

Run: `git -C /Users/xkkx6/Documents/TTcut-apple-silicon-dev-port pull --ff-only`

Expected: local `codex/apple-silicon-dev-port` reaches the pushed launcher commit with no merge commit.

- [ ] **Step 3: Install the app bundle**

Run: `npm run install:macos-launcher`

Expected: `/Applications/TTcut.app` exists with executable launcher, icon, config, and `Info.plist`.

- [ ] **Step 4: Verify Finder-style launch**

Run: `open /Applications/TTcut.app`

Expected: the TTcut Electron window opens, no Terminal window appears, and the launcher log records the dependency paths and successful background start.

- [ ] **Step 5: Verify duplicate protection**

Run: `open /Applications/TTcut.app`

Expected: no second Electron/Forge process appears, and the launcher records or reports `TTcut 已经在运行`.

- [ ] **Step 6: Verify app health and repository cleanliness**

Confirm the Settings page includes Batch 4/8/12/16, component self-check succeeds, and no analysis is started during smoke testing. Then run:

```bash
git status --short
git diff --check codex/apple-silicon-dev-port...HEAD
```

Expected: clean worktree and no whitespace errors.
