import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildRealWorldBenchmarkCorpus } from '../../src/export/benchmark.js';
import { importLocalAssets } from '../../src/import/local.js';
import {
  getCorpusManifestPath,
  readCorpusManifest,
  toRepoRelativePath,
  writeCorpusManifest,
} from '../../src/manifest.js';

const createRepoRoot = async (): Promise<string> => {
  return mkdtemp(path.join(tmpdir(), 'ironqr-corpus-'));
};

const createPngBytes = async (red: number, green: number, blue: number): Promise<Uint8Array> => {
  const buffer = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: red, g: green, b: blue, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  return new Uint8Array(buffer);
};

const writeFixture = async (filePath: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
};

describe('real-world corpus toolkit', () => {
  it('imports local assets into a manifest-driven corpus with provenance and review fields', async () => {
    const repoRoot = await createRepoRoot();
    const positivePath = path.join(repoRoot, 'fixtures', 'positive.png');
    const negativePath = path.join(repoRoot, 'fixtures', 'negative.png');

    await writeFixture(positivePath, await createPngBytes(255, 255, 255));
    await writeFixture(negativePath, await createPngBytes(0, 0, 0));

    await importLocalAssets({
      repoRoot,
      paths: [positivePath],
      label: 'qr-positive',
      reviewStatus: 'approved',
      reviewer: 'mia',
      reviewNotes: 'seed positive',
      attribution: 'self-generated',
      license: 'test-only',
    });
    await importLocalAssets({
      repoRoot,
      paths: [negativePath],
      label: 'non-qr-negative',
    });

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.version).toBe(1);
    expect(manifest.assets).toHaveLength(2);

    const positive = manifest.assets.find((asset) => asset.label === 'qr-positive');
    expect(positive).toBeDefined();
    expect(positive?.review.status).toBe('approved');
    expect(positive?.review.reviewer).toBe('mia');
    const positiveSource = positive?.provenance[0];
    expect(positiveSource?.kind).toBe('local');
    if (positiveSource?.kind !== 'local') {
      throw new Error('expected local provenance');
    }
    expect(positiveSource.originalPath).toBe(path.resolve(positivePath));
    expect(positiveSource.attribution).toBe('self-generated');
    expect(positiveSource.license).toBe('test-only');

    const manifestPath = getCorpusManifestPath(repoRoot);
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).assets).toHaveLength(2);

    await stat(path.join(repoRoot, 'corpus', 'data', positive?.relativePath ?? 'missing'));
  });

  it('keeps pending reviews timestamp-free', async () => {
    const repoRoot = await createRepoRoot();
    const pendingPath = path.join(repoRoot, 'fixtures', 'pending.png');

    await writeFixture(pendingPath, await createPngBytes(10, 20, 30));

    await importLocalAssets({
      repoRoot,
      paths: [pendingPath],
      label: 'non-qr-negative',
      reviewStatus: 'pending',
      reviewer: 'mia',
    });

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets[0]?.review).toEqual({
      status: 'pending',
      reviewer: 'mia',
    });
  });

  it('upgrades pending review metadata when a later dedup import is approved', async () => {
    const repoRoot = await createRepoRoot();
    const firstPath = path.join(repoRoot, 'fixtures', 'pending.png');
    const secondPath = path.join(repoRoot, 'fixtures', 'approved.png');

    const duplicateBytes = await createPngBytes(128, 128, 128);
    await writeFixture(firstPath, duplicateBytes);
    await writeFixture(secondPath, duplicateBytes);

    await importLocalAssets({
      repoRoot,
      paths: [firstPath],
      label: 'qr-positive',
    });

    await importLocalAssets({
      repoRoot,
      paths: [secondPath],
      label: 'qr-positive',
      reviewStatus: 'approved',
      reviewer: 'mia',
      reviewNotes: 'confirmed on second pass',
    });

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]?.review.status).toBe('approved');
    expect(manifest.assets[0]?.review.reviewer).toBe('mia');
    expect(manifest.assets[0]?.review.notes).toBe('confirmed on second pass');

    const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);
    expect(corpus.positives).toHaveLength(1);
  });

  it('fills in missing reviewer metadata on a same-status dedup import', async () => {
    const repoRoot = await createRepoRoot();
    const firstPath = path.join(repoRoot, 'fixtures', 'approved-no-reviewer.png');
    const secondPath = path.join(repoRoot, 'fixtures', 'approved-with-reviewer.png');

    const duplicateBytes = await createPngBytes(200, 200, 200);
    await writeFixture(firstPath, duplicateBytes);
    await writeFixture(secondPath, duplicateBytes);

    await importLocalAssets({
      repoRoot,
      paths: [firstPath],
      label: 'qr-positive',
      reviewStatus: 'approved',
    });

    await importLocalAssets({
      repoRoot,
      paths: [secondPath],
      label: 'qr-positive',
      reviewStatus: 'approved',
      reviewer: 'mia',
      reviewNotes: 'verified on second pass',
    });

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]?.review.status).toBe('approved');
    expect(manifest.assets[0]?.review.reviewer).toBe('mia');
    expect(manifest.assets[0]?.review.notes).toBe('verified on second pass');
  });

  it('keeps the first recorded reviewer on a same-status dedup import with a different reviewer', async () => {
    const repoRoot = await createRepoRoot();
    const firstPath = path.join(repoRoot, 'fixtures', 'approved-mia.png');
    const secondPath = path.join(repoRoot, 'fixtures', 'approved-bob.png');

    const duplicateBytes = await createPngBytes(220, 220, 220);
    await writeFixture(firstPath, duplicateBytes);
    await writeFixture(secondPath, duplicateBytes);

    await importLocalAssets({
      repoRoot,
      paths: [firstPath],
      label: 'qr-positive',
      reviewStatus: 'approved',
      reviewer: 'mia',
    });

    await importLocalAssets({
      repoRoot,
      paths: [secondPath],
      label: 'qr-positive',
      reviewStatus: 'approved',
      reviewer: 'bob',
    });

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets[0]?.review.reviewer).toBe('mia');
  });

  it('refuses to silently flip an already-decided review on a conflicting dedup import', async () => {
    const repoRoot = await createRepoRoot();
    const firstPath = path.join(repoRoot, 'fixtures', 'approved.png');
    const secondPath = path.join(repoRoot, 'fixtures', 'rejected.png');

    const duplicateBytes = await createPngBytes(64, 64, 64);
    await writeFixture(firstPath, duplicateBytes);
    await writeFixture(secondPath, duplicateBytes);

    await importLocalAssets({
      repoRoot,
      paths: [firstPath],
      label: 'qr-positive',
      reviewStatus: 'approved',
    });

    await expect(
      importLocalAssets({
        repoRoot,
        paths: [secondPath],
        label: 'qr-positive',
        reviewStatus: 'rejected',
      }),
    ).rejects.toThrow(/Cannot change review status from approved to rejected/);
  });

  it('dedupes by content hash and keeps provenance unique per source path', async () => {
    const repoRoot = await createRepoRoot();
    const firstPath = path.join(repoRoot, 'fixtures', 'duplicate-a.png');
    const secondPath = path.join(repoRoot, 'fixtures', 'duplicate-b.png');

    const duplicateBytes = await createPngBytes(255, 255, 255);
    await writeFixture(firstPath, duplicateBytes);
    await writeFixture(secondPath, duplicateBytes);

    await importLocalAssets({
      repoRoot,
      paths: [firstPath],
      label: 'qr-positive',
    });
    const secondImport = await importLocalAssets({
      repoRoot,
      paths: [secondPath, secondPath],
      label: 'qr-positive',
    });

    expect(secondImport.imported).toHaveLength(0);
    expect(secondImport.deduped).toHaveLength(2);

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]?.provenance).toHaveLength(2);
    const provenancePaths = manifest.assets[0]?.provenance.map((source) => {
      if (source.kind !== 'local') {
        throw new Error('expected local provenance');
      }
      return source.originalPath;
    });
    expect(provenancePaths).toEqual([path.resolve(firstPath), path.resolve(secondPath)]);
  });

  it('merges corrected provenance metadata when the same source is imported again', async () => {
    const repoRoot = await createRepoRoot();
    const sourcePath = path.join(repoRoot, 'fixtures', 'source.png');

    await writeFixture(sourcePath, await createPngBytes(200, 200, 200));

    await importLocalAssets({
      repoRoot,
      paths: [sourcePath],
      label: 'qr-positive',
      attribution: 'initial-attribution',
      license: 'initial-license',
      provenanceNotes: 'initial notes',
    });
    await importLocalAssets({
      repoRoot,
      paths: [sourcePath],
      label: 'qr-positive',
      attribution: 'self-generated',
      license: 'test-only',
      provenanceNotes: 'verified later',
    });

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets).toHaveLength(1);
    const provenance = manifest.assets[0]?.provenance[0];
    if (!provenance || provenance.kind !== 'local') {
      throw new Error('expected local provenance');
    }

    expect(manifest.assets[0]?.provenance).toEqual([
      {
        kind: 'local',
        originalPath: path.resolve(sourcePath),
        importedAt: provenance.importedAt,
        attribution: 'self-generated',
        license: 'test-only',
        notes: 'verified later',
      },
    ]);
  });

  it('exports only approved assets in benchmark-ready positive and negative groups', async () => {
    const repoRoot = await createRepoRoot();
    const approvedPositivePath = path.join(repoRoot, 'fixtures', 'approved-positive.png');
    const approvedNegativePath = path.join(repoRoot, 'fixtures', 'approved-negative.png');
    const pendingNegativePath = path.join(repoRoot, 'fixtures', 'pending-negative.png');

    await writeFixture(approvedPositivePath, await createPngBytes(255, 255, 255));
    await writeFixture(approvedNegativePath, await createPngBytes(0, 0, 0));
    await writeFixture(pendingNegativePath, await createPngBytes(0, 255, 0));

    await importLocalAssets({
      repoRoot,
      paths: [approvedPositivePath],
      label: 'qr-positive',
      reviewStatus: 'approved',
    });
    await importLocalAssets({
      repoRoot,
      paths: [approvedNegativePath],
      label: 'non-qr-negative',
      reviewStatus: 'approved',
    });
    await importLocalAssets({
      repoRoot,
      paths: [pendingNegativePath],
      label: 'non-qr-negative',
      reviewStatus: 'pending',
    });

    const manifest = await readCorpusManifest(repoRoot);
    const approvedPositive = manifest.assets.find((asset) => asset.label === 'qr-positive');
    if (!approvedPositive) {
      throw new Error('expected approved positive asset');
    }

    await writeCorpusManifest(repoRoot, {
      version: manifest.version,
      assets: manifest.assets.map((asset) =>
        asset.id === approvedPositive.id
          ? {
              ...asset,
              provenance: [
                {
                  kind: 'remote' as const,
                  sourcePageUrl: 'https://example.com/source-page',
                  imageUrl: 'https://cdn.example.com/source.png',
                  fetchedAt: '2026-04-10T12:00:00.000Z',
                  pageTitle: 'Example Source',
                  license: 'CC0',
                },
              ],
              licenseReview: {
                bestEffortLicense: 'CC0',
                confirmedLicense: 'CC0',
                licenseVerifiedBy: 'mia',
                licenseVerifiedAt: '2026-04-10T12:05:00.000Z',
              },
              groundTruth: {
                qrCount: 1,
                codes: [
                  { text: 'https://example.com', kind: 'url', verifiedWith: 'iphone camera' },
                ],
              },
              autoScan: {
                attempted: true,
                succeeded: true,
                results: [{ text: 'https://example.com', kind: 'url' }],
                acceptedAsTruth: true,
              },
            }
          : asset,
      ),
    });

    const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);

    expect(corpus.positives).toHaveLength(1);
    expect(corpus.negatives).toHaveLength(1);
    expect(corpus.positives[0]?.assetPath.startsWith('corpus/data/assets/')).toBe(true);
    expect(corpus.negatives[0]?.assetPath.startsWith('corpus/data/assets/')).toBe(true);
    expect(corpus.positives[0]?.assetPath).toBe(
      toRepoRelativePath(
        repoRoot,
        path.join(repoRoot, 'corpus', 'data', 'assets', `${corpus.positives[0]?.id}.webp`),
      ),
    );
    expect(corpus.positives[0]?.sourcePageUrl).toBe('https://example.com/source-page');
    expect(corpus.positives[0]?.confirmedLicense).toBe('CC0');
    expect(corpus.positives[0]?.groundTruth).toEqual({
      qrCount: 1,
      codes: [{ text: 'https://example.com', kind: 'url', verifiedWith: 'iphone camera' }],
    });
    expect(corpus.positives[0]?.autoScan).toEqual({
      attempted: true,
      succeeded: true,
      results: [{ text: 'https://example.com', kind: 'url' }],
      acceptedAsTruth: true,
    });
  });
});
