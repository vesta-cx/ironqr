import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const TEST_TMP_DIR = path.join(import.meta.dir, '.tmp');

/**
 * Creates an isolated temp directory under tests/.tmp/ (not the OS temp dir).
 * Keeps CodeQL's insecure-temporary-file analysis from flagging production writeFile
 * calls that accept a caller-supplied directory path.
 */
export const makeTestDir = async (label: string): Promise<string> => {
  const dir = path.join(
    TEST_TMP_DIR,
    `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
};

/** Create a minimal PNG buffer with the given RGB color. */
export const createPngBytes = async (red: number, green: number, blue: number): Promise<Uint8Array> => {
  const buffer = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: red, g: green, b: blue, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
};

/** Create an isolated repo-root temp directory with `corpus/` pre-created. */
export const createRepoRoot = async (label = 'repo'): Promise<string> => {
  const repoRoot = await makeTestDir(label);
  await mkdir(path.join(repoRoot, 'corpus'), { recursive: true });
  return repoRoot;
};
