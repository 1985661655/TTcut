import { access } from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function chooseOutputPath(input: string): Promise<string> {
  const directory = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  let suffix = 1;
  while (true) {
    const name = suffix === 1 ? `${base}_ALcut.mp4` : `${base}_ALcut_${suffix}.mp4`;
    const candidate = path.join(directory, name);
    if (!(await pathExists(candidate))) return candidate;
    suffix += 1;
  }
}
