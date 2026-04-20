import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { ironqrAccuracyEngine } from '../../src/accuracy/adapters/ironqr.js';
import { jsqrAccuracyEngine } from '../../src/accuracy/adapters/jsqr.js';
import { quircAccuracyEngine } from '../../src/accuracy/adapters/quirc.js';
import { zxingAccuracyEngine } from '../../src/accuracy/adapters/zxing.js';
import { zxingCppAccuracyEngine } from '../../src/accuracy/adapters/zxing-cpp.js';
import {
  listAccuracyEngines,
  scoreNegativeScan,
  scorePositiveScan,
} from '../../src/accuracy/runner.js';

const corpusAssetPath = (name: string): string =>
  path.resolve(import.meta.dir, '../../../../corpus/data/assets', name);

describe('accuracy scoring', () => {
  it('marks a full text match as pass', () => {
    const outcome = scorePositiveScan(['https://example.com'], {
      succeeded: true,
      results: [{ text: 'https://example.com' }],
    });

    expect(outcome.kind).toBe('pass');
    expect(outcome.matchedTexts).toEqual(['https://example.com']);
  });

  it('marks partial multi-code coverage as partial-pass', () => {
    const outcome = scorePositiveScan(['one', 'two'], {
      succeeded: true,
      results: [{ text: 'one' }],
    });

    expect(outcome.kind).toBe('partial-pass');
    expect(outcome.matchedTexts).toEqual(['one']);
  });

  it('marks decoded-but-wrong payloads as mismatch', () => {
    const outcome = scorePositiveScan(['expected'], {
      succeeded: true,
      results: [{ text: 'other' }],
    });

    expect(outcome.kind).toBe('fail-mismatch');
    expect(outcome.decodedTexts).toEqual(['other']);
  });

  it('marks negative decodes as false positives', () => {
    const outcome = scoreNegativeScan({
      succeeded: true,
      results: [{ text: 'oops' }],
    });

    expect(outcome.kind).toBe('false-positive');
    expect(outcome.decodedTexts).toEqual(['oops']);
  });
});

describe('accuracy engine registry', () => {
  it('lists the first-party and third-party benchmark engines', () => {
    expect(listAccuracyEngines().map((engine) => engine.id)).toEqual([
      'ironqr',
      'jsqr',
      'zxing',
      'zxing-cpp',
      'quirc',
    ]);
  });
});

describe('ironqr accuracy adapter', () => {
  it('decodes the dotted Wi-Fi corpus asset', async () => {
    const result = await ironqrAccuracyEngine.scanImage(
      corpusAssetPath('asset-96574ac1e248e5a1.webp'),
    );

    expect(result.succeeded).toBe(true);
    expect(result.results[0]?.text).toBe('WIFI:S:wi_dje21_MJ_308;T:WPA;P:9qo7x3xf5!#;H:false;;');
  }, 20_000);

  it('decodes the dense version-25 corpus asset', async () => {
    const result = await ironqrAccuracyEngine.scanImage(
      corpusAssetPath('asset-19c43addce501fb1.webp'),
    );

    expect(result.succeeded).toBe(true);
    expect(result.results[0]?.text.startsWith('Version 25 QR Code')).toBe(true);
  }, 30_000);
});

describe('third-party accuracy adapters', () => {
  it('jsqr decodes the dense version-25 corpus asset', async () => {
    const result = await jsqrAccuracyEngine.scanImage(
      corpusAssetPath('asset-19c43addce501fb1.webp'),
    );

    expect(result.succeeded).toBe(true);
    expect(result.results[0]?.text.startsWith('Version 25 QR Code')).toBe(true);
  }, 15_000);

  it('zxing decodes the dotted Wi-Fi corpus asset', async () => {
    const result = await zxingAccuracyEngine.scanImage(
      corpusAssetPath('asset-96574ac1e248e5a1.webp'),
    );

    expect(result.succeeded).toBe(true);
    expect(result.results[0]?.text).toBe('WIFI:S:wi_dje21_MJ_308;T:WPA;P:9qo7x3xf5!#;H:false;;');
  }, 15_000);

  it('zxing-cpp decodes multiple links from the social multi-QR asset', async () => {
    const result = await zxingCppAccuracyEngine.scanImage(
      corpusAssetPath('asset-1b0813d0cb4ee7ce.webp'),
    );

    expect(result.succeeded).toBe(true);
    expect(result.results.length).toBeGreaterThanOrEqual(3);
    expect(result.results.some((entry) => entry.text.startsWith('https://api.whatsapp.com/'))).toBe(
      true,
    );
  }, 20_000);

  it('quirc runs against a corpus asset without throwing', async () => {
    const result = await quircAccuracyEngine.scanImage(
      corpusAssetPath('asset-96574ac1e248e5a1.webp'),
    );

    expect(result.succeeded).toBe(true);
    expect(Array.isArray(result.results)).toBe(true);
  }, 15_000);
});
