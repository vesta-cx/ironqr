import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRealWorldBenchmarkCorpus } from '../../corpus/export/benchmark.js';
import { importLocalAssets } from '../../corpus/import/local.js';
import {
  getCorpusManifestPath,
  readCorpusManifest,
  toRepoRelativePath,
} from '../../corpus/manifest.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK2cAAAAASUVORK5CYII=',
  'base64',
);
const PNG_1X1_ALT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAusB9Y9sS8sAAAAASUVORK5CYII=',
  'base64',
);

async function createRepoRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'qreader-corpus-'));
}

async function writeFixture(filePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

describe('real-world corpus toolkit', () => {
  it('imports local assets into a manifest-driven corpus with provenance and review fields', async () => {
    const repoRoot = await createRepoRoot();
    const positivePath = path.join(repoRoot, 'fixtures', 'positive.png');
    const negativePath = path.join(repoRoot, 'fixtures', 'negative.png');

    await writeFixture(positivePath, PNG_1X1);
    await writeFixture(negativePath, PNG_1X1_ALT);

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
    expect(positive?.provenance[0]?.originalPath).toBe(path.resolve(positivePath));
    expect(positive?.provenance[0]?.attribution).toBe('self-generated');
    expect(positive?.provenance[0]?.license).toBe('test-only');

    const manifestPath = getCorpusManifestPath(repoRoot);
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).assets).toHaveLength(2);

    await stat(path.join(repoRoot, 'corpus', 'data', positive?.relativePath ?? 'missing'));
  });

  it('dedupes by content hash and keeps provenance unique per source path', async () => {
    const repoRoot = await createRepoRoot();
    const firstPath = path.join(repoRoot, 'fixtures', 'duplicate-a.png');
    const secondPath = path.join(repoRoot, 'fixtures', 'duplicate-b.png');

    await writeFixture(firstPath, PNG_1X1);
    await writeFixture(secondPath, PNG_1X1);

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
    expect(manifest.assets[0]?.provenance.map((source) => source.originalPath)).toEqual([
      path.resolve(firstPath),
      path.resolve(secondPath),
    ]);
  });

  it('exports only approved assets in benchmark-ready positive and negative groups', async () => {
    const repoRoot = await createRepoRoot();
    const approvedPositivePath = path.join(repoRoot, 'fixtures', 'approved-positive.png');
    const approvedNegativePath = path.join(repoRoot, 'fixtures', 'approved-negative.png');
    const pendingNegativePath = path.join(repoRoot, 'fixtures', 'pending-negative.png');

    await writeFixture(approvedPositivePath, PNG_1X1);
    await writeFixture(approvedNegativePath, PNG_1X1_ALT);
    await writeFixture(pendingNegativePath, Buffer.from('another-image'));

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

    const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);

    expect(corpus.positives).toHaveLength(1);
    expect(corpus.negatives).toHaveLength(1);
    expect(corpus.positives[0]?.assetPath.startsWith('corpus/data/assets/')).toBe(true);
    expect(corpus.negatives[0]?.assetPath.startsWith('corpus/data/assets/')).toBe(true);
    expect(corpus.positives[0]?.assetPath).toBe(
      toRepoRelativePath(
        repoRoot,
        path.join(repoRoot, 'corpus', 'data', 'assets', `${corpus.positives[0]?.id}.png`),
      ),
    );
  });
});
