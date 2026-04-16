/**
 * Scan every approved asset in the corpus manifest with the production
 * scanner and report per-asset outcome plus aggregate decode/false-positive
 * rates. Standalone — no perfbench fixture required.
 */
import path from 'node:path';
import type { ParsedArgs } from '../args.js';
import type { AppContext } from '../context.js';
import { readCorpusManifest } from '../manifest.js';
import { scanLocalImageFile } from '../scan.js';
import type { CorpusAsset } from '../schema.js';

interface PositiveOutcome {
  readonly kind: 'pass' | 'fail-mismatch' | 'fail-no-decode' | 'fail-error';
  readonly decodedText: string | null;
  readonly expectedText: string | null;
  readonly error: string | null;
}

interface NegativeOutcome {
  readonly kind: 'pass' | 'false-positive' | 'fail-error';
  readonly decodedText: string | null;
  readonly error: string | null;
}

const expectedTextFor = (asset: CorpusAsset): string | null => {
  return asset.groundTruth?.codes[0]?.text ?? null;
};

/**
 * Every ground-truth text for the asset. Multi-QR images (e.g. a poster with
 * six different codes) are scored as passing as long as the scanner decodes
 * any one of them, since single-code scanFrame returns on first success.
 */
const expectedTextsFor = (asset: CorpusAsset): readonly string[] => {
  return asset.groundTruth?.codes.map((c) => c.text) ?? [];
};

const scorePositive = async (repoRoot: string, asset: CorpusAsset): Promise<PositiveOutcome> => {
  const assetPath = path.join(repoRoot, 'corpus', 'data', asset.relativePath);
  try {
    const scan = await scanLocalImageFile(assetPath);
    const decodedText = scan.results[0]?.text ?? null;
    const expectedText = expectedTextFor(asset);

    if (!scan.succeeded) {
      return { kind: 'fail-error', decodedText, expectedText, error: 'scan engine failed' };
    }
    if (scan.results.length === 0) {
      return { kind: 'fail-no-decode', decodedText: null, expectedText, error: null };
    }
    const expectedTexts = expectedTextsFor(asset);
    if (expectedTexts.length > 0 && decodedText !== null && !expectedTexts.includes(decodedText)) {
      return { kind: 'fail-mismatch', decodedText, expectedText, error: null };
    }
    return { kind: 'pass', decodedText, expectedText, error: null };
  } catch (error) {
    return {
      kind: 'fail-error',
      decodedText: null,
      expectedText: expectedTextFor(asset),
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const scoreNegative = async (repoRoot: string, asset: CorpusAsset): Promise<NegativeOutcome> => {
  const assetPath = path.join(repoRoot, 'corpus', 'data', asset.relativePath);
  try {
    const scan = await scanLocalImageFile(assetPath);
    const decodedText = scan.results[0]?.text ?? null;
    if (scan.succeeded && scan.results.length > 0) {
      return { kind: 'false-positive', decodedText, error: null };
    }
    return { kind: 'pass', decodedText: null, error: null };
  } catch (error) {
    return {
      kind: 'fail-error',
      decodedText: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const truncate = (value: string | null, max = 50): string => {
  if (value === null) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

/**
 * Run the `scan-corpus` command: scan every approved asset and report results.
 *
 * Flags (parsed positionally / via getOption):
 *   --label qr-positive|non-qr-negative   only scan one label
 *   --failures-only                       suppress per-asset PASS lines
 *   --quiet                               suppress per-asset output entirely
 */
export const runScanCorpusCommand = async (
  context: AppContext,
  args: ParsedArgs,
): Promise<{ readonly decodeRate: number; readonly falsePositiveRate: number }> => {
  const labelFilter = args.options.label;
  const failuresOnly = args.options['failures-only'] === true;
  const quiet = args.options.quiet === true;

  const manifest = await readCorpusManifest(context.repoRoot);
  const approved = manifest.assets.filter((a) => a.review.status === 'approved');
  const positives = approved.filter(
    (a) => a.label === 'qr-positive' && (!labelFilter || labelFilter === 'qr-positive'),
  );
  const negatives = approved.filter(
    (a) => a.label === 'non-qr-negative' && (!labelFilter || labelFilter === 'non-qr-negative'),
  );

  context.ui.info(
    `Scanning ${positives.length} approved positives and ${negatives.length} approved negatives`,
  );

  const positiveResults = await Promise.all(
    positives.map((a) => scorePositive(context.repoRoot, a)),
  );
  const negativeResults = await Promise.all(
    negatives.map((a) => scoreNegative(context.repoRoot, a)),
  );

  if (!quiet) {
    for (let i = 0; i < positives.length; i += 1) {
      const asset = positives[i];
      const result = positiveResults[i];
      if (!asset || !result) continue;
      if (failuresOnly && result.kind === 'pass') continue;

      const tag = result.kind === 'pass' ? 'PASS' : `FAIL[${result.kind.replace('fail-', '')}]`;
      const decoded = result.decodedText ? `  decoded="${truncate(result.decodedText)}"` : '';
      const expected = result.expectedText ? `  expected="${truncate(result.expectedText)}"` : '';
      const err = result.error ? `  error=${result.error}` : '';
      console.log(`${tag.padEnd(18)} ${asset.id}${decoded}${expected}${err}`);
    }
    for (let i = 0; i < negatives.length; i += 1) {
      const asset = negatives[i];
      const result = negativeResults[i];
      if (!asset || !result) continue;
      if (failuresOnly && result.kind === 'pass') continue;

      const tag = result.kind === 'pass' ? 'PASS' : `FAIL[${result.kind}]`;
      const decoded = result.decodedText ? `  decoded="${truncate(result.decodedText)}"` : '';
      const err = result.error ? `  error=${result.error}` : '';
      console.log(`${tag.padEnd(18)} ${asset.id}${decoded}${err}`);
    }
  }

  // Aggregate
  const positivePass = positiveResults.filter((r) => r.kind === 'pass').length;
  const failBreakdown = {
    mismatch: positiveResults.filter((r) => r.kind === 'fail-mismatch').length,
    noDecode: positiveResults.filter((r) => r.kind === 'fail-no-decode').length,
    error: positiveResults.filter((r) => r.kind === 'fail-error').length,
  };
  const falsePositives = negativeResults.filter((r) => r.kind === 'false-positive').length;
  const negativeErrors = negativeResults.filter((r) => r.kind === 'fail-error').length;

  const decodeRate = positives.length === 0 ? 1 : positivePass / positives.length;
  const falsePositiveRate = negatives.length === 0 ? 0 : falsePositives / negatives.length;

  console.log('');
  console.log(
    `positives: ${positivePass}/${positives.length} pass (${(decodeRate * 100).toFixed(0)}%)`,
  );
  if (positives.length > 0) {
    console.log(
      `  fail breakdown: text-mismatch=${failBreakdown.mismatch} no-decode=${failBreakdown.noDecode} error=${failBreakdown.error}`,
    );
  }
  console.log(
    `negatives: ${falsePositives}/${negatives.length} false positives (${(falsePositiveRate * 100).toFixed(0)}%)${negativeErrors > 0 ? `, ${negativeErrors} scan errors` : ''}`,
  );

  return { decodeRate, falsePositiveRate };
};
