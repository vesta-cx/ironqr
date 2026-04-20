import { decodeGrid } from '../../../../packages/ironqr/src/index.js';
import { generatePositiveCorpus } from '../../../perfbench/src/corpus/generate.js';
import type { NegativeEntry, PositiveEntry } from '../../../perfbench/src/corpus/index.js';
import { generateNegativeCorpus } from '../../../perfbench/src/corpus/negatives.js';

export interface PositiveResult {
  readonly entry: PositiveEntry;
  readonly passed: boolean;
  readonly decodedText: string | null;
  readonly error: string | null;
}

export interface NegativeResult {
  readonly entry: NegativeEntry;
  readonly falsePositive: boolean;
  readonly decodedText: string | null;
}

export interface PerformanceBenchmarkResult {
  readonly positives: readonly PositiveResult[];
  readonly negatives: readonly NegativeResult[];
  readonly decodeSuccesses: number;
  readonly decodeFailures: number;
  readonly falsePositives: number;
  readonly decodeRate: number;
  readonly falsePositiveRate: number;
}

export const runPerformanceBenchmark = async (): Promise<PerformanceBenchmarkResult> => {
  const corpus = {
    positives: generatePositiveCorpus(),
    negatives: generateNegativeCorpus(),
  };

  const positiveResults = await Promise.all(corpus.positives.map(runPositive));
  const negativeResults = await Promise.all(corpus.negatives.map(runNegative));

  const decodeSuccesses = positiveResults.filter((result) => result.passed).length;
  const decodeFailures = positiveResults.length - decodeSuccesses;
  const falsePositives = negativeResults.filter((result) => result.falsePositive).length;

  return {
    positives: positiveResults,
    negatives: negativeResults,
    decodeSuccesses,
    decodeFailures,
    falsePositives,
    decodeRate: positiveResults.length > 0 ? decodeSuccesses / positiveResults.length : 0,
    falsePositiveRate: negativeResults.length > 0 ? falsePositives / negativeResults.length : 0,
  };
};

const runPositive = async (entry: PositiveEntry): Promise<PositiveResult> => {
  try {
    const result = await decodeGrid({ grid: entry.grid });
    const decodedText = result.payload.text;
    return {
      entry,
      passed: decodedText === entry.message,
      decodedText,
      error: null,
    };
  } catch (error) {
    return {
      entry,
      passed: false,
      decodedText: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const runNegative = async (entry: NegativeEntry): Promise<NegativeResult> => {
  try {
    const result = await decodeGrid({ grid: entry.grid });
    return { entry, falsePositive: true, decodedText: result.payload.text };
  } catch {
    return { entry, falsePositive: false, decodedText: null };
  }
};
