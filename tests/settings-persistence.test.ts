import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../src/shared/contracts';

const electronControl = vi.hoisted(() => ({ userData: '' }));
const fsControl = {
  blockedBatch: undefined as number | undefined,
  blockedStarted: undefined as (() => void) | undefined,
  failBatch: undefined as number | undefined,
  releaseBlocked: undefined as (() => void) | undefined,
  writes: [] as number[],
};

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => electronControl.userData) },
}));

import { loadSettings, saveSettings, waitForPendingSettingsWrites } from '../src/main/settings';

function settings(inferenceBatchSize: 4 | 8 | 12 | 16): AppSettings {
  return {
    language: 'zh-CN',
    pre_roll_seconds: 2.5,
    post_roll_seconds: 2,
    inference_batch_size: inferenceBatchSize,
  };
}

function blockBatch(inferenceBatchSize: number) {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  fsControl.blockedBatch = inferenceBatchSize;
  fsControl.blockedStarted = markStarted;
  return {
    started,
    release: () => {
      fsControl.blockedBatch = undefined;
      fsControl.releaseBlocked?.();
    },
  };
}

async function controlledWriteFile(filePath: string, contents: string): Promise<void> {
  const batch = (JSON.parse(contents) as { inference_batch_size: number }).inference_batch_size;
  fsControl.writes.push(batch);
  if (batch === fsControl.blockedBatch) {
    fsControl.blockedStarted?.();
    await new Promise<void>((resolve) => { fsControl.releaseBlocked = resolve; });
  }
  if (batch === fsControl.failBatch) {
    fsControl.failBatch = undefined;
    throw new Error('controlled settings write failure');
  }
  await writeFile(filePath, contents, 'utf8');
}

describe('settings persistence queue', () => {
  beforeEach(() => {
    electronControl.userData = mkdtempSync(path.join(os.tmpdir(), 'ttcut-settings-'));
    fsControl.blockedBatch = undefined;
    fsControl.blockedStarted = undefined;
    fsControl.failBatch = undefined;
    fsControl.releaseBlocked = undefined;
    fsControl.writes = [];
  });

  afterEach(async () => {
    fsControl.releaseBlocked?.();
    await waitForPendingSettingsWrites();
    rmSync(electronControl.userData, { recursive: true, force: true });
  });

  it('strictly validates before enqueueing a write', async () => {
    expect(() => saveSettings({ ...settings(8), inference_batch_size: 6 }, controlledWriteFile)).toThrow();
    await expect(waitForPendingSettingsWrites()).resolves.toBeUndefined();
    expect(fsControl.writes).toEqual([]);
  });

  it('persists concurrent calls in invocation order and resolves every call', async () => {
    const blocked = blockBatch(8);
    const saves = [
      saveSettings(settings(8), controlledWriteFile),
      saveSettings(settings(12), controlledWriteFile),
      saveSettings(settings(16), controlledWriteFile),
    ];

    await blocked.started;
    expect(fsControl.writes).toEqual([8]);
    blocked.release();

    await expect(Promise.all(saves)).resolves.toEqual([settings(8), settings(12), settings(16)]);
    expect(fsControl.writes).toEqual([8, 12, 16]);
    expect(JSON.parse(readFileSync(path.join(electronControl.userData, 'settings.json'), 'utf8'))).toEqual(settings(16));
  });

  it('waits for the latest pending write before loading settings', async () => {
    mkdirSync(electronControl.userData, { recursive: true });
    writeFileSync(path.join(electronControl.userData, 'settings.json'), JSON.stringify(settings(4)), 'utf8');
    const blocked = blockBatch(16);
    const saves = [
      saveSettings(settings(8), controlledWriteFile),
      saveSettings(settings(12), controlledWriteFile),
      saveSettings(settings(16), controlledWriteFile),
    ];

    await blocked.started;
    let loadResolved = false;
    const loaded = loadSettings().then((value) => {
      loadResolved = true;
      return value;
    });
    await Promise.resolve();
    expect(loadResolved).toBe(false);

    blocked.release();
    await expect(Promise.all(saves)).resolves.toBeDefined();
    await expect(loaded).resolves.toEqual(settings(16));
  });

  it('continues after one write fails and exposes a non-rejecting drain', async () => {
    fsControl.failBatch = 8;

    const failed = saveSettings(settings(8), controlledWriteFile);
    const succeeded = saveSettings(settings(12), controlledWriteFile);

    await expect(failed).rejects.toThrow('controlled settings write failure');
    await expect(succeeded).resolves.toEqual(settings(12));
    await expect(waitForPendingSettingsWrites()).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(electronControl.userData, 'settings.json'), 'utf8'))).toEqual(settings(12));
  });
});
