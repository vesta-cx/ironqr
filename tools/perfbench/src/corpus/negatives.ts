import {
  buildDataModulePositions,
  buildFormatInfoCodeword,
  buildFunctionModuleMask,
  FORMAT_INFO_FIRST_COPY_POSITIONS,
  getFormatInfoSecondCopyPositions,
  type QrErrorCorrectionLevel,
} from 'ironqr/qr';
import { buildQrGrid } from './generate.js';
import type { Ecl, NegativeEntry } from './index.js';

export const generateNegativeCorpus = (): NegativeEntry[] => {
  const entries: NegativeEntry[] = [];

  // Random noise grids at QR-like sizes (v1=21, v7=45, v20=97, v40=177)
  for (const [version, seed] of [
    [1, 0xdead],
    [7, 0xbeef],
    [20, 0xcafe],
    [40, 0xf00d],
    [1, 0x1234],
    [7, 0x5678],
  ] as const) {
    const size = 17 + version * 4;
    entries.push({
      id: `noise-v${version}-${seed.toString(16)}`,
      kind: 'random-noise',
      grid: randomNoiseGrid(size, seed),
    });
  }

  // Scrambled data (valid shape, garbage data) for several version/ECL combos
  for (const [version, ecl, seed] of [
    [1, 'M', 0xaaaa],
    [7, 'M', 0xbbbb],
    [20, 'L', 0xcccc],
    [40, 'H', 0xdddd],
  ] as const) {
    entries.push({
      id: `scrambled-v${version}-${ecl}`,
      kind: 'scrambled-data',
      grid: scrambledDataGrid(version, ecl as Ecl, seed),
    });
  }

  // Near-miss format-info (valid QR structure, corrupt format info)
  for (const [version, ecl] of [
    [1, 'M'],
    [7, 'L'],
    [20, 'H'],
  ] as const) {
    entries.push({
      id: `near-miss-fmt-v${version}-${ecl}`,
      kind: 'near-miss-format',
      grid: nearMissFormatGrid(version, ecl as Ecl),
    });
  }

  return entries;
};

/** Fills a grid with random boolean values. */
const randomNoiseGrid = (size: number, seed: number): boolean[][] => {
  const rng = makePrng(seed);
  return Array.from({ length: size }, () => Array.from({ length: size }, () => rng() < 0.5));
};

/**
 * Builds a QR-shaped grid (correct function modules) but randomises every data
 * module so RS decoding will almost certainly fail.
 */
const scrambledDataGrid = (version: number, ecl: Ecl, seed: number): boolean[][] => {
  const grid = buildQrGrid(version, ecl, 0, 'HI');
  const size = grid.length;
  const reserved = buildFunctionModuleMask(size, version);
  const positions = buildDataModulePositions(size, reserved);
  const rng = makePrng(seed);

  for (const [row, col] of positions) {
    const currentRow = grid[row];
    if (currentRow) currentRow[col] = rng() < 0.5;
  }

  return grid;
};

/**
 * Builds a QR-shaped grid with valid structure but a corrupt format-info field
 * in BOTH copies, causing decodeFormatInfo to throw.
 */
const nearMissFormatGrid = (version: number, ecl: Ecl): boolean[][] => {
  const grid = buildQrGrid(version, ecl, 0, 'HI');
  const size = grid.length;
  const corrupt = CORRUPT_FORMAT_INFO;

  for (let index = 0; index < FORMAT_INFO_FIRST_COPY_POSITIONS.length; index += 1) {
    const pos = FORMAT_INFO_FIRST_COPY_POSITIONS[index];
    if (pos) setModule(grid, pos[0], pos[1], ((corrupt >> (14 - index)) & 1) === 1);
  }
  const secondCopyPositions = getFormatInfoSecondCopyPositions(size);
  for (let index = 0; index < secondCopyPositions.length; index += 1) {
    const pos = secondCopyPositions[index];
    if (pos) setModule(grid, pos[0], pos[1], ((corrupt >> (14 - index)) & 1) === 1);
  }

  return grid;
};

const setModule = (matrix: boolean[][], row: number, col: number, value: boolean): void => {
  const currentRow = matrix[row];
  if (currentRow !== undefined && currentRow[col] !== undefined) {
    currentRow[col] = value;
  }
};

/**
 * Returns a 15-bit value whose Hamming distance from every valid format-info
 * codeword exceeds 3, guaranteeing that decodeFormatInfo will throw.
 *
 * The BCH(15,5) format-info code has minimum distance 7, so the 32 valid
 * codewords each occupy a Hamming ball of radius 3.  We search the space for
 * the first candidate (starting from 0x0000) that lies outside all balls.
 */
const findCorruptFormatInfo = (): number => {
  const valid = new Set<number>();
  for (const ecl of ['L', 'M', 'Q', 'H'] as const) {
    for (let mask = 0; mask < 8; mask += 1) {
      valid.add(buildFormatInfoCodeword(ecl as QrErrorCorrectionLevel, mask));
    }
  }

  const validArray = Array.from(valid);

  const minDistance = (candidate: number): number => {
    let min = 15;
    for (const v of validArray) {
      let dist = 0;
      let xor = candidate ^ v;
      while (xor !== 0) {
        dist += xor & 1;
        xor >>>= 1;
      }
      if (dist < min) min = dist;
    }
    return min;
  };

  for (let candidate = 0x0000; candidate <= 0x7fff; candidate += 1) {
    if (minDistance(candidate) > 3) return candidate;
  }

  // Unreachable: there are thousands of valid candidates in a 32768-word space.
  throw new Error('Could not find corrupt format-info value.');
};

const CORRUPT_FORMAT_INFO = findCorruptFormatInfo();

/** Mulberry32 — fast, seedable 32-bit PRNG. */
const makePrng = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
};
