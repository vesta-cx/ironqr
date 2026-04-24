/**
 * Shared test helpers for constructing synthetic QR image fixtures.
 *
 * Provides a v1 QR grid builder and a family of pixel-buffer renderers
 * (plain, inverted, low-contrast, color) for use across unit test files.
 */
import type { ImageDataLike } from '../src/contracts/scan.js';
import { applyHomography, fitHomography } from '../src/pipeline/geometry.js';
import {
  buildDataModulePositions,
  buildFormatInfoCodeword,
  buildFunctionModuleMask,
  FORMAT_INFO_FIRST_COPY_POSITIONS,
  getFormatInfoSecondCopyPositions,
  getVersionBlockInfo,
  maskApplies,
  rsEncode,
} from '../src/qr/index.js';

export type Ecl = 'L' | 'M' | 'Q' | 'H';

const RGBA_CHANNELS = 4;
const WHITE_PIXEL = 255;
const V1_SIZE = 21;
const V1_VERSION = 1;
const QR_TERMINATOR_BITS = 4;
const QR_PAD_BYTE_A = 0xec;
const QR_PAD_BYTE_B = 0x11;
const MAX_KEYSTONE_RATIO = 0.4;

/**
 * Minimal ImageData stand-in for Bun test environments where the browser API
 * is absent. Shape matches what the production scan pipeline reads.
 */
export const makeImageData = (
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
): ImageDataLike => {
  return { width, height, data: pixels, colorSpace: 'srgb' };
};

export const PIXELS_PER_MODULE = 10;

/**
 * Renders a boolean QR grid to RGBA pixels at {@link PIXELS_PER_MODULE} px/module.
 * Dark modules → black (0,0,0,255); light modules → white (255,255,255,255).
 */
export const gridToImageData = (grid: boolean[][]): ImageDataLike => {
  return renderGrid(grid, 0, WHITE_PIXEL);
};

/**
 * Inverted rendering: light modules on a dark background.
 * Dark modules → white; light modules → black.
 */
export const gridToImageDataInverted = (grid: boolean[][]): ImageDataLike => {
  return renderGrid(grid, WHITE_PIXEL, 0);
};

/**
 * Low-contrast rendering: modules are dark gray / light gray instead of black / white.
 */
export const gridToImageDataLowContrast = (
  grid: boolean[][],
  darkValue = 60,
  lightValue = 195,
): ImageDataLike => {
  return renderGrid(grid, darkValue, lightValue);
};

/**
 * Color rendering: dark modules use an arbitrary RGB triple instead of black.
 */
export const gridToImageDataColor = (
  grid: boolean[][],
  darkRgb: readonly [number, number, number] = [0, 0, 139],
  lightRgb: readonly [number, number, number] = [WHITE_PIXEL, WHITE_PIXEL, WHITE_PIXEL],
): ImageDataLike => {
  return renderGridColor(grid, darkRgb, lightRgb);
};

/**
 * Dot rendering: each dark module becomes a centered filled circle with light
 * gaps around it. Useful for stylized QR regressions where modules are not
 * edge-connected and flood-fill on the finder ring would fail by design.
 */
export const gridToImageDataDots = (
  grid: boolean[][],
  darkRgb: readonly [number, number, number] = [0, 0, 0],
  lightRgb: readonly [number, number, number] = [WHITE_PIXEL, WHITE_PIXEL, WHITE_PIXEL],
  radiusRatio = 0.3,
): ImageDataLike => {
  const modules = grid.length;
  const imageSize = modules * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(imageSize * imageSize * RGBA_CHANNELS);
  fillBackground(pixels, lightRgb);

  const radius = PIXELS_PER_MODULE * radiusRatio;
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!(grid[row]?.[col] ?? false)) continue;
      drawFilledCircle(
        pixels,
        imageSize,
        col * PIXELS_PER_MODULE + PIXELS_PER_MODULE / 2,
        row * PIXELS_PER_MODULE + PIXELS_PER_MODULE / 2,
        radius,
        darkRgb,
      );
    }
  }

  return makeImageData(imageSize, imageSize, pixels);
};

const renderGrid = (grid: boolean[][], darkValue: number, lightValue: number): ImageDataLike => {
  const modules = grid.length;
  const imageSize = modules * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(imageSize * imageSize * RGBA_CHANNELS);

  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      const value = grid[row]?.[col] ? darkValue : lightValue;
      fillModuleCell(pixels, imageSize, row, col, value, value, value);
    }
  }

  return makeImageData(imageSize, imageSize, pixels);
};

const renderGridColor = (
  grid: boolean[][],
  darkRgb: readonly [number, number, number],
  lightRgb: readonly [number, number, number],
): ImageDataLike => {
  const modules = grid.length;
  const imageSize = modules * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(imageSize * imageSize * RGBA_CHANNELS);

  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      const [red, green, blue] = grid[row]?.[col] ? darkRgb : lightRgb;
      fillModuleCell(pixels, imageSize, row, col, red, green, blue);
    }
  }

  return makeImageData(imageSize, imageSize, pixels);
};

