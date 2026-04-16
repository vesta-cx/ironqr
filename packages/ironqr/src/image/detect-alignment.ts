import type { ExtraCorrespondence, GridResolution } from './geometry.js';
import { ALIGNMENT_PATTERN_CENTERS } from '../qr/qr-tables.js';

interface Basis {
  readonly center: { x: number; y: number };
  readonly u: { x: number; y: number };
  readonly v: { x: number; y: number };
  readonly moduleSize: number;
}

interface ScoredPoint {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

const ALIGNMENT_CELL_WEIGHTS = buildAlignmentCellWeights();
const MAX_ALIGNMENT_SCORE = ALIGNMENT_CELL_WEIGHTS.reduce((sum, cell) => sum + cell.weight, 0);
const MIN_ALIGNMENT_SCORE_RATIO = 0.35;

/**
 * Locates alignment-pattern centers near the current homography prediction.
 *
 * Uses the resolved grid to predict each alignment center and local module
 * basis, then searches a small pixel window for the best 5×5 alignment-pattern
 * signature. Returned correspondences can be fed into
 * `resolveGridFromCorrespondences()` to refit the homography with extra anchors.
 */
export const locateAlignmentPatternCorrespondences = (
  resolution: GridResolution,
  binary: Uint8Array,
  width: number,
  height: number,
): readonly ExtraCorrespondence[] => {
  if (resolution.version < 2) return [];

  const centers = ALIGNMENT_PATTERN_CENTERS[resolution.version - 1];
  if (!centers || centers.length === 0) return [];

  const isDark = (x: number, y: number): boolean => {
    const px = Math.max(0, Math.min(width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(height - 1, Math.round(y)));
    return (binary[py * width + px] ?? 255) === 0;
  };

  const correspondences: ExtraCorrespondence[] = [];
  const size = resolution.size;

  for (const moduleRow of centers) {
    for (const moduleCol of centers) {
      if (
        (moduleRow === 6 && moduleCol === 6) ||
        (moduleRow === 6 && moduleCol === size - 7) ||
        (moduleRow === size - 7 && moduleCol === 6)
      ) {
        continue;
      }

      const basis = localBasis(resolution, moduleRow, moduleCol);
      const best = searchAlignmentCenter(basis, isDark);
      if (best === null) continue;

      correspondences.push({
        moduleRow,
        moduleCol,
        pixelX: best.x,
        pixelY: best.y,
      });
    }
  }

  return correspondences;
};

const searchAlignmentCenter = (
  basis: Basis,
  isDark: (x: number, y: number) => boolean,
): ScoredPoint | null => {
  const radius = Math.max(3, Math.min(24, Math.round(basis.moduleSize * 2.5)));
  let best: ScoredPoint | null = null;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = basis.center.x + dx;
      const y = basis.center.y + dy;
      const score = scoreAlignmentAt(x, y, basis, isDark);
      if (best === null || score > best.score) {
        best = { x, y, score };
      }
    }
  }

  if (best === null) return null;
  const minScore = MAX_ALIGNMENT_SCORE * MIN_ALIGNMENT_SCORE_RATIO;
  if (best.score < minScore) return null;

  return refineAlignmentCenter(best, basis, isDark);
};

const refineAlignmentCenter = (
  coarse: ScoredPoint,
  basis: Basis,
  isDark: (x: number, y: number) => boolean,
): ScoredPoint => {
  let current = coarse;
  for (const step of [0.5, 0.25] as const) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [dx, dy] of [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
        [step, step],
        [step, -step],
        [-step, step],
        [-step, -step],
      ] as const) {
        const candidate = {
          x: current.x + dx,
          y: current.y + dy,
          score: scoreAlignmentAt(current.x + dx, current.y + dy, basis, isDark),
        };
        if (candidate.score > current.score) {
          current = candidate;
          improved = true;
        }
      }
    }
  }
  return current;
};

const scoreAlignmentAt = (
  centerX: number,
  centerY: number,
  basis: Basis,
  isDark: (x: number, y: number) => boolean,
): number => {
  let score = 0;
  for (const cell of ALIGNMENT_CELL_WEIGHTS) {
    const x = centerX + cell.moduleCol * basis.u.x + cell.moduleRow * basis.v.x;
    const y = centerY + cell.moduleCol * basis.u.y + cell.moduleRow * basis.v.y;
    score += isDark(x, y) === cell.expectDark ? cell.weight : -cell.weight;
  }
  return score;
};

const localBasis = (resolution: GridResolution, moduleRow: number, moduleCol: number): Basis => {
  const center = resolution.samplePoint(moduleRow, moduleCol);
  const left = resolution.samplePoint(moduleRow, Math.max(0, moduleCol - 1));
  const right = resolution.samplePoint(moduleRow, Math.min(resolution.size - 1, moduleCol + 1));
  const up = resolution.samplePoint(Math.max(0, moduleRow - 1), moduleCol);
  const down = resolution.samplePoint(Math.min(resolution.size - 1, moduleRow + 1), moduleCol);

  const u =
    moduleCol === 0
      ? { x: right.x - center.x, y: right.y - center.y }
      : moduleCol === resolution.size - 1
        ? { x: center.x - left.x, y: center.y - left.y }
        : { x: (right.x - left.x) / 2, y: (right.y - left.y) / 2 };
  const v =
    moduleRow === 0
      ? { x: down.x - center.x, y: down.y - center.y }
      : moduleRow === resolution.size - 1
        ? { x: center.x - up.x, y: center.y - up.y }
        : { x: (down.x - up.x) / 2, y: (down.y - up.y) / 2 };

  return {
    center,
    u,
    v,
    moduleSize: (Math.hypot(u.x, u.y) + Math.hypot(v.x, v.y)) / 2,
  };
};

function buildAlignmentCellWeights(): readonly {
  readonly moduleRow: number;
  readonly moduleCol: number;
  readonly expectDark: boolean;
  readonly weight: number;
}[] {
  const cells: Array<{
    readonly moduleRow: number;
    readonly moduleCol: number;
    readonly expectDark: boolean;
    readonly weight: number;
  }> = [];

  for (let moduleRow = -2; moduleRow <= 2; moduleRow += 1) {
    for (let moduleCol = -2; moduleCol <= 2; moduleCol += 1) {
      const outerRing = Math.abs(moduleRow) === 2 || Math.abs(moduleCol) === 2;
      const center = moduleRow === 0 && moduleCol === 0;
      const expectDark = outerRing || center;
      const manhattan = Math.abs(moduleRow) + Math.abs(moduleCol);
      const weight = center ? 4 : outerRing ? (manhattan === 4 ? 2.5 : 2) : 1.5;
      cells.push({ moduleRow, moduleCol, expectDark, weight });
    }
  }

  return cells;
}
