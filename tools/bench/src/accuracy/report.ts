import path from 'node:path';
import type { AccuracyBenchmarkResult } from './types.js';

const getOutputFile = (repoRoot: string): string => {
  return path.join(repoRoot, 'accuracy-benchmark-results.json');
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const truncate = (value: string, max = 60): string => {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

export const printAccuracySummary = (
  result: AccuracyBenchmarkResult,
  repoRoot: string,
  options: { readonly failuresOnly?: boolean } = {},
): void => {
  console.log('── Accuracy Benchmark ─────────────────────────────────');
  for (const summary of result.summaries) {
    console.log(
      `  ${summary.engineId}: full ${summary.fullPasses}/${summary.positiveCount} (${pct(summary.fullPassRate)}), any ${summary.fullPasses + summary.partialPasses}/${summary.positiveCount} (${pct(summary.anyPassRate)}), fp ${summary.falsePositives}/${summary.negativeCount} (${pct(summary.falsePositiveRate)})`,
    );
  }

  const failingAssets = result.assets.filter((asset) => {
    return asset.results.some((engineResult) => engineResult.outcome !== 'pass');
  });
  const listedAssets = options.failuresOnly ? failingAssets : result.assets;

  for (const asset of listedAssets) {
    const engineSummaries = asset.results
      .filter((engineResult) => !options.failuresOnly || engineResult.outcome !== 'pass')
      .map((engineResult) => {
        const decoded =
          engineResult.decodedTexts.length > 0
            ? ` decoded=${engineResult.decodedTexts.map((text) => `"${truncate(text)}"`).join(',')}`
            : '';
        const error = engineResult.error ? ` error=${engineResult.error}` : '';
        return `${engineResult.engineId}=${engineResult.outcome}${decoded}${error}`;
      });
    if (engineSummaries.length === 0) continue;

    const expected =
      asset.expectedTexts.length > 0
        ? ` expected=${asset.expectedTexts.map((text) => `"${truncate(text)}"`).join(',')}`
        : '';
    console.log(`  ${asset.assetId} [${asset.label}]${expected} :: ${engineSummaries.join(' | ')}`);
  }

  console.log(`  Output    : ${getOutputFile(repoRoot)}`);
  console.log('───────────────────────────────────────────────────────');
};

export const writeAccuracyReport = async (
  result: AccuracyBenchmarkResult,
  repoRoot: string,
): Promise<void> => {
  await Bun.write(getOutputFile(repoRoot), `${JSON.stringify(result, null, 2)}\n`);
};
