# Configurable Inference Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted 4/8/12/16 TrackNet Batch control, default Apple Silicon to 8, and recover from inference out-of-memory by reducing the runtime Batch without restarting analysis.

**Architecture:** `AppSettings` owns the user choice and migrates old settings through a pure main-process helper. The renderer passes the value through the typed preload API into the versioned worker request. `TrackNetPredictor` keeps a selected Batch and a mutable effective Batch; only the latter shrinks after OOM, preserving input order and already-completed tracking state.

**Tech Stack:** TypeScript, Zod, Electron IPC, React, Vitest, Python 3.12, pytest, PyTorch MPS/CUDA.

---

## File map

- Create `src/main/settings-values.ts`: platform defaults and backward-compatible normalization, with no Electron dependency.
- Create `tests/settings.test.ts`: settings schema, default, and migration tests.
- Create `tests/contracts.test.ts`: analysis request Batch validation.
- Create `worker/tests/test_predictor.py`: deterministic OOM-backoff tests without loading real Torch weights.
- Modify `src/shared/contracts.ts`: Batch constants, schemas, and inferred type.
- Modify `src/shared/api.ts` and `src/preload/index.ts`: typed analysis-start input.
- Modify `src/main/settings.ts`: use the pure default/migration helper.
- Modify `src/main/index.ts` and `src/main/analysis.ts`: validate and serialize Batch into the worker request.
- Modify `src/renderer/App.tsx`, `src/renderer/i18n.ts`, and `src/renderer/styles.css`: persisted four-option Settings control.
- Modify `worker/ttcut_worker/worker.py`: validate the Batch and pass it to the predictor.
- Modify `worker/ttcut_worker/predictor.py`: effective Batch and ordered OOM retry.
- Modify `worker/tests/test_analysis.py`: worker request protocol coverage.
- Modify `tests/e2e/real-workflow.spec.ts`: persisted UI selection coverage.

## Execution prerequisite

Run `npm ci` once in the isolated worktree. Reuse the already verified Python 3.12 environment at `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python`; `pytest.ini` points it at this worktree's `worker` package.

### Task 1: Settings contract, platform default, and migration

**Files:**
- Create: `src/main/settings-values.ts`
- Create: `tests/settings.test.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/settings.ts`

- [ ] **Step 1: Write failing settings tests**

Create `tests/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { appSettingsSchema } from '../src/shared/contracts';
import { defaultAppSettings, normalizeStoredSettings } from '../src/main/settings-values';

const legacy = { language: 'en', pre_roll_seconds: 1.5, post_roll_seconds: 0.5 };

describe('inference Batch settings', () => {
  it.each([4, 8, 12, 16])('accepts Batch %i', (inference_batch_size) => {
    expect(appSettingsSchema.safeParse({ ...legacy, inference_batch_size }).success).toBe(true);
  });

  it.each([0, 6, 32])('rejects unsupported Batch %i', (inference_batch_size) => {
    expect(appSettingsSchema.safeParse({ ...legacy, inference_batch_size }).success).toBe(false);
  });

  it('defaults Apple Silicon to 8 and other runtimes to 4', () => {
    expect(defaultAppSettings('darwin', 'arm64').inference_batch_size).toBe(8);
    expect(defaultAppSettings('darwin', 'x64').inference_batch_size).toBe(4);
    expect(defaultAppSettings('win32', 'x64').inference_batch_size).toBe(4);
  });

  it('migrates old settings without losing user values', () => {
    expect(normalizeStoredSettings(legacy, 'darwin', 'arm64')).toEqual({
      ...legacy,
      inference_batch_size: 8,
    });
  });

  it('preserves an explicit Batch during normalization', () => {
    expect(normalizeStoredSettings({ ...legacy, inference_batch_size: 12 }, 'darwin', 'arm64')
      .inference_batch_size).toBe(12);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/settings.test.ts`

Expected: FAIL because `settings-values.ts` and `inference_batch_size` do not exist.

