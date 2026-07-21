import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const launcher = join(process.cwd(), 'scripts/macos-launcher/launcher.zsh');
const SAFE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const fixtures: Fixture[] = [];

interface Fixture {
  root: string;
  home: string;
  project: string;
  config: string;
  state: string;
  logs: string;
  npm: string;
  python: string;
  weights: string;
  ffmpeg: string;
  ffprobe: string;
  osascript: string;
  capture: string;
  npmCalls: string;
}

function executable(path: string, contents = '#!/bin/zsh\nexit 0\n'): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ttcut launcher '));
  const home = join(root, 'home');
  const project = join(root, '项目 space');
  const bin = join(root, 'bin space');
  const pythonBin = join(root, 'python bin');
  const state = join(root, 'state');
  const logs = join(root, 'logs');
  mkdirSync(join(project, 'node_modules'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(pythonBin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"launcher-test"}\n');

  const fixture: Fixture = {
    root,
    home,
    project,
    config: join(root, 'launcher.conf'),
    state,
    logs,
    npm: join(bin, 'npm'),
    python: join(pythonBin, 'python'),
    weights: join(root, 'TrackNet 权重.pt'),
    ffmpeg: join(bin, 'ffmpeg'),
    ffprobe: join(bin, 'ffprobe'),
    osascript: join(bin, 'osascript'),
    capture: join(root, 'captured-env'),
    npmCalls: join(root, 'npm-calls'),
  };

  executable(fixture.npm, `#!/bin/zsh
root=\${\${0:h}:h}
print -r -- "$PATH" > "$root/captured-env.path"
print -r -- "$TTCUT_PYTHON" > "$root/captured-env.python"
print -r -- "$TTCUT_TRACKNET_WEIGHTS" > "$root/captured-env.weights"
print -r -- "$TTCUT_FFMPEG" > "$root/captured-env.ffmpeg"
print -r -- "$TTCUT_FFPROBE" > "$root/captured-env.ffprobe"
print -r -- "\${TTCUT_LAUNCHER_LOCKED-unset}" > "$root/captured-env.locked"
print -r -- "$0 $*" > "$root/captured-env.argv"
print -r -- called >> "$root/npm-calls"
print -r -- "$$" >> "$root/npm-pids"
if [[ -f "$root/force-pid-write-failure" ]]; then
  /bin/sleep 60 &
  descendant=$!
  print -r -- "$$" > "$root/failure-parent.pid"
  print -r -- "$descendant" > "$root/failure-child.pid"
  mkdir "$root/state/launcher.pid"
  trap 'exit 0' TERM INT
  wait "$descendant"
  exit 0
fi
if [[ -f "$root/exit-immediately" ]]; then
  exit 42
fi
zmodload zsh/zselect
trap 'exit 0' TERM INT
while true; do zselect -t 6000; done
`);
  executable(fixture.python, '#!/bin/zsh\nexec /usr/bin/python3 "$@"\n');
  executable(fixture.ffmpeg);
  executable(fixture.ffprobe);
  executable(fixture.osascript, `#!/bin/zsh
root=\${\${0:h}:h}
print -rl -- "$@" > "$root/osascript-args"
/bin/cat > "$root/osascript-stdin"
`);
  writeFileSync(fixture.weights, 'weights');
  writeConfig(fixture);
  fixtures.push(fixture);
  return fixture;
}

function writeConfig(fixture: Fixture, overrides: Partial<Record<ConfigKey, string>> = {}): void {
  const config: Record<ConfigKey, string> = {
    PROJECT_DIR: fixture.project,
    NPM_PATH: fixture.npm,
    PYTHON_PATH: fixture.python,
    WEIGHTS_PATH: fixture.weights,
    FFMPEG_PATH: fixture.ffmpeg,
    FFPROBE_PATH: fixture.ffprobe,
    ...overrides,
  };
  writeFileSync(fixture.config, `${Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

type ConfigKey = 'PROJECT_DIR' | 'NPM_PATH' | 'PYTHON_PATH' | 'WEIGHTS_PATH' | 'FFMPEG_PATH' | 'FFPROBE_PATH';

function launcherEnv(fixture: Fixture, env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fixture.home,
    TTCUT_LAUNCHER_CONFIG: fixture.config,
    TTCUT_LAUNCHER_STATE_DIR: fixture.state,
    TTCUT_LAUNCHER_LOG_DIR: fixture.logs,
    TTCUT_LAUNCHER_NO_UI: '1',
    TTCUT_LAUNCHER_STARTUP_WAIT: '0.2',
    ...env,
  };
}

function run(fixture: Fixture, env: Record<string, string> = {}) {
  return spawnSync('/bin/zsh', [launcher], { encoding: 'utf8', env: launcherEnv(fixture, env) });
}

function runAsync(fixture: Fixture, env: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  const child = spawn('/bin/zsh', [launcher], { env: launcherEnv(fixture, env), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolve) => child.on('close', (status) => resolve({ status, stderr })));
}

function processState(pid: number): string {
  return spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

function processFingerprint(pid: number): string {
  return spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.replace(/\n$/, '');
}

function terminatePid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = processState(pid);
    if (!state || state.startsWith('Z')) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = processState(pid);
    if (!state || state.startsWith('Z')) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(`fake npm process ${pid} survived TERM and KILL`);
}

function cleanup(fixture: Fixture): void {
  const pidFile = join(fixture.state, 'launcher.pid');
  if (existsSync(pidFile) && statSync(pidFile).isFile()) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) {
      terminatePid(pid);
    }
  }
  for (const name of ['failure-parent.pid', 'failure-child.pid']) {
    const processFile = join(fixture.root, name);
    if (!existsSync(processFile)) continue;
    const pid = Number.parseInt(readFileSync(processFile, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0 && processState(pid)) terminatePid(pid);
  }
  const npmPidsFile = join(fixture.root, 'npm-pids');
  if (existsSync(npmPidsFile)) {
    const npmPids = new Set(readFileSync(npmPidsFile, 'utf8').trim().split('\n').map(Number));
    for (const pid of npmPids) {
      if (Number.isInteger(pid) && pid > 0 && processState(pid)) terminatePid(pid);
    }
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForCondition(
      () => child.exitCode !== null || child.signalCode !== null,
      'test child process cleanup',
    );
  } catch {
    child.kill('SIGKILL');
    await waitForCondition(
      () => child.exitCode !== null || child.signalCode !== null,
      'test child process KILL cleanup',
    );
  }
}

function expectNpmNotStarted(fixture: Fixture): void {
  expect(existsSync(fixture.npmCalls)).toBe(false);
}

async function waitForFiles(paths: string[], description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path) && readFileSync(path, 'utf8').trim().length > 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const missing = paths.filter((path) => !existsSync(path) || readFileSync(path, 'utf8').trim().length === 0);
  throw new Error(`${description} timed out after 2000ms; incomplete files: ${missing.join(', ')}`);
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${description} timed out after 2000ms`);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanup(fixture);
});

