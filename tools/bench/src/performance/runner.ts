import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScanTimingSpan } from '../../../../packages/ironqr/src/contracts/scan.js';
import { describeAccuracyEngine, resolveAccuracyEngines } from '../accuracy/engines.js';
import { expectedTextsFor, scoreNegativeScan, scorePositiveScan } from '../accuracy/scoring.js';
import type { AccuracyEngine, AccuracyScanResult, EngineAssetResult } from '../accuracy/types.js';
import { type BenchCorpusAsset, loadBenchCorpusAssets } from '../core/corpus.js';
import { type BenchOutcomeBucket, bucketForOutcome, emptyBucketCounts } from '../core/outcome.js';
import {
  type BenchmarkVerdict,
  type BenchReportEnvelope,
  buildReportCorpus,
  failedVerdict,
  type PartialRunSummary,
  passedVerdict,
  REPORT_SCHEMA_VERSION,
  readRepoMetadata,
  unavailableVerdict,
} from '../core/reports.js';
import { mapConcurrentPartial } from '../core/runner.js';
import { createBenchProgressReporter } from '../ui/progress.js';
import {
  getDefaultPerformanceCachePath,
  openPerformanceCacheStore,
  performanceOptionsKey,
} from './cache.js';

const REPORTS_DIRECTORY = path.join('tools', 'bench', 'reports');
const DEFAULT_REPORT_FILE = path.join(REPORTS_DIRECTORY, 'performance.json');
const DEFAULT_ITERATIONS = 8;

export interface PerformanceBenchmarkOptions {
  readonly iterations?: number;
  readonly workers?: number;
  readonly cache?: {
    readonly enabled?: boolean;
    readonly refresh?: boolean;
    readonly file?: string;
    readonly refreshEngineId?: string;
  };
  readonly progress?: {
    readonly enabled?: boolean;
  };
  readonly signal?: AbortSignal;
  readonly requestStop?: () => void;
  readonly selection?: {
    readonly seed?: string | null;
    readonly assetIds?: readonly string[];
    readonly labels?: readonly ('qr-pos' | 'qr-neg')[];
    readonly maxAssets?: number;
    readonly filters?: Record<string, unknown>;
  };
}

export interface PerformanceEngineSummary {
  readonly engineId: string;
  readonly assetCount: number;
  readonly sampleCount: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly p99DurationMs: number;
  readonly averageDurationMs: number;
  readonly throughputAssetsPerSecond: number;
  readonly buckets: Record<BenchOutcomeBucket, number>;
}

export interface PerformanceIterationResult {
  readonly iteration: number;
  readonly assetId: string;
  readonly label: BenchCorpusAsset['label'];
  readonly engineId: string;
  readonly outcome: EngineAssetResult['outcome'];
  readonly bucket: BenchOutcomeBucket;
  readonly imageLoadDurationMs: number | null;
  readonly warmupDurationMs: number | null;
  readonly engineScanDurationMs: number;
  readonly totalJobDurationMs: number;
  readonly cached: boolean;
  readonly ironqrSpans?: readonly ScanTimingSpan[];
}

export interface TimingSummary {
  readonly name: string;
  readonly sampleCount: number;
  readonly totalMs: number;
  readonly averageMs: number;
  readonly maxMs: number;
}

export interface IronqrPerformanceProfile {
  readonly stages: readonly TimingSummary[];
  readonly proposalViews: readonly TimingSummary[];
  readonly decodeViews: readonly TimingSummary[];
  readonly samplers: readonly TimingSummary[];
  readonly refinements: readonly TimingSummary[];
  readonly decodeAttempts: readonly TimingSummary[];
}

export interface PerformanceSlowAsset {
  readonly engineId: string;
  readonly assetId: string;
  readonly iteration: number;
  readonly engineScanDurationMs: number;
  readonly totalJobDurationMs: number;
  readonly outcome: EngineAssetResult['outcome'];
}

