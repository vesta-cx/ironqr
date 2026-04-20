import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const TEST_TMP_DIR = path.join(import.meta.dir, '.tmp');

export const makeTestDir = async (label: string): Promise<string> => {
  const dir = path.join(
    TEST_TMP_DIR,
    `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
};