const macIt = process.platform === 'darwin' ? it : it.skip;

describe('macOS launcher', () => {
  macIt('compiles the error dialog AppleScript', () => {
    const source = readFileSync(launcher, 'utf8');
    const match = source.match(/<<'APPLESCRIPT'[^\n]*\n([\s\S]*?)\nAPPLESCRIPT/);
    const compileRoot = mkdtempSync(join(tmpdir(), 'ttcut applescript '));
    const output = join(compileRoot, 'launcher-dialog.scpt');
    expect(match?.[1]).toBeTruthy();
    try {
      const result = spawnSync('/usr/bin/osacompile', ['-o', output, '-e', match?.[1] ?? ''], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(output)).toBe(true);
      expect(existsSync(join(process.cwd(), 'a.scpt'))).toBe(false);
    } finally {
      rmSync(compileRoot, { recursive: true, force: true });
    }
  });

  macIt('uses the injected osascript for an error dialog', async () => {
    const fixture = makeFixture();
    const result = run(fixture, {
      TTCUT_LAUNCHER_CONFIG: join(fixture.root, 'missing.conf'),
      TTCUT_LAUNCHER_NO_UI: '',
      TTCUT_LAUNCHER_OSASCRIPT: fixture.osascript,
    });

    expect(result.status).toBe(1);
    await waitForFiles([join(fixture.root, 'osascript-args'), join(fixture.root, 'osascript-stdin')], 'error osascript invocation');
    expect(readFileSync(join(fixture.root, 'osascript-args'), 'utf8')).toContain('无法读取启动器配置文件');
    expect(readFileSync(join(fixture.root, 'osascript-stdin'), 'utf8')).toContain('查看日志');
  });

  macIt('rejects an unreadable configuration before npm starts', () => {
    const fixture = makeFixture();
    const result = run(fixture, { TTCUT_LAUNCHER_CONFIG: join(fixture.root, 'missing.conf') });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法读取启动器配置文件');
    expectNpmNotStarted(fixture);
  });

  macIt('reports a malformed configuration only once', () => {
    const fixture = makeFixture();
    writeFileSync(fixture.config, 'not-an-assignment\n');
    const result = run(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr.match(/启动器配置格式无效。/g)).toHaveLength(1);
    expectNpmNotStarted(fixture);
  });

  macIt('reports a state or log directory initialization failure without npm', () => {
    const fixture = makeFixture();
    writeFileSync(fixture.logs, 'not a directory');
    const result = run(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法创建 TTcut 状态或日志目录');
    expectNpmNotStarted(fixture);
  });

  macIt.each([
    ['project directory', 'PROJECT_DIR', '项目不存在'],
    ['package.json', 'PROJECT_DIR', '缺少 package.json'],
    ['node_modules', 'PROJECT_DIR', '缺少 node_modules'],
    ['npm', 'NPM_PATH', '找不到或无法执行 npm'],
    ['Python', 'PYTHON_PATH', '找不到或无法执行 Python'],
    ['TrackNet weights', 'WEIGHTS_PATH', '找不到 TrackNet 权重'],
    ['FFmpeg', 'FFMPEG_PATH', '找不到或无法执行 FFmpeg'],
    ['ffprobe', 'FFPROBE_PATH', '找不到或无法执行 ffprobe'],
  ] as const)('rejects missing %s before npm starts', (_name, key, message) => {
    const fixture = makeFixture();
    if (message === '缺少 package.json') rmSync(join(fixture.project, 'package.json'));
    else if (message === '缺少 node_modules') rmSync(join(fixture.project, 'node_modules'), { recursive: true });
    else writeConfig(fixture, { [key]: join(fixture.root, 'missing path') } as Partial<Record<ConfigKey, string>>);

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expectNpmNotStarted(fixture);
  });

  macIt('starts npm from a path with spaces and Chinese characters and passes the runtime environment', async () => {
    const fixture = makeFixture();
    const result = run(fixture);

    expect(result.status).toBe(0);
    await waitForFiles([
      `${fixture.capture}.path`,
      `${fixture.capture}.python`,
      `${fixture.capture}.weights`,
      `${fixture.capture}.ffmpeg`,
      `${fixture.capture}.ffprobe`,
      `${fixture.capture}.locked`,
      `${fixture.capture}.argv`,
      fixture.npmCalls,
    ], 'npm environment capture');
    expect(readFileSync(`${fixture.capture}.path`, 'utf8').trim()).toBe(`${dirname(fixture.npm)}:${dirname(fixture.python)}:${SAFE_PATH}`);
    expect(readFileSync(`${fixture.capture}.python`, 'utf8').trim()).toBe(fixture.python);
    expect(readFileSync(`${fixture.capture}.weights`, 'utf8').trim()).toBe(fixture.weights);
    expect(readFileSync(`${fixture.capture}.ffmpeg`, 'utf8').trim()).toBe(fixture.ffmpeg);
    expect(readFileSync(`${fixture.capture}.ffprobe`, 'utf8').trim()).toBe(fixture.ffprobe);
    expect(readFileSync(`${fixture.capture}.locked`, 'utf8').trim()).toBe('unset');
    expect(readFileSync(`${fixture.capture}.argv`, 'utf8')).toContain(' start');
    const pidRecord = readFileSync(join(fixture.state, 'launcher.pid'), 'utf8').trim();
    expect(pidRecord).toMatch(/^\d+\t.+$/);
    const npmPid = Number.parseInt(pidRecord, 10);
    const npmPgid = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(npmPid)], { encoding: 'utf8' }).stdout.trim();
    expect(npmPgid).toBe(String(npmPid));
    expect(readFileSync(join(fixture.logs, 'launcher.log'), 'utf8')).toContain('环境摘要');
  });

  macIt('accepts raw configuration paths containing O\'Brien, spaces, and Chinese characters', async () => {
    const fixture = makeFixture();
    const project = join(fixture.root, "O'Brien 项目 space");
    mkdirSync(join(project, 'node_modules'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{"name":"quote-path"}\n');
    writeConfig(fixture, { PROJECT_DIR: project });

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation with raw configuration path');
    expect(readFileSync(fixture.config, 'utf8')).toContain(`PROJECT_DIR=${project}`);
  });

  macIt('does not start another npm process while the pid file is live', async () => {
    const fixture = makeFixture();
    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'first npm invocation');
    const lockProbe = spawnSync(
      '/usr/bin/lockf',
      ['-s', '-t', '0', '-k', join(fixture.state, 'launcher.lock'), '/usr/bin/true'],
    );
    expect(lockProbe.status).toBe(0);
    expect(run(fixture).status).toBe(0);

    expect(readFileSync(fixture.npmCalls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  macIt('serializes sixteen launchers despite forged TTCUT_LAUNCHER_LOCKED values', async () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    const lockFile = join(fixture.state, 'launcher.lock');
    writeFileSync(lockFile, 'opaque lockf file contents\n');
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => runAsync(fixture, {
      TTCUT_LAUNCHER_LOCKED: index % 2 === 0 ? '1' : 'forged-value',
      TTCUT_LAUNCHER_STARTUP_WAIT: '0.4',
    })));

    expect(results.map(({ status }) => status)).toEqual(Array(16).fill(0));
    await waitForFiles([fixture.npmCalls, `${fixture.capture}.locked`], 'concurrent npm invocation');
    expect(readFileSync(fixture.npmCalls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(`${fixture.capture}.locked`, 'utf8').trim()).toBe('unset');
    expect(readFileSync(lockFile, 'utf8')).toBe('opaque lockf file contents\n');
    expect(results.some(({ stderr }) => stderr.includes('TTcut 正在启动') || stderr.includes('TTcut 已经在运行'))).toBe(true);
  });

  macIt('does not start npm while another native lockf process holds the lock', async () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    const lockFile = join(fixture.state, 'launcher.lock');
    const holderReady = join(fixture.root, 'lockf-holder-ready');
    const holder = spawn(
      '/usr/bin/lockf',
      [
        '-s', '-k', lockFile,
        '/bin/zsh', '-c', 'print -r -- "$$" > "$1"; exec /bin/sleep 30',
        'lockf-holder', holderReady,
      ],
      { stdio: 'ignore' },
    );
    try {
      await waitForFiles([holderReady], 'external lockf acquisition');
      expect(spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '-k', lockFile, '/usr/bin/true']).status).toBe(75);
      const result = run(fixture);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('TTcut 正在启动');
      expectNpmNotStarted(fixture);
    } finally {
      if (existsSync(holderReady)) {
        const holderChildPid = Number.parseInt(readFileSync(holderReady, 'utf8'), 10);
        if (Number.isInteger(holderChildPid) && holderChildPid > 0 && processState(holderChildPid)) {
          terminatePid(holderChildPid);
        }
      }
      await terminateProcess(holder);
    }
  });

  macIt('returns an error when lockf cannot create the lock file', () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    chmodSync(fixture.state, 0o555);
    try {
      const result = run(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('无法获取 TTcut 启动锁');
      expect(result.stderr).not.toContain('TTcut 正在启动');
      expectNpmNotStarted(fixture);
    } finally {
      chmodSync(fixture.state, 0o755);
    }
  });

  macIt('keeps a live legacy directory lock and does not start npm', async () => {
    const fixture = makeFixture();
    const owner = spawn('/bin/sleep', ['30']);
    try {
      await waitForCondition(() => processState(owner.pid ?? -1) !== '', 'legacy lock owner startup');
      const lockDir = join(fixture.state, 'launcher.lock');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'owner'), `${owner.pid}\t${processFingerprint(owner.pid ?? -1)}\n`);

      const result = run(fixture);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('TTcut 正在启动');
      expectNpmNotStarted(fixture);
      expect(statSync(lockDir).isDirectory()).toBe(true);
    } finally {
      await terminateProcess(owner);
    }
  });

  macIt('cleans up a stale legacy directory lock before using lockf', async () => {
    const fixture = makeFixture();
    const lockDir = join(fixture.state, 'launcher.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner'), '999999\tstale-fingerprint\n');

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation after legacy lock cleanup');
    expect(statSync(lockDir).isFile()).toBe(true);
  });

  macIt('uses the injected osascript for a duplicate-launch notification', async () => {
    const fixture = makeFixture();
    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'first npm invocation before duplicate UI');

    expect(run(fixture, {
      TTCUT_LAUNCHER_NO_UI: '',
      TTCUT_LAUNCHER_OSASCRIPT: fixture.osascript,
    }).status).toBe(0);
    await waitForFiles([join(fixture.root, 'osascript-args')], 'duplicate osascript invocation');
    expect(readFileSync(join(fixture.root, 'osascript-args'), 'utf8')).toContain('display notification "TTcut 已经在运行"');
  });

  macIt('removes a stale pid file and starts normally', async () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    writeFileSync(join(fixture.state, 'launcher.pid'), '999999\n');

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation after stale pid removal');
    expect(readFileSync(fixture.npmCalls, 'utf8').trim()).toBe('called');
  });

  macIt('treats a live unrelated PID with the wrong fingerprint as stale', async () => {
    const fixture = makeFixture();
    const unrelated = spawn('/bin/sleep', ['30']);
    try {
      mkdirSync(fixture.state, { recursive: true });
      writeFileSync(join(fixture.state, 'launcher.pid'), `${unrelated.pid}\tnot-the-process-fingerprint\n`);

      expect(run(fixture).status).toBe(0);
      await waitForFiles([fixture.npmCalls], 'npm invocation after fingerprint mismatch');
      expect(readFileSync(fixture.npmCalls, 'utf8').trim()).toBe('called');
    } finally {
      await terminateProcess(unrelated);
    }
  });

  macIt('refuses a PID path that is a directory before npm starts', () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    mkdirSync(join(fixture.state, 'launcher.pid'));

    const result = run(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法写入 TTcut 进程状态');
    expectNpmNotStarted(fixture);
  });

  macIt('kills the complete npm process group when PID publication fails', async () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.root, 'force-pid-write-failure'), '1');

    const result = run(fixture, { TTCUT_LAUNCHER_STARTUP_WAIT: '1' });
    await waitForFiles([
      join(fixture.root, 'failure-parent.pid'),
      join(fixture.root, 'failure-child.pid'),
    ], 'PID failure process records');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法写入 TTcut 进程状态');
    const parentPid = Number.parseInt(readFileSync(join(fixture.root, 'failure-parent.pid'), 'utf8'), 10);
    const childPid = Number.parseInt(readFileSync(join(fixture.root, 'failure-child.pid'), 'utf8'), 10);
    await waitForCondition(
      () => processState(parentPid) === '' && processState(childPid) === '',
      'failed npm process group cleanup',
    );
    expect(processState(parentPid)).toBe('');
    expect(processState(childPid)).toBe('');
    expect(existsSync(join(fixture.state, 'launcher.pid'))).toBe(false);
  });

  macIt('reports an npm process that exits during startup', () => {
    const fixture = makeFixture();
    writeConfig(fixture, { NPM_PATH: '/usr/bin/false' });
    const result = run(fixture, { TTCUT_LAUNCHER_STARTUP_WAIT: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TTcut 启动失败');
    expect(existsSync(join(fixture.state, 'launcher.pid'))).toBe(false);
  });

  macIt('does not rotate a log exactly 5 MiB before recording this launch', () => {
    const fixture = makeFixture();
    mkdirSync(fixture.logs, { recursive: true });
    writeFileSync(join(fixture.logs, 'launcher.log'), 'x'.repeat(5 * 1024 * 1024));

    expect(run(fixture).status).toBe(0);
    expect(existsSync(join(fixture.logs, 'launcher.log.previous'))).toBe(false);
    expect(statSync(join(fixture.logs, 'launcher.log')).size).toBeGreaterThan(5 * 1024 * 1024);
  });

  macIt('rotates a log larger than 5 MiB once before recording this launch', () => {
    const fixture = makeFixture();
    mkdirSync(fixture.logs, { recursive: true });
    writeFileSync(join(fixture.logs, 'launcher.log'), 'x'.repeat(5 * 1024 * 1024 + 1));

    expect(run(fixture).status).toBe(0);
    expect(statSync(join(fixture.logs, 'launcher.log.previous')).size).toBe(5 * 1024 * 1024 + 1);
    expect(readFileSync(join(fixture.logs, 'launcher.log'), 'utf8')).toContain('环境摘要');
  });
});

