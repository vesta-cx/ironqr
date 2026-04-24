import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Effect } from 'effect';
import { readBenchImage } from '../../../../tools/bench/src/shared/image.js';
import { scanFrame } from '../../src/index.js';
import { normalizeImageInput } from '../../src/pipeline/frame.js';
import { rescueVersionsFromFinders } from '../../src/pipeline/geometry.js';
import { generateProposals, rankProposals } from '../../src/pipeline/proposals.js';
import { createViewBank } from '../../src/pipeline/views.js';

interface ManifestAsset {
  readonly id: string;
  readonly relativePath: string;
  readonly groundTruth?: {
    readonly qrCount: number;
    readonly codes: ReadonlyArray<{
      readonly text: string;
    }>;
  };
}

const repoRoot = path.resolve(import.meta.dir, '../../../../');
const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'corpus/data/manifest.json'), 'utf8'),
) as { readonly assets: readonly ManifestAsset[] };

const getManifestAsset = (id: string): ManifestAsset => {
  const asset = manifest.assets.find((entry) => entry.id === id);
  if (!asset) throw new Error(`Missing corpus asset ${id}`);
  return asset;
};

const loadRankedProposals = async (id: string) => {
  const asset = getManifestAsset(id);
  const image = await readBenchImage(path.join(repoRoot, 'corpus/data', asset.relativePath));
  const frame = await Effect.runPromise(normalizeImageInput(image));
  const viewBank = createViewBank(frame);
  return rankProposals(viewBank, generateProposals(viewBank));
};

describe('corpus-derived version rescue regressions', () => {
  it('widens the version search enough to include the Version 25 corpus symbol', async () => {
    const proposals = await loadRankedProposals('asset-19c43addce501fb1');
    const proposal = proposals.find((entry) => entry.kind === 'finder-triple');
    expect(proposal).toBeDefined();
    if (!proposal || proposal.kind !== 'finder-triple') return;

    const rescueVersions = rescueVersionsFromFinders(proposal.finders, proposal.estimatedVersions);
    expect(rescueVersions.some((version) => version >= 24)).toBe(true);
  });

  it('widens low initial estimates enough to include a higher-capacity version candidate', async () => {
    const proposals = await loadRankedProposals('asset-1184fc75626fdbe9');
    const proposal = proposals.find((entry) => entry.kind === 'finder-triple');
    expect(proposal).toBeDefined();
    if (!proposal || proposal.kind !== 'finder-triple') return;

    expect(proposal.estimatedVersions).toEqual([1, 2, 3]);
    const rescueVersions = rescueVersionsFromFinders(proposal.finders, proposal.estimatedVersions);
    expect(rescueVersions).toContain(5);
  });
});

describe('corpus-derived decode regressions', () => {
  it('decodes the SaniSale photo that previously failed in the accuracy report', async () => {
    const asset = getManifestAsset('asset-e94cb1a1e0173763');
    const image = await readBenchImage(path.join(repoRoot, 'corpus/data', asset.relativePath));
    const results = await scanFrame(image, {
      allowMultiple: (asset.groundTruth?.qrCount ?? 0) > 1,
    });

    expect(results.map((result) => result.payload.text)).toContain('http://www.sanisale.com/');
  });
});
