import path from 'node:path';
import {
  buildRealWorldBenchmarkCorpus,
  type RealWorldBenchmarkEntry,
  scanLocalImageFile,
} from 'ironqr-corpus-cli';

export interface RealWorldPositiveResult {
  readonly entry: RealWorldBenchmarkEntry;
  readonly passed: boolean;
  readonly decodedText: string | null;
  readonly expectedText: string | null;
  readonly error: string | null;
}

export interface RealWorldNegativeResult {
  readonly entry: RealWorldBenchmarkEntry;
  /** True when the scanner unexpectedly reported a decode for a non-QR negative. */
  readonly falsePositive: boolean;
  readonly decodedText: string | null;
}

export interface RealWorldBenchmarkResult {
  readonly positives: readonly RealWorldPositiveResult[];
  readonly negatives: readonly RealWorldNegativeResult[];
  readonly decodeSuccesses: number;
  readonly decodeFailures: number;
  readonly falsePositives: number;
  readonly decodeRate: number;
  readonly falsePositiveRate: number;
}

export const runRealWorldBenchmark = async (
  repoRoot: string,
): Promise<RealWorldBenchmarkResult> => {
  const corpus = await buildRealWorldBenchmarkCorpus(repoRoot);

  const positiveResults = await Promise.all(
    corpus.positives.map((entry) => runRealWorldPositive(repoRoot, entry)),
  );
  const negativeResults = await Promise.all(
    corpus.negatives.map((entry) => runRealWorldNegative(repoRoot, entry)),
  );

  const decodeSuccesses = positiveResults.filter((r) => r.passed).length;
  const decodeFailures = positiveResults.length - decodeSuccesses;
  const falsePositives = negativeResults.filter((r) => r.falsePositive).length;

  return {
    positives: positiveResults,
    negatives: negativeResults,
    decodeSuccesses,
    decodeFailures,
    falsePositives,
    decodeRate: positiveResults.length > 0 ? decodeSuccesses / positiveResults.length : 1,
    falsePositiveRate: negativeResults.length > 0 ? falsePositives / negativeResults.length : 0,
  };
};

const runRealWorldPositive = async (
  repoRoot: string,
  entry: RealWorldBenchmarkEntry,
): Promise<RealWorldPositiveResult> => {
  try {
    const scan = await scanLocalImageFile(path.join(repoRoot, entry.assetPath));
    return scoreRealWorldPositive(entry, scan);
  } catch (error) {
    return {
      entry,
      passed: false,
      decodedText: null,
      expectedText: expectedTextFor(entry),
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const runRealWorldNegative = async (
  repoRoot: string,
  entry: RealWorldBenchmarkEntry,
): Promise<RealWorldNegativeResult> => {
  try {
    const scan = await scanLocalImageFile(path.join(repoRoot, entry.assetPath));
    if (scan.succeeded && scan.results.length > 0) {
      return { entry, falsePositive: true, decodedText: scan.results[0]?.text ?? null };
    }
    return { entry, falsePositive: false, decodedText: null };
  } catch {
    return { entry, falsePositive: false, decodedText: null };
  }
};

export const scoreRealWorldPositive = (
  entry: RealWorldBenchmarkEntry,
  scan: { readonly succeeded: boolean; readonly results: readonly { readonly text: string }[] },
): RealWorldPositiveResult => {
  const expected = expectedTextFor(entry);
  const decodedText = scan.results[0]?.text ?? null;
  const passed = expected === null ? scan.succeeded : scan.succeeded && decodedText === expected;

  return {
    entry,
    passed,
    decodedText,
    expectedText: expected,
    error: passed ? null : scan.succeeded ? 'text mismatch' : 'decode failed',
  };
};

const expectedTextFor = (entry: RealWorldBenchmarkEntry): string | null => {
  const first = entry.groundTruth?.codes[0];
  return first ? first.text : null;
};
