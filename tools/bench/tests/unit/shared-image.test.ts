import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildLuminanceBuffer, readBenchImage } from '../../src/shared/image.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironqr-bench-image-'));
  tempDirs.push(dir);
  return dir;
};

describe('bench image helpers', () => {
  it('composites fully transparent pixels onto white before exposing RGB data', async () => {
    const dir = await makeTempDir();
    const imagePath = path.join(dir, 'transparent.png');
    await sharp(Buffer.from([0, 0, 0, 0]), {
      raw: { width: 1, height: 1, channels: 4 },
    })
      .png()
      .toFile(imagePath);

    const image = await readBenchImage(imagePath);
    expect([...image.data]).toEqual([255, 255, 255, 255]);
    expect([...buildLuminanceBuffer(image)]).toEqual([255]);
  });
});
