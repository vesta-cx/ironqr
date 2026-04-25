import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAccuracyCacheStore } from '../../src/accuracy/cache.js';
import type { AccuracyEngine, CorpusBenchAsset } from '../../src/accuracy/types.js';
import {
  openPerformanceCacheStore,
  type PerformanceCacheKey,
  performanceOptionsKey,
} from '../../src/performance/cache.js';
import type { PerformanceIterationResult } from '../../src/performance/runner.js';
import { openStudyCache } from '../../src/study/cache.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempFile = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironqr-bench-cache-'));
  tempDirs.push(dir);
  return path.join(dir, 'accuracy-cache.json');
};

const asset: CorpusBenchAsset = {
  id: 'asset-1',
  assetId: 'asset-1',
  label: 'qr-pos',
  sha256: 'sha-a',
  imagePath: '/tmp/asset-1.png',
  relativePath: 'assets/asset-1.png',
  expectedTexts: [],
  loadImage: async () => ({
    path: '/tmp/asset-1.png',
    width: 1,
    height: 1,
    data: new Uint8ClampedArray(4),
    colorSpace: 'srgb',
  }),
};

const cacheableEngine: AccuracyEngine = {
  id: 'jsqr',
  kind: 'third-party',
  capabilities: {
    multiCode: false,
    inversion: 'native',
    rotation: 'native',
    runtime: 'js',
  },
  cache: {
    enabled: true,
    version: 'adapter-v1',
  },
  availability: () => ({ available: true, reason: null }),
  scan: async () => ({
    status: 'decoded',
    attempted: true,
    succeeded: true,
    results: [{ text: 'HELLO' }],
    failureReason: null,
    error: null,
  }),
};

describe('study cache', () => {
  it('batches writes until an explicit flush', async () => {
    const file = await makeTempFile();
    const firstStore = await openStudyCache<{ readonly value: number }>({
      enabled: true,
      refresh: false,
      file,
    });

    await firstStore.write(asset, 'row-1', { value: 1 });
    const beforeFlush = await openStudyCache<{ readonly value: number }>({
      enabled: true,
      refresh: false,
      file,
    });
    expect(await beforeFlush.read(asset, 'row-1')).toBeNull();

    await firstStore.flush();
    expect(JSON.parse(await Bun.file(file).text()).version).toBe(2);
    const afterFlush = await openStudyCache<{ readonly value: number }>({
      enabled: true,
      refresh: false,
      file,
    });
    expect(await afterFlush.read(asset, 'row-1')).toEqual({ value: 1 });
  });

  it('reads v1 snapshots and migrates them on flush', async () => {
    const file = await makeTempFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          [`${asset.id}:row-1`]: {
            assetId: asset.id,
            assetSha256: asset.sha256,
            cacheKey: 'row-1',
            result: { value: 1 },
          },
        },
      }),
    );
    const store = await openStudyCache<{ readonly value: number }>({
      enabled: true,
      refresh: false,
      file,
    });
    expect(await store.read(asset, 'row-1')).toEqual({ value: 1 });
    await store.write(asset, 'row-2', { value: 2 });
    await store.flush();
    const migrated = JSON.parse(await Bun.file(file).text());
    expect(migrated.version).toBe(2);
    expect(migrated.assets[asset.id].entries['row-1']).toEqual({ value: 1 });
    expect(migrated.assets[asset.id].entries['row-2']).toEqual({ value: 2 });
  });
});

