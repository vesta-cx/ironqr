import { decodeGrid } from 'ironqr';
import { generatePositiveCorpus } from './corpus/generate.js';
import type { NegativeEntry, PositiveEntry } from './corpus/index.js';
import { generateNegativeCorpus } from './corpus/negatives.js';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface PositiveResult {
  readonly entry: PositiveEntry;
  readonly passed: boolean;
  readonly decodedText: string | null;
  readonly error: string | null;
}

export interface NegativeResult {
  readonly entry: NegativeEntry;
  /** True when decodeGrid unexpectedly succeeded (false positive). */
  readonly falsePositive: boolean;
  readonly decodedText: string | null;
}

export interface BenchmarkResult {
  readonly positives: readonly PositiveResult[];
  readonly negatives: readonly NegativeResult[];
  readonly decodeSuccesses: number;
  readonly decodeFailures: number;
  readonly falsePositives: number;
  readonly decodeRate: number;
  readonly falsePositiveRate: number;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export const runBenchmark = async (): Promise<BenchmarkResult> => {
  const corpus = {
    positives: generatePositiveCorpus(),
    negatives: generateNegativeCorpus(),
  };

  console.log(
    `Running benchmark: ${corpus.positives.length} positives, ${corpus.negatives.length} negatives`,
  );

  const positiveResults = await Promise.all(corpus.positives.map(runPositive));
  const negativeResults = await Promise.all(corpus.negatives.map(runNegative));

  const decodeSuccesses = positiveResults.filter((r) => r.passed).length;
  const decodeFailures = positiveResults.length - decodeSuccesses;
  const falsePositives = negativeResults.filter((r) => r.falsePositive).length;

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
    const passed = decodedText === entry.message;
    return { entry, passed, decodedText, error: null };
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
