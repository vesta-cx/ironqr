import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CorpusBenchAsset } from '../../src/accuracy/types.js';
import { openScannerArtifactCache } from '../../src/study/scanner-artifact-cache.js';
import {
  getOrComputeClusterFrontierArtifacts,
  getOrComputeDecodeOutcomeArtifacts,
  getOrComputeScannerViewArtifacts,
} from '../../src/study/scanner-artifacts.js';

const makeAsset = (): CorpusBenchAsset => {
  const data = new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
  ]);
  return {
    id: 'asset-test',
    assetId: 'asset-test',
    label: 'qr-pos',
    sha256: 'sha-test',
    imagePath: '/dev/null',
    relativePath: 'asset-test.png',
    expectedTexts: ['test'],
    loadImage: async () => ({
      path: '/dev/null',
      width: 2,
      height: 2,
      data,
      colorSpace: 'srgb',
    }),
  } satisfies CorpusBenchAsset;
};

describe('scanner view artifacts', () => {
  it('hydrates normalized, scalar, and binary views from layered artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-artifacts-'));
    try {
      const first = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      const firstArtifacts = await getOrComputeScannerViewArtifacts(makeAsset(), first);
      expect(firstArtifacts.image.width).toBe(2);
      expect(first.summary().layers.normalizedFrame.writes).toBeGreaterThan(0);
      expect(first.summary().layers.scalarViews.writes).toBe(1);
      expect(first.summary().layers.binaryViews.writes).toBe(1);

      const second = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      const secondArtifacts = await getOrComputeScannerViewArtifacts(makeAsset(), second);
      expect(secondArtifacts.image.width).toBe(2);
      expect(secondArtifacts.image.derivedViews.scalarViews.size).toBeGreaterThan(0);
      expect(secondArtifacts.image.derivedViews.binaryViews.size).toBeGreaterThan(0);
      expect(second.summary().layers.normalizedFrame.hits).toBeGreaterThan(0);
      expect(second.summary().layers.scalarViews.hits).toBe(1);
      expect(second.summary().layers.binaryViews.hits).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caches finder evidence, proposal batches, ranked frontiers, and cluster frontiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-artifacts-'));
    try {
      const options = {
        viewIds: ['gray:otsu:normal'] as const,
        maxProposalsPerView: 12,
        detectorPolicy: { enabledFamilies: ['row-scan', 'matcher'] as const },
        maxProposals: 24,
        maxClusterRepresentatives: 1,
      };
      const first = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      const firstArtifacts = await getOrComputeClusterFrontierArtifacts(
        makeAsset(),
        first,
        options,
      );
      expect(firstArtifacts.clusters.length).toBe(0);
      expect(first.summary().layers.finderEvidence.writes).toBe(1);
      expect(first.summary().layers.proposalBatches.writes).toBe(1);
      expect(first.summary().layers.rankedFrontier.writes).toBe(1);
      expect(first.summary().layers.clusterFrontier.writes).toBe(1);

      const second = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      const secondArtifacts = await getOrComputeClusterFrontierArtifacts(
        makeAsset(),
        second,
        options,
      );
      expect(secondArtifacts.clusters.length).toBe(0);
      expect(second.summary().layers.finderEvidence.hits).toBe(0);
      expect(second.summary().layers.proposalBatches.hits).toBe(1);
      expect(second.summary().layers.rankedFrontier.hits).toBe(1);
      expect(second.summary().layers.clusterFrontier.hits).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caches decode outcomes after cluster frontiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-artifacts-'));
    try {
      const options = {
        viewIds: ['gray:otsu:normal'] as const,
        maxProposalsPerView: 12,
        detectorPolicy: { enabledFamilies: ['row-scan', 'matcher'] as const },
        maxProposals: 24,
        maxClusterRepresentatives: 1,
        maxDecodeAttempts: 1,
      };
      const first = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      const firstArtifacts = await getOrComputeDecodeOutcomeArtifacts(makeAsset(), first, options);
      expect(firstArtifacts.decodedTexts).toEqual([]);
      expect(firstArtifacts.attemptCount).toBe(0);
      expect(first.summary().layers.decodeOutcome.writes).toBe(1);

      const second = openScannerArtifactCache({ enabled: true, refresh: false, directory });
      const secondArtifacts = await getOrComputeDecodeOutcomeArtifacts(
        makeAsset(),
        second,
        options,
      );
      expect(secondArtifacts.decodedTexts).toEqual([]);
      expect(second.summary().layers.decodeOutcome.hits).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
