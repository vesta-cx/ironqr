import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BenchCorpusAsset, loadBenchCorpusAssets } from '../core/corpus.js';
import { describeAccuracyEngine, resolveAccuracyEngines } from '../core/engines.js';
import { abortReason, mapConcurrentPartial } from '../core/runner.js';
import { getDefaultAccuracyCachePath, openAccuracyCacheStore } from './cache.js';
import { createAccuracyProgressReporter } from './progress.js';
import { expectedTextsFor, scoreNegativeScan, scorePositiveScan } from './scoring.js';
import type {
  AccuracyAssetResult,
  AccuracyBenchmarkOptions,
  AccuracyBenchmarkResult,
  AccuracyEngine,
  AccuracyEngineRunOptions,
  AccuracyEngineSummary,
  AccuracyScanResult,
  EngineAssetResult,
} from './types.js';
import { createAccuracyWorkerPool } from './worker-pool.js';

const REPORTS_DIRECTORY = path.join('tools', 'bench', 'reports');
const DEFAULT_REPORT_FILE = path.join(REPORTS_DIRECTORY, 'accuracy.json');
const DEFAULT_WORKER_LIMIT = 8;
export const normalizeAccuracyEngineRunOptions = (
  options?: AccuracyEngineRunOptions,
): AccuracyEngineRunOptions => ({
  verbose: options?.verbose ?? false,
  ironqrTraceMode: options?.ironqrTraceMode ?? 'off',
});

const roundDurationMs = (value: number): number => Math.round(value * 100) / 100;

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

export { inspectAccuracyEngines, resolveAccuracyEngines } from '../core/engines.js';

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
  asset: BenchCorpusAsset,
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
  label: BenchCorpusAsset['label'],
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

const runEngineInProcess = async (
  asset: BenchCorpusAsset,
  engine: AccuracyEngine,
  progress: ReturnType<typeof createAccuracyProgressReporter>,
  runOptions: AccuracyEngineRunOptions,
  cacheable: boolean,
): Promise<{
  readonly scan: AccuracyScanResult;
  readonly durationMs: number;
  readonly imageLoadDurationMs: number | null;
  readonly totalJobDurationMs: number;
}> => {
  progress.onScanStarted({
    engineId: engine.id,
    assetId: asset.id,
    relativePath: asset.relativePath,
    label: asset.label,
    cached: false,
    cacheable,
  });
  let imageLoadDurationMs: number | null = null;
  const startedAt = performance.now();
  const scan = await engine.scan(
    {
      ...asset,
      loadImage: async () => {
        progress.onImageLoadStarted({
          engineId: engine.id,
          assetId: asset.id,
          relativePath: asset.relativePath,
          label: asset.label,
        });
        const imageStartedAt = performance.now();
        const image = await asset.loadImage();
        imageLoadDurationMs = roundDurationMs(performance.now() - imageStartedAt);
        progress.onImageLoadFinished({
          engineId: engine.id,
          assetId: asset.id,
          width: image.width,
          height: image.height,
        });
        return image;
      },
    },
    runOptions,
  );
  const totalJobDurationMs = roundDurationMs(performance.now() - startedAt);
  return {
    scan,
    durationMs: roundDurationMs(totalJobDurationMs - (imageLoadDurationMs ?? 0)),
    imageLoadDurationMs,
    totalJobDurationMs,
  };
};

const runEngineInWorker = async (
  asset: BenchCorpusAsset,
  engine: AccuracyEngine,
  workerPool: ReturnType<typeof createAccuracyWorkerPool>,
  runOptions: AccuracyEngineRunOptions,
  expectedTexts: readonly string[],
  cacheable: boolean,
): Promise<{
  readonly scan: AccuracyScanResult;
  readonly durationMs: number;
  readonly imageLoadDurationMs: number | null;
  readonly totalJobDurationMs: number;
}> => {
  const job = {
    engineId: engine.id,
    cacheable,
    asset: {
      id: asset.id,
      label: asset.label,
      sha256: asset.sha256,
      imagePath: asset.imagePath,
      relativePath: asset.relativePath,
      expectedTexts,
    },
    runOptions,
  };
  return workerPool.run(job).catch(async (firstError) => {
    return workerPool.run(job).catch((secondError) => {
      throw new Error(
        `Accuracy worker repeatedly failed for ${engine.id}/${asset.id}: ${String(firstError)}; ${String(secondError)}`,
      );
    });
  });
};

const scoreAssetForEngine = async (
  asset: BenchCorpusAsset,
  engine: AccuracyEngine,
  cache: Awaited<ReturnType<typeof openAccuracyCacheStore>>,
  workerPool: ReturnType<typeof createAccuracyWorkerPool>,
  progress: ReturnType<typeof createAccuracyProgressReporter>,
  runOptions: AccuracyEngineRunOptions,
): Promise<EngineAssetResult> => {
  const expectedTexts = expectedTextsFor({ expectedTexts: asset.expectedTexts });
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

  const cacheable = cache.isEnabledFor(engine);
  const execution =
    engine.execution?.workerSafe === false
      ? await runEngineInProcess(asset, engine, progress, runOptions, cacheable)
      : await runEngineInWorker(asset, engine, workerPool, runOptions, expectedTexts, cacheable);

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
    ...(options.execution?.requestStop === undefined
      ? {}
      : { requestStop: options.execution.requestStop }),
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
    const corpus = await loadBenchCorpusAssets(repoRoot, options.selection);
    const { assets, positiveCount, negativeCount, selection } = corpus;
    progress.onMessage(`seed=${selection.seed ?? 'none'}`);
    progress.onManifestLoaded(
      assets.length,
      engines.map((engine) => engine.id),
      options.cache?.enabled ?? true,
      { positiveCount, negativeCount },
    );
    progress.onAssetsStarted(assets.length);
    assets.forEach((asset, index) => {
      progress.onAssetPrepared(asset.id, index + 1, assets.length);
    });

    progress.onBenchmarkStarted(
      assets.length,
      engines.map((engine) => engine.id),
      workerCount,
    );
    const runOptions = normalizeAccuracyEngineRunOptions(options.observability);

    const partialRun = await mapConcurrentPartial<BenchCorpusAsset, AccuracyAssetResult>(
      assets,
      assetConcurrency,
      async (asset): Promise<AccuracyAssetResult> => {
        return {
          assetId: asset.id,
          sha256: asset.sha256,
          label: asset.label,
          relativePath: asset.relativePath,
          expectedTexts: expectedTextsFor({ expectedTexts: asset.expectedTexts }),
          results: await Promise.all(
            engines.map((engine) =>
              scoreAssetForEngine(
                asset,
                engine,
                activeCache,
                activeWorkerPool,
                progress,
                runOptions,
              ),
            ),
          ),
        };
      },
      options.execution?.signal === undefined ? {} : { signal: options.execution.signal },
    );
    const assetResults = partialRun.completed;
    const status = partialRun.interrupted
      ? 'interrupted'
      : partialRun.error !== null
        ? 'errored'
        : 'passed';
    const partial =
      status === 'passed'
        ? undefined
        : {
            reason: partialRun.interrupted
              ? abortReason(options.execution?.signal)
              : String(partialRun.error),
            completedAssetCount: partialRun.completedCount,
            pendingAssetCount: partialRun.pendingCount,
            completedJobCount: partialRun.completedCount * engines.length,
            pendingJobCount: partialRun.pendingCount * engines.length,
          };

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
          assetIds: selection.assetIds,
          labels: selection.labels,
          maxAssets: selection.maxAssets,
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
      status,
      ...(partial === undefined ? {} : { partial }),
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
