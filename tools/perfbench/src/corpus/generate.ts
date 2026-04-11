import {
  ALIGNMENT_PATTERN_CENTERS,
  buildDataModulePositions,
  buildFormatInfoCodeword,
  buildFunctionModuleMask,
  buildVersionInfoCodeword,
  FORMAT_INFO_FIRST_COPY_POSITIONS,
  getFormatInfoSecondCopyPositions,
  getRemainderBits,
  getVersionBlockInfo,
  getVersionInfoFirstCopyPositions,
  getVersionInfoSecondCopyPositions,
  maskApplies,
  type QrErrorCorrectionLevel,
  rsEncode,
} from 'ironqr/qr';
import type { Ecl, PositiveEntry } from './index.js';

const ECL_LEVELS: readonly Ecl[] = ['L', 'M', 'Q', 'H'];
const BENCHMARK_MESSAGE = 'HI';

export const generatePositiveCorpus = (): PositiveEntry[] => {
  const entries: PositiveEntry[] = [];

  // v1: all 4 EC levels × all 8 masks
  for (const ecl of ECL_LEVELS) {
    for (let mask = 0; mask < 8; mask += 1) {
      entries.push({
        id: `v1-${ecl}-m${mask}`,
        version: 1,
        ecl,
        maskPattern: mask,
        message: BENCHMARK_MESSAGE,
        rsErrorsInjected: false,
        grid: buildQrGrid(1, ecl, mask, BENCHMARK_MESSAGE),
      });
    }
  }

  // v7, v20, v40: all 4 EC levels, mask 0
  for (const version of [7, 20, 40] as const) {
    for (const ecl of ECL_LEVELS) {
      entries.push({
        id: `v${version}-${ecl}-m0`,
        version,
        ecl,
        maskPattern: 0,
        message: BENCHMARK_MESSAGE,
        rsErrorsInjected: false,
        grid: buildQrGrid(version, ecl, 0, BENCHMARK_MESSAGE),
      });
    }
  }

  // RS error-correction fixture: v1-M with 4 corrupted data codewords (t=5)
  const baseGrid = buildQrGrid(1, 'M', 0, BENCHMARK_MESSAGE);
  const corruptedGrid = injectRsErrors(baseGrid, 1, 'M', 4);
  entries.push({
    id: 'v1-M-m0-rs-corrected',
    version: 1,
    ecl: 'M',
    maskPattern: 0,
    message: BENCHMARK_MESSAGE,
    rsErrorsInjected: true,
    grid: corruptedGrid,
  });

  return entries;
};

// ─── Bit helpers ──────────────────────────────────────────────────────────────

const appendBits = (bits: number[], value: number, length: number): void => {
  for (let bit = length - 1; bit >= 0; bit -= 1) {
    bits.push((value >> bit) & 1);
  }
};

const bytesFromBits = (bits: readonly number[]): number[] => {
  const bytes: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | (bits[index + bit] ?? 0);
    }
    bytes.push(value);
  }
  return bytes;
};

// ─── Payload encoding ─────────────────────────────────────────────────────────

/**
 * Encodes a short message in byte mode and pads to the full data capacity for
 * the given version/ECL combination.
 */
