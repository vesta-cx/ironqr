import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as S from 'effect/Schema';
import sharp from 'sharp';
import { isEnoentError } from '../fs-error.js';
import { classifyLicense } from '../license.js';
import {
  ensureCorpusLayout,
  getBenchmarkExportPath,
  getPerfbenchFixtureAssetsRoot,
  getPerfbenchFixtureManifestPath,
  getPerfbenchFixtureRoot,
  readCorpusManifest,
  toRepoRelativePath,
} from '../manifest.js';
import type { CorpusAsset, RealWorldBenchmarkCorpus, RealWorldBenchmarkEntry } from '../schema.js';
import { RealWorldBenchmarkCorpusSchema } from '../schema.js';

/** Result of writing a real-world benchmark corpus file. */
export interface WriteRealWorldBenchmarkCorpusResult {
  readonly outputPath: string;
  readonly corpus: RealWorldBenchmarkCorpus;
}

/** An approved corpus asset enriched with image dimensions for the bench-selection UI. */
export interface BenchEligibleAsset {
  readonly id: string;
  readonly label: RealWorldBenchmarkEntry['label'];
  readonly assetPath: string;
  readonly previewPath: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly qrCount: number | null;
  readonly textSnippet: string | null;
}

const decodeRealWorldBenchmarkCorpus = S.decodeUnknownSync(RealWorldBenchmarkCorpusSchema);

const confirmedLicenseForAsset = (asset: CorpusAsset): string | undefined => {
  if (asset.licenseReview?.confirmedLicense) {
    return asset.licenseReview.confirmedLicense;
  }

  return asset.provenance.find((source) => source.kind === 'remote' || source.kind === 'local')
    ?.license;
};

const toBenchmarkEntry = (repoRoot: string, asset: CorpusAsset): RealWorldBenchmarkEntry => {
  const remoteSource = asset.provenance.find((source) => source.kind === 'remote');
  const confirmedLicense = confirmedLicenseForAsset(asset);

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
    ...(confirmedLicense ? { confirmedLicense } : {}),
    ...(remoteSource?.attribution ? { attribution: remoteSource.attribution } : {}),
    ...(asset.groundTruth ? { groundTruth: asset.groundTruth } : {}),
    ...(asset.autoScan ? { autoScan: asset.autoScan } : {}),
  };
};

/** Build the full real-world benchmark corpus from all approved assets and write it to disk. */
export const writeRealWorldBenchmarkCorpus = async (
  repoRoot: string,
): Promise<WriteRealWorldBenchmarkCorpusResult> => {
  const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);
  await ensureCorpusLayout(repoRoot);
  const outputPath = getBenchmarkExportPath(repoRoot);
  await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  return { outputPath, corpus };
};

/** Build the real-world benchmark corpus object from all approved corpus assets (without writing). */
export const buildRealWorldBenchmarkCorpus = async (
  repoRoot: string,
): Promise<RealWorldBenchmarkCorpus> => {
  const manifest = await readCorpusManifest(repoRoot);

  const entries = manifest.assets
    .filter((asset) => asset.review.status === 'approved')
    .map((asset) => toBenchmarkEntry(repoRoot, asset))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    positives: entries.filter((entry) => entry.label === 'qr-pos'),
    negatives: entries.filter((entry) => entry.label === 'qr-neg'),
  };
};

/** List all approved corpus assets with image dimensions, suitable for the bench-selection UI. */
export const listBenchEligibleAssets = async (
  repoRoot: string,
): Promise<readonly BenchEligibleAsset[]> => {
  const manifest = await readCorpusManifest(repoRoot);
  const approvedAssets = manifest.assets
    .filter((asset) => asset.review.status === 'approved')
    .sort((left, right) => left.id.localeCompare(right.id));

  return Promise.all(
    approvedAssets.map(async (asset) => {
      const previewPath = path.join(repoRoot, 'corpus', 'data', asset.relativePath);
      const metadata = await sharp(previewPath).metadata();
      if (metadata.width === undefined || metadata.height === undefined) {
        throw new Error(`Missing image dimensions for ${asset.id}: ${previewPath}`);
      }
      const firstCode = asset.groundTruth?.codes[0];

      return {
        id: asset.id,
        label: asset.label,
        assetPath: toRepoRelativePath(repoRoot, previewPath),
        previewPath,
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        width: metadata.width,
        height: metadata.height,
        qrCount: asset.groundTruth?.qrCount ?? null,
        textSnippet: firstCode ? firstCode.text : null,
      } satisfies BenchEligibleAsset;
    }),
  );
};