export interface PerformanceReportSummary {
  readonly ironqr: PerformanceEngineSummary;
  readonly baselines: readonly PerformanceEngineSummary[];
  readonly ranking: {
    readonly ironqrP95Rank: number | null;
    readonly ironqrThroughputRank: number | null;
  };
  readonly hotSpots: {
    readonly slowestStages: readonly TimingSummary[];
    readonly slowestProposalViews: readonly TimingSummary[];
    readonly slowestDecodeAttempts: readonly TimingSummary[];
    readonly slowestAssetsByEngine: Record<string, readonly PerformanceSlowAsset[]>;
  };
  readonly pass: BenchmarkVerdict;
  readonly regression: BenchmarkVerdict;
  readonly cache: {
    readonly enabled: boolean;
    readonly file: string | null;
    readonly hits: number;
    readonly misses: number;
    readonly writes: number;
  };
  readonly partial: PartialRunSummary | null;
}

export interface PerformanceWarmupResult {
  readonly assetId: string;
  readonly label: BenchCorpusAsset['label'];
  readonly engineId: string;
  readonly outcome: EngineAssetResult['outcome'];
  readonly warmupDurationMs: number;
  readonly imageLoadDurationMs: number | null;
  readonly totalJobDurationMs: number;
}

export interface PerformanceReportDetails {
  readonly engines: readonly PerformanceEngineSummary[];
  readonly warmups: readonly PerformanceWarmupResult[];
  readonly assets: readonly PerformanceIterationResult[];
  readonly ironqrProfile: IronqrPerformanceProfile | null;
  readonly partial: PartialRunSummary | null;
}

export type PerformanceReport = BenchReportEnvelope<
  'performance-report',
  PerformanceReportSummary,
  PerformanceReportDetails
>;

export interface PerformanceBenchmarkResult {
  readonly reportFile: string;
  readonly report: PerformanceReport;
}

export const getDefaultPerformanceReportPath = (repoRoot: string): string => {
  return path.join(repoRoot, DEFAULT_REPORT_FILE);
};

export { getDefaultPerformanceCachePath };

const MAX_PERFORMANCE_WORKERS = 8;

const resolvePerformanceWorkerCount = (requested?: number): number => {
  if (requested === undefined) return 4;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_PERFORMANCE_WORKERS) {
    throw new Error(
      `Performance worker count must be an integer from 1 to ${MAX_PERFORMANCE_WORKERS}, got ${requested}`,
    );
  }
  return requested;
};

const resolvePerformanceSelection = (
  selection: PerformanceBenchmarkOptions['selection'] = {},
): {
  readonly seed: string | null;
  readonly assetIds: readonly string[];
  readonly labels: readonly ('qr-pos' | 'qr-neg')[];
  readonly maxAssets: number | null;
  readonly filters: Record<string, unknown>;
} => {
  const seed =
    selection.seed === undefined
      ? selection.maxAssets === undefined
        ? null
        : crypto.randomUUID()
      : selection.seed;
  const filters = {
    assetIds: selection.assetIds ?? [],
    labels: selection.labels ?? [],
    maxAssets: selection.maxAssets ?? null,
    ...(selection.filters ?? {}),
  };
  return {
    seed,
    assetIds: selection.assetIds ?? [],
    labels: selection.labels ?? [],
    maxAssets: selection.maxAssets ?? null,
    filters,
  };
};