- [ ] **Step 3: Add the Batch schema and pure settings helper**

In `src/shared/contracts.ts`, add the shared values and schema near the other settings constants:

```ts
export const INFERENCE_BATCH_VALUES = [4, 8, 12, 16] as const;
export const inferenceBatchSizeSchema = z.union(
  INFERENCE_BATCH_VALUES.map((value) => z.literal(value)),
);
```

Add the required field to `appSettingsSchema` and export its inferred type:

```ts
export const appSettingsSchema = z.object({
  language: z.enum(['zh-CN', 'en']),
  pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
  post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  inference_batch_size: inferenceBatchSizeSchema,
}).strict();

export type InferenceBatchSize = z.infer<typeof inferenceBatchSizeSchema>;
```

Create `src/main/settings-values.ts`:

```ts
import { appSettingsSchema, type AppSettings } from '../shared/contracts';

export function defaultAppSettings(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): AppSettings {
  return {
    language: 'zh-CN',
    pre_roll_seconds: 2.5,
    post_roll_seconds: 2,
    inference_batch_size: platform === 'darwin' && architecture === 'arm64' ? 8 : 4,
  };
}

export function normalizeStoredSettings(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): AppSettings {
  const defaults = defaultAppSettings(platform, architecture);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return appSettingsSchema.parse(value);
  }
  const stored = value as Record<string, unknown>;
  return appSettingsSchema.parse({
    ...stored,
    inference_batch_size: stored.inference_batch_size ?? defaults.inference_batch_size,
  });
}
```

Update `src/main/settings.ts` to call `normalizeStoredSettings(raw)` when loading and return `defaultAppSettings()` in the catch branch. Keep `saveSettings` strict through `appSettingsSchema.parse`.

- [ ] **Step 4: Run focused tests and type checking**

Run: `npm test -- tests/settings.test.ts`

Expected: PASS, 10 tests.

Run: `npm run typecheck`

Expected: FAIL only at existing `AppSettings` object literals that still need the new field; record those locations for Task 2.

- [ ] **Step 5: Commit the settings domain**

```bash
git add src/shared/contracts.ts src/main/settings-values.ts src/main/settings.ts tests/settings.test.ts
git commit -m "feat: add inference batch setting"
```

### Task 2: Settings UI and typed renderer API

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/i18n.ts`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Extend the typed API first**

In `src/shared/api.ts`, define and use one shared input type:

```ts
import type { InferenceBatchSize } from './contracts';

export type AnalysisStartInput = {
  videoPath: string;
  calibration: Calibration;
  device: 'auto' | 'cuda' | 'cpu';
  batchSize: InferenceBatchSize;
};

// In TTcutApi:
startAnalysis(input: AnalysisStartInput): Promise<string>;
```

In `src/preload/index.ts`, import `AnalysisStartInput` and use it for the implementation signature:

```ts
startAnalysis: (input: AnalysisStartInput) => ipcRenderer.invoke(IPC.analysisStart, input),
```

- [ ] **Step 2: Run type checking and verify RED**

Run: `npm run typecheck`

Expected: FAIL because the renderer's initial settings omit `inference_batch_size` and `startAnalysis` omits `batchSize`.

- [ ] **Step 3: Add the four-option Settings control**

In `src/renderer/App.tsx`, make the initial state structurally valid and pass the setting into analysis:

```tsx
const [settings, setSettings] = useState<AppSettings>({
  language: 'zh-CN',
  pre_roll_seconds: 2.5,
  post_roll_seconds: 2,
  inference_batch_size: 4,
});

