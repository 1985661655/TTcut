# MOV Input Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept iPhone `.mov` files throughout TTcut while exporting every result as a non-overwriting `<source>_ALcut.mp4` file.

**Architecture:** Centralize TypeScript extension, container, picker, and MIME decisions in a small main-process video-format module. Mirror the same two-extension allowlist at the Python process boundary, preserve the actual source container in metadata, and isolate output naming in a filesystem-aware helper. Keep the current direct OpenCV/FFmpeg path because the real HEVC Main 10 iPhone sample already decodes locally; do not add source-wide transcoding.

**Tech Stack:** Electron, TypeScript, React, Zod, Vitest, Python 3.12, pytest, FFmpeg/FFprobe, OpenCV.

---

### Task 1: TypeScript Video Format Boundary

**Files:**
- Create: `src/main/video-format.ts`
- Create: `tests/video-format.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/probe.ts`
- Modify: `src/main/media-protocol.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `tests/contracts.test.ts`

- [ ] **Step 1: Write failing format and contract tests**

Add table-driven tests that define the accepted extensions, source container,
preview MIME, picker extensions, and metadata contract:

```ts
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_VIDEO_PICKER_EXTENSIONS,
  mediaContentTypeForPath,
  videoContainerForPath,
} from '../src/main/video-format';

describe('video input formats', () => {
  it.each([
    ['match.mp4', 'mp4', 'video/mp4'],
    ['IMG_7818.MOV', 'mov', 'video/quicktime'],
  ])('accepts %s', (filePath, container, contentType) => {
    expect(videoContainerForPath(filePath)).toBe(container);
    expect(mediaContentTypeForPath(filePath)).toBe(contentType);
  });

  it('rejects extensions outside the explicit allowlist', () => {
    expect(videoContainerForPath('match.mkv')).toBeNull();
  });

  it('provides both native picker extensions', () => {
    expect(SUPPORTED_VIDEO_PICKER_EXTENSIONS).toEqual(['mp4', 'mov']);
  });
});
```

Extend `tests/contracts.test.ts` with a complete valid `videoMetadataSchema`
value whose `path` is `IMG_7818.MOV` and `container` is `mov`; assert it parses.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx vitest run tests/video-format.test.ts tests/contracts.test.ts
```

Expected: FAIL because `src/main/video-format.ts` does not exist and the metadata
contract accepts only `mp4`.

- [ ] **Step 3: Implement the shared TypeScript boundary**

Create `src/main/video-format.ts` with one case-insensitive source of truth:

```ts
import path from 'node:path';

export const SUPPORTED_VIDEO_PICKER_EXTENSIONS = ['mp4', 'mov'] as const;
export type VideoContainer = 'mp4' | 'mov';
export type VideoContentType = 'video/mp4' | 'video/quicktime';

export function videoContainerForPath(filePath: string): VideoContainer | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.mp4') return 'mp4';
  if (extension === '.mov') return 'mov';
  return null;
}

export function mediaContentTypeForPath(filePath: string): VideoContentType {
  return videoContainerForPath(filePath) === 'mov' ? 'video/quicktime' : 'video/mp4';
}
```

Use `videoContainerForPath()` in `selectedVideo()` and `probeVideo()` to reject
unsupported paths. Change the native dialog to title `Select MP4 or MOV video`
and filter `{ name: 'MP4 or MOV video', extensions: [...SUPPORTED_VIDEO_PICKER_EXTENSIONS] }`.

Expand `videoMetadataSchema.container` to `z.enum(['mp4', 'mov'])`. In
`probeVideo()`, write the validated source container instead of the hard-coded
`mp4`. In `registerMediaPath()`, infer `video/mp4` or `video/quicktime` when the
caller does not explicitly pass `image/jpeg`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/video-format.test.ts tests/contracts.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the TypeScript boundary**

```bash
git add src/main/video-format.ts src/main/index.ts src/main/probe.ts \
  src/main/media-protocol.ts src/shared/contracts.ts \
  tests/video-format.test.ts tests/contracts.test.ts
git commit -m "feat: accept MOV video inputs"
```

### Task 2: Python MOV Analysis Boundary

**Files:**
- Create: `worker/tests/test_video.py`
- Modify: `worker/tests/test_analysis.py`
- Modify: `worker/ttcut_worker/video.py`
- Modify: `worker/ttcut_worker/worker.py`

- [ ] **Step 1: Write failing Python tests**

Create files in `tmp_path` and define the required path behavior:

