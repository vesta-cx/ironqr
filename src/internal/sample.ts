import type { GridResolution } from './geometry.js';

/**
 * Samples the QR module grid from a binarized image using the resolved geometry.
 *
 * For each module cell, reads the binary pixel value at the computed center
 * coordinate and returns `true` for a dark module, `false` for a light module.
 *
 * @param imageData - Source image (used for bounds clamping).
 * @param resolution - Grid geometry resolved from finder patterns.
 * @param binary - Binarized pixel array (0 = dark, 255 = light).
 * @returns A 2D boolean grid where `true` = dark module.
 */
export function sampleGrid(
  imageData: ImageData,
  resolution: GridResolution,
  binary: Uint8Array,
): boolean[][] {
  const { width, height } = imageData;
  const { size, samplePoint } = resolution;

  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => {
      const { x, y } = samplePoint(row, col);
      const px = Math.max(0, Math.min(width - 1, Math.round(x)));
      const py = Math.max(0, Math.min(height - 1, Math.round(y)));
      return (binary[py * width + px] ?? 255) === 0;
    }),
  );
}