export const runPerformanceBenchmark = async (
  repoRoot: string,
  reportFile = getDefaultPerformanceReportPath(repoRoot),
  options: PerformanceBenchmarkOptions = {},
): Promise<PerformanceBenchmarkResult> => {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error(`Performance iterations must be a positive integer, got ${iterations}`);
  }

  const selection = resolvePerformanceSelection(options.selection);
  const corpus = await loadBenchCorpusAssets(repoRoot, {
    assetIds: selection.assetIds,
    labels: selection.labels,
    maxAssets: selection.maxAssets,
    seed: selection.seed,
  });
  const assets = corpus.assets;
  const engines = resolveAccuracyEngines();
  const workerCount = resolvePerformanceWorkerCount(options.workers);
  const progress = createBenchProgressReporter({
    commandName: 'performance',
    enabled: options.progress?.enabled ?? true,
    ...(options.requestStop === undefined ? {} : { requestStop: options.requestStop }),
  });
  progress.onManifestStarted();
  progress.onManifestLoaded(
    assets.length,
    engines.map((engine) => engine.id),
    options.cache?.enabled ?? true,
    { positiveCount: corpus.positiveCount, negativeCount: corpus.negativeCount },
  );
  progress.onAssetsStarted(assets.length);
  for (const [index, asset] of assets.entries()) {
    progress.onAssetPrepared(asset.id, index + 1, assets.length);
  }
  progress.onBenchmarkStarted(
    assets.length * iterations,
    engines.map((engine) => engine.id),
    workerCount,
  );

  const cache = await openPerformanceCacheStore(
    options.cache?.file ?? getDefaultPerformanceCachePath(repoRoot),
    {
      enabled: options.cache?.enabled ?? true,
      refresh: options.cache?.refresh ?? false,
      ...(options.cache?.refreshEngineId ? { refreshEngineId: options.cache.refreshEngineId } : {}),
    },
  );
  const optionsKey = performanceOptionsKey({
    iterations,
    seed: selection.seed,
    filters: selection.filters,
  });

  let warmupResults: readonly PerformanceWarmupResult[] = [];
  let iterationResults: readonly PerformanceIterationResult[] = [];
  let partial: PartialRunSummary | undefined;
  let status: PerformanceReport['status'] = 'passed';

  try {
    warmupResults = await runPerformanceWarmup(engines, assets, progress);
    const jobs = buildPerformanceJobs(iterations, assets, engines);
    const partialRun = await mapConcurrentPartial(
      jobs,
      workerCount,
      async (job): Promise<PerformanceIterationResult> => {
        const key = {
          engineId: job.engine.id,
          engineVersion: job.engine.cache.version,
          assetId: job.asset.id,
          assetSha256: job.asset.sha256,
          iteration: job.iteration,
          optionsKey,
        };
        const cached = cache.read(key);
        if (cached) {
          progress.onScanStarted({
            engineId: job.engine.id,
            assetId: job.asset.id,
            relativePath: job.asset.relativePath,
            label: job.asset.label,
            cached: true,
            cacheable: true,
          });
          progress.onScanFinished({
            engineId: job.engine.id,
            assetId: job.asset.id,
            relativePath: job.asset.relativePath,
            result: iterationResultToEngineResult(cached),
            wroteToCache: false,
          });
          return cached;
        }

        const measured = await scanPerformanceJob(job.asset, job.engine, progress);
        const iterationResult = {
          iteration: job.iteration,
          assetId: job.asset.id,
          label: job.asset.label,
          engineId: job.engine.id,
          outcome: measured.result.outcome,
          bucket: bucketForOutcome(job.asset.label, measured.result.outcome),
          imageLoadDurationMs: measured.result.imageLoadDurationMs,
          warmupDurationMs: null,
          engineScanDurationMs: measured.result.durationMs,
          totalJobDurationMs: measured.result.totalJobDurationMs,
          cached: false,
          ...(measured.ironqrSpans.length === 0 ? {} : { ironqrSpans: measured.ironqrSpans }),
        } satisfies PerformanceIterationResult;
        await cache.write(key, iterationResult);
        return iterationResult;
      },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    iterationResults = partialRun.completed;
    if (partialRun.interrupted || partialRun.error !== null) {
      status = partialRun.interrupted ? 'interrupted' : 'errored';
      partial = {
        reason: partialRun.interrupted
          ? interruptedReason(options.signal)
          : String(partialRun.error),
        completedAssetCount: new Set(iterationResults.map((result) => result.assetId)).size,
        pendingAssetCount: Math.ceil(partialRun.pendingCount / engines.length),
        completedJobCount: partialRun.completedCount,
        pendingJobCount: partialRun.pendingCount,
      };
    }
  } finally {
    await cache.save();
    progress.stop();
  }

  const cacheSummary = cache.summary();
  const summaries = engines.map((engine) =>
    summarizePerformanceEngine(engine.id, iterationResults),
  );
  const ironqr = summaries.find((summary) => summary.engineId === 'ironqr');
  if (!ironqr) throw new Error('Missing ironqr performance summary');
  const baselines = summaries.filter((summary) => summary.engineId !== 'ironqr');
  const ironqrProfile = buildIronqrProfile(iterationResults);
  const pass = partial
    ? unavailableVerdict(`Performance benchmark ended early: ${partial.reason}`)
    : buildPerformancePassVerdict(ironqr, baselines);
  const regression = partial
    ? unavailableVerdict('Partial performance reports are not comparable for regression checks.')
    : await buildPerformanceRegressionVerdict(reportFile, ironqr);

  const report: PerformanceReport = {
    kind: 'performance-report',
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: partial ? status : pass.status === 'failed' ? 'failed' : 'passed',
    verdicts: { pass, regression },
    benchmark: {
      name: 'Performance Benchmark',
      description:
        'Compares `ironqr` scan speed against every target baseline engine and records detailed first-party timing metrics for `ironqr`. This report answers whether `ironqr` is competitive on latency/throughput and where it spends time internally. Start with `summary.ranking`, `summary.ironqr`, and `summary.hotSpots`, then inspect `details.assets` for per-asset iteration timings and `details.ironqrProfile` for stage/view/decode-attempt breakdowns.',
    },
    command: { name: 'performance', argv: process.argv.slice(2) },
    repo: await readRepoMetadata(repoRoot),
    corpus: await buildReportCorpus({ repoRoot, assets }),
    selection: { seed: selection.seed, filters: selection.filters },
    engines: engines.map((engine) => ({
      id: engine.id,
      adapterVersion: engine.cache.version,
      packageName: engine.id,
      runtimeVersion: describeAccuracyEngine(engine).capabilities.runtime,
    })),
    options: {
      iterations,
      workers: workerCount,
      warmup: { assetCount: Math.min(1, assets.length) },
    },
    summary: {
      ironqr,
      baselines,
      ranking: {
        ironqrP95Rank: rankBy(
          summaries,
          ironqr.engineId,
          (summary) => summary.p95DurationMs,
          'asc',
        ),
        ironqrThroughputRank: rankBy(
          summaries,
          ironqr.engineId,
          (summary) => summary.throughputAssetsPerSecond,
          'desc',
        ),
      },
      hotSpots: {
        slowestStages: ironqrProfile?.stages.slice(0, 10) ?? [],
        slowestProposalViews: ironqrProfile?.proposalViews.slice(0, 10) ?? [],
        slowestDecodeAttempts: ironqrProfile?.decodeAttempts.slice(0, 10) ?? [],
        slowestAssetsByEngine: slowestAssetsByEngine(iterationResults),
      },
      pass,
      regression,
      cache: cacheSummary,
      partial: partial ?? null,
    },
    details: {
      engines: summaries,
      warmups: warmupResults,
      assets: iterationResults,
      ironqrProfile,
      partial: partial ?? null,
    },
  };

  return { reportFile, report };
};