setActiveTask(await window.ttcut.startAnalysis({
  videoPath: video.path,
  calibration: calibrationValue,
  device: 'auto',
  batchSize: settings.inference_batch_size,
}));
```

Reuse the existing partial-save helper and add this card after platform compatibility:

```tsx
<article className="card timing-setting-card batch-setting-card">
  <div><h2>{t.inferenceBatch}</h2><p>{t.inferenceBatchDetail}</p></div>
  <div className="choice-row four">
    {([4, 8, 12, 16] as const).map((value, index) => (
      <button
        className={settings.inference_batch_size === value ? 'selected' : ''}
        key={value}
        onClick={() => void saveSettingsPartial({ inference_batch_size: value })}
      >
        <strong>{[t.batchLowMemory, t.batchBalanced, t.batchFaster, t.batchMaximum][index]}</strong>
        <span>{value}</span>
      </button>
    ))}
  </div>
</article>
```

Rename `saveRolls` to `saveSettingsPartial` because it now saves both timing and inference settings, updating its two existing call sites.

Add matching Chinese and English keys in `src/renderer/i18n.ts`:

```ts
inferenceBatch: '推理批量',
inferenceBatchDetail: '平衡分析速度与内存占用。',
batchLowMemory: '低内存',
batchBalanced: '推荐',
batchFaster: '更快',
batchMaximum: '最大',
```

```ts
inferenceBatch: 'Inference Batch',
inferenceBatchDetail: 'Balance analysis speed and memory use.',
batchLowMemory: 'Low memory',
batchBalanced: 'Recommended',
batchFaster: 'Faster',
batchMaximum: 'Maximum',
```

Reuse `.timing-setting-card` and `.choice-row.four`; only add `.batch-setting-card` selectors if a focused layout check shows text overflow at the minimum window size.

- [ ] **Step 4: Run type checking and Node tests**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test -- tests/settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the UI and API types**

```bash
git add src/shared/api.ts src/preload/index.ts src/renderer/App.tsx src/renderer/i18n.ts src/renderer/styles.css
git commit -m "feat: add inference batch control"
```

### Task 3: Carry Batch through the Electron-to-worker request

**Files:**
- Create: `tests/contracts.test.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/analysis.ts`
- Modify: `worker/ttcut_worker/worker.py`
- Modify: `worker/tests/test_analysis.py`

- [ ] **Step 1: Write failing TypeScript and Python protocol tests**

Create `tests/contracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { analysisRequestSchema } from '../src/shared/contracts';

const request = {
  schema_version: 1,
  task_id: '22222222-2222-4222-8222-222222222222',
  video_path: '/tmp/match.mp4',
  device: 'auto',
  batch_size: 8,
  calibration: {
    video_width: 1280,
    video_height: 720,
    points: {
      top_left: [400, 200], top_right: [880, 200],
      bottom_right: [1050, 620], bottom_left: [230, 620],
    },
  },
};

describe('analysis request Batch', () => {
  it.each([4, 8, 12, 16])('accepts %i', (batch_size) => {
    expect(analysisRequestSchema.safeParse({ ...request, batch_size }).success).toBe(true);
  });

  it.each([1, 6, 32])('rejects %i', (batch_size) => {
    expect(analysisRequestSchema.safeParse({ ...request, batch_size }).success).toBe(false);
  });
});
```

Add `batch_size: 8` to `valid_request()` in `worker/tests/test_analysis.py`, then add:

```py
def test_worker_request_accepts_supported_batch_sizes():
    for batch_size in (4, 8, 12, 16):
        request = valid_request()
        request["batch_size"] = batch_size
        assert validate_request(request)["batch_size"] == batch_size


def test_worker_request_rejects_unsupported_batch_size():
    request = valid_request()
    request["batch_size"] = 6
    with pytest.raises(Exception, match="fields"):
        validate_request(request)
```

Import `pytest` at the top of the file.

- [ ] **Step 2: Run both focused tests and verify RED**

Run: `npm test -- tests/contracts.test.ts`

Expected: FAIL because the Zod request does not accept `batch_size`.

Run: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -m pytest worker/tests/test_analysis.py -q`

Expected: FAIL because the Python worker still rejects the extra field.

- [ ] **Step 3: Implement request validation and propagation**

