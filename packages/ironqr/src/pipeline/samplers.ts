import type { GridResolution } from './geometry.js';
import { type BinaryView, isDarkPixel } from './views.js';

/**
 * Supported logical-grid samplers.
 */
export type DecodeSampler = 'cross-vote' | 'dense-vote' | 'nearest';

const CROSS_STEP_RATIO = 0.12;
const CENTER_VOTE_WEIGHT = 3;
const CROSS_DARK_THRESHOLD = 4;
const DENSE_STEP_RATIO = 0.16;
const DENSE_SAMPLE_OFFSETS = [-1, 0, 1] as const;

/**
 * Samples a logical QR grid using the requested sampler.
 *
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @param geometry - Resolved QR geometry.
 * @param binary - Thresholded binary pixels.
 * @param sampler - Sampler strategy.
 * @returns A square boolean grid where `true` means a dark module.
 */
export const sampleGrid = (
  width: number,
  height: number,
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
  sampler: DecodeSampler = 'cross-vote',
): boolean[][] => {
  switch (sampler) {
    case 'nearest':
      return sampleNearest(width, height, geometry, binary);
    case 'dense-vote':
      return sampleDenseVote(width, height, geometry, binary);
    case 'cross-vote':
      return sampleCrossVote(width, height, geometry, binary);
    default:
      throw new RangeError(`Unknown decode sampler: ${sampler satisfies never}.`);
  }
};

/**
 * Center-weighted cross sampler.
 *
 * This is the default sampler because it keeps most probes inside the likely
 * ink footprint for rounded, dotted, and slightly misregistered modules.
 *
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @param geometry - Resolved QR geometry.
 * @param binary - Thresholded binary pixels.
 * @returns A sampled logical grid.
 */
export const sampleCrossVote = (
  width: number,
  height: number,
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
): boolean[][] => {
  const { size } = geometry;
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => {
      const center = geometry.samplePoint(row, col);
      const left = geometry.samplePoint(row, Math.max(0, col - 1));
      const right = geometry.samplePoint(row, Math.min(size - 1, col + 1));
      const up = geometry.samplePoint(Math.max(0, row - 1), col);
      const down = geometry.samplePoint(Math.min(size - 1, row + 1), col);
      const stepX = {
        x: (right.x - left.x) * CROSS_STEP_RATIO,
        y: (right.y - left.y) * CROSS_STEP_RATIO,
      };
      const stepY = {
        x: (down.x - up.x) * CROSS_STEP_RATIO,
        y: (down.y - up.y) * CROSS_STEP_RATIO,
      };

      let darkVotes = 0;
      if (isDark(binary, width, height, center.x, center.y)) darkVotes += CENTER_VOTE_WEIGHT;
      if (isDark(binary, width, height, center.x - stepX.x, center.y - stepX.y)) darkVotes += 1;
      if (isDark(binary, width, height, center.x + stepX.x, center.y + stepX.y)) darkVotes += 1;
      if (isDark(binary, width, height, center.x - stepY.x, center.y - stepY.y)) darkVotes += 1;
      if (isDark(binary, width, height, center.x + stepY.x, center.y + stepY.y)) darkVotes += 1;
      return darkVotes >= CROSS_DARK_THRESHOLD;
    }),
  );
};

/**
 * Dense 3×3 vote sampler.
 *
 * This is useful as a rescue path when one center probe is too fragile and the
 * module still has enough local support around its expected center.
 *
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @param geometry - Resolved QR geometry.
 * @param binary - Thresholded binary pixels.
 * @returns A sampled logical grid.
 */
export const sampleDenseVote = (
  width: number,
  height: number,
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
): boolean[][] => {
  const { size } = geometry;
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => {
      const center = geometry.samplePoint(row, col);
      const left = geometry.samplePoint(row, Math.max(0, col - 1));
      const right = geometry.samplePoint(row, Math.min(size - 1, col + 1));
      const up = geometry.samplePoint(Math.max(0, row - 1), col);
      const down = geometry.samplePoint(Math.min(size - 1, row + 1), col);
      const stepX = {
        x: (right.x - left.x) * DENSE_STEP_RATIO,
        y: (right.y - left.y) * DENSE_STEP_RATIO,
      };
      const stepY = {
        x: (down.x - up.x) * DENSE_STEP_RATIO,
        y: (down.y - up.y) * DENSE_STEP_RATIO,
      };
      let dark = 0;
      let total = 0;
      for (const xMul of DENSE_SAMPLE_OFFSETS) {
        for (const yMul of DENSE_SAMPLE_OFFSETS) {
          if (
            isDark(
              binary,
              width,
              height,
              center.x + stepX.x * xMul + stepY.x * yMul,
              center.y + stepX.y * xMul + stepY.y * yMul,
            )
          ) {
            dark += 1;
          }
          total += 1;
        }
      }
      return dark >= Math.ceil(total / 2);
    }),
  );
};

/**
 * Single-sample nearest-neighbor sampler.
 *
 * This is useful as a sharp rescue path when vote samplers blur tiny or hard-
 * thresholded modules.
 *
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @param geometry - Resolved QR geometry.
 * @param binary - Thresholded binary pixels.
 * @returns A sampled logical grid.
 */
export const sampleNearest = (
  width: number,
  height: number,
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
): boolean[][] => {
  const { size } = geometry;
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => {
      const point = geometry.samplePoint(row, col);
      return isDark(binary, width, height, point.x, point.y);
    }),
  );
};

const isDark = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean => {
  const px = Math.max(0, Math.min(width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(height - 1, Math.round(y)));
  const index = py * width + px;
  if (isBinaryViewInput(binary)) return isDarkPixel(binary, index);
  return (binary[index] ?? 255) === 0;
};

const isBinaryViewInput = (value: Uint8Array | BinaryView): value is BinaryView =>
  !(value instanceof Uint8Array);
