import path from 'node:path';
import type { PerformanceBenchmarkResult } from './runner.js';

const getOutputFile = (repoRoot: string): string => {
  return path.join(repoRoot, 'performance-benchmark-results.json');
};

export const printPerformanceSummary = (
  result: PerformanceBenchmarkResult,
  repoRoot: string,
): void => {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

  console.log('── Performance Benchmark ─────────────────────────────');
  console.log(
    `  Positives : ${result.decodeSuccesses}/${result.positives.length} passed (decodeRate ${pct(result.decodeRate)})`,
  );
  console.log(
    `  Negatives : ${result.falsePositives}/${result.negatives.length} false positives (falsePositiveRate ${pct(result.falsePositiveRate)})`,
  );
  console.log(`  Output    : ${getOutputFile(repoRoot)}`);
  console.log('───────────────────────────────────────────────────────');
};

export const writePerformanceReport = async (
  result: PerformanceBenchmarkResult,
  repoRoot: string,
): Promise<void> => {
  await Bun.write(getOutputFile(repoRoot), `${JSON.stringify(result, null, 2)}\n`);
};
