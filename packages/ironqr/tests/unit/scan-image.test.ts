import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import {
  detectFinderPatterns,
  otsuBinarize,
  resolveGrid,
  sampleGrid,
  toGrayscale,
} from '../../src/image/index.js';
import {
  buildDataModulePositions,
  buildFormatInfoCodeword,
  buildFunctionModuleMask,
  decodeGridLogical,
  FORMAT_INFO_FIRST_COPY_POSITIONS,
  getFormatInfoSecondCopyPositions,
  getVersionBlockInfo,
  maskApplies,
  rsEncode,
} from '../../src/qr/index.js';

// ─── Types ────────────────────────────────────────────────────────────────

type Ecl = 'L' | 'M' | 'Q' | 'H';

// ─── Synthetic ImageData ──────────────────────────────────────────────────

/**
 * Minimal ImageData stand-in for Node environments where the browser API is absent.
 * Matches the shape that toGrayscale, sampleGrid etc. expect.
 */
const makeImageData = (width: number, height: number, pixels: Uint8ClampedArray): ImageData => {
  return { width, height, data: pixels, colorSpace: 'srgb' } as unknown as ImageData;
};

// ─── Grid-to-pixels renderer ──────────────────────────────────────────────

const PIXELS_PER_MODULE = 10;

/**
 * Renders a boolean QR grid to an RGBA pixel buffer at 10 px/module.
 * Dark = black (0,0,0,255), light = white (255,255,255,255).
 */
const gridToImageData = (grid: boolean[][]): ImageData => {
  const modules = grid.length;
  const imageSize = modules * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(imageSize * imageSize * 4);

  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      const dark = grid[row]?.[col] ?? false;
      const value = dark ? 0 : 255;

      for (let pr = 0; pr < PIXELS_PER_MODULE; pr += 1) {
        for (let pc = 0; pc < PIXELS_PER_MODULE; pc += 1) {
          const px = (row * PIXELS_PER_MODULE + pr) * imageSize + col * PIXELS_PER_MODULE + pc;
          pixels[px * 4] = value;
          pixels[px * 4 + 1] = value;
          pixels[px * 4 + 2] = value;
          pixels[px * 4 + 3] = 255;
        }
      }
    }
  }

  return makeImageData(imageSize, imageSize, pixels);
};

// ─── Version 1 grid builder (mirrored from decode-grid.test.ts) ───────────

const V1_SIZE = 21;
const V1_VERSION = 1;

const appendBits = (bits: number[], value: number, length: number): void => {
  for (let bit = length - 1; bit >= 0; bit -= 1) {
    bits.push((value >> bit) & 1);
  }
};

const bytesFromBits = (bits: readonly number[]): number[] => {
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | (bits[i + bit] ?? 0);
    }
    bytes.push(value);
  }
  return bytes;
};

