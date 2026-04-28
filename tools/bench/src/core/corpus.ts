import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchImageData } from '../shared/image.js';
import { readBenchImage } from '../shared/image.js';

export type CorpusAssetLabel = 'qr-pos' | 'qr-neg';

const CORPUS_MANIFEST_VERSION = 1;

export interface BenchCorpusManifestAsset {
  readonly id: string;
  readonly label: CorpusAssetLabel;
  readonly sha256: string;
  readonly relativePath: string;
  readonly review: {
    readonly status: string;
  };
  readonly groundTruth?: {
    readonly codes: readonly { readonly text: string }[];
  };
}

interface CorpusManifest {
  readonly version: number;
  readonly assets: readonly BenchCorpusManifestAsset[];
}

export interface BenchCorpusAsset {
  readonly id: string;
  readonly assetId: string;
  readonly label: CorpusAssetLabel;
  readonly sha256: string;
  readonly imagePath: string;
  readonly relativePath: string;
  readonly expectedTexts: readonly string[];
  readonly loadImage: () => Promise<BenchImageData>;
}

export interface BenchCorpusSelectionOptions {
  readonly assetIds?: readonly string[];
  readonly labels?: readonly CorpusAssetLabel[];
  readonly maxAssets?: number | null;
  readonly seed?: string | null;
  readonly filters?: Record<string, unknown>;
  readonly generateSeedWhenSampling?: boolean;
}

export interface BenchCorpusSelection {
  readonly seed: string | null;
  readonly assetIds: readonly string[];
  readonly labels: readonly CorpusAssetLabel[];
  readonly maxAssets: number | null;
  readonly filters: Record<string, unknown>;
}

export interface BenchCorpusLoadResult {
  readonly manifestPath: string;
  readonly manifestAssetCount: number;
  readonly approvedAssetCount: number;
  readonly assets: readonly BenchCorpusAsset[];
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly selection: BenchCorpusSelection;
}

export const getBenchCorpusManifestPath = (repoRoot: string): string =>
  path.join(repoRoot, 'corpus', 'data', 'manifest.json');

export const loadBenchCorpusAssets = async (
  repoRoot: string,
  options: BenchCorpusSelectionOptions = {},
): Promise<BenchCorpusLoadResult> => {
  const manifestPath = getBenchCorpusManifestPath(repoRoot);
  const manifest = await readBenchCorpusManifest(manifestPath);
  const selection = resolveBenchCorpusSelection(options);
  const approved = manifest.assets.filter((asset) => asset.review.status === 'approved');
  const selected = sampleBenchCorpusAssets(approved, selection);
  const assets = selected.map((asset) => toBenchCorpusAsset(repoRoot, asset));
  const positiveCount = assets.filter((asset) => asset.label === 'qr-pos').length;

  return {
    manifestPath,
    manifestAssetCount: manifest.assets.length,
    approvedAssetCount: approved.length,
    assets,
    positiveCount,
    negativeCount: assets.length - positiveCount,
    selection,
  };
};

export const resolveBenchCorpusSelection = (
  options: BenchCorpusSelectionOptions = {},
): BenchCorpusSelection => {
  const maxAssets = options.maxAssets ?? null;
  const shouldGenerateSeed =
    options.generateSeedWhenSampling !== false && options.seed === undefined && maxAssets !== null;
  const seed = shouldGenerateSeed ? crypto.randomUUID() : (options.seed ?? null);
  const filters = {
    assetIds: options.assetIds ?? [],
    labels: options.labels ?? [],
    maxAssets,
    ...(options.filters ?? {}),
  };

  return {
    seed,
    assetIds: options.assetIds ?? [],
    labels: options.labels ?? [],
    maxAssets,
    filters,
  };
};

export const sampleBenchCorpusAssets = (
  assets: readonly BenchCorpusManifestAsset[],
  selection: BenchCorpusSelection,
): readonly BenchCorpusManifestAsset[] => {
  let selected = [...assets];
  if (selection.assetIds.length > 0) {
    const requested = new Set(selection.assetIds);
    selected = selected.filter((asset) => requested.has(asset.id));
  }
  if (selection.labels.length > 0) {
    const labels = new Set(selection.labels);
    selected = selected.filter((asset) => labels.has(asset.label));
  }
  if (selection.maxAssets !== null && selected.length > selection.maxAssets) {
    selected = stableSeededShuffle(selected, selection.seed ?? crypto.randomUUID()).slice(
      0,
      selection.maxAssets,
    );
  }
  return selected;
};

export const stableSeededShuffle = <T>(values: readonly T[], seed: string): readonly T[] => {
  const random = seededRandom(seed);
  return values
    .map((value) => ({ value, sort: random() }))
    .sort((left, right) => left.sort - right.sort)
    .map((entry) => entry.value);
};

const toBenchCorpusAsset = (
  repoRoot: string,
  asset: BenchCorpusManifestAsset,
): BenchCorpusAsset => {
  const imagePath = path.join(repoRoot, 'corpus', 'data', asset.relativePath);
  return {
    id: asset.id,
    assetId: asset.id,
    label: asset.label,
    sha256: asset.sha256,
    imagePath,
    relativePath: asset.relativePath,
    expectedTexts: asset.groundTruth?.codes.map((code) => code.text) ?? [],
    loadImage: () => readBenchImage(imagePath),
  };
};

const readBenchCorpusManifest = async (manifestPath: string): Promise<CorpusManifest> => {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isCorpusManifest(parsed)) {
    throw new Error(`Invalid corpus manifest: ${manifestPath}`);
  }
  if (parsed.version > CORPUS_MANIFEST_VERSION) {
    throw new Error(
      `Incompatible corpus manifest version: ${parsed.version}; bench supports ${CORPUS_MANIFEST_VERSION}.`,
    );
  }
  return parsed;
};

const isCorpusManifest = (value: unknown): value is CorpusManifest => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CorpusManifest>;
  return typeof candidate.version === 'number' && Array.isArray(candidate.assets);
};

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const seededRandom = (seed: string): (() => number) => {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};
