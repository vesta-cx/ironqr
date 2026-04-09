import { ScannerError } from './errors.js';
import { ALIGNMENT_PATTERN_CENTERS, RS_BLOCK_TABLE } from './qr-tables.js';

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrBlockGroup {
  readonly count: number;
  readonly totalCodewords: number;
  readonly dataCodewords: number;
}

export interface QrVersionBlockInfo {
  readonly totalCodewords: number;
  readonly dataCodewords: number;
  readonly ecCodewordsPerBlock: number;
  readonly groups: readonly QrBlockGroup[];
}

export const ALPHANUMERIC_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:' as const;

export const FORMAT_INFO_ECL_BITS: Record<QrErrorCorrectionLevel, number> = {
  L: 0b01,
  M: 0b00,
  Q: 0b11,
  H: 0b10,
};

const FORMAT_INFO_FIRST_COPY_POSITIONS: readonly (readonly [number, number])[] = [
  [8, 0],
  [8, 1],
  [8, 2],
  [8, 3],
  [8, 4],
  [8, 5],
  [8, 7],
  [8, 8],
  [7, 8],
  [5, 8],
  [4, 8],
  [3, 8],
  [2, 8],
  [1, 8],
  [0, 8],
];

function createMatrix(size: number, value: boolean): boolean[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => value));
}

function markRectangle(
  mask: boolean[][],
  top: number,
  left: number,
  height: number,
  width: number,
): void {
  for (let row = top; row < top + height; row += 1) {
    const currentRow = mask[row];
    if (currentRow === undefined) {
      continue;
    }

    for (let col = left; col < left + width; col += 1) {
      if (currentRow[col] !== undefined) {
        currentRow[col] = true;
      }
    }
  }
}

function markCells(mask: boolean[][], positions: readonly (readonly [number, number])[]): void {
  for (const [row, col] of positions) {
    const currentRow = mask[row];
    if (currentRow === undefined) {
      continue;
    }

    if (currentRow[col] !== undefined) {
      currentRow[col] = true;
    }
  }
}

function readBits(matrix: boolean[][], positions: readonly (readonly [number, number])[]): number {
  let value = 0;

  for (const [row, col] of positions) {
    value = (value << 1) | (matrix[row]?.[col] ? 1 : 0);
  }

  return value;
}

function bitCount(value: number): number {
  let count = 0;
  let bits = value;

  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }

  return count;
}

export function buildFormatInfoCodeword(ecl: QrErrorCorrectionLevel, maskPattern: number): number {
  const data = ((FORMAT_INFO_ECL_BITS[ecl] ?? 0) << 3) | maskPattern;
  let value = data << 10;
  const generator = 0x537;

  for (let bit = 14; bit >= 10; bit -= 1) {
    if ((value & (1 << bit)) === 0) {
      continue;
    }

    value ^= generator << (bit - 10);
  }

  return ((data << 10) | value) ^ 0x5412;
}

export function buildVersionInfoCodeword(version: number): number {
  if (version < 7 || version > 40) {
    throw new ScannerError(
      'invalid_input',
      `QR version info is only defined for versions 7-40 (got ${version}).`,
    );
  }

  const data = version;
  let value = data << 12;
  const generator = 0x1f25;

  for (let bit = 17; bit >= 12; bit -= 1) {
    if ((value & (1 << bit)) === 0) {
      continue;
    }

    value ^= generator << (bit - 12);
  }

  return (data << 12) | value;
}

function getFormatInfoSecondCopyPositions(size: number): readonly (readonly [number, number])[] {
  return [
    [8, size - 1],
    [8, size - 2],
    [8, size - 3],
    [8, size - 4],
    [8, size - 5],
    [8, size - 6],
    [8, size - 7],
    [8, size - 8],
    [size - 7, 8],
    [size - 6, 8],
    [size - 5, 8],
    [size - 4, 8],
    [size - 3, 8],
    [size - 2, 8],
    [size - 1, 8],
  ];
}

