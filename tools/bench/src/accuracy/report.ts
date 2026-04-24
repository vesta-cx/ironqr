import { writeFile } from 'node:fs/promises';
import { collapseHome } from '../shared/paths.js';
import { statusCodeForResult } from './scoring.js';
import type {
  AccuracyAssetResult,
  AccuracyBenchmarkResult,
  AccuracyEngineDescriptor,
} from './types.js';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const ms = (value: number): string => `${value.toFixed(2)}ms`;

const truncate = (value: string, max = 60): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const formatCell = (value: string | number | boolean): string => {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
};

const printScalar = (key: string, value: string | number | boolean): void => {
  console.log(`${key}: ${formatCell(value)}`);
};

const printTable = (
  label: string,
  fields: readonly string[],
  rows: readonly (readonly (string | number | boolean)[])[],
): void => {
  console.log(`${label}[${rows.length}]{${fields.join(',')}}:`);
  for (const row of rows) {
    console.log(`  ${row.map((value) => formatCell(value)).join(',')}`);
  }
};

const describeCapabilities = (engine: AccuracyEngineDescriptor): string => {
  return [
    engine.capabilities.runtime,
    engine.capabilities.multiCode ? 'multi' : 'single',
    `invert:${engine.capabilities.inversion}`,
    `rotate:${engine.capabilities.rotation}`,
  ].join(' ');
};

const assetStatusRows = (
  result: AccuracyBenchmarkResult,
  assets: readonly AccuracyAssetResult[],
): readonly (readonly (string | number | boolean)[])[] => {
  return assets.map((asset) => {
    const cells: (string | number | boolean)[] = [
      asset.assetId,
      asset.label,
      asset.expectedTexts.map((text) => truncate(text, 40)).join(' | '),
    ];
    for (const engine of result.engines) {
      const engineResult = asset.results.find((entry) => entry.engineId === engine.id);
      cells.push(engineResult ? statusCodeForResult(engineResult) : 'missing');
    }
    return cells;
  });
};

const failureRows = (
  result: AccuracyBenchmarkResult,
): readonly (readonly (string | number | boolean)[])[] => {
  return result.assets.flatMap((asset) =>
    asset.results
      .filter((engineResult) => engineResult.outcome !== 'pass')
      .map((engineResult) => [
        asset.assetId,
        engineResult.engineId,
        engineResult.outcome,
        engineResult.failureReason ?? '',
        ms(engineResult.durationMs),
        engineResult.cached,
        engineResult.decodedTexts.map((text) => truncate(text, 40)).join(' | '),
        asset.expectedTexts.map((text) => truncate(text, 40)).join(' | '),
        engineResult.error ?? '',
      ]),
  );
};

const ironqrDiagnosticsRows = (
  result: AccuracyBenchmarkResult,
): readonly (readonly (string | number | boolean)[])[] => {
  return result.assets.flatMap((asset) =>
    asset.results.flatMap((engineResult) => {
      const diagnostics = engineResult.diagnostics;
      if (!diagnostics || diagnostics.kind !== 'ironqr-trace') return [];
      return [
        [
          asset.assetId,
          engineResult.engineId,
          diagnostics.traceMode,
          diagnostics.clustering?.rankedProposalCount ?? '',
          diagnostics.clustering?.boundedProposalCount ?? '',
          diagnostics.clustering?.clusterCount ?? '',
          diagnostics.clustering?.representativeCount ?? '',
          diagnostics.scanFinished?.processedRepresentativeCount ?? '',
          diagnostics.scanFinished?.killedClusterCount ?? '',
          `${diagnostics.clusterOutcomes.decoded}/${diagnostics.clusterOutcomes.duplicate}/${diagnostics.clusterOutcomes.killed}/${diagnostics.clusterOutcomes.exhausted}`,
          diagnostics.counts['decode-attempt-started'] ?? 0,
          diagnostics.attemptFailures.timingCheck,
          diagnostics.attemptFailures.decodeFailed,
        ],
      ];
    }),
  );
};