interface PerformanceJob {
  readonly iteration: number;
  readonly asset: BenchCorpusAsset;
  readonly engine: AccuracyEngine;
}

const runPerformanceWarmup = async (
  engines: readonly AccuracyEngine[],
  assets: readonly BenchCorpusAsset[],
  progress: ReturnType<typeof createBenchProgressReporter>,
): Promise<readonly PerformanceWarmupResult[]> => {
  if (assets.length === 0) return [];
  const warmupAssets = loadWarmupAssets(assets);
  return Promise.all(
    engines.map(async (engine) => {
      const asset = warmupAssets[0];
      if (!asset) throw new Error('Performance warmup requires at least one asset');
      const measured = await scanPerformanceJob(asset, engine, progress);
      return {
        assetId: asset.id,
        label: asset.label,
        engineId: engine.id,
        outcome: measured.result.outcome,
        warmupDurationMs: measured.result.durationMs,
        imageLoadDurationMs: measured.result.imageLoadDurationMs,
        totalJobDurationMs: measured.result.totalJobDurationMs,
      } satisfies PerformanceWarmupResult;
    }),
  );
};

const loadWarmupAssets = (assets: readonly BenchCorpusAsset[]): readonly BenchCorpusAsset[] =>
  assets.slice(0, 1);

const buildPerformanceJobs = (
  iterations: number,
  assets: readonly BenchCorpusAsset[],
  engines: readonly AccuracyEngine[],
): readonly PerformanceJob[] => {
  const jobs: PerformanceJob[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const asset of assets) {
      for (const engine of engines) jobs.push({ iteration, asset, engine });
    }
  }
  return jobs;
};

