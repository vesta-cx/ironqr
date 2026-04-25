import {
  type ExtraCorrespondence,
  type GridResolution,
  resolveGridFromCorners,
  resolveGridFromCorrespondences,
} from './geometry.js';
import type { FinderTripleProposal } from './proposals.js';
import { type BinaryView, isDarkPixel } from './views.js';

/**
 * Locates alignment-pattern correspondences suggested by a geometry candidate.
 *
 * The search stays intentionally local and cheap: once a proposal has earned a
 * geometry candidate, we only need enough evidence to tighten the fit before a
 * decode retry.
 *
 * @param geometry - Base geometry candidate.
 * @param binary - Thresholded binary pixels.
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @returns Zero or more located alignment correspondences.
 */
export const locateAlignmentPatternCorrespondences = (
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): readonly ExtraCorrespondence[] => {
  if (geometry.version < 2) return [];

  const anchor = geometry.size - 7;
  const predicted = geometry.samplePoint(anchor, anchor);
  if (!isPointInsideImage(predicted, width, height)) return [];

  const left = geometry.samplePoint(anchor, Math.max(0, anchor - 1));
  const right = geometry.samplePoint(anchor, Math.min(geometry.size - 1, anchor + 1));
  const up = geometry.samplePoint(Math.max(0, anchor - 1), anchor);
  const down = geometry.samplePoint(Math.min(geometry.size - 1, anchor + 1), anchor);
  const moduleRadius = Math.max(
    2,
    Math.round(
      (Math.hypot(right.x - left.x, right.y - left.y) + Math.hypot(down.x - up.x, down.y - up.y)) /
        4,
    ),
  );
  if (!Number.isFinite(moduleRadius) || moduleRadius > Math.max(width, height)) return [];

  const searchRadius = Math.max(3, moduleRadius * 4);
  const minX = Math.max(-searchRadius, Math.ceil(-predicted.x));
  const maxX = Math.min(searchRadius, Math.floor(width - 1 - predicted.x));
  const minY = Math.max(-searchRadius, Math.ceil(-predicted.y));
  const maxY = Math.min(searchRadius, Math.floor(height - 1 - predicted.y));
  if (minX > maxX || minY > maxY) return [];

  let best:
    | {
        readonly pixelX: number;
        readonly pixelY: number;
        readonly score: number;
        readonly distanceSquared: number;
      }
    | undefined;

  for (let offsetY = minY; offsetY <= maxY; offsetY += 1) {
    for (let offsetX = minX; offsetX <= maxX; offsetX += 1) {
      const pixelX = predicted.x + offsetX;
      const pixelY = predicted.y + offsetY;
      const score = scoreAlignmentPattern(binary, width, height, pixelX, pixelY, moduleRadius);
      const distanceSquared = offsetX * offsetX + offsetY * offsetY;
      if (
        !best ||
        score > best.score ||
        (score === best.score && distanceSquared < best.distanceSquared)
      ) {
        best = { pixelX, pixelY, score, distanceSquared };
      }
    }
  }

  if (!best || best.score < 5) return [];
  return [
    {
      moduleRow: anchor,
      moduleCol: anchor,
      pixelX: best.pixelX,
      pixelY: best.pixelY,
    },
  ];
};

/**
 * Applies a cheap structural fitness refinement to an existing geometry.
 *
 * The implementation evaluates a small family of explicit-corner rescue
 * candidates and keeps the geometry whose sampled timing/finder structure
 * matches best.
 *
 * @param geometry - Base geometry candidate.
 * @param binary - Thresholded binary pixels.
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @returns The best refined geometry found, or the original geometry.
 */
