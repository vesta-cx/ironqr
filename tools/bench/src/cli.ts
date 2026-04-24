import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveRepoRootFromModuleUrl } from '../../corpus-cli/src/repo-root.js';
import {
  type BenchmarkVerdict,
  getDefaultAccuracyCachePath,
  getDefaultAccuracyReportPath,
  getDefaultPerformanceCachePath,
  inspectAccuracyEngines,
  printAccuracyHome,
  printAccuracySummary,
  printPerformanceSummary,
  resolveAccuracyEngines,
  runAccuracyBenchmark,
  runPerformanceBenchmark,
  runStudyBenchmark,
  writeAccuracyReport,
  writePerformanceReport,
  writeReportWithSnapshot,
} from './index.js';

const parseLabel = (value: string): 'qr-pos' | 'qr-neg' => {
  if (value === 'qr-pos' || value === 'qr-neg') return value;
  throw new Error(`--label must be qr-pos or qr-neg, got: ${value}`);
};

const parsePositiveInteger = (value: string, flag: string): number => {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer, got: ${value}`);
  }
  return Number(value);
};

interface CliOptions {
  readonly help: boolean;
  readonly failuresOnly: boolean;
  readonly reportFile?: string;
  readonly reportDir?: string;
  readonly cacheFile?: string;
  readonly cacheEnabled: boolean;
  readonly refreshCache: boolean;
  readonly refreshCacheEngineId?: string;
  readonly progressEnabled: boolean;
  readonly workers?: number;
  readonly iterations?: number;
  readonly assetIds: readonly string[];
  readonly labels: readonly ('qr-pos' | 'qr-neg')[];
  readonly maxAssets?: number;
  readonly seed?: string;
  readonly studyId?: string;
}

export const parseArgs = (
  argv: readonly string[],
): { readonly mode: string | undefined; readonly options: CliOptions } => {
  const mode = argv[0]?.startsWith('-') ? undefined : argv[0];
  const rawRest = mode === undefined ? argv : argv.slice(1);
  let studyId: string | undefined;
  let rest = rawRest;
  if (mode === 'study' && rawRest[0] && !rawRest[0].startsWith('-')) {
    studyId = rawRest[0];
    rest = rawRest.slice(1);
  }
  let help = false;
  let failuresOnly = false;
  let reportFile: string | undefined;
  let reportDir: string | undefined;
  let cacheFile: string | undefined;
  let cacheEnabled = true;
  let refreshCache = false;
  let refreshCacheEngineId: string | undefined;
  let progressEnabled = true;
  let workers: number | undefined;
  let iterations: number | undefined;
  const assetIds: string[] = [];
  const labels: Array<'qr-pos' | 'qr-neg'> = [];
  let maxAssets: number | undefined;
  let seed: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--failures-only') {
      failuresOnly = true;
      continue;
    }
    if (arg === '--no-cache') {
      cacheEnabled = false;
      continue;
    }
    if (arg === '--refresh-cache') {
      refreshCache = true;
      const next = rest[index + 1];
      if (next && !next.startsWith('-')) {
        refreshCacheEngineId = next;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--refresh-cache=')) {
      refreshCache = true;
      refreshCacheEngineId = arg.slice('--refresh-cache='.length);
      continue;
    }
    if (arg === '--no-progress' || arg === '--quiet') {
      progressEnabled = false;
      continue;
    }
    if (arg === '--progress' || arg.startsWith('--progress=')) {
      throw new Error('Use --no-progress to disable OpenTUI progress');
    }
    if (arg === '--engine' || arg.startsWith('--engine=')) {
      throw new Error(
        'Benchmarks always run the full target engine set; --engine is not supported',
      );
    }
    if (arg === '--ironqr-trace' || arg.startsWith('--ironqr-trace=')) {
      throw new Error(
        'Focused accuracy does not support full trace collection; use bench performance',
      );
    }
    if (arg === '--asset') {
      const next = rest[index + 1];
      if (!next) throw new Error('--asset requires a value');
      assetIds.push(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--asset=')) {
      assetIds.push(arg.slice('--asset='.length));
      continue;
    }
    if (arg === '--label') {
      const next = rest[index + 1];
      if (!next) throw new Error('--label requires a value');
      labels.push(parseLabel(next));
      index += 1;
      continue;
    }
    if (arg.startsWith('--label=')) {
      labels.push(parseLabel(arg.slice('--label='.length)));
      continue;
    }
    if (arg === '--max-assets') {
      const next = rest[index + 1];
      if (!next) throw new Error('--max-assets requires a value');
      maxAssets = parsePositiveInteger(next, '--max-assets');
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-assets=')) {
      maxAssets = parsePositiveInteger(arg.slice('--max-assets='.length), '--max-assets');
      continue;
    }
    if (arg === '--seed') {
      const next = rest[index + 1];
      if (!next) throw new Error('--seed requires a value');
      seed = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--seed=')) {
      seed = arg.slice('--seed='.length);
      continue;
    }
    if (arg === '--workers') {
      const next = rest[index + 1];
      if (!next) throw new Error('--workers requires a value');
      workers = parsePositiveInteger(next, '--workers');
      index += 1;
      continue;
    }
    if (arg.startsWith('--workers=')) {
      workers = parsePositiveInteger(arg.slice('--workers='.length), '--workers');
      continue;
    }
    if (arg === '--iterations') {
      const next = rest[index + 1];
      if (!next) throw new Error('--iterations requires a value');
      iterations = parsePositiveInteger(next, '--iterations');
      index += 1;
      continue;
    }
    if (arg.startsWith('--iterations=')) {
      iterations = parsePositiveInteger(arg.slice('--iterations='.length), '--iterations');
      continue;
    }
    if (arg === '--report-file') {
      const next = rest[index + 1];
      if (!next) throw new Error('--report-file requires a value');
      reportFile = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--report-file=')) {
      reportFile = arg.slice('--report-file='.length);
      continue;
    }
    if (arg === '--report-dir') {
      const next = rest[index + 1];
      if (!next) throw new Error('--report-dir requires a value');
      reportDir = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--report-dir=')) {
      reportDir = arg.slice('--report-dir='.length);
      continue;
    }
    if (arg === '--cache-file') {
      const next = rest[index + 1];
      if (!next) throw new Error('--cache-file requires a value');
      cacheFile = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--cache-file=')) {
      cacheFile = arg.slice('--cache-file='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const options = {
    help,
    failuresOnly,
    cacheEnabled,
    refreshCache,
    progressEnabled,
    ...(refreshCacheEngineId === undefined ? {} : { refreshCacheEngineId }),
    ...(workers === undefined ? {} : { workers }),
    ...(iterations === undefined ? {} : { iterations }),
    assetIds,
    labels,
    ...(maxAssets === undefined ? {} : { maxAssets }),
    ...(seed === undefined ? {} : { seed }),
    ...(studyId === undefined ? {} : { studyId }),
    ...(reportFile === undefined ? {} : { reportFile }),
    ...(reportDir === undefined ? {} : { reportDir }),
    ...(cacheFile === undefined ? {} : { cacheFile }),
  } satisfies CliOptions;
  validateModeOptions(mode, options);
  return { mode, options };
};

const validateModeOptions = (mode: string | undefined, options: CliOptions): void => {
  const command = mode ?? 'suite';
  if (options.help) return;
  if (command === 'accuracy' && options.iterations !== undefined) {
    throw new Error('--iterations is only supported by bench performance and the full suite');
  }
  if (command === 'study' && options.iterations !== undefined) {
    throw new Error('--iterations is not supported by bench study');
  }
  if (command === 'engines') {
    const unsupported = [
      options.failuresOnly ? '--failures-only' : null,
      options.reportFile ? '--report-file' : null,
      options.reportDir ? '--report-dir' : null,
      options.cacheFile ? '--cache-file' : null,
      options.workers !== undefined ? '--workers' : null,
      options.iterations !== undefined ? '--iterations' : null,
      options.assetIds.length > 0 ? '--asset' : null,
      options.labels.length > 0 ? '--label' : null,
      options.maxAssets !== undefined ? '--max-assets' : null,
      options.seed !== undefined ? '--seed' : null,
      options.refreshCache ? '--refresh-cache' : null,
      !options.cacheEnabled ? '--no-cache' : null,
    ].filter(Boolean);
    if (unsupported.length > 0) {
      throw new Error(`bench engines does not support: ${unsupported.join(', ')}`);
    }
  }
};

const printUsage = (): void => {
  console.log('bin: bun run bench');
  console.log('description: Full benchmark suite for ironqr accuracy and performance');
  console.log('commands:');
  console.log('  "bun run bench"');
  console.log('  "bun run bench accuracy"');
  console.log('  "bun run bench performance"');
  console.log('  "bun run bench study view-order"');
  console.log('  "bun run bench engines"');
  console.log('  "bun run bench accuracy --refresh-cache"');
  console.log('  "bun run bench performance --iterations 8"');
  console.log('  "bun run bench --no-progress"');
};

const resolveReportFile = (
  repoRoot: string,
  options: CliOptions,
  defaultFileName: string,
  defaultPath: string,
): string => {
  if (options.reportFile) return path.resolve(repoRoot, options.reportFile);
  if (options.reportDir)
    return path.join(path.resolve(repoRoot, options.reportDir), defaultFileName);
  return defaultPath;
};

const runAccuracy = async (repoRoot: string, options: CliOptions): Promise<void> => {
  const reportFile = resolveReportFile(
    repoRoot,
    options,
    'accuracy.json',
    getDefaultAccuracyReportPath(repoRoot),
  );
  const cacheFile = options.cacheFile
    ? path.resolve(repoRoot, options.cacheFile)
    : getDefaultAccuracyCachePath(repoRoot);
  const engines = resolveAccuracyEngines();
  const seed = options.seed ?? crypto.randomUUID();
  const result = await runAccuracyBenchmark(repoRoot, engines, reportFile, {
    cache: {
      enabled: options.cacheEnabled,
      refresh: options.refreshCache,
      file: cacheFile,
      disabledEngineIds: [],
      refreshEngineIds: options.refreshCacheEngineId ? [options.refreshCacheEngineId] : [],
    },
    progress: { enabled: options.progressEnabled },
    execution: options.workers === undefined ? {} : { workers: options.workers },
    selection: {
      assetIds: options.assetIds,
      labels: options.labels,
      ...(options.maxAssets === undefined ? {} : { maxAssets: options.maxAssets }),
      ...(seed === undefined ? {} : { seed }),
    },
  });
  printAccuracySummary(result, { failuresOnly: options.failuresOnly });
  await writeAccuracyReport(result);
};

const runPerformance = async (repoRoot: string, options: CliOptions): Promise<void> => {
  const reportFile = resolveReportFile(
    repoRoot,
    options,
    'performance.json',
    path.join(repoRoot, 'tools', 'bench', 'reports', 'performance.json'),
  );
  const cacheFile = options.cacheFile
    ? path.resolve(repoRoot, options.cacheFile)
    : getDefaultPerformanceCachePath(repoRoot);
  const seed = options.seed ?? crypto.randomUUID();
  const result = await runPerformanceBenchmark(repoRoot, reportFile, {
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
    ...(options.workers === undefined ? {} : { workers: options.workers }),
    cache: {
      enabled: options.cacheEnabled,
      refresh: options.refreshCache,
      file: cacheFile,
      ...(options.refreshCacheEngineId ? { refreshEngineId: options.refreshCacheEngineId } : {}),
    },
    progress: { enabled: options.progressEnabled },
    selection: {
      seed: seed ?? null,
      assetIds: options.assetIds,
      labels: options.labels,
      ...(options.maxAssets === undefined ? {} : { maxAssets: options.maxAssets }),
      filters: {
        assetIds: options.assetIds,
        labels: options.labels,
        maxAssets: options.maxAssets ?? null,
      },
    },
  });
  printPerformanceSummary(result);
  await writePerformanceReport(result);
};

const runStudy = async (repoRoot: string, options: CliOptions): Promise<void> => {
  if (!options.studyId)
    throw new Error('bench study requires a study id, e.g. bench study view-order');
  const reportFile = options.reportFile
    ? path.resolve(repoRoot, options.reportFile)
    : options.reportDir
      ? path.join(path.resolve(repoRoot, options.reportDir), `study-${options.studyId}.json`)
      : undefined;
  const cacheFile = options.cacheFile ? path.resolve(repoRoot, options.cacheFile) : undefined;
  const result = await runStudyBenchmark(repoRoot, options.studyId, {
    ...(reportFile === undefined ? {} : { reportFile }),
    ...(cacheFile === undefined ? {} : { cacheFile }),
    progressEnabled: options.progressEnabled,
    assetIds: options.assetIds,
    labels: options.labels,
    ...(options.maxAssets === undefined ? {} : { maxAssets: options.maxAssets }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  console.log(`studyReport: ${JSON.stringify(result.reportFile)}`);
};

const runSuite = async (repoRoot: string, options: CliOptions): Promise<void> => {
  const suiteOptions = { ...options, seed: options.seed ?? crypto.randomUUID() };
  const reportDir = options.reportDir
    ? path.resolve(repoRoot, options.reportDir)
    : path.join(repoRoot, 'tools', 'bench', 'reports');
  const accuracyReportFile = path.join(reportDir, 'accuracy.json');
  const performanceReportFile = path.join(reportDir, 'performance.json');
  await runAccuracy(repoRoot, { ...suiteOptions, reportFile: accuracyReportFile });
  await runPerformance(repoRoot, { ...suiteOptions, reportFile: performanceReportFile });
  const [accuracyReport, performanceReport] = await Promise.all([
    readReport(accuracyReportFile),
    readReport(performanceReportFile),
  ]);
  const accuracyPass = readVerdict(accuracyReport, 'pass');
  const accuracyRegression = readVerdict(accuracyReport, 'regression');
  const performancePass = readVerdict(performanceReport, 'pass');
  const performanceRegression = readVerdict(performanceReport, 'regression');
  const pass: BenchmarkVerdict =
    accuracyPass.status === 'failed' || performancePass.status === 'failed'
      ? {
          status: 'failed',
          description: 'Accuracy or performance benchmark reported a failed pass verdict.',
        }
      : { status: 'passed', description: 'Accuracy and performance pass verdicts did not fail.' };
  const regression: BenchmarkVerdict =
    accuracyRegression.status === 'failed' || performanceRegression.status === 'failed'
      ? {
          status: 'failed',
          description: 'Accuracy or performance benchmark reported a regression.',
        }
      : accuracyRegression.status === 'unavailable' ||
          performanceRegression.status === 'unavailable'
        ? {
            status: 'unavailable',
            description: 'At least one component regression verdict is unavailable.',
          }
        : { status: 'passed', description: 'No component benchmark reported a regression.' };
  const accuracySummary = recordAt(accuracyReport, 'summary');
  const performanceSummary = recordAt(performanceReport, 'summary');
  const accuracyIronqr = recordAt(accuracySummary, 'ironqr');
  const performanceIronqr = recordAt(performanceSummary, 'ironqr');
  const performanceRanking = recordAt(performanceSummary, 'ranking');
  const accuracyGaps = recordAt(accuracySummary, 'gaps');
  const suiteRepo = reportRepo(accuracyReport.repo, repoRoot);
  const summary = {
    kind: 'suite-report',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: pass.status === 'failed' ? 'failed' : 'passed',
    verdicts: { pass, regression },
    benchmark: {
      name: 'Bench Full Suite',
      description:
        'Runs the standard `ironqr` benchmark suite: accuracy comparison against every target baseline engine plus performance comparison/profiling. This report answers whether the current branch regressed on correctness or speed. Start with `summary.verdicts`, then inspect `summary.highlights`, then open the linked accuracy and performance reports for details.',
    },
    command: { name: 'suite', argv: process.argv.slice(2) },
    repo: suiteRepo,
    corpus: accuracyReport.corpus ?? performanceReport.corpus,
    selection: accuracyReport.selection ??
      performanceReport.selection ?? { seed: null, filters: {} },
    engines: mergeEngines(accuracyReport.engines, performanceReport.engines),
    options: {
      cacheEnabled: options.cacheEnabled,
      refreshCache: options.refreshCache,
      refreshCacheEngineId: options.refreshCacheEngineId ?? null,
      workers: options.workers ?? null,
      iterations: options.iterations ?? null,
      maxAssets: options.maxAssets ?? null,
      seed: suiteOptions.seed ?? null,
    },
    summary: {
      verdicts: {
        accuracyPass,
        accuracyRegression,
        performancePass,
        performanceRegression,
      },
      highlights: {
        ironqrAccuracyRank: rankAccuracyIronqr(accuracySummary),
        ironqrSpeedRank: numberOrNull(performanceRanking.ironqrP95Rank),
        ironqrPassRate: numberOrZero(accuracyIronqr.fullPassRate),
        ironqrP95DurationMs: numberOrZero(performanceIronqr.p95DurationMs),
        biggestAccuracyGaps: arrayOrEmpty(accuracyGaps.topIronqrMissedBaselineHits),
        slowestIronqrAssets: slowestIronqrAssets(performanceReport),
      },
    },
    details: { accuracyReportFile, performanceReportFile },
  };
  const summaryFile = path.join(reportDir, 'summary.json');
  const finalSummary = {
    ...summary,
    verdicts: {
      ...summary.verdicts,
      regression: await buildSuiteRegressionVerdict(summaryFile, summary.summary),
    },
  };
  await writeReportWithSnapshot(summaryFile, finalSummary);
  console.log(`summaryReport: ${JSON.stringify(summaryFile)}`);
};

const readReport = async (filePath: string): Promise<Record<string, unknown>> => {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
};

const buildSuiteRegressionVerdict = async (
  summaryFile: string,
  currentSummary: Record<string, unknown>,
): Promise<BenchmarkVerdict> => {
  try {
    const previous = await readReport(summaryFile);
    const previousHighlights = recordAt(recordAt(previous, 'summary'), 'highlights');
    const currentHighlights = recordAt(currentSummary, 'highlights');
    const previousPassRate = numberOrNull(previousHighlights.ironqrPassRate);
    const currentPassRate = numberOrNull(currentHighlights.ironqrPassRate);
    const previousP95 = numberOrNull(previousHighlights.ironqrP95DurationMs);
    const currentP95 = numberOrNull(currentHighlights.ironqrP95DurationMs);
    const previousAccuracyRank = numberOrNull(previousHighlights.ironqrAccuracyRank);
    const currentAccuracyRank = numberOrNull(currentHighlights.ironqrAccuracyRank);
    const previousSpeedRank = numberOrNull(previousHighlights.ironqrSpeedRank);
    const currentSpeedRank = numberOrNull(currentHighlights.ironqrSpeedRank);
    const previousGapCount = arrayOrEmpty(previousHighlights.biggestAccuracyGaps).length;
    const currentGapCount = arrayOrEmpty(currentHighlights.biggestAccuracyGaps).length;
    if (
      previousPassRate === null ||
      currentPassRate === null ||
      previousP95 === null ||
      currentP95 === null
    ) {
      return {
        status: 'unavailable',
        description: 'Previous suite summary is missing comparable highlights.',
      };
    }
    if (currentPassRate < previousPassRate) {
      return {
        status: 'failed',
        description: 'ironqr suite pass rate regressed versus previous summary.',
      };
    }
    if (currentP95 > previousP95) {
      return {
        status: 'failed',
        description: 'ironqr suite p95 duration regressed versus previous summary.',
      };
    }
    if (
      previousAccuracyRank !== null &&
      currentAccuracyRank !== null &&
      currentAccuracyRank > previousAccuracyRank
    ) {
      return {
        status: 'failed',
        description: 'ironqr suite accuracy rank regressed versus previous summary.',
      };
    }
    if (
      previousSpeedRank !== null &&
      currentSpeedRank !== null &&
      currentSpeedRank > previousSpeedRank
    ) {
      return {
        status: 'failed',
        description: 'ironqr suite speed rank regressed versus previous summary.',
      };
    }
    if (currentGapCount > previousGapCount) {
      return {
        status: 'failed',
        description: 'ironqr suite accuracy gap count regressed versus previous summary.',
      };
    }
    return {
      status: 'passed',
      description: 'Suite summary did not regress versus previous report.',
    };
  } catch {
    return {
      status: 'unavailable',
      description: 'No previous suite summary is available for regression comparison.',
    };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const recordAt = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  return isRecord(value) ? value : {};
};

const arrayOrEmpty = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

const numberOrZero = (value: unknown): number => numberOrNull(value) ?? 0;

const reportRepo = (value: unknown, repoRoot: string) => {
  if (!isRecord(value)) return { root: repoRoot, commit: null, dirty: null };
  return {
    root: typeof value.root === 'string' ? value.root : repoRoot,
    commit: typeof value.commit === 'string' ? value.commit : null,
    dirty: typeof value.dirty === 'boolean' ? value.dirty : null,
  };
};

const mergeEngines = (...engineLists: readonly unknown[]): readonly unknown[] => {
  const engines = new Map<string, unknown>();
  for (const engineList of engineLists) {
    if (!Array.isArray(engineList)) continue;
    for (const engine of engineList) {
      if (!isRecord(engine) || typeof engine.id !== 'string') continue;
      engines.set(engine.id, engine);
    }
  }
  return [...engines.values()];
};

const rankAccuracyIronqr = (accuracySummary: Record<string, unknown>): number | null => {
  const ironqr = recordAt(accuracySummary, 'ironqr');
  const baselines = arrayOrEmpty(accuracySummary.baselines).filter(isRecord);
  if (!isRecord(ironqr) || typeof ironqr.engineId !== 'string') return null;
  const ranked = [ironqr, ...baselines].sort((left, right) => {
    const passRateDelta = numberOrZero(right.fullPassRate) - numberOrZero(left.fullPassRate);
    if (passRateDelta !== 0) return passRateDelta;
    return numberOrZero(left.falsePositiveRate) - numberOrZero(right.falsePositiveRate);
  });
  const index = ranked.findIndex((engine) => engine.engineId === 'ironqr');
  return index === -1 ? null : index + 1;
};

const slowestIronqrAssets = (performanceReport: Record<string, unknown>): readonly unknown[] => {
  const details = recordAt(performanceReport, 'details');
  return arrayOrEmpty(details.assets)
    .filter(isRecord)
    .filter((asset) => asset.engineId === 'ironqr')
    .sort(
      (left, right) =>
        numberOrZero(right.engineScanDurationMs) - numberOrZero(left.engineScanDurationMs),
    )
    .slice(0, 20);
};

const readVerdict = (
  report: Record<string, unknown>,
  key: 'pass' | 'regression',
): BenchmarkVerdict => {
  const verdicts = report.verdicts as { readonly [K in typeof key]?: BenchmarkVerdict } | undefined;
  return (
    verdicts?.[key] ?? {
      status: 'unavailable',
      description: `Missing ${key} verdict in component report.`,
    }
  );
};

const main = async (): Promise<void> => {
  const repoRoot = resolveRepoRootFromModuleUrl(import.meta.url);
  const { mode, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  switch (mode ?? 'suite') {
    case 'suite':
      await runSuite(repoRoot, options);
      return;
    case 'accuracy':
      await runAccuracy(repoRoot, options);
      return;
    case 'performance':
      await runPerformance(repoRoot, options);
      return;
    case 'study':
      await runStudy(repoRoot, options);
      return;
    case 'engines':
      printAccuracyHome(process.argv[1] ?? 'bun run bench', repoRoot, inspectAccuracyEngines());
      return;
    case '--help':
    case '-h':
    case 'help':
      printUsage();
      return;
    default:
      printUsage();
      throw new Error(`Unknown bench mode: ${mode}`);
  }
};

if (import.meta.main) {
  await main();
}
