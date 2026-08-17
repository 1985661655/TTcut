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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return appSettingsSchema.parse(value);
  }

  if (Object.hasOwn(value, 'inference_batch_size')) {
    return appSettingsSchema.parse(value);
  }

  return appSettingsSchema.parse({
    ...value,
    inference_batch_size: defaultAppSettings(platform, architecture).inference_batch_size,
  });
}