describe('accuracy cache', () => {
  it('round-trips a cached third-party result with duration', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
      'default',
    );
    await firstStore.save();

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    const hit = secondStore.read(cacheableEngine, asset, 'default');
    expect(hit).not.toBeNull();
    expect(hit?.scan.results).toEqual([{ text: 'HELLO' }]);
    expect(hit?.durationMs).toBe(42.75);
    expect(secondStore.summary()).toMatchObject({ hits: 1, misses: 0, writes: 0 });
  });

  it('persists a cache write immediately without waiting for save()', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
      'default',
    );

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(secondStore.read(cacheableEngine, asset, 'default')?.durationMs).toBe(42.75);
  });

  it('invalidates a cached result when the asset hash changes', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
      'default',
    );
    await firstStore.save();

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    const miss = secondStore.read(cacheableEngine, { ...asset, sha256: 'sha-b' }, 'default');
    expect(miss).toBeNull();
    expect(secondStore.summary()).toMatchObject({ hits: 0, misses: 1, writes: 0 });
  });

  it('invalidates a cached result when run options change', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
      'trace:off',
    );
    await firstStore.save();

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    const miss = secondStore.read(cacheableEngine, asset, 'trace:summary');
    expect(miss).toBeNull();
    expect(secondStore.summary()).toMatchObject({ hits: 0, misses: 1, writes: 0 });
  });

  it('skips cache reads when refresh is requested', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
      'default',
    );
    await firstStore.save();

    const refreshedStore = await openAccuracyCacheStore(file, { enabled: true, refresh: true });
    expect(refreshedStore.read(cacheableEngine, asset, 'default')).toBeNull();
    expect(refreshedStore.summary()).toMatchObject({ hits: 0, misses: 1, writes: 0 });
  });

  it('can disable cache access for one engine', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
      'default',
    );
    await firstStore.save();

    const disabledStore = await openAccuracyCacheStore(file, {
      enabled: true,
      refresh: false,
      disabledEngineIds: [cacheableEngine.id],
    });
    expect(disabledStore.isEnabledFor(cacheableEngine)).toBe(false);
    expect(disabledStore.read(cacheableEngine, asset, 'default')).toBeNull();
    await disabledStore.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'WORLD' }],
        failureReason: null,
        error: null,
      },
      99,
      'default',
    );

    const enabledStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(enabledStore.read(cacheableEngine, asset, 'default')?.scan.results).toEqual([
      { text: 'HELLO' },
    ]);
  });

  it('opens malformed cache files as empty cache snapshots', async () => {
    const file = await makeTempFile();
    await writeFile(file, '{not-json', 'utf8');

    const store = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(store.read(cacheableEngine, asset, 'default')).toBeNull();
    expect(store.summary()).toMatchObject({ hits: 0, misses: 1, writes: 0 });
  });

  it('opens structurally invalid cache files as empty cache snapshots', async () => {
    const file = await makeTempFile();
    await writeFile(
      file,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries: [] }),
      'utf8',
    );

    const store = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(store.read(cacheableEngine, asset, 'default')).toBeNull();
    expect(store.summary()).toMatchObject({ hits: 0, misses: 1, writes: 0 });
  });

  it('evicts a queued write using the latest serialized cache snapshot', async () => {
    const file = await makeTempFile();
    const store = await openAccuracyCacheStore(file, { enabled: true, refresh: false });

    await Promise.all([
      store.write(
        cacheableEngine,
        asset,
        {
          status: 'decoded',
          attempted: true,
          succeeded: true,
          results: [{ text: 'HELLO' }],
          failureReason: null,
          error: null,
        },
        42.75,
        'default',
      ),
      store.evict(cacheableEngine, asset),
    ]);

    expect(store.read(cacheableEngine, asset, 'default')).toBeNull();
  });

  it('evicts a cached engine result', async () => {
    const file = await makeTempFile();
    const store = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await store.write(
      cacheableEngine,
      asset,
      {
        status: 'decoded',
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
      'default',
    );
    await store.evict(cacheableEngine, asset);

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(secondStore.read(cacheableEngine, asset, 'default')).toBeNull();
  });
});

describe('performance cache', () => {
  it('returns hits as cached results so performance can skip scan work', async () => {
    const file = await makeTempFile();
    const optionsKey = performanceOptionsKey({
      iterations: 1,
      seed: 'cache-smoke',
      filters: { maxAssets: 1 },
    });
    const key: PerformanceCacheKey = {
      engineId: 'ironqr',
      engineVersion: 'live-pass-v1',
      assetId: asset.id,
      assetSha256: asset.sha256,
      iteration: 1,
      optionsKey,
    };
    const result: PerformanceIterationResult = {
      iteration: 1,
      assetId: asset.id,
      label: asset.label,
      engineId: 'ironqr',
      outcome: 'pass',
      bucket: 'pos-pass',
      imageLoadDurationMs: 2,
      warmupDurationMs: null,
      engineScanDurationMs: 10,
      totalJobDurationMs: 12,
      cached: false,
      ironqrSpans: [{ name: 'normalize', durationMs: 1 }],
    };

    const firstStore = await openPerformanceCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(key, result);
    await firstStore.save();

    const secondStore = await openPerformanceCacheStore(file, { enabled: true, refresh: false });
    const hit = secondStore.read(key);

    expect(hit).toMatchObject({ cached: true, engineScanDurationMs: 10 });
    expect(hit?.ironqrSpans?.[0]?.name).toBe('normalize');
    expect(secondStore.summary()).toMatchObject({ hits: 1, misses: 0, writes: 0 });
  });

  it('can refresh one performance cache engine without evicting other engines', async () => {
    const file = await makeTempFile();
    const optionsKey = performanceOptionsKey({ iterations: 1, seed: null, filters: {} });
    const makeKey = (engineId: string): PerformanceCacheKey => ({
      engineId,
      engineVersion: 'adapter-v1',
      assetId: asset.id,
      assetSha256: asset.sha256,
      iteration: 1,
      optionsKey,
    });
    const makeResult = (engineId: string): PerformanceIterationResult => ({
      iteration: 1,
      assetId: asset.id,
      label: asset.label,
      engineId,
      outcome: 'pass',
      bucket: 'pos-pass',
      imageLoadDurationMs: 1,
      warmupDurationMs: null,
      engineScanDurationMs: 5,
      totalJobDurationMs: 6,
      cached: false,
    });

    const firstStore = await openPerformanceCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(makeKey('ironqr'), makeResult('ironqr'));
    await firstStore.write(makeKey('jsqr'), makeResult('jsqr'));
    await firstStore.save();

    const refreshedStore = await openPerformanceCacheStore(file, {
      enabled: true,
      refresh: false,
      refreshEngineId: 'ironqr',
    });

    expect(refreshedStore.read(makeKey('ironqr'))).toBeNull();
    expect(refreshedStore.read(makeKey('jsqr'))?.cached).toBe(true);
    expect(refreshedStore.summary()).toMatchObject({ hits: 1, misses: 1, writes: 0 });
  });
});
