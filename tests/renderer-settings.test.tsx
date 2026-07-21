import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTcutApi, BootstrapData } from '../src/shared/api';
import type { AppSettings } from '../src/shared/contracts';
import { App } from '../src/renderer/App';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
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

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});

describe('renderer settings updates', () => {
  it('disables settings controls until bootstrap completes', async () => {
    const pendingBootstrap = deferred<BootstrapData>();
    const saveSettings = vi.fn(async (settings: AppSettings) => settings);
    const api = {
      bootstrap: vi.fn(() => pendingBootstrap.promise),
      saveSettings,
      onTaskEvent: vi.fn(() => () => undefined),
      onCloseRequested: vi.fn(() => () => undefined),
    } as unknown as TTcutApi;
    Object.defineProperty(window, 'ttcut', { configurable: true, value: api });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    const batchCard = screen.getByRole('heading', { name: '推理批量' }).closest('article')!;
    const preRollCard = screen.getByRole('heading', { name: '回合前时间' }).closest('article')!;
    const postRollCard = screen.getByRole('heading', { name: '回合后时间' }).closest('article')!;
    const controls = [
      screen.getByRole('button', { name: '简体中文' }),
      screen.getByRole('button', { name: 'English' }),
      ...within(batchCard).getAllByRole('button'),
      ...within(preRollCard).getAllByRole('button'),
      ...within(postRollCard).getAllByRole('button'),
    ];

    for (const control of controls) {
      expect(control).toBeDisabled();
      fireEvent.click(control);
    }
    expect(saveSettings).not.toHaveBeenCalled();

    await act(async () => { pendingBootstrap.resolve(bootstrapData); });
    for (const control of controls) await waitFor(() => expect(control).toBeEnabled());
  });

  it('serializes saves, merges the latest intent, and ignores stale results', async () => {
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
      await act(async () => {
        if (index === 1) pendingSaves[index]!.reject(new Error('disk write failed'));
        else pendingSaves[index]!.resolve(expected);
      });
      if (index < expectedSaves.length - 1) {
        await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(index + 2));
        expect(batch12).toHaveAttribute('aria-pressed', 'true');
      }
    }

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(batch12).toHaveClass('selected');
    expect(batch12).toHaveAttribute('aria-pressed', 'true');
  });

  it('rolls back the latest failed save, reports it, and keeps the queue usable', async () => {
    const failedSave = deferred<AppSettings>();
    let saveAttempt = 0;
    const saveSettings = vi.fn((settings: AppSettings): Promise<AppSettings> => {
      saveAttempt += 1;
      return saveAttempt === 1 ? failedSave.promise : Promise.resolve(settings);
    });
    const api = {
      bootstrap: vi.fn(async () => bootstrapData),
      saveSettings,
      onTaskEvent: vi.fn(() => () => undefined),
      onCloseRequested: vi.fn(() => () => undefined),
    } as unknown as TTcutApi;
    Object.defineProperty(window, 'ttcut', { configurable: true, value: api });
    document.documentElement.lang = 'zh-CN';

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const batchCard = screen.getByRole('heading', { name: '推理批量' }).closest('article')!;
    const batch8 = within(batchCard).getByRole('button', { name: /推荐\s*8/ });

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'English' })).toHaveClass('selected');
    expect(document.querySelector('.language-loader')).toBeInTheDocument();

    await act(async () => { failedSave.reject(new Error('disk write failed')); });

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('设置未保存，请重试。'));
    await waitFor(() => expect(document.querySelector('.language-loader')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '简体中文' })).toHaveClass('selected');
    expect(document.documentElement.lang).toBe('zh-CN');

    fireEvent.click(batch8);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(batch8).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