export const printAccuracyHome = (
  binPath: string,
  repoRoot: string,
  engines: readonly AccuracyEngineDescriptor[],
): void => {
  printScalar('bin', collapseHome(binPath));
  printScalar('description', 'Benchmark QR decoders against the approved corpus manifest');
  printScalar('repo', repoRoot);
  printTable(
    'engines',
    ['id', 'status', 'kind', 'capabilities'],
    engines.map((engine) => [
      engine.id,
      engine.available ? 'ready' : (engine.reason ?? 'unavailable'),
      engine.kind,
      describeCapabilities(engine),
    ]),
  );
  printTable(
    'help',
    ['command'],
    [
      ['bun run bench accuracy'],
      ['bun run bench accuracy --list-engines'],
      ['bun run bench accuracy --refresh-cache'],
      ['bun run bench accuracy --no-progress'],
      ['bun run bench accuracy --workers 8'],
      ['bun run bench accuracy --verbose'],
      ['bun run bench accuracy --ironqr-trace off|summary|full'],
      ['bun run bench performance'],
    ],
  );
};

export const printAccuracySummary = (
  result: AccuracyBenchmarkResult,
  options: { readonly failuresOnly?: boolean; readonly verbose?: boolean } = {},
): void => {
  printScalar('report', result.reportFile);
  printScalar('corpusAssets', result.corpusAssetCount);
  printScalar('positives', result.positiveCount);
  printScalar('negatives', result.negativeCount);
  printScalar('cacheEnabled', result.cache.enabled);
  if (result.cache.file) {
    printScalar('cacheFile', result.cache.file);
  }
  printScalar('cacheHits', result.cache.hits);
  printScalar('cacheMisses', result.cache.misses);
  printScalar('cacheWrites', result.cache.writes);

  printTable(
    'summaries',
    [
      'engine',
      'full',
      'any',
      'falsePositives',
      'fullRate',
      'anyRate',
      'fpRate',
      'time',
      'avgMs',
      'cached',
    ],
    result.summaries.map((summary) => [
      summary.engineId,
      `${summary.fullPasses}/${summary.positiveCount}`,
      `${summary.fullPasses + summary.partialPasses}/${summary.positiveCount}`,
      `${summary.falsePositives}/${summary.negativeCount}`,
      pct(summary.fullPassRate),
      pct(summary.anyPassRate),
      pct(summary.falsePositiveRate),
      ms(summary.totalDurationMs),
      ms(summary.averageDurationMs),
      `${summary.cachedAssets}/${summary.cachedAssets + summary.freshAssets}`,
    ]),
  );

  const assetFields = ['asset', 'label', 'expected', ...result.engines.map((engine) => engine.id)];
  const assets = options.failuresOnly
    ? result.assets.filter((asset) =>
        asset.results.some((engineResult) => engineResult.outcome !== 'pass'),
      )
    : result.assets;
  printTable('assets', assetFields, assetStatusRows(result, assets));

  printTable(
    'failures',
    ['asset', 'engine', 'outcome', 'reason', 'time', 'cached', 'decoded', 'expected', 'error'],
    failureRows(result),
  );

  if (options.verbose) {
    const diagnosticsRows = ironqrDiagnosticsRows(result);
    if (diagnosticsRows.length > 0) {
      printTable(
        'diagnostics',
        [
          'asset',
          'engine',
          'trace',
          'ranked',
          'bounded',
          'clusters',
          'reps',
          'processedReps',
          'killedClusters',
          'clusterOutcomes',
          'attempts',
          'timingFails',
          'decodeFails',
        ],
        diagnosticsRows,
      );
    }
  }
};

export const writeAccuracyReport = async (result: AccuracyBenchmarkResult): Promise<void> => {
  await writeFile(result.reportFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
};
