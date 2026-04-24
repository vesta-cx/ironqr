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

interface CorpusAsset {
  readonly id: string;
  readonly label: 'qr-positive' | 'non-qr-negative';
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

const defaultWorkerCount = (): number => {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
  return Math.max(1, Math.min(DEFAULT_WORKER_LIMIT, available));
};

const resolveWorkerCount = (requested?: number): number => {
  if (requested === undefined) return defaultWorkerCount();
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`Accuracy worker count must be a positive integer, got ${requested}`);
  }
  return requested;
};

const unexpectedFailureScan = (
  error: unknown,
  failureReason: EngineFailureReason = 'engine_error',
): AccuracyScanResult => ({
  attempted: true,
  succeeded: false,
  results: [],
  failureReason,
  error: error instanceof Error ? error.message : String(error),
});

export const inspectAccuracyEngines = (): readonly AccuracyEngineDescriptor[] => {
  return listAccuracyEngines().map(describeAccuracyEngine);
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
    throw new Error(
      `Unavailable accuracy engine(s): ${unavailable
        .map((engine) => `${engine.id}: ${engine.availability().reason ?? 'unavailable'}`)
        .join('; ')}`,
    );
  }

  return selected;
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
  return JSON.stringify({
    label: asset.label,
    expectedTexts,
    ironqrTraceMode: runOptions.ironqrTraceMode ?? 'summary',
  });
};

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
      cached: true,
      cacheable: true,
    });

    if (asset.label === 'qr-positive') {
      const scored = scorePositiveScan(expectedTexts, cached.scan);
      const result: EngineAssetResult = {
        engineId: engine.id,
        label: asset.label,
        outcome: scored.kind,
        decodedTexts: scored.decodedTexts,
        matchedTexts: scored.matchedTexts,
        failureReason: scored.failureReason,
        error: scored.error,
        durationMs: cached.durationMs,
        cached: true,
        diagnostics: cached.scan.diagnostics ?? null,
      };
      progress.onScanFinished({
        engineId: engine.id,
        assetId: asset.id,
        relativePath: asset.relativePath,
        result,
        wroteToCache: false,
      });
      return result;
    }

    const scored = scoreNegativeScan(cached.scan);
    const result: EngineAssetResult = {
      engineId: engine.id,
      label: asset.label,
      outcome: scored.kind,
      decodedTexts: scored.decodedTexts,
      matchedTexts: [],
      failureReason: scored.failureReason,
      error: scored.error,
      durationMs: cached.durationMs,
      cached: true,
      diagnostics: cached.scan.diagnostics ?? null,
    };
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
    }));

  if (asset.label === 'qr-positive') {
    const scored = scorePositiveScan(expectedTexts, execution.scan);
    const result: EngineAssetResult = {
      engineId: engine.id,
      label: asset.label,
      outcome: scored.kind,
      decodedTexts: scored.decodedTexts,
      matchedTexts: scored.matchedTexts,
      failureReason: scored.failureReason,
      error: scored.error,
      durationMs: execution.durationMs,
      cached: false,
      diagnostics: execution.scan.diagnostics ?? null,
    };
    const wroteToCache = isCacheableEngineResult(engine, cache, result);
    if (wroteToCache) {
      await cache.write(engine, cacheLookupAsset, execution.scan, execution.durationMs, runKey);
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
  }

  const scored = scoreNegativeScan(execution.scan);
  const result: EngineAssetResult = {
    engineId: engine.id,
    label: asset.label,
    outcome: scored.kind,
    decodedTexts: scored.decodedTexts,
    matchedTexts: [],
    failureReason: scored.failureReason,
    error: scored.error,
    durationMs: execution.durationMs,
    cached: false,
    diagnostics: execution.scan.diagnostics ?? null,
  };
  const wroteToCache = isCacheableEngineResult(engine, cache, result);
  if (wroteToCache) {
    await cache.write(engine, cacheLookupAsset, execution.scan, execution.durationMs, runKey);
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
    mode: options.progress?.mode ?? 'auto',
    verbose: options.progress?.verbose ?? options.observability?.verbose ?? false,
  });
  progress.onManifestStarted();
  const cache = await openAccuracyCacheStore(cacheFile, {
    enabled: options.cache?.enabled ?? true,
    refresh: options.cache?.refresh ?? false,
    disabledEngineIds: options.cache?.disabledEngineIds ?? [],
  });
  const workerPool = createAccuracyWorkerPool(workerCount, progress);

  try {
    const manifest = await readBenchCorpusManifest(repoRoot);
    const approvedAssets = manifest.assets.filter((asset) => asset.review.status === 'approved');
    const positiveCount = approvedAssets.filter((asset) => asset.label === 'qr-positive').length;
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
    const runOptions: AccuracyEngineRunOptions = {
      verbose: options.observability?.verbose ?? false,
      ironqrTraceMode: options.observability?.ironqrTraceMode ?? 'summary',
    };

    const assetResults = (await mapConcurrent(assets, assetConcurrency, async (asset) => ({
      assetId: asset.id,
      label: asset.label,
      relativePath: asset.relativePath,
      expectedTexts: expectedTextsFor({
        expectedTexts: asset.groundTruth?.codes.map((code) => code.text) ?? [],
      }),
      results: await Promise.all(
        engines.map((engine) =>
          scoreAssetForEngine(asset, repoRoot, engine, cache, workerPool, progress, runOptions),
        ),
      ),
    }))) as readonly AccuracyAssetResult[];

    return {
      reportFile,
      corpusAssetCount: assets.length,
      positiveCount,
      negativeCount,
      engines: engines.map(describeAccuracyEngine),
      assets: assetResults,
      summaries: engines.map((engine) => summarizeEngine(engine.id, assetResults)),
      cache: cache.summary(),
    };
  } finally {
    await workerPool.close();
    await cache.save();
    progress.stop();
  }
};
