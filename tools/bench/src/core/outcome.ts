import type { CorpusAssetLabel } from '../accuracy/types.js';

export type BenchOutcomeBucket = 'pos-pass' | 'pos-partial' | 'pos-fail' | 'neg-pass' | 'neg-fail';

export const bucketForOutcome = (label: CorpusAssetLabel, outcome: string): BenchOutcomeBucket => {
  if (label === 'qr-pos') {
    if (outcome === 'pass') return 'pos-pass';
    if (outcome === 'partial-pass') return 'pos-partial';
    return 'pos-fail';
  }
  return outcome === 'pass' ? 'neg-pass' : 'neg-fail';
};

export const emptyBucketCounts = (): Record<BenchOutcomeBucket, number> => ({
  'pos-pass': 0,
  'pos-partial': 0,
  'pos-fail': 0,
  'neg-pass': 0,
  'neg-fail': 0,
});
