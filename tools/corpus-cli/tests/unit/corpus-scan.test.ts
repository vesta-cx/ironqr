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

const corpusAssetPath = (name: string): string =>
  path.resolve(import.meta.dir, '../../../../corpus/data/assets', name);

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

  it('decodes the dotted Wi-Fi corpus asset', async () => {
    const result = await scanLocalImageFile(corpusAssetPath('asset-96574ac1e248e5a1.webp'));

    expect(result.succeeded).toBe(true);
    expect(result.results[0]?.text).toBe('WIFI:S:wi_dje21_MJ_308;T:WPA;P:9qo7x3xf5!#;H:false;;');
  });

  it.skip('dense version-25 corpus asset needs the slow hard-case scanner path outside corpus-cli smoke coverage', async () => {
    const result = await scanLocalImageFile(corpusAssetPath('asset-19c43addce501fb1.webp'));

    expect(result.succeeded).toBe(true);
    expect(result.results[0]?.text.startsWith('Version 25 QR Code')).toBe(true);
  }, 30_000);
});
