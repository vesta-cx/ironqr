/**
 * Fitness-driven homography refinement.
 *
 * After geometry produces an initial homography from finder centers, we hill-
 * climb on a fitness function defined by the QR's own structural features:
 * the timing patterns (alternating dark/light), the three finder patterns
 * (their fixed dark/light pixel signature), and \u2014 when the QR has them \u2014
 * the alignment patterns. The QR itself tells us when the grid is right.
 *
 * Inspired by quirc's `jiggle_perspective` (ISC, Daniel Beer). We perturb
 * each of the 8 free homography parameters by a small fraction, accept any
 * change that improves the score, and halve the step every pass. After a
 * handful of passes the homography settles into a local fitness maximum.
 *
 * This replaces what would otherwise be N independent ad-hoc fixes (multi-
 * sample voting, alignment-pattern correspondence refit, perspective fudge
 * factors) with a single principled mechanism: the decoder doesn't need to
 * be the only oracle anymore \u2014 the QR's structural redundancy is.
 */

import type { Bounds, CornerSet, Point } from '../contracts/geometry.js';
import {
  ALIGNMENT_PATTERN_CENTERS,
  buildVersionInfoCodeword,
  getVersionInfoFirstCopyPositions,
  getVersionInfoSecondCopyPositions,
} from '../qr/index.js';
import { applyHomography, type GridResolution, type Homography } from './geometry.js';

/**
 * Refines `resolution` by hill-climbing on the QR's structural fitness.
 * Returns the original resolution unchanged when no improvement is found.
 */
export const refineGridFitness = (
  resolution: GridResolution,
  binary: Uint8Array,
  width: number,
  height: number,
): GridResolution => {
  const { size } = resolution;
  if (size < 21) return resolution;

  const isDark = (x: number, y: number): boolean => {
    const px = Math.max(0, Math.min(width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(height - 1, Math.round(y)));
    return (binary[py * width + px] ?? 255) === 0;
  };

  const samplePoints = collectSamplePoints(size, resolution.version);

  let current: Homography = resolution.homography;
  let bestScore = scoreHomography(current, samplePoints, isDark);
  // No improvement possible (or no coverage) — don't pay the jiggle cost.
  if (bestScore <= 0) return resolution;

  // Start with a broader search, mirroring quirc's perspective jiggle. A QR
  // photographed at a real angle can need a couple of percent of projective
  // correction before the timing lines land on the right cells.
  const initialStep: number[] = current.map((v) => Math.max(Math.abs(v) * 0.02, 1e-7));
  const step = initialStep.slice();

  for (let pass = 0; pass < 8; pass += 1) {
    let improved = false;
    for (let i = 0; i < 8; i += 1) {
      // Try +step and -step on parameter i.
      for (const sign of [1, -1] as const) {
        const trial = perturbHomography(current, i, sign * (step[i] ?? 0));
        const trialScore = scoreHomography(trial, samplePoints, isDark);
        if (trialScore > bestScore) {
          current = trial;
          bestScore = trialScore;
          improved = true;
        }
      }
    }
    // Halve the step on each pass; on a no-improvement pass, halve faster
    // to explore finer adjustments before giving up.
    const factor = improved ? 0.5 : 0.25;
    for (let i = 0; i < 8; i += 1) step[i] = (step[i] ?? 0) * factor;
  }

  if (current === resolution.homography) return resolution;

  return rebuildGridResolution(resolution, current);
};

// ─── Sample points ────────────────────────────────────────────────────────

/**
 * A single sample location and the value (dark = true, light = false) the
 * QR specification requires to appear there. The fitness function rewards
 * matches and penalises mismatches.
 */
interface SamplePoint {
  readonly moduleRow: number;
  readonly moduleCol: number;
  readonly expectDark: boolean;
}

const collectSamplePoints = (size: number, version: number): readonly SamplePoint[] => {
  const points: SamplePoint[] = [];

  // ── Timing patterns ──
  // Row 6 alternates dark/light from col 7 to col size-8 inclusive.
  // Col 6 alternates dark/light from row 7 to row size-8 inclusive.
  // Col 6 row 6 is part of the finder, skipped. Even indices are dark.
  for (let i = 7; i <= size - 8; i += 1) {
    points.push({ moduleRow: 6, moduleCol: i, expectDark: i % 2 === 0 });
    points.push({ moduleRow: i, moduleCol: 6, expectDark: i % 2 === 0 });
  }

  // ── Finder pattern signatures ──
  // Each finder is a 7×7 square: outer ring of dark, inner ring of light,
  // 3×3 dark center. Sample a representative subset rather than all 49.
  pushFinderSignature(points, 0, 0);
  pushFinderSignature(points, 0, size - 7);
  pushFinderSignature(points, size - 7, 0);

  // ── Alignment patterns (v≥2) ──
  // Each alignment pattern is a 5×5 square: outer dark ring, inner light
  // ring, 1 dark center module. Sample a representative subset.
  if (version >= 2) {
    const centers = ALIGNMENT_PATTERN_CENTERS[version - 1];
    if (centers) {
      for (const r of centers) {
        for (const c of centers) {
          // Skip the three positions overlapping the finders.
          if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6))
            continue;
          pushAlignmentSignature(points, r, c);
        }
      }
    }
  }

  // ── Version information (v≥7) ──
  // The 18-bit BCH-protected version block appears twice near the top-right
  // and bottom-left finders. When decode later complains that version info is
  // unreadable, the homography is often close but not quite landing on these
  // cells. Sampling them directly gives the fitter a spec-defined target.
  if (version >= 7) {
    const codeword = buildVersionInfoCodeword(version);
    pushBitSamples(points, getVersionInfoFirstCopyPositions(size), codeword);
    pushBitSamples(points, getVersionInfoSecondCopyPositions(size), codeword);
  }

  return points;
};

