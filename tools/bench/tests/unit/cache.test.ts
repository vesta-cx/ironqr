import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAccuracyCacheStore } from '../../src/accuracy/cache.js';
import type { AccuracyEngine, CorpusBenchAsset } from '../../src/accuracy/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempFile = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ironqr-bench-cache-'));
  tempDirs.push(dir);
  return path.join(dir, 'accuracy-cache.json');
};

const asset: Pick<CorpusBenchAsset, 'id' | 'label' | 'sha256' | 'relativePath'> = {
  id: 'asset-1',
  label: 'qr-positive',
  sha256: 'sha-a',
  relativePath: 'assets/asset-1.png',
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
    attempted: true,
    succeeded: true,
    results: [{ text: 'HELLO' }],
    failureReason: null,
    error: null,
  }),
};

describe('accuracy cache', () => {
  it('round-trips a cached third-party result with duration', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
    );
    await firstStore.save();

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    const hit = secondStore.read(cacheableEngine, asset);
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
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
    );

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(secondStore.read(cacheableEngine, asset)?.durationMs).toBe(42.75);
  });

  it('invalidates a cached result when the asset hash changes', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
    );
    await firstStore.save();

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    const miss = secondStore.read(cacheableEngine, { ...asset, sha256: 'sha-b' });
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
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
    );
    await firstStore.save();

    const refreshedStore = await openAccuracyCacheStore(file, { enabled: true, refresh: true });
    expect(refreshedStore.read(cacheableEngine, asset)).toBeNull();
    expect(refreshedStore.summary()).toMatchObject({ hits: 0, misses: 1, writes: 0 });
  });

  it('can disable cache access for one engine', async () => {
    const file = await makeTempFile();
    const firstStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await firstStore.write(
      cacheableEngine,
      asset,
      {
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
    );
    await firstStore.save();

    const disabledStore = await openAccuracyCacheStore(file, {
      enabled: true,
      refresh: false,
      disabledEngineIds: [cacheableEngine.id],
    });
    expect(disabledStore.isEnabledFor(cacheableEngine)).toBe(false);
    expect(disabledStore.read(cacheableEngine, asset)).toBeNull();
    await disabledStore.write(
      cacheableEngine,
      asset,
      {
        attempted: true,
        succeeded: true,
        results: [{ text: 'WORLD' }],
        failureReason: null,
        error: null,
      },
      99,
    );

    const enabledStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(enabledStore.read(cacheableEngine, asset)?.scan.results).toEqual([{ text: 'HELLO' }]);
  });

  it('opens malformed cache files as empty cache snapshots', async () => {
    const file = await makeTempFile();
    await writeFile(file, '{not-json', 'utf8');

    const store = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(store.read(cacheableEngine, asset)).toBeNull();
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
    expect(store.read(cacheableEngine, asset)).toBeNull();
    expect(store.summary()).toMatchObject({ hits: 0, misses: 1, writes: 0 });
  });

  it('evicts a cached engine result', async () => {
    const file = await makeTempFile();
    const store = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    await store.write(
      cacheableEngine,
      asset,
      {
        attempted: true,
        succeeded: true,
        results: [{ text: 'HELLO' }],
        failureReason: null,
        error: null,
      },
      42.75,
    );
    await store.evict(cacheableEngine, asset);

    const secondStore = await openAccuracyCacheStore(file, { enabled: true, refresh: false });
    expect(secondStore.read(cacheableEngine, asset)).toBeNull();
  });
});