/** Read the committed perfbench fixture manifest; returns an empty corpus when not yet written. */
export const readRealWorldBenchmarkFixture = async (
  repoRoot: string,
): Promise<RealWorldBenchmarkCorpus> => {
  const fixturePath = getPerfbenchFixtureManifestPath(repoRoot);

  try {
    const raw = await readFile(fixturePath, 'utf8');
    try {
      return decodeRealWorldBenchmarkCorpus(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `Failed to decode benchmark corpus at ${fixturePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    if (isEnoentError(error)) {
      return { positives: [], negatives: [] };
    }

    throw error;
  }
};

/** Generate an `ATTRIBUTION.md` string for benchmark entries that require attribution. */
export const generateAttributionMd = (entries: readonly RealWorldBenchmarkEntry[]): string => {
  const needsAttribution = entries.filter((e) => {
    const license = e.confirmedLicense;
    if (!license) return false;
    const tier = classifyLicense(license);
    // Public domain / CC0 need no attribution; everything else does
    return tier !== 'restricted' && !/public.?domain|cc0/i.test(license);
  });

  if (needsAttribution.length === 0) {
    const hasUnknownLicense = entries.some((e) => !e.confirmedLicense);
    return hasUnknownLicense
      ? '# Attribution\n\nLicensing not confirmed for all assets. Verify before distributing.\n'
      : '# Attribution\n\nAll images in this fixture are in the public domain or CC0.\n';
  }

  const lines: string[] = [
    '# Attribution',
    '',
    'The following images in this perfbench fixture require attribution under their respective licenses.',
    'IronQR is open-source software (MCX License). Non-commercial (NC) licenses are used only for testing.',
    '',
    '| Asset | License | Source | Author |',
    '|-------|---------|--------|--------|',
  ];

  for (const entry of needsAttribution) {
    const file = path.basename(entry.assetPath);
    const license = entry.confirmedLicense ?? 'Unknown';
    const source = entry.sourcePageUrl ? `[source](${entry.sourcePageUrl})` : '—';
    const author = entry.attribution ?? '—';
    lines.push(`| \`${file}\` | ${license} | ${source} | ${author} |`);
  }

  lines.push('');
  return lines.join('\n');
};

/**
 * Write the committed perfbench fixture for a selected subset of approved corpus assets.
 * Atomically replaces the fixture directory and regenerates `ATTRIBUTION.md`.
 */
export const writeSelectedRealWorldBenchmarkFixture = async (
  repoRoot: string,
  assetIds: readonly string[],
): Promise<WriteRealWorldBenchmarkCorpusResult> => {
  const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);
  const entryById = new Map(
    [...corpus.positives, ...corpus.negatives].map((entry) => [entry.id, entry] as const),
  );
  const selectedEntries = [...new Set(assetIds)].map((assetId) => {
    const entry = entryById.get(assetId);
    if (!entry) {
      throw new Error(`Unknown bench asset: ${assetId}`);
    }
    return entry;
  });

  const fixtureRoot = getPerfbenchFixtureRoot(repoRoot);
  const tmpRoot = `${fixtureRoot}.tmp`;
  const fixtureAssetsRoot = getPerfbenchFixtureAssetsRoot(repoRoot);
  const tmpAssetsRoot = path.join(tmpRoot, path.relative(fixtureRoot, fixtureAssetsRoot));
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpAssetsRoot, { recursive: true });

  const copiedEntries = await Promise.all(
    selectedEntries.map(async (entry) => {
      const sourcePath = path.join(repoRoot, entry.assetPath);
      const extension = path.extname(sourcePath) || '.webp';
      const finalTargetPath = path.join(fixtureAssetsRoot, `${entry.id}${extension}`);
      const tmpTargetPath = path.join(tmpAssetsRoot, `${entry.id}${extension}`);
      await copyFile(sourcePath, tmpTargetPath);

      return {
        ...entry,
        assetPath: toRepoRelativePath(repoRoot, finalTargetPath),
      } satisfies RealWorldBenchmarkEntry;
    }),
  );

  const nextCorpus: RealWorldBenchmarkCorpus = {
    positives: copiedEntries
      .filter((entry) => entry.label === 'qr-pos')
      .sort((left, right) => left.id.localeCompare(right.id)),
    negatives: copiedEntries
      .filter((entry) => entry.label === 'qr-neg')
      .sort((left, right) => left.id.localeCompare(right.id)),
  };

  const outputPath = getPerfbenchFixtureManifestPath(repoRoot);
  const tmpManifestPath = path.join(tmpRoot, path.relative(fixtureRoot, outputPath));
  await writeFile(tmpManifestPath, `${JSON.stringify(nextCorpus, null, 2)}\n`, 'utf8');

  const allEntries = [...nextCorpus.positives, ...nextCorpus.negatives];
  const attributionMd = generateAttributionMd(allEntries);
  await writeFile(path.join(tmpRoot, 'ATTRIBUTION.md'), attributionMd, 'utf8');

  await rm(fixtureRoot, { recursive: true, force: true });
  await rename(tmpRoot, fixtureRoot);

  return { outputPath, corpus: nextCorpus };
};
