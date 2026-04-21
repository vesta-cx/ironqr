import path from 'node:path';
import { readCorpusManifest } from '../../../corpus-cli/src/manifest.js';
import type { CorpusAsset } from '../../../corpus-cli/src/schema.js';
import { barcodeDetectorAccuracyEngine } from './adapters/barcode-detector.js';
import { ironqrAccuracyEngine } from './adapters/ironqr.js';
import { jsqrAccuracyEngine } from './adapters/jsqr.js';
import { quircAccuracyEngine } from './adapters/quirc.js';
import { zbarAccuracyEngine } from './adapters/zbar.js';
import { zxingAccuracyEngine } from './adapters/zxing.js';
import { zxingCppAccuracyEngine } from './adapters/zxing-cpp.js';
import type {
  AccuracyAssetResult,
  AccuracyBenchmarkResult,
  AccuracyEngine,
  AccuracyEngineDescriptor,
  AccuracyEngineSummary,
  EngineAssetResult,
  NegativeOutcome,
  PositiveOutcome,
} from './types.js';

const ACCURACY_ASSET_CONCURRENCY = 4;

const uniqueTexts = (texts: readonly string[]): readonly string[] => {
  return [...new Set(texts)];
};

const mapConcurrent = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  if (values.length === 0) return [];

  const results = new Array<Output>(values.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const value = values[currentIndex];
      if (value === undefined) continue;
      results[currentIndex] = await map(value, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));

  return results;
};

export const expectedTextsFor = (asset: CorpusAsset): readonly string[] => {
  return uniqueTexts(asset.groundTruth?.codes.map((code) => code.text) ?? []);
};

export const scorePositiveScan = (
  expectedTexts: readonly string[],
  scan: {
    readonly succeeded: boolean;
    readonly results: readonly { readonly text: string }[];
    readonly error?: string;
  },
): PositiveOutcome => {
  const decodedTexts = uniqueTexts(scan.results.map((result) => result.text));
  if (!scan.succeeded) {
    return {
      kind: 'fail-error',
      decodedTexts,
      matchedTexts: [],
      expectedTexts,
      error: scan.error ?? 'scan engine failed',
    };
  }
  if (decodedTexts.length === 0) {
    return {
      kind: 'fail-no-decode',
      decodedTexts,
      matchedTexts: [],
      expectedTexts,
      error: null,
    };
  }
  if (expectedTexts.length === 0) {
    return {
      kind: 'pass',
      decodedTexts,
      matchedTexts: [],
      expectedTexts,
      error: null,
    };
  }

  const matchedTexts = expectedTexts.filter((expected) => decodedTexts.includes(expected));
  if (matchedTexts.length === expectedTexts.length) {
    return {
      kind: 'pass',
      decodedTexts,
      matchedTexts,
      expectedTexts,
      error: null,
    };
  }
  if (matchedTexts.length > 0) {
    return {
      kind: 'partial-pass',
      decodedTexts,
      matchedTexts,
      expectedTexts,
      error: null,
    };
  }
  return {
    kind: 'fail-mismatch',
    decodedTexts,
    matchedTexts: [],
    expectedTexts,
    error: null,
  };
};

export const scoreNegativeScan = (scan: {
  readonly succeeded: boolean;
  readonly results: readonly { readonly text: string }[];
  readonly error?: string;
}): NegativeOutcome => {
  const decodedTexts = uniqueTexts(scan.results.map((result) => result.text));
  if (!scan.succeeded) {
    return {
      kind: 'fail-error',
      decodedTexts,
      error: scan.error ?? 'scan engine failed',
    };
  }
  if (decodedTexts.length > 0) {
    return {
      kind: 'false-positive',
      decodedTexts,
      error: null,
    };
  }
  return {
    kind: 'pass',
    decodedTexts,
    error: null,
  };
};

export const listAccuracyEngines = (): readonly AccuracyEngine[] => {
  return [
    ironqrAccuracyEngine,
    jsqrAccuracyEngine,
    zxingAccuracyEngine,
    zxingCppAccuracyEngine,
    quircAccuracyEngine,
    zbarAccuracyEngine,
    barcodeDetectorAccuracyEngine,
  ];
};

const describeEngine = (engine: AccuracyEngine): AccuracyEngineDescriptor => {
  const availability = engine.availability();
  return {
    id: engine.id,
    kind: engine.kind,
    capabilities: engine.capabilities,
    available: availability.available,
    reason: availability.reason,
  };
};

