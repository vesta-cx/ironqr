import { collapseHome } from '../shared/paths.js';
import { writeReportWithSnapshot } from '../core/reports.js';
import type { PerformanceBenchmarkResult, PerformanceEngineSummary } from './runner.js';

const ms = (value: number): string => `${value.toFixed(2)}ms`;

const printScalar = (key: string, value: string | number | boolean): void => {
  console.log(`${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
};

const printTable = (
  label: string,
  fields: readonly string[],
  rows: readonly (readonly (string | number | boolean)[])[],
): void => {
  console.log(`${label}[${rows.length}]{${fields.join(',')}}:`);
  for (const row of rows) {
    console.log(
      `  ${row.map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))).join(',')}`,
    );
  }
};

export const printPerformanceSummary = (result: PerformanceBenchmarkResult): void => {
  printScalar('report', result.reportFile);
  printScalar('status', result.report.status);
  printScalar('pass', result.report.summary.pass.status);
  printScalar('regression', result.report.summary.regression.status);
  printTable(
    'engines',
    ['engine', 'samples', 'p50', 'p95', 'p99', 'avg', 'throughput'],
    result.report.details.engines.map((summary) => performanceSummaryRow(summary)),
  );
};

export const printPerformancePlaceholder = (
  binPath: string,
  result: { readonly message: string },
): void => {
  console.log(`bin: ${collapseHome(binPath)}`);
  console.log('description: Benchmark QR decoder throughput and latency');
  console.log(`status: ${JSON.stringify(result.message)}`);
};

export const writePerformanceReport = async (
  result: PerformanceBenchmarkResult,
): Promise<void> => {
  await writeReportWithSnapshot(result.reportFile, result.report);
};

const performanceSummaryRow = (
  summary: PerformanceEngineSummary,
): readonly (string | number | boolean)[] => [
  summary.engineId,
  summary.sampleCount,
  ms(summary.p50DurationMs),
  ms(summary.p95DurationMs),
  ms(summary.p99DurationMs),
  ms(summary.averageDurationMs),
  summary.throughputAssetsPerSecond,
];
