import { describe, expect, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  importLocalAssets,
  writeSelectedRealWorldBenchmarkFixture,
} from 'ironqr-corpus-cli';
import { resolveRepoRootFromModuleUrl } from '../../src/cli.js';
import { runRealWorldBenchmark, scoreRealWorldPositive } from '../../src/real-world-runner.js';
import { makeTestDir } from '../helpers.js';

const createPngBytes = (): Uint8Array => {
  return Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmS0AAAAASUVORK5CYII=',
      'base64',
    ),
  );
};

describe('real-world benchmark runner', () => {
  it('treats a successful scan as passing when no ground truth is present', () => {
    const result = scoreRealWorldPositive(
      {
        id: 'asset-1',
        label: 'qr-positive',
        assetPath: 'tools/perfbench/fixtures/real-world/assets/asset-1.webp',
        sha256: 'abc',
        byteLength: 1,
        mediaType: 'image/webp',
      },
      {
        succeeded: true,
        results: [{ text: 'https://example.com' }],
      },
    );

    expect(result.passed).toBe(true);
    expect(result.expectedText).toBe(null);
    expect(result.error).toBe(null);
  });

  it('reports zero counts when committed fixture is missing and passes exit gate', async () => {
    const repoRoot = await makeTestDir('bench-empty');
    const result = await runRealWorldBenchmark(repoRoot);

    expect(result.positives).toHaveLength(0);
    expect(result.negatives).toHaveLength(0);
    expect(result.decodeRate).toBe(1);
    expect(result.falsePositiveRate).toBe(0);
  });

  it('writes committed perfbench fixture into tools/perfbench/fixtures/real-world', async () => {
    const repoRoot = await makeTestDir('bench-export');
    const fixturePath = path.join(repoRoot, 'fixtures', 'positive.png');
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, createPngBytes());

    await importLocalAssets({
      repoRoot,
      paths: [fixturePath],
      label: 'qr-positive',
      reviewStatus: 'approved',
      reviewer: 'mia',
      groundTruth: {
        qrCount: 1,
        codes: [{ text: 'https://example.com' }],
      },
    });

    const manifestPath = path.join(repoRoot, 'corpus', 'data', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly assets: readonly { readonly id: string }[];
    };
    const { outputPath, corpus } = await writeSelectedRealWorldBenchmarkFixture(
      repoRoot,
      manifest.assets.map((asset) => asset.id),
    );

    expect(outputPath).toBe(
      path.join(repoRoot, 'tools', 'perfbench', 'fixtures', 'real-world', 'manifest.json'),
    );
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(corpus);
  });

  it('derives repo root from perfbench CLI module location', () => {
    expect(
      resolveRepoRootFromModuleUrl(
        'file:///Users/mia/Development/mia-cx/QReader/tools/perfbench/src/cli.ts',
      ),
    ).toBe('/Users/mia/Development/mia-cx/QReader');
  });
});