```py
from pathlib import Path

import pytest

from ttcut_worker.errors import VideoError
from ttcut_worker.video import validate_video_path


@pytest.mark.parametrize("name", ["match.mp4", "IMG_7818.MOV"])
def test_validate_video_path_accepts_supported_extensions(tmp_path: Path, name: str):
    source = tmp_path / name
    source.write_bytes(b"video")
    assert validate_video_path(source) == source.resolve()


def test_validate_video_path_rejects_other_extensions(tmp_path: Path):
    source = tmp_path / "match.mkv"
    source.write_bytes(b"video")
    with pytest.raises(VideoError, match="MP4 or MOV"):
        validate_video_path(source)
```

Add `test_worker_request_accepts_mov_video()` in `test_analysis.py` by replacing
`valid_request()["video_path"]` with `IMG_7818.MOV` and asserting
`validate_request()` returns it.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
PYTHONPATH=worker .venv312/bin/python -m pytest \
  worker/tests/test_video.py worker/tests/test_analysis.py -q
```

Expected: FAIL because `validate_video_path` is not defined and MOV requests are
rejected.

- [ ] **Step 3: Implement Python extension support**

In `video.py`, replace `validate_mp4_path` with:

```py
SUPPORTED_VIDEO_SUFFIXES = {".mp4", ".mov"}


def validate_video_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if path.suffix.lower() not in SUPPORTED_VIDEO_SUFFIXES:
        raise VideoError("Only one MP4 or MOV video is supported.")
    if not path.is_file():
        raise VideoError(f"Video file does not exist: {path}")
    return path.resolve()
```

Call it from `probe_video()` and make the three decoder errors container-neutral.
In `worker.py`, accept suffixes in `{'.mp4', '.mov'}` at request validation and
return `info.path.suffix.lower().lstrip('.')` as the worker result container.

- [ ] **Step 4: Run Python focused and full tests**

Run:

```bash
PYTHONPATH=worker .venv312/bin/python -m pytest \
  worker/tests/test_video.py worker/tests/test_analysis.py -q
PYTHONPATH=worker .venv312/bin/python -m pytest worker/tests -q
```

Expected: focused tests and the complete Python suite pass.

- [ ] **Step 5: Commit the Python boundary**

```bash
git add worker/ttcut_worker/video.py worker/ttcut_worker/worker.py \
  worker/tests/test_video.py worker/tests/test_analysis.py
git commit -m "feat: analyze MOV videos"
```

### Task 3: Fixed ALcut MP4 Output Naming

**Files:**
- Create: `src/main/output-path.ts`
- Create: `tests/output-path.test.ts`
- Modify: `src/main/export.ts`

- [ ] **Step 1: Write failing output-path tests**

Use a temporary directory to prove MP4 and MOV sources produce MP4 outputs and
existing exports are skipped:

```ts
it.each([
  ['match.mp4', 'match_ALcut.mp4'],
  ['IMG_7818.MOV', 'IMG_7818_ALcut.mp4'],
])('names %s as %s', async (source, expected) => {
  expect(path.basename(await chooseOutputPath(path.join(root, source)))).toBe(expected);
});

