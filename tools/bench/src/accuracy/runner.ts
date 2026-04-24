import crypto from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultAccuracyCachePath, openAccuracyCacheStore } from './cache.js';
import { describeAccuracyEngine, listAccuracyEngines } from './engines.js';
import { createAccuracyProgressReporter } from './progress.js';
import { expectedTextsFor, scoreNegativeScan, scorePositiveScan } from './scoring.js';
import type {
  AccuracyAssetResult,
  AccuracyBenchmarkOptions,
  AccuracyBenchmarkResult,
  AccuracyEngine,
  AccuracyEngineDescriptor,
  AccuracyEngineRunOptions,
  AccuracyEngineSummary,
  AccuracyScanResult,
  EngineAssetResult,
  EngineFailureReason,
} from './types.js';
import { createAccuracyWorkerPool } from './worker-pool.js';

const REPORTS_DIRECTORY = path.join('tools', 'bench', 'reports');
const DEFAULT_REPORT_FILE = path.join(REPORTS_DIRECTORY, 'accuracy.json');
const DEFAULT_WORKER_LIMIT = 8;
const CORPUS_MANIFEST_VERSION = 1;

export const normalizeAccuracyEngineRunOptions = (
  options?: AccuracyEngineRunOptions,
): AccuracyEngineRunOptions => ({
  verbose: options?.verbose ?? false,
  ironqrTraceMode: options?.ironqrTraceMode ?? 'off',
});

interface CorpusAsset {
  readonly id: string;
  readonly label: 'qr-pos' | 'qr-neg';
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
  readonly assets: readonly CorpusAsset[];
}

