import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import sharp from 'sharp';
import { scanLocalImageFile } from '../../src/scan.js';
import { makeTestDir } from '../helpers.js';

const createBlankPng = async (filePath: string): Promise<void> => {
  await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toFile(filePath);
};

describe('corpus reviewer scan assist', () => {
  it('returns no results for a blank image', async () => {
    const dir = await makeTestDir('corpus-scan');
    const imagePath = path.join(dir, 'blank.png');
    await createBlankPng(imagePath);

    const result = await scanLocalImageFile(imagePath);

    expect(result).toEqual({
      attempted: true,
      succeeded: true,
      results: [],
    });
  });
});