const scanPerformanceJob = async (
  asset: BenchCorpusAsset,
  engine: AccuracyEngine,
  progress: ReturnType<typeof createBenchProgressReporter>,
): Promise<{
  readonly result: EngineAssetResult;
  readonly ironqrSpans: readonly ScanTimingSpan[];
}> => {
  progress.onScanStarted({
    engineId: engine.id,
    assetId: asset.id,
    relativePath: asset.relativePath,
    label: asset.label,
    cached: false,
    cacheable: false,
  });
  const spans: ScanTimingSpan[] = [];
  let imageLoadDurationMs: number | null = null;
  const startedAt = performance.now();
  const measuredAsset: BenchCorpusAsset = {
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
      imageLoadDurationMs = round(performance.now() - imageStartedAt);
      progress.onImageLoadFinished({
        engineId: engine.id,
        assetId: asset.id,
        width: image.width,
        height: image.height,
      });
      return image;
    },
  };
  const scan = await engine.scan(measuredAsset, {
    ironqrTraceMode: 'off',
    ...(engine.id === 'ironqr'
      ? {
          metricsSink: {
            record: (span: ScanTimingSpan) => spans.push(span),
          },
        }
      : {}),
  });
  const totalJobDurationMs = round(performance.now() - startedAt);
  const expectedTexts = expectedTextsFor({ expectedTexts: asset.expectedTexts });
  const result = toEngineAssetResult(
    engine.id,
    asset.label,
    expectedTexts,
    scan,
    round(totalJobDurationMs - (imageLoadDurationMs ?? 0)),
    false,
    imageLoadDurationMs,
    totalJobDurationMs,
  );
  progress.onScanFinished({
    engineId: engine.id,
    assetId: asset.id,
    relativePath: asset.relativePath,
    result,
    wroteToCache: false,
  });
  return { result, ironqrSpans: spans };
};

