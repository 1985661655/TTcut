import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { appSettingsSchema, type AppSettings } from '../shared/contracts';
import { defaultAppSettings, normalizeStoredSettings } from './settings-values';

export type SettingsWriteFile = (filePath: string, contents: string) => Promise<void>;

let pendingSettingsWrites: Promise<void> = Promise.resolve();

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<AppSettings> {
  await waitForPendingSettingsWrites();
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as unknown;
    return normalizeStoredSettings(raw);
  } catch {
    return defaultAppSettings();
  }
}

async function writeSettingsFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, 'utf8');
}

export function saveSettings(
  value: unknown,
  writeFileOperation: SettingsWriteFile = writeSettingsFile,
): Promise<AppSettings> {
  const settings = appSettingsSchema.parse(value);
  const write = pendingSettingsWrites.then(async () => {
    const target = settingsPath();
    const temp = `${target}.${process.pid}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFileOperation(temp, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temp, target);
    return settings;
  });
  pendingSettingsWrites = write.then(() => undefined, () => undefined);
  return write;
}

export function waitForPendingSettingsWrites(): Promise<void> {
  return pendingSettingsWrites;
}
