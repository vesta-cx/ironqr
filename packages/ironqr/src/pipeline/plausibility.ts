import { createGeometryCandidates, type GridResolution } from './geometry.js';
import type { ScanProposal } from './proposals.js';
import { sampleGrid } from './samplers.js';
import type { ViewBank } from './views.js';

const MAX_SCREEN_GEOMETRIES = 3;
const TIMING_PASS_THRESHOLD = 0.38;
const FINDER_PASS_THRESHOLD = 0.4;
const PITCH_PASS_THRESHOLD = 0.08;
const STRUCTURE_PASS_THRESHOLD = 2.2;
const TIMING_SCORE_WEIGHT = 2.5;
const FINDER_SCORE_WEIGHT = 1.5;
const MIN_QR_SIZE = 21;
const TIMING_AXIS_INDEX = 6;
const TIMING_PATTERN_MARGIN = 7;
const TIMING_PATTERN_END_MARGIN = 8;
const FINDER_CENTER_OFFSET = 3;
const FINDER_EDGE_OFFSET = 4;
const SEPARATOR_NEAR_OFFSET = 7;
const SEPARATOR_FAR_OFFSET = 8;

/**
 * Cheap structural assessment for one proposal before full decode work.
 */
export interface ProposalStructureAssessment {
  /** Whether the proposal looks QR-like enough to deserve decode budget. */
  readonly passed: boolean;
  /** Best geometry candidate discovered during the assessment. */
  readonly bestGeometry: GridResolution | null;
  /** Aggregate structural score. */
  readonly score: number;
  /** Timing-line plausibility. */
  readonly timingScore: number;
  /** Finder-signature plausibility. */
  readonly finderScore: number;
  /** Separator support around the three finders. */
  readonly separatorScore: number;
  /** Projected module-pitch smoothness. */
  readonly pitchScore: number;
}

/**
 * Checks whether a proposal's strongest source-view geometry induces a
 * believable QR lattice before we spend the full decode cascade on it.
 *
 * @param proposal - Ranked proposal to screen.
 * @param viewBank - Shared lazy view cache.
 * @returns Structural plausibility summary.
 */
export const assessProposalStructure = (
  proposal: ScanProposal,
  viewBank: ViewBank,
): ProposalStructureAssessment => {
  const geometryCandidates = createGeometryCandidates(proposal).slice(0, MAX_SCREEN_GEOMETRIES);
  if (geometryCandidates.length === 0) {
    return {
      passed: false,
      bestGeometry: null,
      score: 0,
      timingScore: 0,
      finderScore: 0,
      separatorScore: 0,
      pitchScore: 0,
    };
  }

  const sourceBinaryView = viewBank.getBinaryView(proposal.binaryViewId);
  let best = {
    geometry: null as GridResolution | null,
    score: Number.NEGATIVE_INFINITY,
    timingScore: 0,
    finderScore: 0,
    separatorScore: 0,
    pitchScore: 0,
  };

  for (const geometry of geometryCandidates) {
    const grid = sampleGrid(
      sourceBinaryView.width,
      sourceBinaryView.height,
      geometry,
      sourceBinaryView,
      'cross-vote',
    );
    const timingScore = measureTimingSupport(grid);
    const finderScore = measureFinderSupport(grid);
    const separatorScore = measureSeparatorSupport(grid);
    const pitchScore = measurePitchSmoothness(geometry);
    const score =
      timingScore * TIMING_SCORE_WEIGHT +
      finderScore * FINDER_SCORE_WEIGHT +
      separatorScore +
      pitchScore;

    if (score > best.score) {
      best = {
        geometry,
        score,
        timingScore,
        finderScore,
        separatorScore,
        pitchScore,
      };
    }
  }

  return {
    passed:
      best.score >= STRUCTURE_PASS_THRESHOLD &&
      best.timingScore >= TIMING_PASS_THRESHOLD &&
      best.finderScore >= FINDER_PASS_THRESHOLD &&
      best.pitchScore >= PITCH_PASS_THRESHOLD,
    bestGeometry: best.geometry,
    score: best.score,
    timingScore: best.timingScore,
    finderScore: best.finderScore,
    separatorScore: best.separatorScore,
    pitchScore: best.pitchScore,
  };
};

const measureTimingSupport = (grid: readonly (readonly boolean[])[]): number => {
  if (grid.length < MIN_QR_SIZE) return 0;
  return Math.min(measureTimingLine(grid, 'row'), measureTimingLine(grid, 'col'));
};

const measureTimingLine = (grid: readonly (readonly boolean[])[], axis: 'row' | 'col'): number => {
  let matches = 0;
  let total = 0;
  for (
    let index = TIMING_PATTERN_MARGIN;
    index <= grid.length - TIMING_PATTERN_END_MARGIN;
    index += 1
  ) {
    const value =
      axis === 'row' ? grid[TIMING_AXIS_INDEX]?.[index] : grid[index]?.[TIMING_AXIS_INDEX];
    if (value === undefined) return 0;
    const expectedDark = index % 2 === 0;
    matches += value === expectedDark ? 1 : 0;
    total += 1;
  }
  return total === 0 ? 0 : matches / total;
};

