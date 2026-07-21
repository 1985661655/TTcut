import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  const state = join(root, 'state');
  const logs = join(root, 'logs');
  mkdirSync(join(project, 'node_modules'), { recursive: true });
  mkdirSync(bin, { recursive: true });
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
    python: join(bin, 'python'),
    weights: join(root, 'TrackNet 权重.pt'),
    ffmpeg: join(bin, 'ffmpeg'),
    ffprobe: join(bin, 'ffprobe'),
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
if [[ -f "$root/exit-immediately" ]]; then
  exit 42
fi
zmodload zsh/zselect
trap 'exit 0' TERM INT
while true; do zselect -t 6000; done
`);
  executable(fixture.python);
  executable(fixture.ffmpeg);
  executable(fixture.ffprobe);
  writeFileSync(fixture.weights, 'weights');
  writeConfig(fixture);
  fixtures.push(fixture);
  return fixture;
}

function quoteConfig(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
  writeFileSync(fixture.config, `${Object.entries(config).map(([key, value]) => `${key}=${quoteConfig(value)}`).join('\n')}\n`);
}

type ConfigKey = 'PROJECT_DIR' | 'NPM_PATH' | 'PYTHON_PATH' | 'WEIGHTS_PATH' | 'FFMPEG_PATH' | 'FFPROBE_PATH';

function run(fixture: Fixture, env: Record<string, string> = {}) {
  return spawnSync('/bin/zsh', [launcher], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.home,
      TTCUT_LAUNCHER_CONFIG: fixture.config,
      TTCUT_LAUNCHER_STATE_DIR: fixture.state,
      TTCUT_LAUNCHER_LOG_DIR: fixture.logs,
      TTCUT_LAUNCHER_NO_UI: '1',
      TTCUT_LAUNCHER_STARTUP_WAIT: '1',
      ...env,
    },
  });
}

function cleanup(fixture: Fixture): void {
  const pidFile = join(fixture.state, 'launcher.pid');
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  rmSync(fixture.root, { recursive: true, force: true });
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

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanup(fixture);
});

const macIt = process.platform === 'darwin' ? it : it.skip;

describe('macOS launcher', () => {
  it('opens an existing log through Finder and safely ignores a missing log', () => {
    const source = readFileSync(launcher, 'utf8');

    expect(source).toContain('tell application "Finder" to open (POSIX file (item 2 of argv))');
    expect(source).toContain('try\n      tell application "Finder" to open (POSIX file (item 2 of argv))\n    end try');
    expect(source).not.toContain('do shell script "if [ -e ');
  });

  macIt('rejects an unreadable configuration before npm starts', () => {
    const fixture = makeFixture();
    const result = run(fixture, { TTCUT_LAUNCHER_CONFIG: join(fixture.root, 'missing.conf') });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法读取启动器配置文件');
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
    expect(readFileSync(`${fixture.capture}.path`, 'utf8').trim()).toBe(SAFE_PATH);
    expect(readFileSync(`${fixture.capture}.python`, 'utf8').trim()).toBe(fixture.python);
    expect(readFileSync(`${fixture.capture}.weights`, 'utf8').trim()).toBe(fixture.weights);
    expect(readFileSync(`${fixture.capture}.ffmpeg`, 'utf8').trim()).toBe(fixture.ffmpeg);
    expect(readFileSync(`${fixture.capture}.ffprobe`, 'utf8').trim()).toBe(fixture.ffprobe);
    expect(readFileSync(`${fixture.capture}.argv`, 'utf8')).toContain(' start');
    expect(existsSync(join(fixture.state, 'launcher.pid'))).toBe(true);
    expect(readFileSync(join(fixture.logs, 'launcher.log'), 'utf8')).toContain('环境摘要');
  });

  macIt('does not start another npm process while the pid file is live', async () => {
    const fixture = makeFixture();
    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'first npm invocation');
    expect(run(fixture).status).toBe(0);

    expect(readFileSync(fixture.npmCalls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  macIt('removes a stale pid file and starts normally', async () => {
    const fixture = makeFixture();
    mkdirSync(fixture.state, { recursive: true });
    writeFileSync(join(fixture.state, 'launcher.pid'), '999999\n');

    expect(run(fixture).status).toBe(0);
    await waitForFiles([fixture.npmCalls], 'npm invocation after stale pid removal');
    expect(readFileSync(fixture.npmCalls, 'utf8').trim()).toBe('called');
  });

  macIt('reports an npm process that exits during startup', () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.root, 'exit-immediately'), '1');
    const result = run(fixture);

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
