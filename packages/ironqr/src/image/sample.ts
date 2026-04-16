import type { GridResolution } from './geometry.js';

/**
 * Samples the QR module grid from a binarized image using the resolved geometry.
 *
 * Each module cell is sampled at 5 sub-pixel positions — the center plus four
 * inset corners at ½-module radius — and assigned by majority vote. Single-
 * point center sampling missed modules whose dark area was offset (stylized
 * QRs, mild geometry drift), and a 3×3 grid pulled in too much neighbour ink
 * when modules were small or stretched. The 5-point pattern keeps voting
 * within the cell while staying robust to sub-pixel shifts.
 *
 * @param width - Image width in pixels (used for bounds clamping).
 * @param height - Image height in pixels (used for bounds clamping).
 * @param resolution - Grid geometry resolved from finder patterns.
 * @param binary - Binarized pixel array (0 = dark, 255 = light).
 * @returns A 2D boolean grid where `true` = dark module.
 */
export const sampleGrid = (
  width: number,
  height: number,
  resolution: GridResolution,
  binary: Uint8Array,
): boolean[][] => {
  const { size, samplePoint } = resolution;

  // Estimate per-cell module size in pixels by walking one module right and
  // one module down from a near-center reference point. Held constant for
  // efficiency — the module size barely varies across a QR symbol under
  // affine / mild projective sampling.
  const ref = samplePoint(Math.floor(size / 2), Math.floor(size / 2));
  const refRight = samplePoint(Math.floor(size / 2), Math.floor(size / 2) + 1);
  const refDown = samplePoint(Math.floor(size / 2) + 1, Math.floor(size / 2));
  const moduleX = Math.max(1, Math.hypot(refRight.x - ref.x, refRight.y - ref.y));
  const moduleY = Math.max(1, Math.hypot(refDown.x - ref.x, refDown.y - ref.y));
  const insetX = moduleX * 0.25;
  const insetY = moduleY * 0.25;

  const isDarkAt = (x: number, y: number): boolean => {
    const px = Math.max(0, Math.min(width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(height - 1, Math.round(y)));
    return (binary[py * width + px] ?? 255) === 0;
  };

  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => {
      const { x, y } = samplePoint(row, col);
      let darkVotes = 0;
      // Center counts twice so it tie-breaks ties without dominating.
      if (isDarkAt(x, y)) darkVotes += 2;
      if (isDarkAt(x - insetX, y - insetY)) darkVotes += 1;
      if (isDarkAt(x + insetX, y - insetY)) darkVotes += 1;
      if (isDarkAt(x - insetX, y + insetY)) darkVotes += 1;
      if (isDarkAt(x + insetX, y + insetY)) darkVotes += 1;
      // Total possible votes = 6; threshold at majority (>3).
      return darkVotes > 3;
    }),
  );
};
