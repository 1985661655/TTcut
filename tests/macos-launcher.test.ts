import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
print -r -- "$0 $*" > "$root/captured-env.argv"
print -r -- called >> "$root/npm-calls"
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
  return spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
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
  rmSync(fixture.root, { recursive: true, force: true });
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  await closed;
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
      `${fixture.capture}.argv`,
      fixture.npmCalls,
    ], 'npm environment capture');
    expect(readFileSync(`${fixture.capture}.path`, 'utf8').trim()).toBe(`${dirname(fixture.npm)}:${dirname(fixture.python)}:${SAFE_PATH}`);
    expect(readFileSync(`${fixture.capture}.python`, 'utf8').trim()).toBe(fixture.python);
    expect(readFileSync(`${fixture.capture}.weights`, 'utf8').trim()).toBe(fixture.weights);
    expect(readFileSync(`${fixture.capture}.ffmpeg`, 'utf8').trim()).toBe(fixture.ffmpeg);
    expect(readFileSync(`${fixture.capture}.ffprobe`, 'utf8').trim()).toBe(fixture.ffprobe);
    expect(readFileSync(`${fixture.capture}.argv`, 'utf8')).toContain(' start');
    const pidRecord = readFileSync(join(fixture.state, 'launcher.pid'), 'utf8').trim();
    expect(pidRecord).toMatch(/^\d+\t.+$/);
    const npmPid = Number.parseInt(pidRecord, 10);
    const npmPgid = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(npmPid)], { encoding: 'utf8' }).stdout.trim();
    expect(npmPgid).toBe(String(npmPid));
    expect(readdirSync(fixture.state).filter((name) => name.includes('candidate') || name.includes('stale'))).toEqual([]);
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
    expect(run(fixture).status).toBe(0);

    expect(readFileSync(fixture.npmCalls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  macIt('serializes eight concurrent launchers to one npm process', async () => {
    const fixture = makeFixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => runAsync(fixture, { TTCUT_LAUNCHER_STARTUP_WAIT: '0.4' })));

    expect(results.map(({ status }) => status)).toEqual(Array(8).fill(0));
    await waitForFiles([fixture.npmCalls], 'concurrent npm invocation');
    expect(readFileSync(fixture.npmCalls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(results.some(({ stderr }) => stderr.includes('TTcut 正在启动') || stderr.includes('TTcut 已经在运行'))).toBe(true);
  });

  macIt('ignores a complete unpublished candidate owned by a live process', async () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    const candidate = join(fixture.state, 'launcher.lock.candidate.unpublished');
    writeFileSync(candidate, `${process.pid}\t${processFingerprint(process.pid)}\n`);

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation with an unpublished candidate');
    expect(readFileSync(candidate, 'utf8').trim()).toContain(`${process.pid}\t`);
  });

  macIt('recovers an incomplete canonical lock record', async () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    writeFileSync(join(fixture.state, 'launcher.lock'), 'partial');

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation after incomplete lock recovery');
    expect(readFileSync(fixture.npmCalls, 'utf8').trim()).toBe('called');
  });

  macIt('returns an error when the state directory cannot publish a lock', () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    chmodSync(fixture.state, 0o555);
    try {
      const result = run(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('无法写入 TTcut 启动锁');
      expect(result.stderr).not.toContain('TTcut 正在启动');
      expectNpmNotStarted(fixture);
    } finally {
      chmodSync(fixture.state, 0o755);
    }
  });

  macIt('does not remove a lock whose published owner record changed', async () => {
    const fixture = makeFixture();
    const lockFile = join(fixture.state, 'launcher.lock');
    const launch = runAsync(fixture, { TTCUT_LAUNCHER_STARTUP_WAIT: '0.6' });
    try {
      await waitForCondition(() => existsSync(lockFile) && statSync(lockFile).isFile(), 'published launcher lock');
      writeFileSync(lockFile, '999999\tforeign-owner\n');
    } finally {
      await launch;
    }

    expect((await launch).status).toBe(0);
    expect(readFileSync(lockFile, 'utf8').trim()).toBe('999999\tforeign-owner');
  });

  macIt('removes a stale launcher lock and retries once', async () => {
    const fixture = makeFixture();
    const lockFile = join(fixture.state, 'launcher.lock');
    mkdirSync(fixture.state, { recursive: true });
    writeFileSync(lockFile, '999999\tstale-fingerprint\n');

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation after stale lock removal');
    expect(existsSync(lockFile)).toBe(false);
  });

  macIt('cleans up a legacy directory lock', async () => {
    const fixture = makeFixture();
    const lockDir = join(fixture.state, 'launcher.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner'), '999999\tstale-fingerprint\n');

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation after legacy lock cleanup');
    expect(existsSync(lockDir)).toBe(false);
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
