import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScannerArtifactCache } from '../../src/study/scanner-artifact-cache.js';

describe('scanner artifact cache', () => {
  it('stores JSON artifacts in per-layer files keyed by layer version and config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-artifact-cache-'));
    try {
      const input = {
        layer: 'rankedFrontier' as const,
        assetId: 'asset-1',
        assetSha256: 'sha-1',
        upstreamKey: 'proposal-key',
        config: { rankingVariant: 'timing-heavy' },
      };
      const cache = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      expect(await cache.readJson<{ readonly ok: boolean }>(input)).toBeNull();
      const key = await cache.writeJson(input, { ok: true });
      expect(typeof key).toBe('string');
      expect(await cache.readJson<{ readonly ok: boolean }>(input)).toEqual({ ok: true });
      expect(
        await cache.readJson<{ readonly ok: boolean }>({
          ...input,
          config: { rankingVariant: 'baseline' },
        }),
      ).toBeNull();
      expect(cache.summary().layers.rankedFrontier).toEqual({ hits: 1, misses: 2, writes: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bypasses reads but still writes when refresh is enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-artifact-cache-'));
    try {
      const input = {
        layer: 'decodeOutcome' as const,
        assetId: 'asset-1',
        assetSha256: 'sha-1',
      };
      const priming = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      await priming.writeJson(input, { decoded: false });

      const refresh = openScannerArtifactCache({ enabled: true, refresh: true, directory });
      expect(await refresh.readJson<{ readonly decoded: boolean }>(input)).toBeNull();
      await refresh.writeJson(input, { decoded: true });

      const cache = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      expect(await cache.readJson<{ readonly decoded: boolean }>(input)).toEqual({ decoded: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('disables reads and writes when cache is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-artifact-cache-'));
    try {
      const input = {
        layer: 'binaryViews' as const,
        assetId: 'asset-1',
        assetSha256: 'sha-1',
      };
      const disabled = openScannerArtifactCache({ enabled: false, refresh: false, directory });
      expect(await disabled.writeJson(input, { ignored: true })).toBeNull();
      expect(await disabled.readJson<{ readonly ignored: boolean }>(input)).toBeNull();

      const enabled = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      expect(await enabled.readJson<{ readonly ignored: boolean }>(input)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