const pushFinderSignature = (points: SamplePoint[], topRow: number, topCol: number): void => {
  // Center 3×3 dark.
  for (let dr = 2; dr <= 4; dr += 1) {
    for (let dc = 2; dc <= 4; dc += 1) {
      points.push({ moduleRow: topRow + dr, moduleCol: topCol + dc, expectDark: true });
    }
  }
  // Outer ring corners (dark).
  points.push({ moduleRow: topRow, moduleCol: topCol, expectDark: true });
  points.push({ moduleRow: topRow, moduleCol: topCol + 6, expectDark: true });
  points.push({ moduleRow: topRow + 6, moduleCol: topCol, expectDark: true });
  points.push({ moduleRow: topRow + 6, moduleCol: topCol + 6, expectDark: true });
  // Inner light ring midpoints.
  points.push({ moduleRow: topRow + 1, moduleCol: topCol + 3, expectDark: false });
  points.push({ moduleRow: topRow + 5, moduleCol: topCol + 3, expectDark: false });
  points.push({ moduleRow: topRow + 3, moduleCol: topCol + 1, expectDark: false });
  points.push({ moduleRow: topRow + 3, moduleCol: topCol + 5, expectDark: false });
};

const pushAlignmentSignature = (points: SamplePoint[], cr: number, cc: number): void => {
  // 1×1 dark center.
  points.push({ moduleRow: cr, moduleCol: cc, expectDark: true });
  // Outer dark ring corners.
  points.push({ moduleRow: cr - 2, moduleCol: cc - 2, expectDark: true });
  points.push({ moduleRow: cr - 2, moduleCol: cc + 2, expectDark: true });
  points.push({ moduleRow: cr + 2, moduleCol: cc - 2, expectDark: true });
  points.push({ moduleRow: cr + 2, moduleCol: cc + 2, expectDark: true });
  // Inner light ring midpoints.
  points.push({ moduleRow: cr - 1, moduleCol: cc, expectDark: false });
  points.push({ moduleRow: cr + 1, moduleCol: cc, expectDark: false });
  points.push({ moduleRow: cr, moduleCol: cc - 1, expectDark: false });
  points.push({ moduleRow: cr, moduleCol: cc + 1, expectDark: false });
};

const pushBitSamples = (
  points: SamplePoint[],
  positions: readonly (readonly [number, number])[],
  codeword: number,
): void => {
  const bitCount = positions.length;
  for (let index = 0; index < bitCount; index += 1) {
    const position = positions[index];
    if (!position) continue;
    const [moduleRow, moduleCol] = position;
    points.push({
      moduleRow,
      moduleCol,
      expectDark: ((codeword >> (bitCount - 1 - index)) & 1) === 1,
    });
  }
};

// ─── Scoring & perturbation ───────────────────────────────────────────────

/** +1 for every cell that matches expectation, -1 for every mismatch. */
const scoreHomography = (
  h: Homography,
  points: readonly SamplePoint[],
  isDark: (x: number, y: number) => boolean,
): number => {
  let score = 0;
  for (const p of points) {
    const pix = applyHomography(h, p.moduleCol, p.moduleRow);
    const observedDark = isDark(pix.x, pix.y);
    score += observedDark === p.expectDark ? 1 : -1;
  }
  return score;
};

/** Returns a copy of `h` with parameter `i` shifted by `delta`. */
const perturbHomography = (h: Homography, i: number, delta: number): Homography => {
  const out: number[] = h.slice();
  out[i] = (out[i] ?? 0) + delta;
  return out as unknown as Homography;
};

// ─── Rebuild resolution ───────────────────────────────────────────────────

const rebuildGridResolution = (
  original: GridResolution,
  homography: Homography,
): GridResolution => {
  const { version, size } = original;
  const samplePoint = (gridRow: number, gridCol: number): Point =>
    applyHomography(homography, gridCol, gridRow);

  const cornerTL = samplePoint(-0.5, -0.5);
  const cornerTR = samplePoint(-0.5, size - 0.5);
  const cornerBR = samplePoint(size - 0.5, size - 0.5);
  const cornerBL = samplePoint(size - 0.5, -0.5);

  const corners: CornerSet = {
    topLeft: cornerTL,
    topRight: cornerTR,
    bottomRight: cornerBR,
    bottomLeft: cornerBL,
  };

  const xs = [cornerTL.x, cornerTR.x, cornerBR.x, cornerBL.x];
  const ys = [cornerTL.y, cornerTR.y, cornerBR.y, cornerBL.y];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const bounds: Bounds = {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };

  return { version, size, corners, bounds, homography, samplePoint };
};
