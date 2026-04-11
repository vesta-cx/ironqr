import {
  ALIGNMENT_PATTERN_CENTERS,
  buildDataModulePositions,
  buildFormatInfoCodeword,
  buildFunctionModuleMask,
  buildVersionInfoCodeword,
  FORMAT_INFO_FIRST_COPY_POSITIONS,
  getFormatInfoSecondCopyPositions,
  getVersionBlockInfo,
  getVersionInfoFirstCopyPositions,
  getVersionInfoSecondCopyPositions,
  maskApplies,
  rsEncode,
} from '../../src/qr/index.js';

const ALPHANUMERIC_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const bytesFromBits = (bits: readonly number[]): Uint8Array => {
  if (bits.length % 8 !== 0) {
    throw new Error('Fixture bits must be byte aligned.');
  }

  const bytes = new Uint8Array(bits.length / 8);
  for (let index = 0; index < bytes.length; index += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | (bits[index * 8 + bit] ?? 0);
    }
    bytes[index] = value;
  }

  return bytes;
};

const appendBits = (bits: number[], value: number, length: number): void => {
  for (let bit = length - 1; bit >= 0; bit -= 1) {
    bits.push((value >> bit) & 1);
  }
};

const encodeAlphanumericData = (
  message: string,
  version: number,
  totalDataCodewords: number,
): number[] => {
  const countBits = version <= 9 ? 9 : version <= 26 ? 11 : 13;
  const values = new Map(
    ALPHANUMERIC_CHARSET.split('').map((char, index) => [char, index] as const),
  );
  const bits: number[] = [];

  appendBits(bits, 0b0010, 4);
  appendBits(bits, message.length, countBits);

  for (let index = 0; index < message.length; index += 2) {
    const first = values.get(message[index] ?? '');
    if (first === undefined) {
      throw new Error(`Unsupported alphanumeric character: ${message[index] ?? ''}`);
    }

    const secondChar = message[index + 1];
    if (secondChar === undefined) {
      appendBits(bits, first, 6);
      continue;
    }

    const second = values.get(secondChar);
    if (second === undefined) {
      throw new Error(`Unsupported alphanumeric character: ${secondChar}`);
    }

    appendBits(bits, first * 45 + second, 11);
  }

  const terminatorBits = Math.min(4, totalDataCodewords * 8 - bits.length);
  appendBits(bits, 0, terminatorBits);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  let padByte = 0xec;
  while (bits.length < totalDataCodewords * 8) {
    appendBits(bits, padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  return Array.from(bytesFromBits(bits));
};

const splitInterleavedBlocks = (
  dataCodewords: readonly number[],
  blockInfo: ReturnType<typeof getVersionBlockInfo>,
) => {
  const blocks: Array<{ data: number[]; ecc: number[] }> = [];

  for (const group of blockInfo.groups) {
    for (let repeat = 0; repeat < group.count; repeat += 1) {
      blocks.push({
        data: new Array(group.dataCodewords).fill(0),
        ecc: new Array(blockInfo.ecCodewordsPerBlock).fill(0),
      });
    }
  }

  let offset = 0;
  // QR splits data into contiguous blocks (not cyclically).
  for (const block of blocks) {
    for (let index = 0; index < block.data.length; index += 1) {
      block.data[index] = dataCodewords[offset] ?? 0;
      offset += 1;
    }
  }

  if (offset !== dataCodewords.length) {
    throw new Error(
      `Fixture mismatch while splitting data blocks: consumed ${offset}, expected ${dataCodewords.length}.`,
    );
  }

  return blocks;
};

const buildRawCodewords = (version: number, message: string): number[] => {
  const blockInfo = getVersionBlockInfo(version, 'M');
  const dataCodewords = encodeAlphanumericData(message, version, blockInfo.dataCodewords);
  const blocks = splitInterleavedBlocks(dataCodewords, blockInfo);

  for (const block of blocks) {
    block.ecc = Array.from(rsEncode(block.data, blockInfo.ecCodewordsPerBlock));
  }

  const rawCodewords: number[] = [];
  const maxDataCodewords = Math.max(...blocks.map((block) => block.data.length), 0);
  for (let index = 0; index < maxDataCodewords; index += 1) {
    for (const block of blocks) {
      if (index < block.data.length) {
        rawCodewords.push(block.data[index] ?? 0);
      }
    }
  }

  for (let index = 0; index < blockInfo.ecCodewordsPerBlock; index += 1) {
    for (const block of blocks) {
      rawCodewords.push(block.ecc[index] ?? 0);
    }
  }

  return rawCodewords;
};

const buildMatrix = (version: number, message: string): boolean[][] => {
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const reserved = buildFunctionModuleMask(size, version);
  const rawCodewords = buildRawCodewords(version, message);

  const setModule = (row: number, col: number, value: boolean): void => {
    const currentRow = matrix[row];
    if (currentRow === undefined) {
      throw new Error(`Missing fixture row ${row}.`);
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

  const drawAlignment = (centerRow: number, centerCol: number): void => {
    for (let row = -2; row <= 2; row += 1) {
      for (let col = -2; col <= 2; col += 1) {
        const absoluteRow = centerRow + row;
        const absoluteCol = centerCol + col;
        const dark = Math.abs(row) === 2 || Math.abs(col) === 2 || (row === 0 && col === 0);
        setModule(absoluteRow, absoluteCol, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    setModule(6, index, index % 2 === 0);
    setModule(index, 6, index % 2 === 0);
  }

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

      drawAlignment(rowCenter, colCenter);
    }
  }

  const formatBits = buildFormatInfoCodeword('M', 0);

  for (let index = 0; index < FORMAT_INFO_FIRST_COPY_POSITIONS.length; index += 1) {
    const position = FORMAT_INFO_FIRST_COPY_POSITIONS[index];
    if (!position) continue;
    setModule(position[0], position[1], ((formatBits >> (14 - index)) & 1) === 1);
  }

  for (let index = 0; index < getFormatInfoSecondCopyPositions(size).length; index += 1) {
    const position = getFormatInfoSecondCopyPositions(size)[index];
    if (!position) continue;
    setModule(position[0], position[1], ((formatBits >> (14 - index)) & 1) === 1);
  }

  const versionBits = buildVersionInfoCodeword(version);

  for (let index = 0; index < getVersionInfoFirstCopyPositions(size).length; index += 1) {
    const position = getVersionInfoFirstCopyPositions(size)[index];
    if (!position) continue;
    setModule(position[0], position[1], ((versionBits >> (17 - index)) & 1) === 1);
  }

  for (let index = 0; index < getVersionInfoSecondCopyPositions(size).length; index += 1) {
    const position = getVersionInfoSecondCopyPositions(size)[index];
    if (!position) continue;
    setModule(position[0], position[1], ((versionBits >> (17 - index)) & 1) === 1);
  }

  setModule(size - 8, 8, true);

  const positions = buildDataModulePositions(size, reserved);
  if (positions.length !== rawCodewords.length * 8) {
    throw new Error(
      `Fixture mismatch: ${positions.length} data modules, ${rawCodewords.length * 8} bits.`,
    );
  }

  const bits: number[] = [];
  for (const codeword of rawCodewords) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      bits.push((codeword >> bit) & 1);
    }
  }

  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    const bit = bits[index] === 1;
    if (!position) {
      continue;
    }

    const [row, col] = position;
    const applyMask = maskApplies(0, row, col);
    setModule(row, col, applyMask ? !bit : bit);
  }

  return matrix;
};

export const helloWorldV7MGrid = buildMatrix(7, 'HELLO WORLD');