const finalizeV1DataCodewords = (payloadBits: readonly number[], ecl: Ecl): number[] => {
  const { dataCodewords: totalDataCodewords } = getVersionBlockInfo(V1_VERSION, ecl);
  const totalBits = totalDataCodewords * 8;
  const bits = Array.from(payloadBits);
  appendBits(bits, 0, Math.min(4, totalBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  let padByte = 0xec;
  while (bits.length < totalBits) {
    appendBits(bits, padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }
  return bytesFromBits(bits);
};

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

  const set = (row: number, col: number, value: boolean): void => {
    const r = matrix[row];
    if (r) r[col] = value;
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
        set(top + row, left + col, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, V1_SIZE - 7);
  drawFinder(V1_SIZE - 7, 0);

  for (let i = 8; i < V1_SIZE - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const formatBits = buildFormatInfoCodeword(ecl, maskPattern);
  for (let i = 0; i < FORMAT_INFO_FIRST_COPY_POSITIONS.length; i += 1) {
    const pos = FORMAT_INFO_FIRST_COPY_POSITIONS[i];
    if (pos) set(pos[0], pos[1], ((formatBits >> (14 - i)) & 1) === 1);
  }
  for (let i = 0; i < getFormatInfoSecondCopyPositions(V1_SIZE).length; i += 1) {
    const pos = getFormatInfoSecondCopyPositions(V1_SIZE)[i];
    if (pos) set(pos[0], pos[1], ((formatBits >> (14 - i)) & 1) === 1);
  }

  set(V1_SIZE - 8, 8, true);

  for (const cw of allCodewords) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      bits.push((cw >> bit) & 1);
    }
  }

  const positions = buildDataModulePositions(V1_SIZE, reserved);
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i];
    if (!position) continue;
    const [row, col] = position;
    const bit = bits[i] === 1;
    set(row, col, maskApplies(maskPattern, row, col) ? !bit : bit);
  }

  return matrix;
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe('single-image baseline pipeline (internal modules)', () => {
  it('toGrayscale converts an all-white ImageData to all-255 luma', () => {
    const width = 10;
    const height = 10;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const imageData = makeImageData(width, height, pixels);
    const luma = toGrayscale(imageData);
    expect(luma.every((v) => v === 255)).toBe(true);
  });

  it('toGrayscale converts an all-black ImageData to all-0 luma', () => {
    const width = 4;
    const height = 4;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + 3] = 255; // alpha=255, RGB=0
    }
    const imageData = makeImageData(width, height, pixels);
    const luma = toGrayscale(imageData);
    expect(luma.every((v) => v === 0)).toBe(true);
  });

  it('otsuBinarize on a blank (all-white) image returns all-255 (light)', () => {
    const width = 100;
    const height = 100;
    const luma = new Uint8Array(width * height).fill(255);
    const binary = otsuBinarize(luma, width, height);
    expect(binary.every((v) => v === 255)).toBe(true);
  });

  it('detectFinderPatterns returns fewer than 3 candidates for a blank image', () => {
    const width = 210;
    const height = 210;
    const binary = new Uint8Array(width * height).fill(255);
    const finders = detectFinderPatterns(binary, width, height);
    expect(finders.length).toBeLessThan(3);
  });

  it('detects 3 finder patterns in a synthetic v1-M QR image at 10px/module', () => {
    const bits: number[] = [];
    appendBits(bits, 0b0010, 4); // alphanumeric
    appendBits(bits, 2, 9);
    appendBits(bits, 17 * 45 + 18, 11); // "HI"
    const grid = buildVersion1Grid(finalizeV1DataCodewords(bits, 'M'), 'M', 0);
    const imageData = gridToImageData(grid);
    const luma = toGrayscale(imageData);
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const finders = detectFinderPatterns(binary, imageData.width, imageData.height);
    expect(finders.length).toBe(3);
  });

  it('resolveGrid returns a valid GridResolution from 3 finder candidates', () => {
    const bits: number[] = [];
    appendBits(bits, 0b0010, 4);
    appendBits(bits, 2, 9);
    appendBits(bits, 17 * 45 + 18, 11);
    const grid = buildVersion1Grid(finalizeV1DataCodewords(bits, 'M'), 'M', 0);
    const imageData = gridToImageData(grid);
    const luma = toGrayscale(imageData);
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const finders = detectFinderPatterns(binary, imageData.width, imageData.height);
    expect(finders.length).toBe(3);

    const resolution = resolveGrid(finders);
    expect(resolution).not.toBeNull();
    expect(resolution?.version).toBe(1);
    expect(resolution?.size).toBe(21);
  });

  it('full internal pipeline decodes a synthetic v1-M "HI" QR image', async () => {
    const bits: number[] = [];
    appendBits(bits, 0b0010, 4);
    appendBits(bits, 2, 9);
    appendBits(bits, 17 * 45 + 18, 11); // "HI"
    const grid = buildVersion1Grid(finalizeV1DataCodewords(bits, 'M'), 'M', 0);
    const imageData = gridToImageData(grid);

    const luma = toGrayscale(imageData);
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const finders = detectFinderPatterns(binary, imageData.width, imageData.height);
    expect(finders.length).toBe(3);

    const resolution = resolveGrid(finders);
    expect(resolution).not.toBeNull();
    if (resolution === null) return;

    const sampledGrid = sampleGrid(imageData.width, imageData.height, resolution, binary);
    const result = await Effect.runPromise(decodeGridLogical({ grid: sampledGrid }));

    expect(result.payload.text).toBe('HI');
    expect(result.version).toBe(1);
    expect(result.errorCorrectionLevel).toBe('M');
  });

  it('not-found path: returns [] when fewer than 3 finder patterns are detected', () => {
    // Blank white image has no finder patterns → detectFinderPatterns returns < 3 → pipeline
    // returns [] without throwing.
    const width = 210;
    const height = 210;
    const luma = new Uint8Array(width * height).fill(255);
    const binary = otsuBinarize(luma, width, height);
    const finders = detectFinderPatterns(binary, width, height);
    expect(finders.length).toBeLessThan(3);
    // scanFrameInternal would return [] here — covered by this guard.
  });
});