function getVersionInfoFirstCopyPositions(size: number): readonly (readonly [number, number])[] {
  return Array.from(
    { length: 18 },
    (_, index) => [Math.floor(index / 3), size - 11 + (index % 3)] as const,
  );
}

function getVersionInfoSecondCopyPositions(size: number): readonly (readonly [number, number])[] {
  return Array.from(
    { length: 18 },
    (_, index) => [size - 11 + (index % 3), Math.floor(index / 3)] as const,
  );
}

export function getVersionFromSize(size: number): number {
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new ScannerError('invalid_input', `Invalid QR grid size: ${size}`);
  }

  return version;
}

export function maskApplies(maskPattern: number, row: number, col: number): boolean {
  switch (maskPattern) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      throw new ScannerError('decode_failed', `Unsupported mask pattern: ${maskPattern}`);
  }
}

function markFinderPattern(mask: boolean[][], top: number, left: number): void {
  markRectangle(mask, top, left, 8, 8);
}

function markAlignmentPattern(mask: boolean[][], centerRow: number, centerCol: number): void {
  markRectangle(mask, centerRow - 2, centerCol - 2, 5, 5);
}

export function buildFunctionModuleMask(size: number, version: number): boolean[][] {
  const mask = createMatrix(size, false);

  if (version < 1 || version > 40) {
    throw new ScannerError('invalid_input', `Invalid QR version: ${version}`);
  }

  markFinderPattern(mask, 0, 0);
  markFinderPattern(mask, 0, size - 8);
  markFinderPattern(mask, size - 8, 0);

  const timingRow = mask[6];
  if (timingRow === undefined) {
    throw new ScannerError('internal_error', 'Missing timing row while building QR function mask.');
  }

  for (let index = 0; index < size; index += 1) {
    timingRow[index] = true;
    const timingColumnRow = mask[index];
    if (timingColumnRow === undefined) {
      throw new ScannerError(
        'internal_error',
        'Missing timing column while building QR function mask.',
      );
    }
    timingColumnRow[6] = true;
  }

  if (version >= 2) {
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

        markAlignmentPattern(mask, rowCenter, colCenter);
      }
    }
  }

  markCells(mask, FORMAT_INFO_FIRST_COPY_POSITIONS);
  markCells(mask, getFormatInfoSecondCopyPositions(size));

  if (version >= 7) {
    markCells(mask, getVersionInfoFirstCopyPositions(size));
    markCells(mask, getVersionInfoSecondCopyPositions(size));
  }

  const darkModuleRow = mask[size - 8];
  if (darkModuleRow === undefined) {
    throw new ScannerError(
      'internal_error',
      'Missing dark module row while building QR function mask.',
    );
  }
  darkModuleRow[8] = true;

  return mask;
}

export function decodeFormatInfo(matrix: boolean[][]): {
  readonly errorCorrectionLevel: QrErrorCorrectionLevel;
  readonly maskPattern: number;
} {
  const firstCopyPositions = FORMAT_INFO_FIRST_COPY_POSITIONS;
  const secondCopyPositions = getFormatInfoSecondCopyPositions(matrix.length);

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestEcl: QrErrorCorrectionLevel = 'M';
  let bestMask = 0;

  for (const observed of [
    readBits(matrix, firstCopyPositions),
    readBits(matrix, secondCopyPositions),
  ]) {
    for (const ecl of ['L', 'M', 'Q', 'H'] as const) {
      for (let maskPattern = 0; maskPattern < 8; maskPattern += 1) {
        const candidate = buildFormatInfoCodeword(ecl, maskPattern);
        const distance = bitCount(candidate ^ observed);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEcl = ecl;
          bestMask = maskPattern;
        }
      }
    }
  }

  if (bestDistance > 3) {
    throw new ScannerError('decode_failed', 'Could not decode QR format information.');
  }

  return { errorCorrectionLevel: bestEcl, maskPattern: bestMask };
}