it('increments the suffix without overwriting', async () => {
  await writeFile(path.join(root, 'IMG_7818_ALcut.mp4'), 'existing');
  await writeFile(path.join(root, 'IMG_7818_ALcut_2.mp4'), 'existing');
  expect(path.basename(await chooseOutputPath(path.join(root, 'IMG_7818.MOV'))))
    .toBe('IMG_7818_ALcut_3.mp4');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run tests/output-path.test.ts
```

Expected: FAIL because `chooseOutputPath` does not exist.

- [ ] **Step 3: Implement isolated naming and wire export**

Create `src/main/output-path.ts`:

```ts
import { access } from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

export async function chooseOutputPath(input: string): Promise<string> {
  const directory = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  let suffix = 1;
  while (true) {
    const marker = suffix === 1 ? '' : `_${suffix}`;
    const candidate = path.join(directory, `${base}_ALcut${marker}.mp4`);
    if (!(await pathExists(candidate))) return candidate;
    suffix += 1;
  }
}
```

Remove the private naming loop from `export.ts`, import the two helpers, and use
`chooseOutputPath(analysis.video.path)`. Keep the UUID `.partial.mp4`, collision
recheck, and atomic rename behavior unchanged.

- [ ] **Step 4: Run output, export, and type tests**

Run:

```bash
npx vitest run tests/output-path.test.ts tests/media-export.integration.test.ts \
  tests/media-plan.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit output naming**

```bash
git add src/main/output-path.ts src/main/export.ts tests/output-path.test.ts
git commit -m "feat: export ALcut MP4 files"
```

### Task 4: Renderer Copy and Documentation

**Files:**
- Create: `tests/i18n.test.ts`
- Modify: `src/renderer/i18n.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/e2e/real-workflow.spec.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/ffmpeg-strategy.md`
- Modify: `docs/release-notes-v1.0.0.md`

- [ ] **Step 1: Write failing copy tests**

Assert both languages describe the supported input and the renderer no longer
promises MP4-only input:

```ts
import { describe, expect, it } from 'vitest';
import { messages } from '../src/renderer/i18n';

describe('video input copy', () => {
  it('mentions MP4 and MOV in Chinese', () => {
    expect(messages('zh-CN').chooseVideo).toBe('选择 MP4 或 MOV 视频');
    expect(messages('zh-CN').errors.INVALID_INPUT).toContain('MP4 或 MOV');
  });

  it('mentions MP4 and MOV in English', () => {
    expect(messages('en').chooseVideo).toBe('Choose MP4 or MOV video');
    expect(messages('en').errors.INVALID_INPUT).toContain('MP4 or MOV');
  });
});
```

- [ ] **Step 2: Run the copy test and verify RED**

Run:

```bash
npx vitest run tests/i18n.test.ts
```

Expected: FAIL with the old MP4-only strings.

- [ ] **Step 3: Update UI and documentation**

Change selection descriptions, choose/drop labels, invalid-file text, and error
messages in both languages from MP4-only to MP4-or-MOV. Change the drop-zone
extension hint in `App.tsx` to `.mp4 / .mov`. Update E2E button selectors to
`/选择 MP4 或 MOV 视频/`.

Update user-facing documentation so inputs are MP4/MOV and outputs are always
`_ALcut.mp4`, including collision examples. Preserve historical design-plan text
that documents already-completed work; change active README, architecture,
FFmpeg strategy, release notes, and live E2E expectations only.

- [ ] **Step 4: Run renderer tests and stale-copy scan**

Run:

```bash
npx vitest run tests/i18n.test.ts tests/renderer-settings.test.tsx
rg -n "only accepts.*MP4|只接受.*MP4|选择 MP4 视频|_ttcut" \
  README.md src tests/e2e docs/architecture.md docs/ffmpeg-strategy.md \
  docs/release-notes-v1.0.0.md
```

Expected: tests pass; the scan returns no stale active MP4-only input or `_ttcut`
output copy.

- [ ] **Step 5: Commit copy and docs**

```bash
git add src/renderer/i18n.ts src/renderer/App.tsx tests/i18n.test.ts \
  tests/e2e/real-workflow.spec.ts README.md docs/architecture.md \
  docs/ffmpeg-strategy.md docs/release-notes-v1.0.0.md
git commit -m "docs: describe MOV input workflow"
```

### Task 5: Full Verification and Installed App Smoke Test

**Files:**
- Modify only if a verification failure reveals a scoped defect.

- [ ] **Step 1: Run all automated verification**

```bash
npm run typecheck
npm test
PYTHONPATH=worker .venv312/bin/python -m pytest worker/tests -q
git diff --check ca41d55...HEAD
```

Expected: TypeScript exits 0, all Vitest and pytest tests pass, and the diff has
no whitespace errors.

- [ ] **Step 2: Probe and decode the real iPhone source**

```bash
/opt/homebrew/bin/ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate \
  -show_entries format=format_name,duration -of json \
  '/Volumes/futures/table tennis/IMG_7818.MOV'

PYTHONPATH=worker .venv312/bin/python -c \
  "from ttcut_worker.video import probe_video; print(probe_video('/Volumes/futures/table tennis/IMG_7818.MOV'))"
```

Expected: FFprobe reports HEVC Main 10, 1920x1080 and MOV-compatible format;
Python returns `VideoInfo` without an exception.

- [ ] **Step 3: Refresh and restart the clickable application**

Run `npm run install:macos-launcher`, stop the existing launcher process group
using the verified PID from `~/Library/Application Support/TTcut/launcher.pid`,
then run `open /Applications/TTcut.app`.

Expected: one TTcut process starts without a Terminal window and the TTcut window
becomes visible.

- [ ] **Step 4: Exercise the real MOV in the UI**

Select `/Volumes/futures/table tennis/IMG_7818.MOV` through the app, then verify:

- selection screen says MP4 or MOV
- calibration screen shows `1920 x 1080`
- the video element reaches `loadedmetadata` and has a nonzero frame
- no renderer or main-process error is logged

Do not run full model inference as part of this format smoke test.

- [ ] **Step 5: Review, commit any verification-only correction, and push**

Run a final diff review against `ca41d55`, confirm `git status --short` is clean,
and push `codex/apple-silicon-dev-port` to update the existing pull request.
