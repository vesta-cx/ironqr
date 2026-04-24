import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanFrame } from '../../../../packages/ironqr/src/index.js';
import type { ScanTimingDetails, ScanTimingSummary } from '../../../../packages/ironqr/src/pipeline/scan.js';
import { bucketForOutcome, emptyBucketCounts, type BenchOutcomeBucket } from '../core/outcome.js';
import {
  buildReportCorpus,
  type BenchReportEnvelope,
  type BenchmarkVerdict,
  failedVerdict,
  passedVerdict,
  readRepoMetadata,
  REPORT_SCHEMA_VERSION,
  unavailableVerdict,
} from '../core/reports.js';
import { readBenchImage } from '../shared/image.js';
import { describeAccuracyEngine } from '../accuracy/engines.js';
import { resolveAccuracyEngines, runAccuracyBenchmark } from '../accuracy/runner.js';
import type { AccuracyAssetResult, EngineAssetResult } from '../accuracy/types.js';

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
  readonly label: AccuracyAssetResult['label'];
  readonly engineId: string;
  readonly outcome: EngineAssetResult['outcome'];
  readonly bucket: BenchOutcomeBucket;
  readonly engineScanDurationMs: number;
  readonly cached: boolean;
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
  readonly proposalViews: readonly [];
  readonly decodeViews: readonly [];
  readonly samplers: readonly [];
  readonly refinements: readonly [];
  readonly decodeAttempts: readonly TimingSummary[];
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
    readonly slowestProposalViews: readonly [];
    readonly slowestDecodeAttempts: readonly TimingSummary[];
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
}

export interface PerformanceReportDetails {
  readonly engines: readonly PerformanceEngineSummary[];
  readonly assets: readonly PerformanceIterationResult[];
  readonly ironqrProfile: IronqrPerformanceProfile | null;
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

export const runPerformanceBenchmark = async (
  repoRoot: string,
  reportFile = getDefaultPerformanceReportPath(repoRoot),
  options: PerformanceBenchmarkOptions = {},
): Promise<PerformanceBenchmarkResult> => {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error(`Performance iterations must be a positive integer, got ${iterations}`);
  }

  const engines = resolveAccuracyEngines();
  const iterationResults: PerformanceIterationResult[] = [];
  let lastAssets: readonly AccuracyAssetResult[] = [];
  let cacheSummary = { enabled: options.cache?.enabled ?? true, file: null as string | null, hits: 0, misses: 0, writes: 0 };

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const accuracy = await runAccuracyBenchmark(repoRoot, engines, reportFile, {
      cache: {
        enabled: options.cache?.enabled ?? true,
        refresh: options.cache?.refresh ?? false,
        ...(options.cache?.file ? { file: options.cache.file } : {}),
        disabledEngineIds: [],
        refreshEngineIds: options.cache?.refreshEngineId ? [options.cache.refreshEngineId] : [],
      },
      progress: { enabled: false },
      execution: options.workers === undefined ? {} : { workers: options.workers },
      selection: {
        assetIds: options.selection?.assetIds ?? [],
        labels: options.selection?.labels ?? [],
        ...(options.selection?.maxAssets === undefined ? {} : { maxAssets: options.selection.maxAssets }),
        ...(options.selection?.seed === null || options.selection?.seed === undefined
          ? {}
          : { seed: options.selection.seed }),
      },
    });
    lastAssets = accuracy.assets;
    cacheSummary = accuracy.cache;
    for (const asset of accuracy.assets) {
      for (const result of asset.results) {
        iterationResults.push({
          iteration,
          assetId: asset.assetId,
          label: asset.label,
          engineId: result.engineId,
          outcome: result.outcome,
          bucket: bucketForOutcome(asset.label, result.outcome),
          engineScanDurationMs: result.durationMs,
          cached: result.cached,
        });
      }
    }
  }

  const summaries = engines.map((engine) => summarizePerformanceEngine(engine.id, iterationResults));
  const ironqr = summaries.find((summary) => summary.engineId === 'ironqr');
  if (!ironqr) throw new Error('Missing ironqr performance summary');
  const baselines = summaries.filter((summary) => summary.engineId !== 'ironqr');
  const ironqrProfile = await buildIronqrProfile(repoRoot, lastAssets);
  const pass = buildPerformancePassVerdict(ironqr, baselines);
  const regression = await buildPerformanceRegressionVerdict(reportFile, ironqr);

  const report: PerformanceReport = {
    kind: 'performance-report',
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: pass.status === 'failed' ? 'failed' : 'passed',
    verdicts: { pass, regression },
    benchmark: {
      name: 'Performance Benchmark',
      description:
        'Compares ironqr scan speed against every target baseline engine and records first-party timing metrics for ironqr. Start with summary.ranking, summary.ironqr, and summary.hotSpots, then inspect details.assets for per-asset iteration timings.',
    },
    command: { name: 'performance', argv: process.argv.slice(2) },
    repo: await readRepoMetadata(repoRoot),
    corpus: await buildReportCorpus({ repoRoot, assets: lastAssets }),
    selection: { seed: options.selection?.seed ?? null, filters: options.selection?.filters ?? {} },
    engines: engines.map((engine) => ({
      id: engine.id,
      adapterVersion: engine.cache.version,
      packageName: engine.id,
      runtimeVersion: describeAccuracyEngine(engine).capabilities.runtime,
    })),
    options: { iterations, workers: options.workers ?? null },
    summary: {
      ironqr,
      baselines,
      ranking: {
        ironqrP95Rank: rankBy(summaries, ironqr.engineId, (summary) => summary.p95DurationMs, 'asc'),
        ironqrThroughputRank: rankBy(
          summaries,
          ironqr.engineId,
          (summary) => summary.throughputAssetsPerSecond,
          'desc',
        ),
      },
      hotSpots: {
        slowestStages: ironqrProfile?.stages.slice(0, 10) ?? [],
        slowestProposalViews: [],
        slowestDecodeAttempts: ironqrProfile?.decodeAttempts.slice(0, 10) ?? [],
      },
      pass,
      regression,
      cache: cacheSummary,
    },
    details: { engines: summaries, assets: iterationResults, ironqrProfile },
  };

  return { reportFile, report };
};

