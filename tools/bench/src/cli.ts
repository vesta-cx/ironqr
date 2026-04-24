import path from 'node:path';
import { resolveRepoRootFromModuleUrl } from '../../corpus-cli/src/repo-root.js';
import {
  getDefaultAccuracyCachePath,
  getDefaultAccuracyReportPath,
  inspectAccuracyEngines,
  printAccuracyHome,
  printAccuracySummary,
  printPerformanceSummary,
  resolveAccuracyEngines,
  runAccuracyBenchmark,
  runPerformanceBenchmark,
  writeAccuracyReport,
  writeJsonReport,
  writePerformanceReport,
  type BenchmarkVerdict,
} from './index.js';

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
  readonly cacheFile?: string;
  readonly cacheEnabled: boolean;
  readonly refreshCache: boolean;
  readonly refreshCacheEngineId?: string;
  readonly progressEnabled: boolean;
  readonly workers?: number;
  readonly iterations?: number;
}

export const parseArgs = (
  argv: readonly string[],
): { readonly mode: string | undefined; readonly options: CliOptions } => {
  const [mode, ...rest] = argv;
  let help = false;
  let failuresOnly = false;
  let reportFile: string | undefined;
  let cacheFile: string | undefined;
  let cacheEnabled = true;
  let refreshCache = false;
  let refreshCacheEngineId: string | undefined;
  let progressEnabled = true;
  let workers: number | undefined;
  let iterations: number | undefined;

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
      throw new Error('Benchmarks always run the full target engine set; --engine is not supported');
    }
    if (arg === '--ironqr-trace' || arg.startsWith('--ironqr-trace=')) {
      throw new Error('Focused accuracy does not support full trace collection; use bench performance');
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

  return {
    mode,
    options: {
      help,
      failuresOnly,
      cacheEnabled,
      refreshCache,
      progressEnabled,
      ...(refreshCacheEngineId === undefined ? {} : { refreshCacheEngineId }),
      ...(workers === undefined ? {} : { workers }),
      ...(iterations === undefined ? {} : { iterations }),
      ...(reportFile === undefined ? {} : { reportFile }),
      ...(cacheFile === undefined ? {} : { cacheFile }),
    },
  };
};

const printUsage = (): void => {
  console.log('bin: bun run bench');
  console.log('description: Full benchmark suite for ironqr accuracy and performance');
  console.log('commands:');
  console.log('  "bun run bench"');
  console.log('  "bun run bench accuracy"');
  console.log('  "bun run bench performance"');
  console.log('  "bun run bench engines"');
  console.log('  "bun run bench accuracy --refresh-cache"');
  console.log('  "bun run bench performance --iterations 8"');
  console.log('  "bun run bench --no-progress"');
};

const runAccuracy = async (repoRoot: string, options: CliOptions): Promise<void> => {
  const reportFile = options.reportFile
    ? path.resolve(repoRoot, options.reportFile)
    : getDefaultAccuracyReportPath(repoRoot);
  const cacheFile = options.cacheFile
    ? path.resolve(repoRoot, options.cacheFile)
    : getDefaultAccuracyCachePath(repoRoot);
  const engines = resolveAccuracyEngines();
  const result = await runAccuracyBenchmark(repoRoot, engines, reportFile, {
    cache: {
      enabled: options.cacheEnabled,
      refresh: options.refreshCache,
      file: cacheFile,
      disabledEngineIds: [],
    },
    progress: { enabled: options.progressEnabled },
    execution: options.workers === undefined ? {} : { workers: options.workers },
  });
  printAccuracySummary(result, { failuresOnly: options.failuresOnly });
  await writeAccuracyReport(result);
};

const runPerformance = async (repoRoot: string, options: CliOptions): Promise<void> => {
  const reportFile = options.reportFile
    ? path.resolve(repoRoot, options.reportFile)
    : path.join(repoRoot, 'tools', 'bench', 'reports', 'performance.json');
  const cacheFile = options.cacheFile
    ? path.resolve(repoRoot, options.cacheFile)
    : getDefaultAccuracyCachePath(repoRoot);
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
  });
  printPerformanceSummary(result);
  await writePerformanceReport(result);
};

const runSuite = async (repoRoot: string, options: CliOptions): Promise<void> => {
  const accuracyReportFile = getDefaultAccuracyReportPath(repoRoot);
  const performanceReportFile = path.join(repoRoot, 'tools', 'bench', 'reports', 'performance.json');
  await runAccuracy(repoRoot, { ...options, reportFile: accuracyReportFile });
  await runPerformance(repoRoot, { ...options, reportFile: performanceReportFile });
  const pass: BenchmarkVerdict = {
    status: 'unavailable',
    description: 'Suite verdict aggregation will compare accuracy and performance summaries in a follow-up slice.',
  };
  const summary = {
    kind: 'suite-report',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'passed',
    verdicts: { pass, regression: pass },
    benchmark: {
      name: 'Bench Full Suite',
      description:
        'Runs the standard ironqr benchmark suite: accuracy comparison against every target baseline engine plus performance comparison/profiling. Start with summary.verdicts, then inspect linked reports.',
    },
    command: { name: 'suite', argv: process.argv.slice(2) },
    repo: { root: repoRoot, commit: null, dirty: null },
    corpus: {
      manifestPath: path.join(repoRoot, 'corpus', 'data', 'manifest.json'),
      assetCount: 0,
      positiveCount: 0,
      negativeCount: 0,
      manifestHash: '',
      assetIds: [],
    },
    selection: { seed: null, filters: {} },
    engines: [],
    options: {},
    summary: {
      verdicts: {
        accuracyPass: pass,
        accuracyRegression: pass,
        performancePass: pass,
        performanceRegression: pass,
      },
      highlights: {
        ironqrAccuracyRank: null,
        ironqrSpeedRank: null,
        ironqrPassRate: 0,
        ironqrP95DurationMs: 0,
        biggestAccuracyGaps: [],
        slowestIronqrAssets: [],
      },
    },
    details: { accuracyReportFile, performanceReportFile },
  };
  const summaryFile = path.join(repoRoot, 'tools', 'bench', 'reports', 'summary.json');
  await writeJsonReport(summaryFile, summary);
  console.log(`summaryReport: ${JSON.stringify(summaryFile)}`);
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
