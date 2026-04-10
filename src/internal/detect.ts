/**
 * A detected finder pattern candidate with estimated center and module size.
 */
export interface FinderCandidate {
  readonly cx: number;
  readonly cy: number;
  readonly moduleSize: number;
}

/**
 * Checks whether five run lengths satisfy the QR finder 1:1:3:1:1 ratio.
 *
 * @param runs - Five consecutive run lengths.
 * @returns True when the runs match the expected ratio within 50% tolerance.
 */
function isFinderRatio(runs: readonly [number, number, number, number, number]): boolean {
  const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
  if (total < 7) return false;

  const module = total / 7;
  const maxVariance = module * 0.5;

  return (
    Math.abs(runs[0] - module) < maxVariance &&
    Math.abs(runs[1] - module) < maxVariance &&
    Math.abs(runs[2] - 3 * module) < 3 * maxVariance &&
    Math.abs(runs[3] - module) < maxVariance &&
    Math.abs(runs[4] - module) < maxVariance
  );
}

/**
 * Result of a successful vertical cross-check of a finder candidate.
 */
interface VerticalCheckResult {
  readonly moduleSize: number;
  /** Refined y-center of the pattern. */
  readonly cy: number;
}

/**
 * Verifies a horizontal finder candidate by cross-checking vertically.
 *
 * Scans upward and downward from the given pixel to confirm the 1:1:3:1:1
 * pattern also holds in the column direction. Also computes the true vertical
 * center of the finder pattern from the run extents.
 *
 * @param binary - Binarized pixel array.
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param cx - Candidate center x coordinate.
 * @param cy - Candidate center y coordinate (scan row).
 * @param hModuleSize - Horizontal module size estimate.
 * @returns Refined center and module size, or null if not a finder.
 */
function crossCheckVertical(
  binary: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  hModuleSize: number,
): VerticalCheckResult | null {
  const col = Math.round(cx);
  const row = Math.round(cy);

  // Scan up from center — center pixel must be dark; bail if rounding landed on light.
  let count0 = 0;
  let r = row;
  const centerColor = binary[r * width + col] ?? 255;
  if (centerColor !== 0) return null;
  while (r >= 0 && (binary[r * width + col] ?? 255) === centerColor) {
    count0 += 1;
    r -= 1;
  }
  if (r < 0) return null;

  let count1 = 0;
  while (r >= 0 && (binary[r * width + col] ?? 255) !== centerColor) {
    count1 += 1;
    r -= 1;
  }
  if (r < 0) return null;

  let count2 = 0;
  while (r >= 0 && (binary[r * width + col] ?? 255) === centerColor) {
    count2 += 1;
    r -= 1;
  }

  // Scan down from center
  let count3 = 0;
  r = row + 1;
  while (r < height && (binary[r * width + col] ?? 255) === centerColor) {
    count3 += 1;
    r += 1;
  }
  if (r >= height) return null;

  let count4 = 0;
  while (r < height && (binary[r * width + col] ?? 255) !== centerColor) {
    count4 += 1;
    r += 1;
  }
  if (r >= height) return null;

  const runs: [number, number, number, number, number] = [
    count2,
    count1,
    count0 + count3,
    count4,
    0,
  ];

  // Scan past the outer dark band to get the last run
  let count5 = 0;
  while (r < height && (binary[r * width + col] ?? 255) === centerColor) {
    count5 += 1;
    r += 1;
  }
  runs[4] = count5;

  if (!isFinderRatio(runs)) return null;

  const vModuleSize = (runs[0] + runs[1] + runs[2] + runs[3] + runs[4]) / 7;
  if (Math.abs(vModuleSize - hModuleSize) > hModuleSize) return null;

  // Compute the true vertical center from the extent of the full 7-module span.
  // The dark center (3 modules) runs from (row - count0 + 1) to (row + count3).
  // The outer span top = top of run2, bottom = bottom of run4.
  const topOfSpan = row - count0 + 1 - count1 - count2;
  const bottomOfSpan = row + count3 + count4 + count5;
  const refinedCy = (topOfSpan + bottomOfSpan) / 2;

  return { moduleSize: vModuleSize, cy: refinedCy };
}

/**
 * Scans a binarized image for QR finder pattern candidates.
 *
 * Walks each row looking for 1:1:3:1:1 dark/light run ratios, then cross-checks
 * each candidate vertically. Returns up to 3 best non-overlapping candidates.
 *
 * @param binary - Binarized pixel array (0 = dark, 255 = light).
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @returns Up to 3 finder pattern candidates sorted by confidence.
 */
export function detectFinderPatterns(
  binary: Uint8Array,
  width: number,
  height: number,
): FinderCandidate[] {
  const candidates: FinderCandidate[] = [];

  for (let row = 0; row < height; row += 1) {
    const runs: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let runPhase = 0; // 0..4
    let currentColor = 255; // start assuming light
    let col = 0;

    // Skip leading light pixels
    while (col < width && (binary[row * width + col] ?? 255) === 255) {
      col += 1;
    }

    if (col >= width) continue;
    currentColor = 0; // now on dark
    let runStart = col;

    for (; col <= width; col += 1) {
      const pixel = col < width ? (binary[row * width + col] ?? 255) : 255 ^ currentColor;
      if (pixel === currentColor) continue;

      runs[runPhase] = col - runStart;

      if (runPhase === 4) {
        if (isFinderRatio(runs)) {
          const moduleSize = (runs[0] + runs[1] + runs[2] + runs[3] + runs[4]) / 7;
          const cx = col - runs[4] - runs[3] - runs[2] / 2 - 0.5;
          const vCheck = crossCheckVertical(binary, width, height, cx, row, moduleSize);

          if (vCheck !== null) {
            const finalModuleSize = (moduleSize + vCheck.moduleSize) / 2;
            const refinedCy = vCheck.cy;

            // Deduplicate: skip if too close to an existing candidate
            const duplicate = candidates.some(
              (c) =>
                Math.abs(c.cx - cx) < finalModuleSize * 5 &&
                Math.abs(c.cy - refinedCy) < finalModuleSize * 5,
            );

            if (!duplicate) {
              candidates.push({ cx, cy: refinedCy, moduleSize: finalModuleSize });
            }
          }
        }

        // Slide window: drop first run, shift remaining
        runs[0] = runs[2];
        runs[1] = runs[3];
        runs[2] = runs[4];
        runs[3] = 0;
        runs[4] = 0;
        runPhase = 3;
      } else {
        runPhase += 1;
      }

      currentColor = pixel;
      runStart = col;
    }
  }

  // Return up to 3 non-overlapping candidates with largest module size (most confident)
  candidates.sort((a, b) => b.moduleSize - a.moduleSize);

  const result: FinderCandidate[] = [];
  for (const candidate of candidates) {
    const overlaps = result.some(
      (existing) =>
        Math.abs(existing.cx - candidate.cx) < candidate.moduleSize * 7 &&
        Math.abs(existing.cy - candidate.cy) < candidate.moduleSize * 7,
    );
    if (!overlaps) {
      result.push(candidate);
    }
    if (result.length === 3) break;
  }

  return result;
}
