import path from 'node:path';
import { resolveRepoRootFromModuleUrl } from '../../corpus-cli/src/repo-root.js';
import {
  getDefaultAccuracyCachePath,
  getDefaultAccuracyReportPath,
  inspectAccuracyEngines,
  printAccuracyHome,
  printAccuracySummary,
  printPerformancePlaceholder,
  resolveAccuracyEngines,
  runAccuracyBenchmark,
  runPerformanceBenchmark,
  writeAccuracyReport,
} from './index.js';

const isProgressMode = (value: string): value is CliOptions['progressMode'] => {
  return (
    value === 'auto' ||
    value === 'plain' ||
    value === 'dashboard' ||
    value === 'tui' ||
    value === 'off'
  );
};

interface CliOptions {
  readonly help: boolean;
  readonly engines: readonly string[];
  readonly failuresOnly: boolean;
  readonly listEngines: boolean;
  readonly reportFile?: string;
  readonly cacheFile?: string;
  readonly cacheEnabled: boolean;
  readonly ironqrCacheEnabled: boolean;
  readonly refreshCache: boolean;
  readonly progressMode: 'auto' | 'plain' | 'dashboard' | 'tui' | 'off';
  readonly verbose: boolean;
  readonly ironqrTraceMode: 'off' | 'summary' | 'full';
  readonly workers?: number;
}

