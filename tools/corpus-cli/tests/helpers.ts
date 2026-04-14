import { mkdir } from 'node:fs/promises';
import path from 'node:path';

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