const readBenchCorpusManifest = async (repoRoot: string): Promise<CorpusManifest> => {
  const filePath = path.join(repoRoot, 'corpus', 'data', 'manifest.json');
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isCorpusManifest(parsed)) {
    throw new Error(`Invalid corpus manifest: ${filePath}`);
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

const mapConcurrent = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> => {
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

const roundDurationMs = (value: number): number => Math.round(value * 100) / 100;

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

const resolveSelection = (
  selection: AccuracyBenchmarkOptions['selection'] = {},
): NonNullable<AccuracyBenchmarkOptions['selection']> & { readonly seed?: string } => ({
  assetIds: selection.assetIds ?? [],
  labels: selection.labels ?? [],
  ...(selection.maxAssets === undefined ? {} : { maxAssets: selection.maxAssets }),
  ...(selection.seed === undefined && selection.maxAssets !== undefined
    ? { seed: crypto.randomUUID() }
    : selection.seed === undefined
      ? {}
      : { seed: selection.seed }),
});

const sampleAssets = (
  assets: readonly CorpusAsset[],
  selection: NonNullable<AccuracyBenchmarkOptions['selection']> = {},
): readonly CorpusAsset[] => {
  let selected = [...assets];
  if (selection.assetIds && selection.assetIds.length > 0) {
    const requested = new Set(selection.assetIds);
    selected = selected.filter((asset) => requested.has(asset.id));
  }
  if (selection.labels && selection.labels.length > 0) {
    const labels = new Set(selection.labels);
    selected = selected.filter((asset) => labels.has(asset.label));
  }
  if (selection.maxAssets !== undefined && selected.length > selection.maxAssets) {
    const random = seededRandom(selection.seed ?? crypto.randomUUID());
    selected = selected
      .map((asset) => ({ asset, sort: random() }))
      .sort((left, right) => left.sort - right.sort)
      .slice(0, selection.maxAssets)
      .map((entry) => entry.asset);
  }
  return selected;
};

const defaultWorkerCount = (): number => {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
  return Math.max(1, Math.min(DEFAULT_WORKER_LIMIT, available));
};

const resolveWorkerCount = (requested?: number): number => {
  if (requested === undefined) return defaultWorkerCount();
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > DEFAULT_WORKER_LIMIT) {
    throw new Error(
      `Accuracy worker count must be an integer from 1 to ${DEFAULT_WORKER_LIMIT}, got ${requested}`,
    );
  }
  return requested;
};

const unexpectedFailureScan = (
  error: unknown,
  failureReason: EngineFailureReason = 'engine_error',
): AccuracyScanResult => ({
  status: 'error',
  attempted: true,
  succeeded: false,
  results: [],
  failureReason,
  error: error instanceof Error ? error.message : String(error),
});

export const inspectAccuracyEngines = (): readonly AccuracyEngineDescriptor[] => {
  return listAccuracyEngines().map(describeAccuracyEngine);
};

export const resolveAccuracyEngines = (): readonly AccuracyEngine[] => {
  const engines = listAccuracyEngines();
  const unavailable = engines.filter((engine) => !engine.availability().available);
  if (unavailable.length > 0) {
    throw new Error(
      `Unavailable benchmark engine(s): ${unavailable
        .map((engine) => `${engine.id}: ${engine.availability().reason ?? 'unavailable'}`)
        .join('; ')}`,
    );
  }
  return engines;
};

const summarizeEngine = (
  engineId: string,
  assets: readonly AccuracyAssetResult[],
): AccuracyEngineSummary => {
  const results = assets.flatMap((asset) =>
    asset.results.filter((result) => result.engineId === engineId),
  );
  const positives = results.filter((result) => result.label === 'qr-pos');
  const negatives = results.filter((result) => result.label === 'qr-neg');
  const fullPasses = positives.filter((result) => result.outcome === 'pass').length;
  const partialPasses = positives.filter((result) => result.outcome === 'partial-pass').length;
  const positiveFailures = positives.length - fullPasses - partialPasses;
  const falsePositives = negatives.filter((result) => result.outcome === 'false-positive').length;
  const negativeErrors = negatives.filter((result) => result.outcome === 'fail-error').length;
  const totalDurationMs = roundDurationMs(
    results.reduce((sum, result) => sum + result.durationMs, 0),
  );
  const cachedAssets = results.filter((result) => result.cached).length;

  return {
    engineId,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    fullPasses,
    partialPasses,
    positiveFailures,
    falsePositives,
    negativeErrors,
    fullPassRate: positives.length === 0 ? 1 : fullPasses / positives.length,
    anyPassRate: positives.length === 0 ? 1 : (fullPasses + partialPasses) / positives.length,
    falsePositiveRate: negatives.length === 0 ? 0 : falsePositives / negatives.length,
    totalDurationMs,
    averageDurationMs: results.length === 0 ? 0 : roundDurationMs(totalDurationMs / results.length),
    cachedAssets,
    freshAssets: results.length - cachedAssets,
  };
};

export const isCacheableEngineResult = (
  engine: AccuracyEngine,
  cache: Awaited<ReturnType<typeof openAccuracyCacheStore>>,
  result: EngineAssetResult,
): boolean => {
  if (!cache.isEnabledFor(engine)) return false;
  if (engine.cache.mode !== 'pass-only') return true;
  return result.outcome === 'pass' || result.outcome === 'partial-pass';
};

const cacheRunKey = (
  asset: CorpusAsset,
  expectedTexts: readonly string[],
  runOptions: AccuracyEngineRunOptions,
): string => {
  const normalizedRunOptions = normalizeAccuracyEngineRunOptions(runOptions);
  return JSON.stringify({
    label: asset.label,
    expectedTexts,
    ironqrTraceMode: normalizedRunOptions.ironqrTraceMode,
  });
};

const toEngineAssetResult = (
  engineId: string,
  label: CorpusAsset['label'],
  expectedTexts: readonly string[],
  scan: AccuracyScanResult,
  durationMs: number,
  cached: boolean,
  imageLoadDurationMs: number | null = null,
  totalJobDurationMs = durationMs,
): EngineAssetResult => {
  if (label === 'qr-pos') {
    const scored = scorePositiveScan(expectedTexts, scan);
    return {
      engineId,
      label,
      outcome: scored.kind,
      decodedTexts: scored.decodedTexts,
      matchedTexts: scored.matchedTexts,
      failureReason: scored.failureReason,
      error: scored.error,
      durationMs,
      imageLoadDurationMs,
      totalJobDurationMs,
      cached,
      diagnostics: scan.diagnostics ?? null,
    };
  }

  const scored = scoreNegativeScan(scan);
  return {
    engineId,
    label,
    outcome: scored.kind,
    decodedTexts: scored.decodedTexts,
    matchedTexts: [],
    failureReason: scored.failureReason,
    error: scored.error,
    durationMs,
    imageLoadDurationMs,
    totalJobDurationMs,
    cached,
    diagnostics: scan.diagnostics ?? null,
  };
};

const stripDiagnosticsForCache = (scan: AccuracyScanResult): AccuracyScanResult => ({
  ...scan,
  diagnostics: null,
});

const scoreAssetForEngine = async (
  asset: CorpusAsset,
  repoRoot: string,
  engine: AccuracyEngine,
  cache: Awaited<ReturnType<typeof openAccuracyCacheStore>>,
  workerPool: ReturnType<typeof createAccuracyWorkerPool>,
  progress: ReturnType<typeof createAccuracyProgressReporter>,
  runOptions: AccuracyEngineRunOptions,
): Promise<EngineAssetResult> => {
  const expectedTexts = expectedTextsFor({
    expectedTexts: asset.groundTruth?.codes.map((code) => code.text) ?? [],
  });
  const runKey = cacheRunKey(asset, expectedTexts, runOptions);
  const cacheLookupAsset = {
    id: asset.id,
    label: asset.label,
    sha256: asset.sha256,
    relativePath: asset.relativePath,
  };

  const cached = cache.read(engine, cacheLookupAsset, runKey);
  if (cached) {
    progress.onScanStarted({
      engineId: engine.id,
      assetId: asset.id,
      relativePath: asset.relativePath,
      label: asset.label,
      cached: true,
      cacheable: true,
    });
    const result = toEngineAssetResult(
      engine.id,
      asset.label,
      expectedTexts,
      cached.scan,
      cached.durationMs,
      true,
      null,
      cached.durationMs,
    );
    progress.onScanFinished({
      engineId: engine.id,
      assetId: asset.id,
      relativePath: asset.relativePath,
      result,
      wroteToCache: false,
    });
    return result;
  }

  const execution = await workerPool
    .run({
      engineId: engine.id,
      cacheable: cache.isEnabledFor(engine),
      asset: {
        id: asset.id,
        label: asset.label,
        sha256: asset.sha256,
        imagePath: path.join(repoRoot, 'corpus', 'data', asset.relativePath),
        relativePath: asset.relativePath,
        expectedTexts,
      },
      runOptions,
    })
    .catch((error) => ({
      scan: unexpectedFailureScan(error),
      durationMs: 0,
      imageLoadDurationMs: null,
      totalJobDurationMs: 0,
    }));

  const result = toEngineAssetResult(
    engine.id,
    asset.label,
    expectedTexts,
    execution.scan,
    execution.durationMs,
    false,
    execution.imageLoadDurationMs,
    execution.totalJobDurationMs,
  );
  const wroteToCache = isCacheableEngineResult(engine, cache, result);
  if (wroteToCache) {
    await cache.write(
      engine,
      cacheLookupAsset,
      stripDiagnosticsForCache(execution.scan),
      execution.durationMs,
      runKey,
    );
  } else if (engine.cache.mode === 'pass-only') {
    await cache.evict(engine, cacheLookupAsset);
  }
  progress.onScanFinished({
    engineId: engine.id,
    assetId: asset.id,
    relativePath: asset.relativePath,
    result,
    wroteToCache,
  });
  return result;
};

export const getDefaultAccuracyReportPath = (repoRoot: string): string => {
  return path.join(repoRoot, DEFAULT_REPORT_FILE);
};

export { getDefaultAccuracyCachePath };

export const runAccuracyBenchmark = async (
  repoRoot: string,
  engines: readonly AccuracyEngine[] = resolveAccuracyEngines(),
  reportFile = getDefaultAccuracyReportPath(repoRoot),
  options: AccuracyBenchmarkOptions = {},
): Promise<AccuracyBenchmarkResult> => {
  await mkdir(path.dirname(reportFile), { recursive: true });
  const workerCount = resolveWorkerCount(options.execution?.workers);
  const assetConcurrency = Math.max(workerCount, 4);
  const cacheFile = options.cache?.file ?? getDefaultAccuracyCachePath(repoRoot);
  const progress = createAccuracyProgressReporter({
    enabled: options.progress?.enabled ?? true,
  });
  progress.onManifestStarted();
  let cache: Awaited<ReturnType<typeof openAccuracyCacheStore>> | null = null;
  let workerPool: ReturnType<typeof createAccuracyWorkerPool> | null = null;
  let result: AccuracyBenchmarkResult | null = null;
  let runError: unknown;

  try {
    cache = await openAccuracyCacheStore(cacheFile, {
      enabled: options.cache?.enabled ?? true,
      refresh: options.cache?.refresh ?? false,
      disabledEngineIds: options.cache?.disabledEngineIds ?? [],
      refreshEngineIds: options.cache?.refreshEngineIds ?? [],
    });
    workerPool = createAccuracyWorkerPool(workerCount, progress);
    const activeCache = cache;
    const activeWorkerPool = workerPool;
    const manifest = await readBenchCorpusManifest(repoRoot);
    const selection = resolveSelection(options.selection);
    const approvedAssets = sampleAssets(
      manifest.assets.filter((asset) => asset.review.status === 'approved'),
      selection,
    );
    const positiveCount = approvedAssets.filter((asset) => asset.label === 'qr-pos').length;
    const negativeCount = approvedAssets.length - positiveCount;
    progress.onManifestLoaded(
      approvedAssets.length,
      engines.map((engine) => engine.id),
      options.cache?.enabled ?? true,
      { positiveCount, negativeCount },
    );
    progress.onAssetsStarted(approvedAssets.length);
    const assets = approvedAssets.map((asset, index) => {
      progress.onAssetPrepared(asset.id, index + 1, approvedAssets.length);
      return asset;
    });

    progress.onBenchmarkStarted(
      assets.length,
      engines.map((engine) => engine.id),
      workerCount,
    );
    const runOptions = normalizeAccuracyEngineRunOptions(options.observability);

    const assetResults = await mapConcurrent<CorpusAsset, AccuracyAssetResult>(
      assets,
      assetConcurrency,
      async (asset): Promise<AccuracyAssetResult> => ({
        assetId: asset.id,
        sha256: asset.sha256,
        label: asset.label,
        relativePath: asset.relativePath,
        expectedTexts: expectedTextsFor({
          expectedTexts: asset.groundTruth?.codes.map((code) => code.text) ?? [],
        }),
        results: await Promise.all(
          engines.map((engine) =>
            scoreAssetForEngine(
              asset,
              repoRoot,
              engine,
              activeCache,
              activeWorkerPool,
              progress,
              runOptions,
            ),
          ),
        ),
      }),
    );

    result = {
      repoRoot,
      reportFile,
      corpusAssetCount: assets.length,
      positiveCount,
      negativeCount,
      engines: engines.map(describeAccuracyEngine),
      assets: assetResults,
      summaries: engines.map((engine) => summarizeEngine(engine.id, assetResults)),
      selection: {
        seed: selection.seed ?? null,
        filters: {
          assetIds: selection.assetIds ?? [],
          labels: selection.labels ?? [],
          maxAssets: selection.maxAssets ?? null,
        },
      },
      options: {
        workers: workerCount,
        progressEnabled: options.progress?.enabled ?? true,
        cacheEnabled: options.cache?.enabled ?? true,
        refreshCache: options.cache?.refresh ?? false,
        refreshEngineIds: options.cache?.refreshEngineIds ?? [],
        observability: runOptions,
      },
      cache: activeCache.summary(),
    };
  } catch (error) {
    runError = error;
  } finally {
    const cleanup = await Promise.allSettled([workerPool?.close(), cache?.save()]);
    progress.stop();
    const failed = cleanup.find((entry) => entry.status === 'rejected');
    if (failed?.status === 'rejected') {
      if (runError !== undefined) {
        console.error(`[bench] cleanup failed after benchmark error: ${String(failed.reason)}`);
      } else {
        runError = failed.reason;
      }
    }
  }

  if (runError !== undefined) throw runError;
  if (result === null) {
    throw new Error('Accuracy benchmark failed before producing a result');
  }
  return result;
};