Add `batch_size: inferenceBatchSizeSchema` to `analysisRequestSchema`.

In `src/main/index.ts`, validate the renderer value with the same schema:

```ts
const batchSize = inferenceBatchSizeSchema.parse(record.batchSize);
return startAnalysis(currentWindow(), {
  videoPath: record.videoPath,
  calibration: calibrationSchema.parse(record.calibration),
  device,
  batchSize,
});
```

In `src/main/analysis.ts`, extend the input type with `batchSize: InferenceBatchSize` and add this request field:

```ts
batch_size: value.batchSize,
```

In `worker/ttcut_worker/worker.py`, require and validate the field:

```py
expected_fields = {"schema_version", "task_id", "video_path", "device", "batch_size", "calibration"}

if value["batch_size"] not in {4, 8, 12, 16}:
    raise ValueError("batch_size")
```

Construct the predictor with the validated request value:

```py
points, info, _stats = TrackNetPredictor(
    loaded,
    batch_size=request["batch_size"],
).predict(request["video_path"], progress_callback=progress)
```

- [ ] **Step 4: Run focused tests, type checking, and worker boundary tests**

Run: `npm test -- tests/contracts.test.ts tests/settings.test.ts`

Expected: PASS.

Run: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -m pytest worker/tests/test_analysis.py -q`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the request protocol**

```bash
git add tests/contracts.test.ts src/shared/contracts.ts src/main/index.ts src/main/analysis.ts worker/ttcut_worker/worker.py worker/tests/test_analysis.py
git commit -m "feat: pass inference batch to worker"
```

### Task 4: Ordered out-of-memory backoff in the predictor

**Files:**
- Create: `worker/tests/test_predictor.py`
- Modify: `worker/ttcut_worker/predictor.py`

- [ ] **Step 1: Write failing predictor tests**

Create `worker/tests/test_predictor.py`:

```py
from pathlib import Path

import pytest

from ttcut_worker.errors import DeviceError
from ttcut_worker.model import LoadedTrackNet
from ttcut_worker.predictor import TrackNetPredictor, _AcceleratorOutOfMemory
from ttcut_worker.video import FramePacket, VideoInfo


def predictor(batch_size=8):
    loaded = LoadedTrackNet(model=None, seq_len=8, bg_mode="", device="mps")
    return TrackNetPredictor(loaded, batch_size=batch_size)


def fixtures(count):
    inputs = list(range(count))
    groups = [[FramePacket(index, index / 60, "fps_estimation", None)] for index in inputs]
    info = VideoInfo(Path("match.mp4"), 1920, 1080, 60, count, count, count / 60)
    return inputs, groups, info


def test_oom_retries_in_order_and_keeps_reduced_batch(monkeypatch):
    subject = predictor(8)
    calls = []

    def infer(inputs, packet_groups, _info):
        calls.append(len(inputs))
        if len(inputs) > 2:
            raise _AcceleratorOutOfMemory("MPS backend out of memory")
        return [group[0].index for group in packet_groups]

    monkeypatch.setattr(subject, "_infer_batch", infer)
    monkeypatch.setattr(subject, "_clear_accelerator_cache", lambda: None)
    inputs, groups, info = fixtures(8)

    assert subject._infer_with_backoff(inputs, groups, info) == list(range(8))
    assert calls == [8, 4, 2, 2, 2, 2]
    assert subject.effective_batch_size == 2

    calls.clear()
    assert subject._infer_with_backoff(*fixtures(4)) == list(range(4))
    assert calls == [2, 2]


