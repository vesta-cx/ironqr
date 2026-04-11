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

export const FORMAT_INFO_FIRST_COPY_POSITIONS: readonly (readonly [number, number])[] = [
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

/**
 * Creates a square boolean matrix initialized to a uniform value.
 *
 * @param size - Width and height of the matrix.
 * @param value - Initial value for every cell.
 * @returns A square boolean matrix of the requested size.
 */
const createMatrix = (size: number, value: boolean): boolean[][] => {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => value));
};

/**
 * Marks every cell inside a rectangle as reserved.
 *
 * @param mask - Reservation mask being mutated in place.
 * @param top - Top row of the rectangle.
 * @param left - Left column of the rectangle.
 * @param height - Rectangle height in modules.
 * @param width - Rectangle width in modules.
 * @returns Nothing.
 */
const markRectangle = (
  mask: boolean[][],
  top: number,
  left: number,
  height: number,
  width: number,
): void => {
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
};

/**
 * Marks an explicit set of cells as reserved.
 *
 * @param mask - Reservation mask being mutated in place.
 * @param positions - Row and column pairs to mark.
 * @returns Nothing.
 */
const markCells = (mask: boolean[][], positions: readonly (readonly [number, number])[]): void => {
  for (const [row, col] of positions) {
    const currentRow = mask[row];
    if (currentRow === undefined) {
      continue;
    }

    if (currentRow[col] !== undefined) {
      currentRow[col] = true;
    }
  }
};

/**
 * Reads a bit sequence from the given matrix coordinates.
 *
 * @param matrix - QR module matrix to read from.
 * @param positions - Ordered row and column pairs to read.
 * @returns The collected bits packed into an integer.
 */
const readBits = (
  matrix: boolean[][],
  positions: readonly (readonly [number, number])[],
): number => {
  let value = 0;

  for (const [row, col] of positions) {
    value = (value << 1) | (matrix[row]?.[col] ? 1 : 0);
  }

  return value;
};

/**
 * Counts the number of set bits in an integer.
 *
 * @param value - Integer to inspect.
 * @returns The Hamming weight of the integer.
 */
const bitCount = (value: number): number => {
  let count = 0;
  let bits = value;

  while (bits !== 0) {
    bits &= bits - 1;
    count += 1;
  }

  return count;
};

/**
 * Builds the masked 15-bit QR format information codeword.
 *
 * @param ecl - Error correction level to encode.
 * @param maskPattern - Data mask pattern to encode.
 * @returns The fully encoded and masked format information value.
 */
export const buildFormatInfoCodeword = (
  ecl: QrErrorCorrectionLevel,
  maskPattern: number,
): number => {
  const data = ((FORMAT_INFO_ECL_BITS[ecl] ?? 0) << 3) | maskPattern;
  let value = data << 10;
  const generator = 0x537;

  // Divide by the BCH generator polynomial to compute the 10-bit remainder.
  for (let bit = 14; bit >= 10; bit -= 1) {
    if ((value & (1 << bit)) === 0) {
      continue;
    }

    value ^= generator << (bit - 10);
  }

  return ((data << 10) | value) ^ 0x5412;
};

/**
 * Builds the 18-bit QR version information codeword.
 *
 * @param version - QR version in the range 7 through 40.
 * @returns The BCH-protected version information value.
 * @throws {ScannerError} Thrown when the version is outside the range that stores version bits.
 */
export const buildVersionInfoCodeword = (version: number): number => {
  if (version < 7 || version > 40) {
    throw new ScannerError(
      'invalid_input',
      `QR version info is only defined for versions 7-40 (got ${version}).`,
    );
  }

  const data = version;
  let value = data << 12;
  const generator = 0x1f25;

  // Divide by the BCH generator polynomial to compute the 12-bit remainder.
  for (let bit = 17; bit >= 12; bit -= 1) {
    if ((value & (1 << bit)) === 0) {
      continue;
    }

    value ^= generator << (bit - 12);
  }

  return (data << 12) | value;
};

/**
 * Returns the matrix coordinates for the second copy of the format bits.
 *
 * @param size - Side length of the QR matrix.
 * @returns Ordered coordinates for the mirrored format information copy.
 */
export const getFormatInfoSecondCopyPositions = (
  size: number,
): readonly (readonly [number, number])[] => {
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
};

/**
 * Returns the matrix coordinates for the first copy of the version bits.
 *
 * @param size - Side length of the QR matrix.
 * @returns Ordered coordinates for the top-right version information copy.
 */
export const getVersionInfoFirstCopyPositions = (
  size: number,
): readonly (readonly [number, number])[] => {
  return Array.from(
    { length: 18 },
    (_, index) => [Math.floor(index / 3), size - 11 + (index % 3)] as const,
  );
};

/**
 * Returns the matrix coordinates for the second copy of the version bits.
 *
 * @param size - Side length of the QR matrix.
 * @returns Ordered coordinates for the bottom-left version information copy.
 */
export const getVersionInfoSecondCopyPositions = (
  size: number,
): readonly (readonly [number, number])[] => {
  return Array.from(
    { length: 18 },
    (_, index) => [size - 11 + (index % 3), Math.floor(index / 3)] as const,
  );
};

/**
 * Converts a matrix size into its QR Model 2 version number.
 *
 * @param size - Side length of the square QR matrix.
 * @returns The inferred QR version.
 * @throws {ScannerError} Thrown when the size does not match a supported QR version.
 */
export const getVersionFromSize = (size: number): number => {
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new ScannerError('invalid_input', `Invalid QR grid size: ${size}`);
  }

  return version;
};