export const parseArgs = (
  argv: readonly string[],
): { readonly mode: string | undefined; readonly options: CliOptions } => {
  const [mode, ...rest] = argv;
  const engines: string[] = [];
  let help = false;
  let failuresOnly = false;
  let listEngines = false;
  let reportFile: string | undefined;
  let cacheFile: string | undefined;
  let cacheEnabled = true;
  let ironqrCacheEnabled = true;
  let refreshCache = false;
  let progressMode: 'auto' | 'plain' | 'dashboard' | 'tui' | 'off' = 'auto';
  let verbose = false;
  let ironqrTraceMode: 'off' | 'summary' | 'full' = 'off';
  let workers: number | undefined;

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
    if (arg === '--list-engines') {
      listEngines = true;
      continue;
    }
    if (arg === '--no-cache') {
      cacheEnabled = false;
      continue;
    }
    if (arg === '--no-ironqr-cache') {
      ironqrCacheEnabled = false;
      continue;
    }
    if (arg === '--refresh-cache') {
      refreshCache = true;
      continue;
    }
    if (arg === '--no-progress' || arg === '--quiet') {
      progressMode = 'off';
      continue;
    }
    if (arg === '--progress') {
      const next = rest[index + 1];
      if (!next) throw new Error('--progress requires a value');
      if (!isProgressMode(next)) {
        throw new Error(`--progress must be one of auto|plain|dashboard|tui|off, got: ${next}`);
      }
      progressMode = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--progress=')) {
      const value = arg.slice('--progress='.length);
      if (!isProgressMode(value)) {
        throw new Error(`--progress must be one of auto|plain|dashboard|tui|off, got: ${value}`);
      }
      progressMode = value;
      continue;
    }
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--ironqr-trace') {
      const next = rest[index + 1];
      if (!next) throw new Error('--ironqr-trace requires a value');
      if (next !== 'off' && next !== 'summary' && next !== 'full') {
        throw new Error(`--ironqr-trace must be one of off|summary|full, got: ${next}`);
      }
      ironqrTraceMode = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--ironqr-trace=')) {
      const value = arg.slice('--ironqr-trace='.length);
      if (value !== 'off' && value !== 'summary' && value !== 'full') {
        throw new Error(`--ironqr-trace must be one of off|summary|full, got: ${value}`);
      }
      ironqrTraceMode = value;
      continue;
    }
    if (arg === '--workers') {
      const next = rest[index + 1];
      if (!next) throw new Error('--workers requires a value');
      const parsed = Number.parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--workers must be a positive integer, got: ${next}`);
      }
      workers = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith('--workers=')) {
      const parsed = Number.parseInt(arg.slice('--workers='.length), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(
          `--workers must be a positive integer, got: ${arg.slice('--workers='.length)}`,
        );
      }
      workers = parsed;
      continue;
    }
    if (arg === '--engine') {
      const next = rest[index + 1];
      if (!next) throw new Error('--engine requires a value');
      engines.push(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--engine=')) {
      engines.push(arg.slice('--engine='.length));
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
      engines,
      failuresOnly,
      listEngines,
      cacheEnabled,
      ironqrCacheEnabled,
      refreshCache,
      progressMode,
      verbose,
      ironqrTraceMode,
      ...(workers === undefined ? {} : { workers }),
      ...(reportFile === undefined ? {} : { reportFile }),
      ...(cacheFile === undefined ? {} : { cacheFile }),
    },
  };
};

const printUsage = (): void => {
  console.log('bin: bun run bench');
  console.log('description: Benchmark QR decoders against the approved corpus manifest');
  console.log('commands:');
  console.log('  "bun run bench accuracy"');
  console.log('  "bun run bench accuracy --list-engines"');
  console.log('  "bun run bench accuracy --engine ironqr --engine zxing-cpp"');
  console.log('  "bun run bench accuracy --refresh-cache"');
  console.log('  "bun run bench accuracy --no-cache"');
  console.log('  "bun run bench accuracy --no-ironqr-cache"');
  console.log('  "bun run bench accuracy --progress auto|plain|dashboard|tui|off"');
  console.log('  "bun run bench accuracy --no-progress"');
  console.log('  "bun run bench accuracy --workers 8"');
  console.log('  "bun run bench accuracy --verbose"');
  console.log('  "bun run bench accuracy --ironqr-trace off|summary|full"');
  console.log('  "bun run bench performance"');
};

const runAccuracy = async (repoRoot: string, options: CliOptions): Promise<void> => {
  if (options.listEngines) {
    printAccuracyHome(process.argv[1] ?? 'bun run bench', repoRoot, inspectAccuracyEngines());
    return;
  }

  const reportFile = options.reportFile
    ? path.resolve(repoRoot, options.reportFile)
    : getDefaultAccuracyReportPath(repoRoot);
  const cacheFile = options.cacheFile
    ? path.resolve(repoRoot, options.cacheFile)
    : getDefaultAccuracyCachePath(repoRoot);
  const engines = resolveAccuracyEngines(options.engines);
  const result = await runAccuracyBenchmark(repoRoot, engines, reportFile, {
    cache: {
      enabled: options.cacheEnabled,
      refresh: options.refreshCache,
      file: cacheFile,
      disabledEngineIds: options.ironqrCacheEnabled ? [] : ['ironqr'],
    },
    progress: {
      enabled: options.progressMode !== 'off',
      mode: options.progressMode,
      verbose: options.verbose,
    },
    execution: {
      ...(options.workers === undefined ? {} : { workers: options.workers }),
    },
    ...(options.verbose || options.ironqrTraceMode !== 'off'
      ? {
          observability: {
            verbose: options.verbose,
            ironqrTraceMode: options.ironqrTraceMode,
          },
        }
      : {}),
  });
  printAccuracySummary(result, { failuresOnly: options.failuresOnly, verbose: options.verbose });
  if (options.progressMode !== 'off') {
    console.error(`[bench] stage report: writing ${result.reportFile}`);
  }
  await writeAccuracyReport(result);
};

const runPerformance = async (): Promise<void> => {
  const result = await runPerformanceBenchmark();
  printPerformancePlaceholder(process.argv[1] ?? 'bun run bench', result);
};

const main = async (): Promise<void> => {
  const repoRoot = resolveRepoRootFromModuleUrl(import.meta.url);
  const { mode, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!mode) {
    printAccuracyHome(process.argv[1] ?? 'bun run bench', repoRoot, inspectAccuracyEngines());
    return;
  }

  switch (mode) {
    case 'accuracy':
      await runAccuracy(repoRoot, options);
      return;
    case 'performance':
      await runPerformance();
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
