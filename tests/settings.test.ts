import { describe, expect, it } from 'vitest';
import { appSettingsSchema } from '../src/shared/contracts';
import { defaultAppSettings, normalizeStoredSettings } from '../src/main/settings-values';

const baseSettings = {
  language: 'en',
  pre_roll_seconds: 1.5,
  post_roll_seconds: 0.5,
} as const;

describe('app settings', () => {
  it.each([4, 8, 12, 16])('accepts inference batch size %i', (inferenceBatchSize) => {
    expect(appSettingsSchema.parse({
      ...baseSettings,
      inference_batch_size: inferenceBatchSize,
    })).toEqual({
      ...baseSettings,
      inference_batch_size: inferenceBatchSize,
    });
  });

  it.each([0, 6, 32])('rejects inference batch size %i', (inferenceBatchSize) => {
    expect(() => appSettingsSchema.parse({
      ...baseSettings,
      inference_batch_size: inferenceBatchSize,
    })).toThrow();
  });

  it('uses a larger default batch on Apple Silicon', () => {
    expect(defaultAppSettings('darwin', 'arm64').inference_batch_size).toBe(8);
    expect(defaultAppSettings('darwin', 'x64').inference_batch_size).toBe(4);
    expect(defaultAppSettings('win32', 'x64').inference_batch_size).toBe(4);
  });

  it('adds the platform default batch to legacy settings without losing fields', () => {
    expect(normalizeStoredSettings(baseSettings, 'darwin', 'arm64')).toEqual({
      ...baseSettings,
      inference_batch_size: 8,
    });
  });

  it('preserves an explicit inference batch size', () => {
    expect(normalizeStoredSettings({
      ...baseSettings,
      inference_batch_size: 12,
    }, 'darwin', 'arm64').inference_batch_size).toBe(12);
  });
});