const installer = join(process.cwd(), 'scripts/install-macos-launcher.zsh');
const installerIcon = join(process.cwd(), 'resources/macos/ttcut-launcher-icon.png');
const installerLauncher = join(process.cwd(), 'scripts/macos-launcher/launcher.zsh');
const installerFixtures: InstallerFixture[] = [];

interface InstallerFixture {
  root: string;
  appParent: string;
  appDestination: string;
  project: string;
  npm: string;
  python: string;
  weights: string;
  ffmpeg: string;
  ffprobe: string;
  launcherSource: string;
  iconSource: string;
}

function makeInstallerFixture(): InstallerFixture {
  const root = mkdtempSync(join(tmpdir(), 'ttcut installer '));
  const project = join(root, "O'Brien 项目 = 空格");
  const bin = join(root, '工具 = bin');
  const appParent = join(root, 'Applications 中文');
  const fixture: InstallerFixture = {
    root,
    appParent,
    appDestination: join(appParent, 'TTcut.app'),
    project,
    npm: join(bin, 'npm = 工具'),
    python: join(bin, 'python = 工具'),
    weights: join(root, "TrackNet O'Brien = 权重.pt"),
    ffmpeg: join(bin, 'ffmpeg = 工具'),
    ffprobe: join(bin, 'ffprobe = 工具'),
    launcherSource: join(root, 'launcher source.zsh'),
    iconSource: join(root, 'icon source.png'),
  };
  mkdirSync(join(project, 'node_modules'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(appParent, { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"installer-test"}\n');
  executable(fixture.npm);
  executable(fixture.python, `#!/bin/zsh
if [[ "\${TTCUT_TEST_RACE_DESTINATION:-}" == "$4" && "$3" == *.staging.* ]]; then
  /bin/mkdir -p "$4"
  print -r -- conflict > "$4/conflict"
fi
exec /usr/bin/python3 "$@"
`);
  executable(fixture.ffmpeg);
  executable(fixture.ffprobe);
  writeFileSync(fixture.weights, 'weights');
  copyFileSync(installerLauncher, fixture.launcherSource);
  copyFileSync(installerIcon, fixture.iconSource);
  installerFixtures.push(fixture);
  return fixture;
}

function installerEnv(fixture: InstallerFixture, env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TTCUT_APP_DESTINATION: fixture.appDestination,
    TTCUT_PROJECT_DIR: fixture.project,
    TTCUT_NPM_PATH: fixture.npm,
    TTCUT_PYTHON_PATH: fixture.python,
    TTCUT_WEIGHTS_PATH: fixture.weights,
    TTCUT_FFMPEG_PATH: fixture.ffmpeg,
    TTCUT_FFPROBE_PATH: fixture.ffprobe,
    TTCUT_LAUNCHER_SOURCE: fixture.launcherSource,
    TTCUT_ICON_SOURCE: fixture.iconSource,
    ...env,
  };
}

function install(fixture: InstallerFixture, env: Record<string, string> = {}) {
  return spawnSync('/bin/zsh', [installer], { encoding: 'utf8', env: installerEnv(fixture, env) });
}

function writeSentinelApp(destination: string): void {
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'sentinel'), 'keep this app');
}

