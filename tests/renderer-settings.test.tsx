import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTcutApi, BootstrapData } from '../src/shared/api';
import type { AppSettings } from '../src/shared/contracts';
import { App } from '../src/renderer/App';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const initialSettings: AppSettings = {
  language: 'zh-CN',
  pre_roll_seconds: 2.5,
  post_roll_seconds: 2,
  inference_batch_size: 4,
};

const bootstrapData: BootstrapData = {
  version: '1.0.0',
  settings: initialSettings,
  components: {
    analysis: { available: true, version: 'test', path: '/analysis', acceleration: 'cpu', detail: null },
    media: { available: true, version: 'test', path: '/media', detail: null },
  },
  componentSetup: { analysis_offer: null, media_offer: null },
  platformCompatibility: {
    status: 'supported',
    reason: 'supported',
    platform: 'win32',
    architecture: 'x64',
    build_number: 19045,
    installation_type: 'Client',
  },
  logsPath: '/logs',
};

afterEach(() => cleanup());

describe('renderer settings updates', () => {
  it('serializes saves, merges the latest intent, and ignores stale responses', async () => {
    const pendingSaves: Array<ReturnType<typeof deferred<AppSettings>>> = [];
    const saveSettings = vi.fn((settings: AppSettings): Promise<AppSettings> => {
      const pending = deferred<AppSettings>();
      pendingSaves.push(pending);
      return pending.promise;
    });
    const api = {
      bootstrap: vi.fn(async () => bootstrapData),
      saveSettings,
      onTaskEvent: vi.fn(() => () => undefined),
      onCloseRequested: vi.fn(() => () => undefined),
    } as unknown as TTcutApi;
    Object.defineProperty(window, 'ttcut', { configurable: true, value: api });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    const batchCard = screen.getByRole('heading', { name: '推理批量' }).closest('article')!;
    const preRollCard = screen.getByRole('heading', { name: '回合前时间' }).closest('article')!;
    const postRollCard = screen.getByRole('heading', { name: '回合后时间' }).closest('article')!;
    const batch8 = within(batchCard).getByRole('button', { name: /推荐\s*8/ });
    const batch12 = within(batchCard).getByRole('button', { name: /更快\s*12/ });

    fireEvent.click(batch8);
    fireEvent.click(batch12);
    fireEvent.click(within(preRollCard).getByRole('button', { name: /短\s*1\.5 s/ }));
    fireEvent.click(within(postRollCard).getByRole('button', { name: /极短\s*0\.5 s/ }));
    fireEvent.click(screen.getByRole('button', { name: 'English' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'English' })).toHaveClass('selected'));
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenNthCalledWith(1, { ...initialSettings, inference_batch_size: 8 });
    expect(batch12).toHaveAttribute('aria-pressed', 'true');

    const expectedSaves: AppSettings[] = [
      { ...initialSettings, inference_batch_size: 8 },
      { ...initialSettings, inference_batch_size: 12 },
      { ...initialSettings, inference_batch_size: 12, pre_roll_seconds: 1.5 },
      { ...initialSettings, inference_batch_size: 12, pre_roll_seconds: 1.5, post_roll_seconds: 0.5 },
      { language: 'en', inference_batch_size: 12, pre_roll_seconds: 1.5, post_roll_seconds: 0.5 },
    ];

    for (let index = 0; index < expectedSaves.length; index += 1) {
      const expected = expectedSaves[index]!;
      expect(saveSettings).toHaveBeenNthCalledWith(index + 1, expected);
      await act(async () => { pendingSaves[index]!.resolve(expected); });
      if (index < expectedSaves.length - 1) {
        await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(index + 2));
        expect(batch12).toHaveAttribute('aria-pressed', 'true');
      }
    }

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible());
    expect(batch12).toHaveClass('selected');
    expect(batch12).toHaveAttribute('aria-pressed', 'true');
  });
});
