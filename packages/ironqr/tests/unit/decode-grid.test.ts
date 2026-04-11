import { describe, expect, it } from 'bun:test';
import { decodeGrid } from '../../src/index.js';
import {
  buildDataModulePositions,
  buildFormatInfoCodeword,
  buildFunctionModuleMask,
  buildVersionInfoCodeword,
  FORMAT_INFO_FIRST_COPY_POSITIONS,
  getFormatInfoSecondCopyPositions,
  getRemainderBits,
  getVersionBlockInfo,
  maskApplies,
  rsEncode,
} from '../../src/qr/index.js';
import { helloWorldV1MGrid } from '../fixtures/hello-world-v1-m.js';
import { helloWorldV7MGrid } from '../fixtures/hello-world-v7-m.js';

// ─── Types ─────────────────────────────────────────────────────────────────

type Ecl = 'L' | 'M' | 'Q' | 'H';

// ─── Constants ─────────────────────────────────────────────────────────────

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const V1_SIZE = 21;
const V1_VERSION = 1;

// A single valid v7-M RS block (31 data + 18 EC = 49 bytes), used to
// confirm correctRsBlock() leaves error-free blocks untouched.
const VALID_V7_M_RS_BLOCK = [
  32, 209, 67, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236,
  236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 236, 129, 93, 188, 173, 236, 74, 208, 229, 53,
  207, 223, 112, 34, 118, 223, 231, 66, 151,
] as const;

// ─── Bit helpers ───────────────────────────────────────────────────────────

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

// ─── Version 1 grid builder ────────────────────────────────────────────────

/**
 * Pads a raw payload bit stream to the full data codeword capacity for the
 * given version-1 EC level, then returns the resulting data codeword bytes.
 */