const buildIronqrProfile = async (
  repoRoot: string,
  assets: readonly AccuracyAssetResult[],
): Promise<IronqrPerformanceProfile | null> => {
  if (assets.length === 0) return null;
  const stageTimings = {
    total: [] as number[],
    normalize: [] as number[],
    proposalGeneration: [] as number[],
    ranking: [] as number[],
    clustering: [] as number[],
    clusterProcessing: [] as number[],
    decodeAttempts: [] as number[],
  } satisfies Record<string, number[]>;
  const attemptTimings: Record<string, number[]> = {};

  for (const asset of assets) {
    const image = await readBenchImage(path.join(repoRoot, 'corpus', 'data', asset.relativePath));
    const report = await scanFrame(image, {
      allowMultiple: asset.expectedTexts.length > 1,
      observability: { scan: { timings: 'full' } },
    });
    const timings = report.scan.timings;
    if (!timings) continue;
    stageTimings.total.push(timings.totalMs);
    stageTimings.normalize.push(timings.normalizeFrameMs);
    stageTimings.proposalGeneration.push(timings.proposalGenerationMs);
    stageTimings.ranking.push(timings.rankingMs);
    stageTimings.clustering.push(timings.clusteringMs);
    stageTimings.clusterProcessing.push(timings.clusterProcessingMs);
    stageTimings.decodeAttempts.push(timings.decodeAttemptMs);
    if (hasAttemptTimings(timings)) {
      for (const attempt of timings.attempts) {
        const key = `${attempt.decodeBinaryViewId}/${attempt.sampler}/${attempt.refinement}`;
        (attemptTimings[key] ??= []).push(attempt.durationMs);
      }
    }
  }

  return {
    stages: summarizeTimingRecord(stageTimings).sort((left, right) => right.totalMs - left.totalMs),
    proposalViews: [],
    decodeViews: [],
    samplers: [],
    refinements: [],
    decodeAttempts: summarizeTimingRecord(attemptTimings).sort(
      (left, right) => right.totalMs - left.totalMs,
    ),
  };
};

const hasAttemptTimings = (timings: ScanTimingSummary): timings is ScanTimingDetails => {
  return 'attempts' in timings;
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

const summarizePerformanceEngine = (
  engineId: string,
  results: readonly PerformanceIterationResult[],
): PerformanceEngineSummary => {
  const engineResults = results.filter((result) => result.engineId === engineId);
  const durations = engineResults.map((result) => result.engineScanDurationMs).sort((a, b) => a - b);
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

const buildPerformanceRegressionVerdict = async (
  reportFile: string,
  ironqr: PerformanceEngineSummary,
): Promise<BenchmarkVerdict> => {
  try {
    const previous = JSON.parse(await readFile(reportFile, 'utf8')) as {
      readonly summary?: {
        readonly ironqr?: {
          readonly p95DurationMs?: number;
          readonly throughputAssetsPerSecond?: number;
        };
      };
    };
    const previousIronqr = previous.summary?.ironqr;
    if (!previousIronqr) return unavailableVerdict('Previous performance summary is missing ironqr data.');
    if (ironqr.p95DurationMs > (previousIronqr.p95DurationMs ?? Number.POSITIVE_INFINITY)) {
      return failedVerdict('ironqr p95 duration regressed versus previous performance summary.');
    }
    if (ironqr.throughputAssetsPerSecond < (previousIronqr.throughputAssetsPerSecond ?? 0)) {
      return failedVerdict('ironqr throughput regressed versus previous performance summary.');
    }
    return passedVerdict('Performance summary did not regress versus previous report.');
  } catch {
    return unavailableVerdict('No previous performance summary is available for regression comparison.');
  }
};

const buildPerformancePassVerdict = (
  ironqr: PerformanceEngineSummary,
  baselines: readonly PerformanceEngineSummary[],
): BenchmarkVerdict => {
  const slower = baselines.filter(
    (baseline) => ironqr.p95DurationMs > baseline.p95DurationMs || ironqr.throughputAssetsPerSecond < baseline.throughputAssetsPerSecond,
  );
  if (slower.length === 0) {
    return passedVerdict('ironqr is competitive with or faster than all baseline engines on p95 and throughput.');
  }
  return failedVerdict(
    `ironqr trails baseline engine(s) on p95 or throughput: ${slower.map((engine) => engine.engineId).join(', ')}`,
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
