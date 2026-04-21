import { resolveRepoRootFromModuleUrl } from '../../corpus-cli/src/repo-root.js';
import {
  printAccuracyEngineCatalog,
  printAccuracySummary,
  writeAccuracyReport,
} from './accuracy/report.js';
import {
  inspectAccuracyEngines,
  resolveAccuracyEngines,
  runAccuracyBenchmark,
} from './accuracy/runner.js';
import {
  printPerformanceSummary,
  runPerformanceBenchmark,
  writePerformanceReport,
} from './performance.js';

interface CliOptions {
  readonly engines: readonly string[];
  readonly failuresOnly: boolean;
  readonly listEngines: boolean;
}

const parseArgs = (
  argv: readonly string[],
): { readonly mode: string | undefined; readonly options: CliOptions } => {
  const [mode, ...rest] = argv;
  const engines: string[] = [];
  let failuresOnly = false;
  let listEngines = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) continue;
    if (arg === '--failures-only') {
      failuresOnly = true;
      continue;
    }
    if (arg === '--list-engines') {
      listEngines = true;
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    mode,
    options: { engines, failuresOnly, listEngines },
  };
};

const printUsage = (): void => {
  console.log(
    'Usage: bun run bench <performance|accuracy|engines> [--engine <id>] [--failures-only] [--list-engines]',
  );
};

const runPerformance = async (): Promise<void> => {
  const repoRoot = resolveRepoRootFromModuleUrl(import.meta.url);
  const result = await runPerformanceBenchmark();
  printPerformanceSummary(result, repoRoot);
  await writePerformanceReport(result, repoRoot);
};

const runAccuracy = async (options: CliOptions): Promise<void> => {
  const repoRoot = resolveRepoRootFromModuleUrl(import.meta.url);
  if (options.listEngines) {
    printAccuracyEngineCatalog(inspectAccuracyEngines());
    return;
  }

  const engines = resolveAccuracyEngines(options.engines);
  const result = await runAccuracyBenchmark(repoRoot, engines);
  printAccuracySummary(result, repoRoot, { failuresOnly: options.failuresOnly });
  await writeAccuracyReport(result, repoRoot);
};

const runEngines = (): void => {
  printAccuracyEngineCatalog(inspectAccuracyEngines());
};

const main = async (): Promise<void> => {
  const { mode, options } = parseArgs(process.argv.slice(2));
  if (!mode) {
    printUsage();
    process.exit(1);
  }

  switch (mode) {
    case 'performance':
      await runPerformance();
      return;
    case 'accuracy':
      await runAccuracy(options);
      return;
    case 'engines':
      runEngines();
      return;
    default:
      printUsage();
      throw new Error(`Unknown bench mode: ${mode}`);
  }
};

if (import.meta.main) {
  await main();
}
