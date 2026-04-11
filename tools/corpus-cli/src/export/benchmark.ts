import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ensureCorpusLayout,
  getBenchmarkExportPath,
  readCorpusManifest,
  toRepoRelativePath,
} from '../manifest.js';
import type { RealWorldBenchmarkCorpus, RealWorldBenchmarkEntry } from '../schema.js';

export interface WriteRealWorldBenchmarkCorpusResult {
  readonly outputPath: string;
  readonly corpus: RealWorldBenchmarkCorpus;
}

export const writeRealWorldBenchmarkCorpus = async (
  repoRoot: string,
): Promise<WriteRealWorldBenchmarkCorpusResult> => {
  const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);
  await ensureCorpusLayout(repoRoot);
  const outputPath = getBenchmarkExportPath(repoRoot);
  await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  return { outputPath, corpus };
};

export const buildRealWorldBenchmarkCorpus = async (
  repoRoot: string,
): Promise<RealWorldBenchmarkCorpus> => {
  const manifest = await readCorpusManifest(repoRoot);

  const entries: RealWorldBenchmarkEntry[] = manifest.assets
    .filter((asset) => asset.review.status === 'approved')
    .map((asset) => {
      const remoteSource = asset.provenance.find((source) => source.kind === 'remote');

      return {
        id: asset.id,
        label: asset.label,
        assetPath: toRepoRelativePath(
          repoRoot,
          path.join(repoRoot, 'corpus', 'data', asset.relativePath),
        ),
        sha256: asset.sha256,
        byteLength: asset.byteLength,
        mediaType: asset.mediaType,
        ...(remoteSource?.sourcePageUrl ? { sourcePageUrl: remoteSource.sourcePageUrl } : {}),
        ...(asset.licenseReview?.confirmedLicense
          ? { confirmedLicense: asset.licenseReview.confirmedLicense }
          : {}),
        ...(asset.groundTruth ? { groundTruth: asset.groundTruth } : {}),
        ...(asset.autoScan ? { autoScan: asset.autoScan } : {}),
      };
    });

  return {
    positives: entries.filter((entry) => entry.label === 'qr-positive'),
    negatives: entries.filter((entry) => entry.label === 'non-qr-negative'),
  };
};