export const inspectAccuracyEngines = (): readonly AccuracyEngineDescriptor[] => {
  return listAccuracyEngines().map(describeEngine);
};

export const resolveAccuracyEngines = (
  engineIds: readonly string[] = [],
): readonly AccuracyEngine[] => {
  const engines = listAccuracyEngines();
  if (engineIds.length === 0) {
    return engines.filter((engine) => engine.availability().available);
  }

  const requested = new Set(engineIds);
  const selected = engines.filter((engine) => requested.has(engine.id));
  if (selected.length !== requested.size) {
    const found = new Set(selected.map((engine) => engine.id));
    const missing = engineIds.filter((engineId) => !found.has(engineId));
    throw new Error(`Unknown accuracy engine(s): ${missing.join(', ')}`);
  }

  const unavailable = selected.filter((engine) => !engine.availability().available);
  if (unavailable.length > 0) {
    const reasons = unavailable.map((engine) => {
      const availability = engine.availability();
      return `${engine.id}: ${availability.reason ?? 'unavailable'}`;
    });
    throw new Error(`Unavailable accuracy engine(s): ${reasons.join('; ')}`);
  }

  return selected;
};

const scoreAssetForEngine = async (
  repoRoot: string,
  asset: CorpusAsset,
  engine: AccuracyEngine,
): Promise<EngineAssetResult> => {
  const imagePath = path.join(repoRoot, 'corpus', 'data', asset.relativePath);
  const scan = await engine.scanImage(imagePath);

  if (asset.label === 'qr-positive') {
    const positive = scorePositiveScan(expectedTextsFor(asset), scan);
    return {
      engineId: engine.id,
      label: asset.label,
      outcome: positive.kind,
      decodedTexts: positive.decodedTexts,
      matchedTexts: positive.matchedTexts,
      error: positive.error,
    };
  }

  const negative = scoreNegativeScan(scan);
  return {
    engineId: engine.id,
    label: asset.label,
    outcome: negative.kind,
    decodedTexts: negative.decodedTexts,
    matchedTexts: [],
    error: negative.error,
  };
};

const summarizeEngine = (
  engineId: string,
  assets: readonly AccuracyAssetResult[],
): AccuracyEngineSummary => {
  const results = assets.flatMap((asset) =>
    asset.results.filter((result) => result.engineId === engineId),
  );
  const positives = results.filter((result) => result.label === 'qr-positive');
  const negatives = results.filter((result) => result.label === 'non-qr-negative');
  const fullPasses = positives.filter((result) => result.outcome === 'pass').length;
  const partialPasses = positives.filter((result) => result.outcome === 'partial-pass').length;
  const positiveFailures = positives.length - fullPasses - partialPasses;
  const falsePositives = negatives.filter((result) => result.outcome === 'false-positive').length;
  const negativeErrors = negatives.filter((result) => result.outcome === 'fail-error').length;

  return {
    engineId,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    fullPasses,
    partialPasses,
    positiveFailures,
    falsePositives,
    negativeErrors,
    fullPassRate: positives.length > 0 ? fullPasses / positives.length : 1,
    anyPassRate: positives.length > 0 ? (fullPasses + partialPasses) / positives.length : 1,
    falsePositiveRate: negatives.length > 0 ? falsePositives / negatives.length : 0,
  };
};

export const runAccuracyBenchmark = async (
  repoRoot: string,
  engines: readonly AccuracyEngine[] = listAccuracyEngines(),
): Promise<AccuracyBenchmarkResult> => {
  const manifest = await readCorpusManifest(repoRoot);
  const approvedAssets = manifest.assets.filter((asset) => asset.review.status === 'approved');

  const assets = await mapConcurrent(
    approvedAssets,
    ACCURACY_ASSET_CONCURRENCY,
    async (asset): Promise<AccuracyAssetResult> => ({
      assetId: asset.id,
      label: asset.label,
      expectedTexts: expectedTextsFor(asset),
      results: await Promise.all(
        engines.map((engine) => scoreAssetForEngine(repoRoot, asset, engine)),
      ),
    }),
  );

  return {
    engines: engines.map(describeEngine),
    assets,
    summaries: engines.map((engine) => summarizeEngine(engine.id, assets)),
  };
};