def test_oom_at_batch_one_becomes_device_error(monkeypatch):
    subject = predictor(4)
    monkeypatch.setattr(
        subject,
        "_infer_batch",
        lambda *_args: (_ for _ in ()).throw(_AcceleratorOutOfMemory("out of memory")),
    )
    monkeypatch.setattr(subject, "_clear_accelerator_cache", lambda: None)

    with pytest.raises(DeviceError, match="batch size 1"):
        subject._infer_with_backoff(*fixtures(1))
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -m pytest worker/tests/test_predictor.py -q`

Expected: FAIL because `_AcceleratorOutOfMemory`, `effective_batch_size`, and `_infer_with_backoff` do not exist.

- [ ] **Step 3: Implement the minimal backoff loop**

In `worker/ttcut_worker/predictor.py`, import `sys` and add the private marker exception:

```py
class _AcceleratorOutOfMemory(RuntimeError):
    pass
```

Initialize both configured and runtime values:

```py
self.batch_size = batch_size
self.effective_batch_size = batch_size
```

Reset `effective_batch_size` at the beginning of `predict`, use it as the collection threshold, and replace direct `_infer_batch` calls with `_infer_with_backoff`.

Add the ordered retry loop:

```py
def _infer_with_backoff(self, inputs, packet_groups, info):
    output = []
    cursor = 0
    while cursor < len(inputs):
        chunk_size = min(self.effective_batch_size, len(inputs) - cursor)
        try:
            output.extend(self._infer_batch(
                inputs[cursor:cursor + chunk_size],
                packet_groups[cursor:cursor + chunk_size],
                info,
            ))
            cursor += chunk_size
        except _AcceleratorOutOfMemory as exc:
            self._clear_accelerator_cache()
            if chunk_size == 1:
                self.effective_batch_size = 1
                raise DeviceError("Inference ran out of memory at batch size 1.") from exc
            self.effective_batch_size = max(1, chunk_size // 2)
            print(
                f"Inference batch {chunk_size} ran out of memory; retrying with {self.effective_batch_size}.",
                file=sys.stderr,
                flush=True,
            )
    return output
```

Add allocator cleanup for the active backend:

```py
def _clear_accelerator_cache(self):
    torch = import_torch()
    device_type = getattr(self.loaded.device, "type", str(self.loaded.device))
    if device_type == "cuda" and torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif device_type == "mps":
        empty_cache = getattr(getattr(torch, "mps", None), "empty_cache", None)
        if callable(empty_cache):
            empty_cache()
```

In `_infer_batch`, convert only recognized OOM exceptions into the private marker and remove the CUDA-specific user message:

```py
except Exception as exc:
    if "out of memory" in str(exc).lower():
        raise _AcceleratorOutOfMemory(str(exc)) from exc
    raise
```

- [ ] **Step 4: Run predictor and full Python tests**

Run: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -m pytest worker/tests/test_predictor.py -q`

Expected: PASS, 2 tests.

Run: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -m pytest worker/tests -q`

Expected: all Python tests PASS.

- [ ] **Step 5: Commit OOM recovery**

```bash
git add worker/ttcut_worker/predictor.py worker/tests/test_predictor.py
git commit -m "feat: reduce inference batch after oom"
```

### Task 5: End-to-end UI persistence and full verification

**Files:**
- Modify: `tests/e2e/real-workflow.spec.ts`

- [ ] **Step 1: Add a failing persistence assertion to the real workflow**

After opening Settings in `tests/e2e/real-workflow.spec.ts`, select Batch 8 and verify the visual state:

```ts
const batchCard = page.locator('.batch-setting-card');
await expect(batchCard.getByRole('heading', { name: '推理批量' })).toBeVisible();
await batchCard.getByRole('button', { name: /推荐.*8/ }).click();
await expect(batchCard.getByRole('button', { name: /推荐.*8/ })).toHaveClass(/selected/);
```

After the setting save has settled, verify the persisted JSON:

```ts
await expect.poll(async () => {
  const saved = JSON.parse(await readFile(path.join(isolatedUserData, 'settings.json'), 'utf8'));
  return saved.inference_batch_size;
}).toBe(8);
```

The existing later analysis start then proves the selected value crosses the strict Electron and Python request boundaries.

- [ ] **Step 2: Run the focused Electron workflow where its real fixture is available**

Run: `npm run test:e2e -- tests/e2e/real-workflow.spec.ts`

Expected: PASS. If the Windows-only baseline fixture is unavailable on this Mac worktree, record the skip and run the packaged Mac app manually in Step 4 instead; do not weaken the assertions.

- [ ] **Step 3: Run all automated checks**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test`

Expected: all Node/Vitest tests PASS.

Run: `/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -m pytest worker/tests -q`

Expected: all Python tests PASS.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 4: Launch the isolated worktree app and inspect the Settings layout**

Run with the existing local component environment:

```bash
TTCUT_PYTHON=/Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python \
TTCUT_TRACKNET_WEIGHTS=/Users/xkkx6/Downloads/TrackNet_best.pt \
TTCUT_FFMPEG=/opt/homebrew/bin/ffmpeg \
TTCUT_FFPROBE=/opt/homebrew/bin/ffprobe \
npm start
```

Expected: Settings shows 4/8/12/16 without overflow at the default and minimum window sizes; 8 is selected for a fresh Apple Silicon user-data directory; relaunch preserves an explicit selection.

- [ ] **Step 5: Benchmark Batch 4 and 8 on the same local source**

Use `/Volumes/futures/table tennis/7月21日.mp4` and `/Users/xkkx6/Downloads/TrackNet_best.pt`. Run this command first with `TTCUT_BENCH_BATCH=4`, then as a separate command with `TTCUT_BENCH_BATCH=8`:

```bash
PYTHONPATH=worker TTCUT_BENCH_BATCH=4 /Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -c 'import hashlib,json,os; from dataclasses import asdict; from ttcut_worker.model import load_tracknet; from ttcut_worker.predictor import TrackNetPredictor; batch=int(os.environ["TTCUT_BENCH_BATCH"]); loaded=load_tracknet("/Users/xkkx6/Downloads/TrackNet_best.pt", "auto"); points,info,stats=TrackNetPredictor(loaded,batch_size=batch).predict("/Volumes/futures/table tennis/7月21日.mp4"); payload=json.dumps([asdict(point) for point in points],sort_keys=True,separators=(",",":")); print(json.dumps({"batch":batch,"frames":info.decoded_frame_count,"fps":stats.average_inference_fps,"sha256":hashlib.sha256(payload.encode()).hexdigest()}))'
```

```bash
PYTHONPATH=worker TTCUT_BENCH_BATCH=8 /Users/xkkx6/Documents/TTcut-apple-silicon-dev-port/.venv312/bin/python -c 'import hashlib,json,os; from dataclasses import asdict; from ttcut_worker.model import load_tracknet; from ttcut_worker.predictor import TrackNetPredictor; batch=int(os.environ["TTCUT_BENCH_BATCH"]); loaded=load_tracknet("/Users/xkkx6/Downloads/TrackNet_best.pt", "auto"); points,info,stats=TrackNetPredictor(loaded,batch_size=batch).predict("/Volumes/futures/table tennis/7月21日.mp4"); payload=json.dumps([asdict(point) for point in points],sort_keys=True,separators=(",",":")); print(json.dumps({"batch":batch,"frames":info.decoded_frame_count,"fps":stats.average_inference_fps,"sha256":hashlib.sha256(payload.encode()).hexdigest()}))'
```

Expected: both runs report 67,368 decoded frames and the same trajectory hash. Record both FPS values and report the measured result instead of assuming Batch 8 wins.

- [ ] **Step 6: Commit verification coverage**

```bash
git add tests/e2e/real-workflow.spec.ts
git commit -m "test: cover inference batch workflow"
```

- [ ] **Step 7: Final branch review**

Run: `git status --short`

Expected: clean worktree.

Run: `git log --oneline --decorate -6`

Expected: the design commit followed by five focused implementation commits.

Review `git diff codex/apple-silicon-dev-port...HEAD` for unrelated changes, platform regressions, and accidental generated files before pushing or updating the existing pull request.