const fillBackground = (
  pixels: Uint8ClampedArray,
  rgb: readonly [number, number, number],
): void => {
  for (let i = 0; i < pixels.length; i += RGBA_CHANNELS) {
    pixels[i] = rgb[0];
    pixels[i + 1] = rgb[1];
    pixels[i + 2] = rgb[2];
    pixels[i + 3] = WHITE_PIXEL;
  }
};

const drawFilledCircle = (
  pixels: Uint8ClampedArray,
  imageSize: number,
  centerX: number,
  centerY: number,
  radius: number,
  rgb: readonly [number, number, number],
): void => {
  const minY = Math.max(0, Math.floor(centerY - radius - 1));
  const maxY = Math.min(imageSize, Math.ceil(centerY + radius + 1));
  const minX = Math.max(0, Math.floor(centerX - radius - 1));
  const maxX = Math.min(imageSize, Math.ceil(centerX + radius + 1));

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const dx = px + 0.5 - centerX;
      const dy = py + 0.5 - centerY;
      if (dx * dx + dy * dy > radius * radius) continue;
      const offset = (py * imageSize + px) * RGBA_CHANNELS;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = WHITE_PIXEL;
    }
  }
};

const fillModuleCell = (
  pixels: Uint8ClampedArray,
  imageSize: number,
  row: number,
  col: number,
  red: number,
  green: number,
  blue: number,
): void => {
  for (let pixelRow = 0; pixelRow < PIXELS_PER_MODULE; pixelRow += 1) {
    for (let pixelCol = 0; pixelCol < PIXELS_PER_MODULE; pixelCol += 1) {
      const pixelIndex =
        ((row * PIXELS_PER_MODULE + pixelRow) * imageSize + col * PIXELS_PER_MODULE + pixelCol) *
        RGBA_CHANNELS;
      pixels[pixelIndex] = red;
      pixels[pixelIndex + 1] = green;
      pixels[pixelIndex + 2] = blue;
      pixels[pixelIndex + 3] = WHITE_PIXEL;
    }
  }
};

