export * from './real-world.js';

export type Ecl = 'L' | 'M' | 'Q' | 'H';

export interface PositiveEntry {
  readonly id: string;
  readonly version: number;
  readonly ecl: Ecl;
  readonly maskPattern: number;
  readonly message: string;
  /** True when bits were deliberately flipped to exercise RS error correction. */
  readonly rsErrorsInjected: boolean;
  readonly grid: boolean[][];
}

export interface NegativeEntry {
  readonly id: string;
  readonly kind: 'random-noise' | 'scrambled-data' | 'near-miss-format';
  readonly grid: boolean[][];
}

export interface BenchmarkCorpus {
  readonly positives: readonly PositiveEntry[];
  readonly negatives: readonly NegativeEntry[];
}