export function decodeVersionInfo(matrix: boolean[][]): number {
  const size = matrix.length;
  const version = getVersionFromSize(size);

  if (version < 7) {
    return version;
  }

  const firstCopyPositions = getVersionInfoFirstCopyPositions(size);
  const secondCopyPositions = getVersionInfoSecondCopyPositions(size);
  const observedValues = [
    readBits(matrix, firstCopyPositions),
    readBits(matrix, secondCopyPositions),
  ];

  let bestVersion = version;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let candidateVersion = 7; candidateVersion <= 40; candidateVersion += 1) {
    const candidate = buildVersionInfoCodeword(candidateVersion);
    for (const observed of observedValues) {
      const distance = bitCount(candidate ^ observed);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestVersion = candidateVersion;
      }
    }
  }

  if (bestDistance > 3) {
    throw new ScannerError('decode_failed', 'Could not decode QR version information.');
  }

  return bestVersion;
}

export function getVersionBlockInfo(
  version: number,
  errorCorrectionLevel: QrErrorCorrectionLevel,
): QrVersionBlockInfo {
  if (version < 1 || version > 40) {
    throw new ScannerError('invalid_input', `Invalid QR version: ${version}`);
  }

  const levelIndex = { L: 0, M: 1, Q: 2, H: 3 }[errorCorrectionLevel];
  const table = RS_BLOCK_TABLE[(version - 1) * 4 + levelIndex];

  if (table === undefined) {
    throw new ScannerError(
      'internal_error',
      `Missing RS block table for version ${version}-${errorCorrectionLevel}.`,
    );
  }

  const groups: QrBlockGroup[] = [];
  let totalCodewords = 0;
  let dataCodewords = 0;
  let ecCodewordsPerBlock = 0;

  for (let index = 0; index < table.length; index += 3) {
    const count = table[index] ?? 0;
    const total = table[index + 1] ?? 0;
    const data = table[index + 2] ?? 0;
    const ec = total - data;

    if (ecCodewordsPerBlock === 0) {
      ecCodewordsPerBlock = ec;
    }

    groups.push({ count, totalCodewords: total, dataCodewords: data });
    totalCodewords += count * total;
    dataCodewords += count * data;
  }

  return {
    totalCodewords,
    dataCodewords,
    ecCodewordsPerBlock,
    groups,
  };
}

export function getVersion1BlockInfo(errorCorrectionLevel: QrErrorCorrectionLevel): {
  readonly totalCodewords: number;
  readonly dataCodewords: number;
  readonly ecCodewords: number;
} {
  const blockInfo = getVersionBlockInfo(1, errorCorrectionLevel);
  return {
    totalCodewords: blockInfo.totalCodewords,
    dataCodewords: blockInfo.dataCodewords,
    ecCodewords: blockInfo.ecCodewordsPerBlock,
  };
}

export function getRemainderBits(version: number): number {
  if (version === 1) {
    return 0;
  }

  if (version <= 6) {
    return 7;
  }

  if (version <= 13) {
    return 0;
  }

  if (version <= 20) {
    return 3;
  }

  if (version <= 27) {
    return 4;
  }

  if (version <= 34) {
    return 3;
  }

  return 0;
}

export function buildDataModulePositions(
  size: number,
  reserved: boolean[][],
): Array<readonly [number, number]> {
  const positions: Array<readonly [number, number]> = [];

  let row = size - 1;
  let direction = -1;

  for (let col = size - 1; col > 0; ) {
    if (col === 6) {
      col -= 1;
      continue;
    }

    while (true) {
      for (let offset = 0; offset < 2; offset += 1) {
        const currentCol = col - offset;
        if (!reserved[row]?.[currentCol]) {
          positions.push([row, currentCol]);
        }
      }

      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }

    col -= 2;
  }

  return positions;
}

export function unmask(
  matrix: boolean[][],
  maskPattern: number,
  reserved: boolean[][],
): boolean[][] {
  const size = matrix.length;
  const output = matrix.map((row) => row.slice());

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (reserved[row]?.[col]) {
        continue;
      }

      if (maskApplies(maskPattern, row, col)) {
        const currentRow = output[row];
        if (currentRow === undefined) {
          throw new ScannerError('internal_error', 'Missing output row while applying QR mask.');
        }
        currentRow[col] = !currentRow[col];
      }
    }
  }

  return output;
}