function findIconsets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name.endsWith('.iconset')) return [path];
    return entry.isDirectory() ? findIconsets(path) : [];
  });
}

afterEach(() => {
  for (const fixture of installerFixtures.splice(0)) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe('macOS launcher installer', () => {
  macIt('builds a valid, idempotent app bundle with raw configuration values', () => {
    const fixture = makeInstallerFixture();
    const first = install(fixture);
    expect(first.status, first.stderr).toBe(0);

    const contents = join(fixture.appDestination, 'Contents');
    const executablePath = join(contents, 'MacOS', 'TTcutLauncher');
    const configPath = join(contents, 'Resources', 'launcher.conf');
    const iconPath = join(contents, 'Resources', 'TTcut.icns');
    const plistPath = join(contents, 'Info.plist');
    expect(statSync(executablePath).mode & 0o111).not.toBe(0);
    expect(readFileSync(executablePath, 'utf8')).toBe(readFileSync(installerLauncher, 'utf8'));
    expect(readFileSync(configPath, 'utf8')).toBe([
      `PROJECT_DIR=${fixture.project}`,
      `NPM_PATH=${fixture.npm}`,
      `PYTHON_PATH=${fixture.python}`,
      `WEIGHTS_PATH=${fixture.weights}`,
      `FFMPEG_PATH=${fixture.ffmpeg}`,
      `FFPROBE_PATH=${fixture.ffprobe}`,
      '',
    ].join('\n'));
    expect(statSync(iconPath).size).toBeGreaterThan(0);
    expect(spawnSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' }).status).toBe(0);
    const plist = readFileSync(plistPath, 'utf8');
    for (const value of [
      'TTcutLauncher',
      'TTcut',
      'com.weiye.ttcut.local-launcher',
      '<string>TTcut</string>',
      '<string>APPL</string>',
      '<string>1.0</string>',
      '<true/>',
    ]) expect(plist).toContain(value);
    expect(existsSync(join(fixture.appDestination, 'TTcut.iconset'))).toBe(false);
    expect(findIconsets(fixture.appDestination)).toEqual([]);

    writeFileSync(join(fixture.appDestination, 'sentinel'), 'first install');
    const second = install(fixture);
    expect(second.status, second.stderr).toBe(0);
    expect(existsSync(executablePath)).toBe(true);
    expect(existsSync(join(fixture.appDestination, 'sentinel'))).toBe(false);
  });

  macIt.each([
    ['launcher source', (fixture: InstallerFixture) => fixture.launcherSource],
    ['icon source', (fixture: InstallerFixture) => fixture.iconSource],
  ] as const)('does not replace an existing app when the %s is missing', (_name, sourcePath) => {
    const fixture = makeInstallerFixture();
    writeSentinelApp(fixture.appDestination);
    rmSync(sourcePath(fixture));
    const result = install(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/[\u4e00-\u9fff]/);
    expect(readFileSync(join(fixture.appDestination, 'sentinel'), 'utf8')).toBe('keep this app');
  });

  macIt.each(['TTCUT_LAUNCHER_SOURCE', 'TTCUT_ICON_SOURCE'] as const)('rejects unsafe %s overrides before replacing an app', (key) => {
    const fixture = makeInstallerFixture();
    writeSentinelApp(fixture.appDestination);
    const result = install(fixture, { [key]: `${fixture.root}\nunsafe` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('配置路径无效');
    expect(readFileSync(join(fixture.appDestination, 'sentinel'), 'utf8')).toBe('keep this app');
  });

  macIt.each([
    ['project directory', (fixture: InstallerFixture) => ({ TTCUT_PROJECT_DIR: join(fixture.root, 'missing project') })],
    ['package.json', (fixture: InstallerFixture) => {
      rmSync(join(fixture.project, 'package.json'));
      return {};
    }],
    ['node_modules', (fixture: InstallerFixture) => {
      rmSync(join(fixture.project, 'node_modules'), { recursive: true });
      return {};
    }],
    ['npm', (fixture: InstallerFixture) => ({ TTCUT_NPM_PATH: join(fixture.root, 'missing npm') })],
    ['Python', (fixture: InstallerFixture) => ({ TTCUT_PYTHON_PATH: join(fixture.root, 'missing python') })],
    ['TrackNet weights', (fixture: InstallerFixture) => {
      rmSync(fixture.weights);
      return {};
    }],
    ['FFmpeg', (fixture: InstallerFixture) => ({ TTCUT_FFMPEG_PATH: join(fixture.root, 'missing ffmpeg') })],
    ['ffprobe', (fixture: InstallerFixture) => ({ TTCUT_FFPROBE_PATH: join(fixture.root, 'missing ffprobe') })],
  ] as const)('does not replace an existing app when %s is missing', (_name, makeFailure) => {
    const fixture = makeInstallerFixture();
    writeSentinelApp(fixture.appDestination);
    const result = install(fixture, makeFailure(fixture));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/[\u4e00-\u9fff]/);
    expect(readFileSync(join(fixture.appDestination, 'sentinel'), 'utf8')).toBe('keep this app');
  });

  macIt('does not replace an existing app when icon conversion fails', () => {
    const fixture = makeInstallerFixture();
    writeSentinelApp(fixture.appDestination);
    const fakeBin = join(fixture.root, 'fake bin');
    mkdirSync(fakeBin);
    executable(join(fakeBin, 'iconutil'), '#!/bin/zsh\nexit 91\n');
    const result = install(fixture, { PATH: `${fakeBin}:${process.env.PATH}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/[\u4e00-\u9fff]/);
    expect(readFileSync(join(fixture.appDestination, 'sentinel'), 'utf8')).toBe('keep this app');
  });

  macIt('fails without replacing an app while another installer holds its lock', async () => {
    const fixture = makeInstallerFixture();
    writeSentinelApp(fixture.appDestination);
    const lockFile = join(fixture.appParent, '.TTcut.app.ttcut-installer.lock');
    const holder = spawn('/usr/bin/lockf', ['-s', '-k', lockFile, '/bin/sleep', '30']);
    try {
      await waitForCondition(
        () => spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '-k', lockFile, '/usr/bin/true']).status === 75,
        'installer lock acquisition',
      );
      const result = install(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('安装器正在运行');
      expect(readFileSync(join(fixture.appDestination, 'sentinel'), 'utf8')).toBe('keep this app');
    } finally {
      await terminateProcess(holder);
    }
  });

  macIt('fails without replacing an app when its installer lock cannot be opened', () => {
    const fixture = makeInstallerFixture();
    writeSentinelApp(fixture.appDestination);
    mkdirSync(join(fixture.appParent, '.TTcut.app.ttcut-installer.lock'));
    const result = install(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('无法创建 TTcut 安装锁');
    expect(readFileSync(join(fixture.appDestination, 'sentinel'), 'utf8')).toBe('keep this app');
  });

  macIt('restores the old app and preserves a concurrent target when the directory commit races', () => {
    const fixture = makeInstallerFixture();
    writeSentinelApp(fixture.appDestination);
    const result = install(fixture, { TTCUT_TEST_RACE_DESTINATION: fixture.appDestination });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('无法安装 TTcut.app');
    expect(readFileSync(join(fixture.appDestination, 'sentinel'), 'utf8')).toBe('keep this app');
    const conflict = readdirSync(fixture.appParent).find((name) => name.includes('.TTcut.app.ttcut-installer.conflict.'));
    expect(conflict).toBeTruthy();
    expect(readFileSync(join(fixture.appParent, conflict ?? '', 'conflict'), 'utf8')).toBe('conflict\n');
  });

  macIt.each(['file', 'symlink'] as const)('replaces an existing %s target without nesting the staging bundle', (kind) => {
    const fixture = makeInstallerFixture();
    if (kind === 'file') writeFileSync(fixture.appDestination, 'old target');
    else {
      const externalTarget = join(fixture.root, 'external target');
      mkdirSync(externalTarget);
      symlinkSync(externalTarget, fixture.appDestination);
    }
    const result = install(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(join(fixture.appDestination, 'Contents', 'MacOS', 'TTcutLauncher')).isFile()).toBe(true);
    expect(existsSync(join(fixture.appDestination, 'TTcut.app'))).toBe(false);
  });

  macIt('fails safely when the destination parent is not a writable directory', () => {
    const fixture = makeInstallerFixture();
    const invalidParent = join(fixture.root, 'not a directory');
    writeFileSync(invalidParent, 'file');
    fixture.appDestination = join(invalidParent, 'TTcut.app');
    const result = install(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('目标目录');
    expect(existsSync(fixture.appDestination)).toBe(false);
  });
});