/**
 * Evaluates whether a mask pattern applies at a specific module coordinate.
 *
 * @param maskPattern - QR mask pattern number.
 * @param row - Module row.
 * @param col - Module column.
 * @returns True when the module should be flipped by the mask.
 * @throws {ScannerError} Thrown when the mask pattern is unknown.
 */
export const maskApplies = (maskPattern: number, row: number, col: number): boolean => {
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
};

/**
 * Marks the reserved area occupied by a finder pattern and its separator.
 *
 * @param mask - Reservation mask being mutated in place.
 * @param top - Top row of the finder pattern.
 * @param left - Left column of the finder pattern.
 * @returns Nothing.
 */
const markFinderPattern = (mask: boolean[][], top: number, left: number): void => {
  markRectangle(mask, top, left, 8, 8);
};

/**
 * Marks the reserved area occupied by an alignment pattern.
 *
 * @param mask - Reservation mask being mutated in place.
 * @param centerRow - Alignment pattern center row.
 * @param centerCol - Alignment pattern center column.
 * @returns Nothing.
 */
const markAlignmentPattern = (mask: boolean[][], centerRow: number, centerCol: number): void => {
  markRectangle(mask, centerRow - 2, centerCol - 2, 5, 5);
};

/**
 * Builds a mask of every function module reserved by the QR specification.
 *
 * @param size - Side length of the QR matrix.
 * @param version - QR version represented by the matrix.
 * @returns A matrix whose true cells are reserved function modules.
 * @throws {ScannerError} Thrown when the version is invalid or the matrix cannot be constructed.
 */
export const buildFunctionModuleMask = (size: number, version: number): boolean[][] => {
  const mask = createMatrix(size, false);

  if (version < 1 || version > 40) {
    throw new ScannerError('invalid_input', `Invalid QR version: ${version}`);
  }

  // Reserve finder patterns, timing patterns, alignment patterns, format info, version info,
  // and the dark module so data extraction can skip them later.
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
};

/**
 * Decodes the QR format information from either embedded copy.
 *
 * @param matrix - QR module matrix including function modules.
 * @returns The decoded error correction level and mask pattern.
 * @throws {ScannerError} Thrown when neither copy can be decoded within QR tolerance.
 */
export const decodeFormatInfo = (
  matrix: boolean[][],
): {
  readonly errorCorrectionLevel: QrErrorCorrectionLevel;
  readonly maskPattern: number;
} => {
  const firstCopyPositions = FORMAT_INFO_FIRST_COPY_POSITIONS;
  const secondCopyPositions = getFormatInfoSecondCopyPositions(matrix.length);

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestEcl: QrErrorCorrectionLevel = 'M';
  let bestMask = 0;

  // Compare both embedded copies against every legal codeword and keep the closest match.
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
};

/**
 * Decodes the QR version information from the matrix.
 *
 * @param matrix - QR module matrix including function modules.
 * @returns The decoded QR version.
 * @throws {ScannerError} Thrown when the version information cannot be decoded within tolerance.
 */
export const decodeVersionInfo = (matrix: boolean[][]): number => {
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
};

/**
 * Looks up the Reed-Solomon block layout for a QR version and EC level.
 *
 * @param version - QR version number.
 * @param errorCorrectionLevel - QR error correction level.
 * @returns Block-level codeword counts for the requested QR symbol shape.
 * @throws {ScannerError} Thrown when the version or table entry is missing.
 */
export const getVersionBlockInfo = (
  version: number,
  errorCorrectionLevel: QrErrorCorrectionLevel,
): QrVersionBlockInfo => {
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

  // The QR table stores repeating triples: block count, total codewords, and data codewords.
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
};

/**
 * Convenience lookup for the version 1 block layout.
 *
 * @param errorCorrectionLevel - QR error correction level.
 * @returns Total, data, and ECC codeword counts for version 1.
 */
export const getVersion1BlockInfo = (
  errorCorrectionLevel: QrErrorCorrectionLevel,
): {
  readonly totalCodewords: number;
  readonly dataCodewords: number;
  readonly ecCodewords: number;
} => {
  const blockInfo = getVersionBlockInfo(1, errorCorrectionLevel);
  return {
    totalCodewords: blockInfo.totalCodewords,
    dataCodewords: blockInfo.dataCodewords,
    ecCodewords: blockInfo.ecCodewordsPerBlock,
  };
};

/**
 * Returns the number of remainder bits appended after the codewords for a version.
 *
 * @param version - QR version number.
 * @returns The number of remainder bits for that version.
 */
export const getRemainderBits = (version: number): number => {
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
};

/**
 * Enumerates data-module coordinates in the QR zig-zag scan order.
 *
 * @param size - Side length of the QR matrix.
 * @param reserved - Reservation mask marking function modules.
 * @returns Ordered row and column pairs for every data module.
 */
export const buildDataModulePositions = (
  size: number,
  reserved: boolean[][],
): Array<readonly [number, number]> => {
  const positions: Array<readonly [number, number]> = [];

  let row = size - 1;
  let direction = -1;

  // Walk the matrix in the standard two-column zig-zag, skipping the timing column.
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
};

/**
 * Removes the selected data mask from a QR matrix.
 *
 * @param matrix - QR module matrix to unmask.
 * @param maskPattern - Mask pattern that was applied when the symbol was encoded.
 * @param reserved - Reservation mask marking function modules.
 * @returns A copy of the matrix with data modules unmasked.
 * @throws {ScannerError} Thrown when the output matrix is unexpectedly malformed.
 */
export const unmask = (
  matrix: boolean[][],
  maskPattern: number,
  reserved: boolean[][],
): boolean[][] => {
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
};