export const refineGeometryByFitness = (
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): GridResolution => {
  const candidates = generateCornerNudges(geometry);
  let best = geometry;
  let bestScore = structuralFitness(geometry, binary, width, height);
  for (const candidate of candidates) {
    const score = structuralFitness(candidate, binary, width, height);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

/**
 * Ranks explicit-corner rescue candidates by structural plausibility and keeps
 * only the strongest few for decode retries.
 *
 * @param geometry - Base geometry candidate.
 * @param binary - Thresholded binary pixels.
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @param maxCandidates - Maximum nudges to retain.
 * @returns Best-first corner nudges.
 */
export const selectTopCornerNudges = (
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
  maxCandidates: number,
): readonly GridResolution[] => {
  return dedupeCornerNudges(generateCornerNudges(geometry))
    .map((candidate) => ({
      candidate,
      score: structuralFitness(candidate, binary, width, height),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, maxCandidates))
    .map((entry) => entry.candidate);
};

/**
 * Applies an alignment-assisted homography refit for a finder-triple proposal.
 *
 * @param proposal - Source finder-triple proposal.
 * @param geometry - Current geometry candidate.
 * @param binary - Thresholded binary pixels.
 * @param width - Binary image width.
 * @param height - Binary image height.
 * @returns A refined geometry candidate or `null` when no alignment support was found.
 */
export const refineGeometryWithAlignment = (
  proposal: FinderTripleProposal,
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): GridResolution | null => {
  const points = locateAlignmentPatternCorrespondences(geometry, binary, width, height);
  if (points.length === 0) return null;
  return resolveGridFromCorrespondences(proposal.finders, geometry.version, points);
};

/**
 * Generates small explicit-corner rescue candidates.
 *
 * @param geometry - Base geometry candidate.
 * @returns Corner-nudged alternatives.
 */
const generateCornerNudges = (geometry: GridResolution): readonly GridResolution[] => {
  const top = edgeStep(geometry.corners.topLeft, geometry.corners.topRight, geometry.size);
  const left = edgeStep(geometry.corners.topLeft, geometry.corners.bottomLeft, geometry.size);
  const right = edgeStep(geometry.corners.topRight, geometry.corners.bottomRight, geometry.size);
  const bottom = edgeStep(geometry.corners.bottomLeft, geometry.corners.bottomRight, geometry.size);
  const deltas = [
    { x: -right.x, y: -right.y },
    { x: right.x, y: right.y },
    { x: -bottom.x, y: -bottom.y },
    { x: bottom.x, y: bottom.y },
    { x: right.x + bottom.x, y: right.y + bottom.y },
    { x: -right.x - bottom.x, y: -right.y - bottom.y },
  ];

  const nudged: GridResolution[] = [];
  for (const delta of deltas) {
    const candidate = resolveGridFromCorners(geometry, {
      topLeft: geometry.corners.topLeft,
      topRight: {
        x: geometry.corners.topRight.x + delta.x * 0.4,
        y: geometry.corners.topRight.y + delta.y * 0.4,
      },
      bottomRight: {
        x: geometry.corners.bottomRight.x + delta.x,
        y: geometry.corners.bottomRight.y + delta.y,
      },
      bottomLeft: {
        x: geometry.corners.bottomLeft.x + delta.x * 0.4,
        y: geometry.corners.bottomLeft.y + delta.y * 0.4,
      },
    });
    if (candidate) nudged.push(candidate);
  }

  const topLeftDeltas = [
    { x: -top.x - left.x, y: -top.y - left.y },
    { x: top.x + left.x, y: top.y + left.y },
  ];
  for (const delta of topLeftDeltas) {
    const candidate = resolveGridFromCorners(geometry, {
      topLeft: { x: geometry.corners.topLeft.x + delta.x, y: geometry.corners.topLeft.y + delta.y },
      topRight: geometry.corners.topRight,
      bottomRight: geometry.corners.bottomRight,
      bottomLeft: geometry.corners.bottomLeft,
    });
    if (candidate) nudged.push(candidate);
  }

  const brColumnStep = edgeStep(
    geometry.corners.bottomLeft,
    geometry.corners.bottomRight,
    geometry.size,
  );
  const brRowStep = edgeStep(
    geometry.corners.topRight,
    geometry.corners.bottomRight,
    geometry.size,
  );
  const bottomRightLattice: readonly (readonly [number, number])[] = [
    [-1, 0],
    [0, -1],
    [-1, -1],
    [1, 0],
    [0, 1],
    [1, 1],
    [-2, 0],
    [0, -2],
    [-2, -1],
    [-1, -2],
    [2, 0],
    [0, 2],
    [2, 1],
    [1, 2],
    [-2, -2],
    [2, 2],
  ];
  for (const [deltaCol, deltaRow] of bottomRightLattice) {
    const candidate = resolveGridFromCorners(geometry, {
      topLeft: geometry.corners.topLeft,
      topRight: geometry.corners.topRight,
      bottomRight: {
        x: geometry.corners.bottomRight.x + brColumnStep.x * deltaCol + brRowStep.x * deltaRow,
        y: geometry.corners.bottomRight.y + brColumnStep.y * deltaCol + brRowStep.y * deltaRow,
      },
      bottomLeft: geometry.corners.bottomLeft,
    });
    if (candidate) nudged.push(candidate);
  }

  return nudged;
};

const structuralFitness = (
  geometry: GridResolution,
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): number => {
  let score = 0;
  for (let index = 7; index <= geometry.size - 8; index += 1) {
    const rowPoint = geometry.samplePoint(6, index);
    const colPoint = geometry.samplePoint(index, 6);
    const expectedDark = index % 2 === 0;
    score += sample(binary, width, height, rowPoint.x, rowPoint.y) === expectedDark ? 1 : -1;
    score += sample(binary, width, height, colPoint.x, colPoint.y) === expectedDark ? 1 : -1;
  }

  const finderCenters = [
    geometry.samplePoint(3, 3),
    geometry.samplePoint(3, geometry.size - 4),
    geometry.samplePoint(geometry.size - 4, 3),
  ];
  for (const center of finderCenters) {
    score += sample(binary, width, height, center.x, center.y) ? 2 : -2;
  }

  if (geometry.version >= 2) {
    const alignment = geometry.samplePoint(geometry.size - 7, geometry.size - 7);
    score += sample(binary, width, height, alignment.x, alignment.y) ? 2 : -2;
  }

  return score;
};

const ALIGNMENT_PATTERN_PROBES = [
  { x: 0, y: 0, dark: true, weight: 3 },
  { x: -2, y: -2, dark: true, weight: 1 },
  { x: 2, y: -2, dark: true, weight: 1 },
  { x: -2, y: 2, dark: true, weight: 1 },
  { x: 2, y: 2, dark: true, weight: 1 },
  { x: -1, y: 0, dark: false, weight: 1 },
  { x: 1, y: 0, dark: false, weight: 1 },
  { x: 0, y: -1, dark: false, weight: 1 },
  { x: 0, y: 1, dark: false, weight: 1 },
] as const;

const scoreAlignmentPattern = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
): number => {
  let score = 0;
  for (const probe of ALIGNMENT_PATTERN_PROBES) {
    const dark = sample(
      binary,
      width,
      height,
      centerX + probe.x * radius,
      centerY + probe.y * radius,
    );
    score += dark === probe.dark ? probe.weight : -probe.weight;
  }
  return score;
};

const dedupeCornerNudges = (candidates: readonly GridResolution[]): readonly GridResolution[] => {
  const seen = new Set<string>();
  const deduped: GridResolution[] = [];
  for (const candidate of candidates) {
    const signature = [
      candidate.corners.topLeft,
      candidate.corners.topRight,
      candidate.corners.bottomRight,
      candidate.corners.bottomLeft,
    ]
      .map((point) => `${Math.round(point.x)}:${Math.round(point.y)}`)
      .join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(candidate);
  }
  return deduped;
};

const edgeStep = (
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  size: number,
) => {
  const scale = Math.max(1, size - 1);
  return { x: (end.x - start.x) / scale, y: (end.y - start.y) / scale };
};

const isPointInsideImage = (
  point: { readonly x: number; readonly y: number },
  width: number,
  height: number,
): boolean => {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= width - 1 &&
    point.y >= 0 &&
    point.y <= height - 1
  );
};

const sample = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= height) return false;
  const index = py * width + px;
  if (isBinaryViewInput(binary)) return isDarkPixel(binary, index);
  return (binary[index] ?? 255) === 0;
};

const isBinaryViewInput = (value: Uint8Array | BinaryView): value is BinaryView =>
  !(value instanceof Uint8Array);
