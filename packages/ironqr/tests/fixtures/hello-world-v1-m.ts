import {
  buildDataModulePositions,
  buildFormatInfoCodeword,
  buildFunctionModuleMask,
  FORMAT_INFO_FIRST_COPY_POSITIONS,
  rsEncode,
  ScannerError,
} from '../../src/qr/index.js';

const buildGrid = (): boolean[][] => {
  const size = 21;
  const version = 1;
  const matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => false));

  const setModule = (row: number, col: number, value: boolean): void => {
    const currentRow = matrix[row];
    if (currentRow === undefined) {
      throw new ScannerError('internal_error', `Missing fixture row ${row}.`);
    }
    currentRow[col] = value;
  };

  const drawFinder = (top: number, left: number): void => {
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 7; col += 1) {
        const dark =
          row === 0 ||
          row === 6 ||
          col === 0 ||
          col === 6 ||
          (row >= 2 && row <= 4 && col >= 2 && col <= 4);
        setModule(top + row, left + col, dark);
      }
    }
  };

  const reserve = buildFunctionModuleMask(size, version);

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    setModule(6, index, index % 2 === 0);
    setModule(index, 6, index % 2 === 0);
  }

  const formatBits = buildFormatInfoCodeword('M', 0);

  for (let index = 0; index < FORMAT_INFO_FIRST_COPY_POSITIONS.length; index += 1) {
    const position = FORMAT_INFO_FIRST_COPY_POSITIONS[index];
    if (!position) {
      continue;
    }
    setModule(position[0], position[1], ((formatBits >> (14 - index)) & 1) === 1);
  }

  for (let col = 8; col < size - 8; col += 1) {
    setModule(6, col, (col - 8) % 2 === 0);
  }
  for (let row = 8; row < size - 8; row += 1) {
    setModule(row, 6, (row - 8) % 2 === 0);
  }

  const dataCodewords = [
    0b00100000, 0b01011011, 0b00001011, 0b01111000, 0b11010001, 0b01110010, 0b11011100, 0b01001101,
    0b01000011, 0b01000000, 0b11101100, 0b00010001, 0b11101100, 0b00010001, 0b11101100, 0b00010001,
  ];

  const ecCodewords = Array.from(rsEncode(dataCodewords, 10));
  const allCodewords = [...dataCodewords, ...ecCodewords];
  const bits: number[] = [];
  for (const codeword of allCodewords) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      bits.push((codeword >> bit) & 1);
    }
  }

  const positions = buildDataModulePositions(size, reserve);
  if (positions.length !== bits.length) {
    throw new ScannerError(
      'internal_error',
      `Fixture mismatch: ${positions.length} data modules, ${bits.length} bits.`,
    );
  }

  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    const bit = bits[index] === 1;
    if (!position) {
      continue;
    }
    const [row, col] = position;
    const applyMask = (row + col) % 2 === 0;
    setModule(row, col, applyMask ? !bit : bit);
  }

  return matrix;
};

export const helloWorldV1MGrid = buildGrid();