const toEngineAssetResult = (
  engineId: string,
  label: BenchCorpusAsset['label'],
  expectedTexts: readonly string[],
  scan: AccuracyScanResult,
  durationMs: number,
  cached: boolean,
  imageLoadDurationMs: number | null,
  totalJobDurationMs: number,
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

const iterationResultToEngineResult = (result: PerformanceIterationResult): EngineAssetResult => ({
  engineId: result.engineId,
  label: result.label,
  outcome: result.outcome,
  decodedTexts: [],
  matchedTexts: [],
  failureReason: null,
  error: null,
  durationMs: result.engineScanDurationMs,
  imageLoadDurationMs: result.imageLoadDurationMs,
  totalJobDurationMs: result.totalJobDurationMs,
  cached: result.cached,
});

const buildIronqrProfile = (
  results: readonly PerformanceIterationResult[],
): IronqrPerformanceProfile | null => {
  const spans = results.flatMap((result) => result.ironqrSpans ?? []);
  if (spans.length === 0) return null;
  const stageTimings: Record<string, number[]> = {};
  const proposalViewTimings: Record<string, number[]> = {};
  const attemptTimings: Record<string, number[]> = {};
  const decodeViewTimings: Record<string, number[]> = {};
  const samplerTimings: Record<string, number[]> = {};
  const refinementTimings: Record<string, number[]> = {};

  for (const span of spans) {
    if (span.name === 'proposal-view') {
      pushTiming(
        proposalViewTimings,
        String(span.metadata?.binaryViewId ?? 'unknown'),
        span.durationMs,
      );
      continue;
    }
    if (span.name === 'decode-attempt') {
      const decodeView = String(span.metadata?.decodeBinaryViewId ?? 'unknown');
      const sampler = String(span.metadata?.sampler ?? 'unknown');
      const refinement = String(span.metadata?.refinement ?? 'unknown');
      pushTiming(attemptTimings, `${decodeView}/${sampler}/${refinement}`, span.durationMs);
      pushTiming(decodeViewTimings, decodeView, span.durationMs);
      pushTiming(samplerTimings, sampler, span.durationMs);
      pushTiming(refinementTimings, refinement, span.durationMs);
      continue;
    }
    pushTiming(stageTimings, span.name, span.durationMs);
  }

  return {
    stages: summarizeTimingRecord(stageTimings).sort((left, right) => right.totalMs - left.totalMs),
    proposalViews: summarizeTimingRecord(proposalViewTimings).sort(
      (left, right) => right.totalMs - left.totalMs,
    ),
    decodeViews: summarizeTimingRecord(decodeViewTimings).sort(
      (left, right) => right.totalMs - left.totalMs,
    ),
    samplers: summarizeTimingRecord(samplerTimings).sort(
      (left, right) => right.totalMs - left.totalMs,
    ),
    refinements: summarizeTimingRecord(refinementTimings).sort(
      (left, right) => right.totalMs - left.totalMs,
    ),
    decodeAttempts: summarizeTimingRecord(attemptTimings).sort(
      (left, right) => right.totalMs - left.totalMs,
    ),
  };
};

const interruptedReason = (signal?: AbortSignal): string => {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason.message
    : typeof reason === 'string'
      ? reason
      : 'Interrupted.';
};

const pushTiming = (record: Record<string, number[]>, key: string, durationMs: number): void => {
  const durations = record[key] ?? [];
  durations.push(durationMs);
  record[key] = durations;
};

const summarizeTimingRecord = (record: Record<string, readonly number[]>): TimingSummary[] => {
  return Object.entries(record).map(([name, values]) => {
    const totalMs = round(values.reduce((sum, value) => sum + value, 0));
    return {
      name,
      sampleCount: values.length,
      totalMs,
      averageMs: values.length === 0 ? 0 : round(totalMs / values.length),
      maxMs: values.length === 0 ? 0 : round(Math.max(...values)),
    };
  });
};

const slowestAssetsByEngine = (
  results: readonly PerformanceIterationResult[],
): Record<string, readonly PerformanceSlowAsset[]> => {
  const byEngine: Record<string, PerformanceSlowAsset[]> = {};
  for (const result of results) {
    const assets = byEngine[result.engineId] ?? [];
    assets.push({
      engineId: result.engineId,
      assetId: result.assetId,
      iteration: result.iteration,
      engineScanDurationMs: result.engineScanDurationMs,
      totalJobDurationMs: result.totalJobDurationMs,
      outcome: result.outcome,
    });
    byEngine[result.engineId] = assets;
  }
  return Object.fromEntries(
    Object.entries(byEngine).map(([engineId, assets]) => [
      engineId,
      assets
        .sort((left, right) => right.engineScanDurationMs - left.engineScanDurationMs)
        .slice(0, 20),
    ]),
  );
};

const summarizePerformanceEngine = (
  engineId: string,
  results: readonly PerformanceIterationResult[],
): PerformanceEngineSummary => {
  const engineResults = results.filter((result) => result.engineId === engineId);
  const durations = engineResults
    .map((result) => result.engineScanDurationMs)
    .sort((a, b) => a - b);
  const buckets = emptyBucketCounts();
  for (const result of engineResults) buckets[result.bucket] += 1;
  const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const averageDurationMs = durations.length === 0 ? 0 : round(totalDuration / durations.length);
  return {
    engineId,
    assetCount: new Set(engineResults.map((result) => result.assetId)).size,
    sampleCount: engineResults.length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    p99DurationMs: percentile(durations, 0.99),
    averageDurationMs,
    throughputAssetsPerSecond: averageDurationMs === 0 ? 0 : round(1000 / averageDurationMs),
    buckets,
  };
};

const PERFORMANCE_DURATION_METRICS = [
  'p50DurationMs',
  'p95DurationMs',
  'p99DurationMs',
  'averageDurationMs',
] as const;

const buildPerformanceRegressionVerdict = async (
  reportFile: string,
  ironqr: PerformanceEngineSummary,
): Promise<BenchmarkVerdict> => {
  try {
    const previous = JSON.parse(await readFile(reportFile, 'utf8')) as {
      readonly summary?: {
        readonly ironqr?: Partial<PerformanceEngineSummary>;
      };
    };
    const previousIronqr = previous.summary?.ironqr;
    if (!previousIronqr)
      return unavailableVerdict('Previous performance summary is missing ironqr data.');
    const regressedDuration = PERFORMANCE_DURATION_METRICS.find(
      (metric) => ironqr[metric] > (previousIronqr[metric] ?? Number.POSITIVE_INFINITY),
    );
    if (regressedDuration) {
      return failedVerdict(
        `ironqr ${regressedDuration} regressed versus previous performance summary.`,
      );
    }
    if (ironqr.throughputAssetsPerSecond < (previousIronqr.throughputAssetsPerSecond ?? 0)) {
      return failedVerdict('ironqr throughput regressed versus previous performance summary.');
    }
    return passedVerdict('Performance summary did not regress versus previous report.');
  } catch {
    return unavailableVerdict(
      'No previous performance summary is available for regression comparison.',
    );
  }
};

const buildPerformancePassVerdict = (
  ironqr: PerformanceEngineSummary,
  baselines: readonly PerformanceEngineSummary[],
): BenchmarkVerdict => {
  const slower = baselines.filter(
    (baseline) =>
      PERFORMANCE_DURATION_METRICS.some((metric) => ironqr[metric] > baseline[metric]) ||
      ironqr.throughputAssetsPerSecond < baseline.throughputAssetsPerSecond,
  );
  if (slower.length === 0) {
    return passedVerdict(
      'ironqr is competitive with or faster than all baseline engines on p50/p95/p99/average duration and throughput.',
    );
  }
  return failedVerdict(
    `ironqr trails baseline engine(s) on duration or throughput: ${slower.map((engine) => engine.engineId).join(', ')}`,
  );
};

const percentile = (sorted: readonly number[], percentileValue: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return round(sorted[index] ?? 0);
};

const rankBy = (
  summaries: readonly PerformanceEngineSummary[],
  engineId: string,
  value: (summary: PerformanceEngineSummary) => number,
  direction: 'asc' | 'desc',
): number | null => {
  const ranked = [...summaries].sort((left, right) =>
    direction === 'asc' ? value(left) - value(right) : value(right) - value(left),
  );
  const index = ranked.findIndex((summary) => summary.engineId === engineId);
  return index === -1 ? null : index + 1;
};

const round = (value: number): number => Math.round(value * 100) / 100;