export const appendBits = (bits: number[], value: number, length: number): void => {
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

export const finalizeV1DataCodewords = (payloadBits: readonly number[], ecl: Ecl): number[] => {
  const { dataCodewords: totalDataCodewords } = getVersionBlockInfo(V1_VERSION, ecl);
  const totalBits = totalDataCodewords * 8;
  if (payloadBits.length > totalBits) {
    throw new Error(
      `finalizeV1DataCodewords: payload uses ${payloadBits.length} bits, capacity is ${totalBits}.`,
    );
  }

  const bits = Array.from(payloadBits);
  appendBits(bits, 0, Math.min(QR_TERMINATOR_BITS, totalBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  let padByte = QR_PAD_BYTE_A;
  while (bits.length < totalBits) {
    appendBits(bits, padByte, 8);
    padByte = padByte === QR_PAD_BYTE_A ? QR_PAD_BYTE_B : QR_PAD_BYTE_A;
  }

  return bytesFromBits(bits);
};

export const buildVersion1Grid = (
  dataCodewords: readonly number[],
  ecl: Ecl,
  maskPattern: number,
): boolean[][] => {
  const blockInfo = getVersionBlockInfo(V1_VERSION, ecl);
  if (dataCodewords.length !== blockInfo.dataCodewords) {
    throw new Error(
      `buildVersion1Grid: expected ${blockInfo.dataCodewords} data codewords, got ${dataCodewords.length}.`,
    );
  }

  const matrix = Array.from({ length: V1_SIZE }, () =>
    Array.from({ length: V1_SIZE }, () => false),
  );
  const reserved = buildFunctionModuleMask(V1_SIZE, V1_VERSION);
  const allCodewords = [
    ...dataCodewords,
    ...Array.from(rsEncode(dataCodewords, blockInfo.ecCodewordsPerBlock)),
  ];
  const bits: number[] = [];
  const secondCopyPositions = getFormatInfoSecondCopyPositions(V1_SIZE);

  const set = (row: number, col: number, value: boolean): void => {
    const currentRow = matrix[row];
    if (!currentRow) throw new Error(`buildVersion1Grid: missing row ${row}.`);
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
        set(top + row, left + col, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, V1_SIZE - 7);
  drawFinder(V1_SIZE - 7, 0);

  for (let index = 8; index < V1_SIZE - 8; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }

  const formatBits = buildFormatInfoCodeword(ecl, maskPattern);
  for (let index = 0; index < FORMAT_INFO_FIRST_COPY_POSITIONS.length; index += 1) {
    const position = FORMAT_INFO_FIRST_COPY_POSITIONS[index];
    if (!position) continue;
    set(position[0], position[1], ((formatBits >> (14 - index)) & 1) === 1);
  }
  for (let index = 0; index < secondCopyPositions.length; index += 1) {
    const position = secondCopyPositions[index];
    if (!position) continue;
    set(position[0], position[1], ((formatBits >> (14 - index)) & 1) === 1);
  }

  // Mandatory dark module per ISO/IEC 18004.
  set(V1_SIZE - 8, 8, true);

  for (const codeword of allCodewords) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      bits.push((codeword >> bit) & 1);
    }
  }

  const positions = buildDataModulePositions(V1_SIZE, reserved);
  if (positions.length !== bits.length) {
    throw new Error(`buildVersion1Grid: ${positions.length} data modules for ${bits.length} bits.`);
  }

  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (!position) continue;
    const [row, col] = position;
    const bit = bits[index] === 1;
    set(row, col, maskApplies(maskPattern, row, col) ? !bit : bit);
  }

  return matrix;
};

/**
 * Applies a true projective warp to a rendered QR image, simulating viewing
 * a planar QR through a camera at an angle.
 *
 * Maps the source image's four corners to a trapezoidal output where the
 * bottom edge is compressed by `keystoneRatio` and the bottom is also pulled
 * upward, giving a real homography-representable perspective.
 */
export const gridToImageDataPerspective = (
  grid: boolean[][],
  keystoneRatio = 0.2,
): ImageDataLike => {
  return imageDataPerspective(gridToImageData(grid), keystoneRatio);
};

/** Applies the same keystone warp helper to an already-rendered pixel buffer. */
export const imageDataPerspective = (source: ImageDataLike, keystoneRatio = 0.2): ImageDataLike => {
  if (!Number.isFinite(keystoneRatio) || keystoneRatio < 0 || keystoneRatio > MAX_KEYSTONE_RATIO) {
    throw new RangeError(
      `imageDataPerspective: keystoneRatio must be between 0 and ${MAX_KEYSTONE_RATIO}, got ${keystoneRatio}.`,
    );
  }

  const width = source.width;
  const height = source.height;
  const maxX = width - 1;
  const maxY = height - 1;
  const inset = keystoneRatio * width;
  const liftY = keystoneRatio * height * 0.5;
  const destinationCorners = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: maxX, y: 0 },
    bottomLeft: { x: inset, y: maxY - liftY },
    bottomRight: { x: maxX - inset, y: maxY - liftY },
  };
  const sourceCorners = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: maxX, y: 0 },
    bottomLeft: { x: 0, y: maxY },
    bottomRight: { x: maxX, y: maxY },
  };

  const inverseHomography = fitHomography([
    [destinationCorners.topLeft, sourceCorners.topLeft],
    [destinationCorners.topRight, sourceCorners.topRight],
    [destinationCorners.bottomLeft, sourceCorners.bottomLeft],
    [destinationCorners.bottomRight, sourceCorners.bottomRight],
  ]);
  if (inverseHomography === null) {
    throw new Error('imageDataPerspective: degenerate projective warp.');
  }

  const out = new Uint8ClampedArray(width * height * RGBA_CHANNELS);
  out.fill(WHITE_PIXEL);

  const readChannel = (x: number, y: number, channel: number): number => {
    const clampedX = Math.max(0, Math.min(width - 1, x));
    const clampedY = Math.max(0, Math.min(height - 1, y));
    return source.data[(clampedY * width + clampedX) * RGBA_CHANNELS + channel] ?? WHITE_PIXEL;
  };

  const sampleChannel = (sourceX: number, sourceY: number, channel: number): number => {
    const x0 = Math.floor(sourceX);
    const y0 = Math.floor(sourceY);
    const fx = sourceX - x0;
    const fy = sourceY - y0;
    return (
      readChannel(x0, y0, channel) * (1 - fx) * (1 - fy) +
      readChannel(x0 + 1, y0, channel) * fx * (1 - fy) +
      readChannel(x0, y0 + 1, channel) * (1 - fx) * fy +
      readChannel(x0 + 1, y0 + 1, channel) * fx * fy
    );
  };

  for (let outputY = 0; outputY < height; outputY += 1) {
    for (let outputX = 0; outputX < width; outputX += 1) {
      const sourcePoint = applyHomography(inverseHomography, outputX, outputY);
      if (
        sourcePoint.x < 0 ||
        sourcePoint.x >= width ||
        sourcePoint.y < 0 ||
        sourcePoint.y >= height
      ) {
        continue;
      }

      const base = (outputY * width + outputX) * RGBA_CHANNELS;
      out[base] = sampleChannel(sourcePoint.x, sourcePoint.y, 0);
      out[base + 1] = sampleChannel(sourcePoint.x, sourcePoint.y, 1);
      out[base + 2] = sampleChannel(sourcePoint.x, sourcePoint.y, 2);
      out[base + 3] = WHITE_PIXEL;
    }
  }

  return makeImageData(width, height, out);
};

/** Convenience: build a v1 \"HI\" alphanumeric grid at mask 0, ECL M. */
export const buildHiGrid = (): boolean[][] => {
  const bits: number[] = [];
  appendBits(bits, 0b0010, 4);
  appendBits(bits, 2, 9);
  appendBits(bits, 17 * 45 + 18, 11);
  return buildVersion1Grid(finalizeV1DataCodewords(bits, 'M'), 'M', 0);
};
