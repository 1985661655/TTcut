import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseOutputPath, pathExists, publishOutput } from '../src/main/output-path';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'ttcut-output-path-'));
  temporaryDirectories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('export output paths', () => {
  it('reports whether a path exists', async () => {
    const root = await temporaryDirectory();
    const existing = path.join(root, 'match.mp4');
    await writeFile(existing, 'video', 'utf8');

    await expect(pathExists(existing)).resolves.toBe(true);
    await expect(pathExists(path.join(root, 'missing.mp4'))).resolves.toBe(false);
  });

  it('propagates filesystem errors other than a missing path', async () => {
    await expect(pathExists('\0')).rejects.toThrow();
  });

  it.each([
    ['match.mp4', 'match_ALcut.mp4'],
    ['IMG_7818.MOV', 'IMG_7818_ALcut.mp4'],
  ])('chooses a fixed MP4 output for %s', async (inputName, outputName) => {
    const root = await temporaryDirectory();

    await expect(chooseOutputPath(path.join(root, inputName))).resolves.toBe(path.join(root, outputName));
  });

  it('increments the suffix without overwriting existing outputs', async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, 'IMG_7818_ALcut.mp4'), 'first', 'utf8');
    await writeFile(path.join(root, 'IMG_7818_ALcut_2.mp4'), 'second', 'utf8');

    await expect(chooseOutputPath(path.join(root, 'IMG_7818.MOV')))
      .resolves.toBe(path.join(root, 'IMG_7818_ALcut_3.mp4'));
  });

  it('treats a dangling symlink as an occupied output path', async () => {
    const root = await temporaryDirectory();
    await symlink(
      path.join(root, 'missing-target.mp4'),
      path.join(root, 'IMG_7818_ALcut.mp4'),
      'file',
    );

    await expect(chooseOutputPath(path.join(root, 'IMG_7818.MOV')))
      .resolves.toBe(path.join(root, 'IMG_7818_ALcut_2.mp4'));
  });

  it('rejects a concurrent output without overwriting its contents', async () => {
    const root = await temporaryDirectory();
    const output = await chooseOutputPath(path.join(root, 'IMG_7818.MOV'));
    const partial = path.join(root, '.IMG_7818_ALcut.task.partial.mp4');
    await writeFile(partial, 'completed export', 'utf8');
    await writeFile(output, 'concurrent export', 'utf8');

    await expect(publishOutput(partial, output)).rejects.toThrow('OUTPUT_COLLISION');
    await expect(readFile(output, 'utf8')).resolves.toBe('concurrent export');
  });

  it('publishes the complete partial and removes the partial path', async () => {
    const root = await temporaryDirectory();
    const partial = path.join(root, '.IMG_7818_ALcut.task.partial.mp4');
    const output = path.join(root, 'IMG_7818_ALcut.mp4');
    await writeFile(partial, 'complete export contents', 'utf8');

    await publishOutput(partial, output);

    await expect(readFile(output, 'utf8')).resolves.toBe('complete export contents');
    await expect(pathExists(partial)).resolves.toBe(false);
  });
});