const finalizeVersion1DataCodewords = (payloadBits: readonly number[], ecl: Ecl): number[] => {
  const { dataCodewords: totalDataCodewords } = getVersionBlockInfo(V1_VERSION, ecl);
  const totalBits = totalDataCodewords * 8;
  const bits = Array.from(payloadBits);

  appendBits(bits, 0, Math.min(4, totalBits - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  let padByte = 0xec;
  while (bits.length < totalBits) {
    appendBits(bits, padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  return bytesFromBits(bits);
};

/**
 * Builds a fully-compliant version-1 QR matrix from data codewords using the
 * specified EC level and mask pattern.  All function-module patterns, format
 * info, dark module, and data placement follow ISO 18004.
 */
const buildVersion1Grid = (
  dataCodewords: readonly number[],
  ecl: Ecl,
  maskPattern: number,
): boolean[][] => {
  const { ecCodewordsPerBlock } = getVersionBlockInfo(V1_VERSION, ecl);
  const matrix = Array.from({ length: V1_SIZE }, () =>
    Array.from({ length: V1_SIZE }, () => false),
  );
  const reserved = buildFunctionModuleMask(V1_SIZE, V1_VERSION);
  const allCodewords = [
    ...dataCodewords,
    ...Array.from(rsEncode(dataCodewords, ecCodewordsPerBlock)),
  ];
  const bits: number[] = [];

  const setModule = (row: number, col: number, value: boolean): void => {
    const currentRow = matrix[row];
    if (currentRow === undefined) throw new Error(`Missing row ${row}.`);
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

  drawFinder(0, 0);
  drawFinder(0, V1_SIZE - 7);
  drawFinder(V1_SIZE - 7, 0);

  for (let index = 8; index < V1_SIZE - 8; index += 1) {
    setModule(6, index, index % 2 === 0);
    setModule(index, 6, index % 2 === 0);
  }

  const formatBits = buildFormatInfoCodeword(ecl, maskPattern);
  for (let index = 0; index < FORMAT_INFO_FIRST_COPY_POSITIONS.length; index += 1) {
    const position = FORMAT_INFO_FIRST_COPY_POSITIONS[index];
    if (!position) continue;
    setModule(position[0], position[1], ((formatBits >> (14 - index)) & 1) === 1);
  }
  for (let index = 0; index < getFormatInfoSecondCopyPositions(V1_SIZE).length; index += 1) {
    const position = getFormatInfoSecondCopyPositions(V1_SIZE)[index];
    if (!position) continue;
    setModule(position[0], position[1], ((formatBits >> (14 - index)) & 1) === 1);
  }

  setModule(V1_SIZE - 8, 8, true);

  for (const codeword of allCodewords) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      bits.push((codeword >> bit) & 1);
    }
  }

  const positions = buildDataModulePositions(V1_SIZE, reserved);
  if (positions.length !== bits.length) {
    throw new Error(`Fixture mismatch: ${positions.length} data modules, ${bits.length} bits.`);
  }

  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (!position) continue;
    const [row, col] = position;
    const bit = bits[index] === 1;
    setModule(row, col, maskApplies(maskPattern, row, col) ? !bit : bit);
  }

  return matrix;
};

// ─── Mode-specific payload helpers ────────────────────────────────────────

const alphanumericBits = (message: string): number[] => {
  const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const values = new Map(CHARSET.split('').map((c, i) => [c, i] as const));
  const bits: number[] = [];
  appendBits(bits, 0b0010, 4);
  appendBits(bits, message.length, 9); // v1 count bits
  for (let i = 0; i < message.length; i += 2) {
    const a = values.get(message[i] ?? '') ?? 0;
    const secondChar = message[i + 1];
    const b = secondChar !== undefined ? values.get(secondChar) : undefined;
    if (b === undefined) {
      appendBits(bits, a, 6);
    } else {
      appendBits(bits, a * 45 + b, 11);
    }
  }
  return bits;
};

const buildFnc1SecondPositionGrid = (): boolean[][] => {
  const bits: number[] = [];
  appendBits(bits, 0b1001, 4); // FNC1 second
  appendBits(bits, 0x41, 8); // application indicator
  bits.push(...alphanumericBits('AB'));
  return buildVersion1Grid(finalizeVersion1DataCodewords(bits, 'M'), 'M', 0);
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('decodeGrid', () => {
  // ── Pre-existing end-to-end tests ────────────────────────────────────────

  it('decodes the version 1-M HELLO WORLD logical grid end-to-end', async () => {
    const result = await decodeGrid({ grid: helloWorldV1MGrid });
    expect(result.version).toBe(1);
    expect(result.errorCorrectionLevel).toBe('M');
    expect(result.payload.kind).toBe('text');
    expect(result.payload.text).toBe('HELLO WORLD');
    expect(new TextDecoder().decode(result.payload.bytes)).toBe('HELLO WORLD');
    expect(result.headers.length).toBeGreaterThan(0);
  });

  it('decodes a version 7-M HELLO WORLD logical grid end-to-end', async () => {
    const result = await decodeGrid({ grid: helloWorldV7MGrid });
    expect(result.version).toBe(7);
    expect(result.errorCorrectionLevel).toBe('M');
    expect(result.payload.kind).toBe('text');
    expect(result.payload.text).toBe('HELLO WORLD');
    expect(new TextDecoder().decode(result.payload.bytes)).toBe('HELLO WORLD');
  });

  // ── RS / GF table boundary tests ─────────────────────────────────────────

  it('initializes GF tables before correcting a valid RS block in a fresh process', async () => {
    const { execFileSync } = await import('node:child_process');
    const command = `import { correctRsBlock } from './src/qr/index.ts'; const block = ${JSON.stringify(VALID_V7_M_RS_BLOCK)}; console.log(JSON.stringify(Array.from(correctRsBlock(block, 18))));`;
    const output = execFileSync('bun', ['-e', command], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(JSON.parse(output.trim())).toEqual(VALID_V7_M_RS_BLOCK);
  });

  it('wraps unrecoverable RS failures in ScannerError at the public decode boundary', async () => {
    const grid = helloWorldV1MGrid.map((row) => row.slice());
    const reserved = buildFunctionModuleMask(grid.length, 1);
    const positions = buildDataModulePositions(grid.length, reserved);

    for (let index = 0; index < 96; index += 1) {
      const position = positions[index];
      if (!position) continue;
      const [row, col] = position;
      const currentRow = grid[row];
      if (!currentRow) continue;
      currentRow[col] = !currentRow[col];
    }

    await expect(decodeGrid({ grid })).rejects.toMatchObject({
      name: 'ScannerError',
      code: 'decode_failed',
      message: expect.stringContaining('Reed-Solomon'),
    });
  });

  // ── AC3: mask pattern coverage ────────────────────────────────────────────

  it('decodes a version 1-M grid correctly for all 8 mask patterns', async () => {
    const payloadBits = alphanumericBits('HI');

    for (let maskPattern = 0; maskPattern < 8; maskPattern += 1) {
      const dataCodewords = finalizeVersion1DataCodewords(payloadBits, 'M');
      const grid = buildVersion1Grid(dataCodewords, 'M', maskPattern);
      const result = await decodeGrid({ grid });
      expect(result.payload.text, `mask ${maskPattern}`).toBe('HI');
      expect(result.errorCorrectionLevel, `mask ${maskPattern}`).toBe('M');
    }
  });

  // ── AC3: EC level coverage ────────────────────────────────────────────────

  it.each<[Ecl]>([['L'], ['Q'], ['H']])('decodes a version 1-%s grid end-to-end', async (ecl) => {
    const dataCodewords = finalizeVersion1DataCodewords(alphanumericBits('HI'), ecl);
    const grid = buildVersion1Grid(dataCodewords, ecl, 0);
    const result = await decodeGrid({ grid });
    expect(result.version).toBe(1);
    expect(result.errorCorrectionLevel).toBe(ecl);
    expect(result.payload.text).toBe('HI');
  });

  // ── AC3: error recovery ───────────────────────────────────────────────────

  it('silently corrects up to t codeword errors and still returns the right payload', async () => {
    // v1-M: t = floor(10/2) = 5.  Corrupt 4 separate data codewords (each by
    // flipping one bit) — well within the correction capacity.
    const dataCodewords = finalizeVersion1DataCodewords(alphanumericBits('HI'), 'M');
    const originalGrid = buildVersion1Grid(dataCodewords, 'M', 0);
    const corrupted = originalGrid.map((row) => row.slice());
    const reserved = buildFunctionModuleMask(V1_SIZE, V1_VERSION);
    const positions = buildDataModulePositions(V1_SIZE, reserved);

    for (let codeword = 0; codeword < 4; codeword += 1) {
      // Flip the most-significant bit of each of codewords 0, 1, 2, 3.
      const position = positions[codeword * 8];
      if (!position) continue;
      const [row, col] = position;
      const currentRow = corrupted[row];
      if (currentRow) currentRow[col] = !currentRow[col];
    }

    const result = await decodeGrid({ grid: corrupted });
    expect(result.payload.text).toBe('HI');
    expect(result.errorCorrectionLevel).toBe('M');
  });

  // ── AC3: segment mode coverage ────────────────────────────────────────────

  it('decodes a numeric-mode segment', async () => {
    // Encode "1234": groups of 3 → 123 (10 bits) + single 4 (4 bits).
    const bits: number[] = [];
    appendBits(bits, 0b0001, 4); // numeric mode
    appendBits(bits, 4, 10); // 4 chars (v1 numeric count = 10 bits)
    appendBits(bits, 123, 10); // "123"
    appendBits(bits, 4, 4); // "4"

    const result = await decodeGrid({
      grid: buildVersion1Grid(finalizeVersion1DataCodewords(bits, 'M'), 'M', 0),
    });
    expect(result.payload.text).toBe('1234');
    expect(result.headers).toContainEqual(['mode', 'numeric']);
    expect(new TextDecoder().decode(result.payload.bytes)).toBe('1234');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.mode).toBe('numeric');
    expect(result.segments[0]?.text).toBe('1234');
  });

  it('decodes a byte-mode segment with ISO-8859-1 encoding', async () => {
    // Encode three raw bytes: H I !
    const bits: number[] = [];
    appendBits(bits, 0b0100, 4); // byte mode
    appendBits(bits, 3, 8); // 3 bytes (v1 byte count = 8 bits)
    appendBits(bits, 0x48, 8); // 'H'
    appendBits(bits, 0x49, 8); // 'I'
    appendBits(bits, 0x21, 8); // '!'

    const result = await decodeGrid({
      grid: buildVersion1Grid(finalizeVersion1DataCodewords(bits, 'M'), 'M', 0),
    });
    expect(result.payload.text).toBe('HI!');
    expect(Array.from(result.payload.bytes)).toEqual([0x48, 0x49, 0x21]);
    expect(result.headers).toContainEqual(['mode', 'byte']);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.mode).toBe('byte');
    expect(result.segments[0]?.text).toBe('HI!');
    expect(Array.from(result.segments[0]?.bytes ?? [])).toEqual([0x48, 0x49, 0x21]);
  });

  it('decodes a kanji-mode segment', async () => {
    // Encode あ (SJIS 0x82A0).
    // Offset = 0x82A0 - 0x8140 = 0x0160 → high=0x01, low=0x60=96
    // QR value = 1 * 0xC0 + 96 = 288 (fits in 13 bits)
    const bits: number[] = [];
    appendBits(bits, 0b1000, 4); // kanji mode
    appendBits(bits, 1, 8); // 1 char (v1 kanji count = 8 bits)
    appendBits(bits, 288, 13); // あ

    const result = await decodeGrid({
      grid: buildVersion1Grid(finalizeVersion1DataCodewords(bits, 'M'), 'M', 0),
    });
    expect(result.payload.text).toBe('あ');
    expect(result.headers).toContainEqual(['mode', 'kanji']);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.mode).toBe('kanji');
    expect(result.segments[0]?.text).toBe('あ');
    expect(Array.from(result.segments[0]?.bytes ?? [])).toEqual([0x82, 0xa0]);
  });

  it('decodes an ECI-mode segment switching to UTF-8 encoding', async () => {
    // ECI assignment 26 = UTF-8.  Encode "é" (U+00E9) as two UTF-8 bytes.
    const bits: number[] = [];
    appendBits(bits, 0b0111, 4); // ECI mode
    appendBits(bits, 26, 8); // UTF-8 assignment (single-byte ECI form, value < 0x80)
    appendBits(bits, 0b0100, 4); // byte mode
    appendBits(bits, 2, 8); // 2 bytes
    appendBits(bits, 0xc3, 8); // é UTF-8 high byte
    appendBits(bits, 0xa9, 8); // é UTF-8 low byte

    const result = await decodeGrid({
      grid: buildVersion1Grid(finalizeVersion1DataCodewords(bits, 'M'), 'M', 0),
    });
    expect(result.payload.text).toBe('é');
    expect(result.headers).toContainEqual(['mode', 'eci']);
    expect(result.headers).toContainEqual(['encoding', 'utf-8']);
    expect(result.headers).toContainEqual(['mode', 'byte']);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ mode: 'eci', text: 'utf-8' });
    expect(result.segments[1]).toMatchObject({ mode: 'byte', text: 'é' });
    expect(Array.from(result.segments[1]?.bytes ?? [])).toEqual([0xc3, 0xa9]);
  });

  // ── AC3: multi-segment combination ───────────────────────────────────────

  it('decodes a symbol with consecutive numeric and alphanumeric segments', async () => {
    // Encode numeric "123" followed immediately by alphanumeric "HI" in one symbol.
    const bits: number[] = [];
    appendBits(bits, 0b0001, 4); // numeric mode
    appendBits(bits, 3, 10); // 3 chars
    appendBits(bits, 123, 10); // "123"
    appendBits(bits, 0b0010, 4); // alphanumeric mode
    appendBits(bits, 2, 9); // 2 chars
    appendBits(bits, 17 * 45 + 18, 11); // "HI" (H=17, I=18)

    const result = await decodeGrid({
      grid: buildVersion1Grid(finalizeVersion1DataCodewords(bits, 'M'), 'M', 0),
    });
    expect(result.payload.text).toBe('123HI');
    expect(result.headers).toContainEqual(['mode', 'numeric']);
    expect(result.headers).toContainEqual(['mode', 'alphanumeric']);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ mode: 'numeric', text: '123' });
    expect(result.segments[1]).toMatchObject({ mode: 'alphanumeric', text: 'HI' });
  });

  // ── AC3: FNC1-first ───────────────────────────────────────────────────────

  it('decodes a FNC1 first-position marker followed by alphanumeric data', async () => {
    // FNC1-first has no payload bits; it's a bare mode indicator.
    const bits: number[] = [];
    appendBits(bits, 0b0101, 4); // FNC1-first
    appendBits(bits, 0b0010, 4); // alphanumeric
    appendBits(bits, 2, 9); // 2 chars
    appendBits(bits, 10 * 45 + 11, 11); // "AB" (A=10, B=11)

    const result = await decodeGrid({
      grid: buildVersion1Grid(finalizeVersion1DataCodewords(bits, 'M'), 'M', 0),
    });
    expect(result.payload.text).toBe('AB');
    expect(result.headers).toContainEqual(['mode', 'fnc1-first']);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ mode: 'fnc1-first', text: '' });
    expect(result.segments[1]).toMatchObject({ mode: 'alphanumeric', text: 'AB' });
  });

  // ── FNC1 second-position ──────────────────────────────────────────────────

  it('consumes the FNC1 second-position application indicator before decoding later segments', async () => {
    const result = await decodeGrid({ grid: buildFnc1SecondPositionGrid() });
    expect(result.payload.text).toBe('AB');
    expect(result.headers).toContainEqual(['mode', 'fnc1-second']);
    expect(result.headers).toContainEqual(['application-indicator', '65']);
    expect(new TextDecoder().decode(result.payload.bytes)).toBe('AB');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ mode: 'fnc1-second', text: '65' });
    expect(result.segments[1]).toMatchObject({ mode: 'alphanumeric', text: 'AB' });
  });

  // ── Full version/table coverage ───────────────────────────────────────────

  it('covers the full QR Model 2 version range in the data-module and RS tables', () => {
    expect(buildVersionInfoCodeword(7)).toBe(0x7c94);

    for (let version = 1; version <= 40; version += 1) {
      const size = 17 + version * 4;
      const reserved = buildFunctionModuleMask(size, version);
      const positions = buildDataModulePositions(size, reserved);
      const blockInfo = getVersionBlockInfo(version, 'M');

      expect(reserved.length).toBe(size);
      expect(positions).toHaveLength(blockInfo.totalCodewords * 8 + getRemainderBits(version));
    }
  });
});