const measureFinderSupport = (grid: readonly (readonly boolean[])[]): number => {
  if (grid.length < MIN_QR_SIZE) return 0;
  const size = grid.length;
  const centers = [
    { row: FINDER_CENTER_OFFSET, col: FINDER_CENTER_OFFSET },
    { row: FINDER_CENTER_OFFSET, col: size - FINDER_EDGE_OFFSET },
    { row: size - FINDER_EDGE_OFFSET, col: FINDER_CENTER_OFFSET },
  ] as const;
  const probes = [
    { deltaRow: 0, deltaCol: 0, dark: true, weight: 3 },
    { deltaRow: -1, deltaCol: 0, dark: true, weight: 1 },
    { deltaRow: 1, deltaCol: 0, dark: true, weight: 1 },
    { deltaRow: 0, deltaCol: -1, dark: true, weight: 1 },
    { deltaRow: 0, deltaCol: 1, dark: true, weight: 1 },
    { deltaRow: -2, deltaCol: 0, dark: false, weight: 1 },
    { deltaRow: 2, deltaCol: 0, dark: false, weight: 1 },
    { deltaRow: 0, deltaCol: -2, dark: false, weight: 1 },
    { deltaRow: 0, deltaCol: 2, dark: false, weight: 1 },
    { deltaRow: -3, deltaCol: 0, dark: true, weight: 1 },
    { deltaRow: 3, deltaCol: 0, dark: true, weight: 1 },
    { deltaRow: 0, deltaCol: -3, dark: true, weight: 1 },
    { deltaRow: 0, deltaCol: 3, dark: true, weight: 1 },
  ] as const;

  let score = 0;
  let total = 0;
  for (const center of centers) {
    for (const probe of probes) {
      const row = center.row + probe.deltaRow;
      const col = center.col + probe.deltaCol;
      const value = grid[row]?.[col];
      if (value === undefined) continue;
      score += value === probe.dark ? probe.weight : 0;
      total += probe.weight;
    }
  }

  return total === 0 ? 0 : score / total;
};

const measureSeparatorSupport = (grid: readonly (readonly boolean[])[]): number => {
  if (grid.length < MIN_QR_SIZE) return 0;
  const size = grid.length;
  const probes = [
    [SEPARATOR_NEAR_OFFSET, FINDER_CENTER_OFFSET],
    [FINDER_CENTER_OFFSET, SEPARATOR_NEAR_OFFSET],
    [SEPARATOR_NEAR_OFFSET, SEPARATOR_NEAR_OFFSET],
    [SEPARATOR_NEAR_OFFSET, size - FINDER_EDGE_OFFSET],
    [FINDER_CENTER_OFFSET, size - SEPARATOR_FAR_OFFSET],
    [SEPARATOR_NEAR_OFFSET, size - SEPARATOR_FAR_OFFSET],
    [size - SEPARATOR_FAR_OFFSET, FINDER_CENTER_OFFSET],
    [size - FINDER_EDGE_OFFSET, SEPARATOR_NEAR_OFFSET],
    [size - SEPARATOR_FAR_OFFSET, SEPARATOR_NEAR_OFFSET],
  ] as const;
  let light = 0;
  for (const [row, col] of probes) {
    const value = grid[row]?.[col];
    light += value === false ? 1 : 0;
  }
  return light / probes.length;
};

const measurePitchSmoothness = (geometry: GridResolution): number => {
  return Math.min(
    linePitchSmoothness(sampleLinePoints(geometry, 'row')),
    linePitchSmoothness(sampleLinePoints(geometry, 'col')),
  );
};

const sampleLinePoints = (geometry: GridResolution, axis: 'row' | 'col') => {
  const points = [] as Array<{ readonly x: number; readonly y: number }>;
  for (
    let index = TIMING_PATTERN_MARGIN;
    index <= geometry.size - TIMING_PATTERN_END_MARGIN;
    index += 1
  ) {
    points.push(
      axis === 'row'
        ? geometry.samplePoint(TIMING_AXIS_INDEX, index)
        : geometry.samplePoint(index, TIMING_AXIS_INDEX),
    );
  }
  return points;
};

const linePitchSmoothness = (
  points: readonly { readonly x: number; readonly y: number }[],
): number => {
  if (points.length < 2) return 0;
  const steps: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (Number.isFinite(distance) && distance > 1e-6) steps.push(distance);
  }
  if (steps.length === 0) return 0;
  const min = Math.min(...steps);
  const max = Math.max(...steps);
  if (max <= 1e-6) return 0;
  return min / max;
};