const encodeByteMode = (message: string, version: number, totalDataCodewords: number): number[] => {
  const messageBytes = new TextEncoder().encode(message);
  const countBits = version <= 9 ? 8 : 16;
  const bits: number[] = [];

  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, messageBytes.length, countBits);
  for (const byte of messageBytes) {
    appendBits(bits, byte, 8);
  }

  const totalBits = totalDataCodewords * 8;
  appendBits(bits, 0, Math.min(4, totalBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  let padByte = 0xec;
  while (bits.length < totalBits) {
    appendBits(bits, padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  return bytesFromBits(bits);
};

// ─── RS block interleaving ────────────────────────────────────────────────────

/**
 * Splits data codewords into RS blocks, encodes each block, then interleaves
 * data and EC codewords in the order required by ISO 18004.
 */
const interleaveBlocks = (
  dataCodewords: readonly number[],
  blockInfo: ReturnType<typeof getVersionBlockInfo>,
): number[] => {
  // Build block data arrays following group structure
  const blocks: Array<{ data: number[]; ecc: number[] }> = [];
  for (const group of blockInfo.groups) {
    for (let repeat = 0; repeat < group.count; repeat += 1) {
      blocks.push({ data: new Array<number>(group.dataCodewords).fill(0), ecc: [] });
    }
  }

  // Fill blocks with consecutive data codewords
  let offset = 0;
  for (const block of blocks) {
    for (let index = 0; index < block.data.length; index += 1) {
      block.data[index] = dataCodewords[offset] ?? 0;
      offset += 1;
    }
  }

  // RS-encode each block
  for (const block of blocks) {
    block.ecc = Array.from(rsEncode(block.data, blockInfo.ecCodewordsPerBlock));
  }

  // Interleave data codewords
  const maxDataLen = Math.max(...blocks.map((b) => b.data.length));
  const raw: number[] = [];
  for (let index = 0; index < maxDataLen; index += 1) {
    for (const block of blocks) {
      if (index < block.data.length) raw.push(block.data[index] ?? 0);
    }
  }

  // Interleave EC codewords
  for (let index = 0; index < blockInfo.ecCodewordsPerBlock; index += 1) {
    for (const block of blocks) {
      raw.push(block.ecc[index] ?? 0);
    }
  }

  return raw;
};

// ─── Matrix helpers ───────────────────────────────────────────────────────────

const setModule = (matrix: boolean[][], row: number, col: number, value: boolean): void => {
  const currentRow = matrix[row];
  if (currentRow !== undefined && currentRow[col] !== undefined) {
    currentRow[col] = value;
  }
};

const drawFinder = (matrix: boolean[][], top: number, left: number): void => {
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const dark =
        row === 0 ||
        row === 6 ||
        col === 0 ||
        col === 6 ||
        (row >= 2 && row <= 4 && col >= 2 && col <= 4);
      setModule(matrix, top + row, left + col, dark);
    }
  }
};

const drawAlignment = (matrix: boolean[][], centerRow: number, centerCol: number): void => {
  for (let row = -2; row <= 2; row += 1) {
    for (let col = -2; col <= 2; col += 1) {
      const dark = Math.abs(row) === 2 || Math.abs(col) === 2 || (row === 0 && col === 0);
      setModule(matrix, centerRow + row, centerCol + col, dark);
    }
  }
};

// ─── Full grid builder ────────────────────────────────────────────────────────

/**
 * Builds a fully-compliant QR matrix for any version 1-40, EC level, mask
 * pattern, and short byte-mode message.  All function modules, format info,
 * version info, and interleaved RS codewords are placed per ISO 18004.
 */
export const buildQrGrid = (
  version: number,
  ecl: Ecl,
  maskPattern: number,
  message: string,
): boolean[][] => {
  const size = 17 + version * 4;
  const blockInfo = getVersionBlockInfo(version, ecl as QrErrorCorrectionLevel);
  const dataCodewords = encodeByteMode(message, version, blockInfo.dataCodewords);
  const rawCodewords = interleaveBlocks(dataCodewords, blockInfo);
  const reserved = buildFunctionModuleMask(size, version);

  const matrix: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );

  // Finder patterns
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, 0, size - 7);
  drawFinder(matrix, size - 7, 0);

  // Timing patterns
  for (let index = 8; index < size - 8; index += 1) {
    setModule(matrix, 6, index, index % 2 === 0);
    setModule(matrix, index, 6, index % 2 === 0);
  }

  // Alignment patterns (version 2+)
  const centers = ALIGNMENT_PATTERN_CENTERS[version - 1] ?? [];
  for (const rowCenter of centers) {
    for (const colCenter of centers) {
      if (
        (rowCenter === 6 && colCenter === 6) ||
        (rowCenter === 6 && colCenter === size - 7) ||
        (rowCenter === size - 7 && colCenter === 6)
      ) {
        continue;
      }
      drawAlignment(matrix, rowCenter, colCenter);
    }
  }

  // Dark module
  setModule(matrix, size - 8, 8, true);

  // Format info (both copies)
  const formatBits = buildFormatInfoCodeword(ecl as QrErrorCorrectionLevel, maskPattern);
  for (let index = 0; index < FORMAT_INFO_FIRST_COPY_POSITIONS.length; index += 1) {
    const pos = FORMAT_INFO_FIRST_COPY_POSITIONS[index];
    if (pos) setModule(matrix, pos[0], pos[1], ((formatBits >> (14 - index)) & 1) === 1);
  }
  const secondCopyPositions = getFormatInfoSecondCopyPositions(size);
  for (let index = 0; index < secondCopyPositions.length; index += 1) {
    const pos = secondCopyPositions[index];
    if (pos) setModule(matrix, pos[0], pos[1], ((formatBits >> (14 - index)) & 1) === 1);
  }

  // Version info (version 7+)
  if (version >= 7) {
    const versionBits = buildVersionInfoCodeword(version);
    const topRight = getVersionInfoFirstCopyPositions(size);
    const bottomLeft = getVersionInfoSecondCopyPositions(size);
    for (let index = 0; index < 18; index += 1) {
      const bit = ((versionBits >> (17 - index)) & 1) === 1;
      const tr = topRight[index];
      const bl = bottomLeft[index];
      if (tr) setModule(matrix, tr[0], tr[1], bit);
      if (bl) setModule(matrix, bl[0], bl[1], bit);
    }
  }

  // Data bits
  const positions = buildDataModulePositions(size, reserved);
  const rawBits: number[] = [];
  for (const codeword of rawCodewords) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      rawBits.push((codeword >> bit) & 1);
    }
  }
  const remainder = getRemainderBits(version);
  for (let index = 0; index < remainder; index += 1) {
    rawBits.push(0);
  }

  for (let index = 0; index < positions.length; index += 1) {
    const pos = positions[index];
    if (!pos) continue;
    const [row, col] = pos;
    const bit = rawBits[index] === 1;
    setModule(matrix, row, col, maskApplies(maskPattern, row, col) ? !bit : bit);
  }

  return matrix;
};

// ─── RS error-injection helper ────────────────────────────────────────────────

/**
 * Returns a copy of the grid with the most-significant bit of the first
 * `errorCount` data codewords flipped.  For v1-M: t = floor(10/2) = 5;
 * injecting 4 errors stays within the correction capacity.
 */
export const injectRsErrors = (
  grid: boolean[][],
  version: number,
  _ecl: Ecl,
  errorCount: number,
): boolean[][] => {
  const size = grid.length;
  const reserved = buildFunctionModuleMask(size, version);
  const positions = buildDataModulePositions(size, reserved);
  const corrupted = grid.map((row) => row.slice());

  for (let codeword = 0; codeword < errorCount; codeword += 1) {
    // Flip the most-significant bit (bit 7) of each codeword
    const pos = positions[codeword * 8];
    if (!pos) continue;
    const [row, col] = pos;
    const currentRow = corrupted[row];
    if (currentRow) currentRow[col] = !currentRow[col];
  }

  return corrupted;
};
