import type { FinderCandidate, FinderTriple } from './detect.js';
import { assertImagePlaneLength } from './validation.js';

interface RunQuadLine {
  readonly startX: number;
  readonly endX: number;
  readonly y: number;
}

interface RunQuad {
  readonly top: RunQuadLine;
  bottom: RunQuadLine;
}

export interface AlignmentQuadCandidate {
  readonly x: number;
  readonly y: number;
}

const FINDER_QUAD_MIN_HEIGHT = 2;
const ALIGNMENT_QUAD_MIN_HEIGHT = 1;
const QUAD_MAX_RATIO = 1.5;
const QUAD_MIN_RATIO = 0.5;

const sumRuns = (runs: readonly number[]): number => runs.reduce((sum, run) => sum + run, 0);

const finderRatioMatches = (runs: readonly [number, number, number, number, number]): boolean => {
  const total = sumRuns(runs);
  if (total < 7) return false;

  const moduleSize = total / 7;
  const maxVariance = moduleSize * 0.75;
  return (
    Math.abs(runs[0] - moduleSize) < maxVariance &&
    Math.abs(runs[1] - moduleSize) < maxVariance &&
    Math.abs(runs[2] - 3 * moduleSize) < 3 * maxVariance &&
    Math.abs(runs[3] - moduleSize) < maxVariance &&
    Math.abs(runs[4] - moduleSize) < maxVariance
  );
};

const alignmentRatioMatches = (a: number, b: number, c: number): boolean => {
  const average = (a + b + c) / 3;
  const maxVariance = average * 0.75;
  return (
    Math.abs(a - average) < maxVariance &&
    Math.abs(b - average) < maxVariance &&
    Math.abs(c - average) < maxVariance
  );
};

const recenterDarkRun = (
  binary: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } => {
  const centerX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const centerY = Math.max(0, Math.min(height - 1, Math.round(y)));
  if ((binary[centerY * width + centerX] ?? 255) !== 0) {
    return { x, y };
  }

  let left = centerX;
  while (left >= 0 && (binary[centerY * width + left] ?? 255) === 0) left -= 1;
  let right = centerX;
  while (right < width && (binary[centerY * width + right] ?? 255) === 0) right += 1;
  let top = centerY;
  while (top >= 0 && (binary[top * width + centerX] ?? 255) === 0) top -= 1;
  let bottom = centerY;
  while (bottom < height && (binary[bottom * width + centerX] ?? 255) === 0) bottom += 1;

  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
  };
};

const quadLineMatches = (lineWidth: number, quad: RunQuad): boolean => {
  const quadWidth = Math.max(1, quad.bottom.endX - quad.bottom.startX);
  return lineWidth / quadWidth < QUAD_MAX_RATIO && lineWidth / quadWidth > QUAD_MIN_RATIO;
};

const overlapsQuad = (line: RunQuadLine, quad: RunQuad, lineWidth: number): boolean => {
  return (
    (line.startX >= quad.bottom.startX && line.startX <= quad.bottom.endX) ||
    (line.endX >= quad.bottom.startX && line.startX <= quad.bottom.endX) ||
    (line.startX <= quad.bottom.startX &&
      line.endX >= quad.bottom.endX &&
      quadLineMatches(lineWidth, quad))
  );
};

const finalizeFinderQuad = (
  quad: RunQuad,
  binary: Uint8Array,
  width: number,
  height: number,
): FinderCandidate => {
  const x = (quad.top.startX + quad.top.endX + quad.bottom.startX + quad.bottom.endX) / 4;
  const y = (quad.top.y + quad.bottom.y + 1) / 2;
  const topWidth = quad.top.endX - quad.top.startX;
  const bottomWidth = quad.bottom.endX - quad.bottom.startX;
  const hModuleSize = (topWidth + bottomWidth) / 6;
  const vModuleSize = (quad.bottom.y - quad.top.y + 1) / 3;
  const recentered = recenterDarkRun(binary, width, height, x, y);

  return {
    cx: recentered.x,
    cy: recentered.y,
    moduleSize: (hModuleSize + vModuleSize) / 2,
    hModuleSize,
    vModuleSize,
    source: 'row-scan',
  };
};

const finalizeAlignmentQuad = (
  quad: RunQuad,
  binary: Uint8Array,
  width: number,
  height: number,
): AlignmentQuadCandidate => {
  const x = (quad.top.startX + quad.top.endX + quad.bottom.startX + quad.bottom.endX) / 4;
  const y = (quad.top.y + quad.bottom.y + 1) / 2;
  const recentered = recenterDarkRun(binary, width, height, x, y);
  return { x: recentered.x, y: recentered.y };
};

export const detectFinderCandidatesQuad = (
  binary: Uint8Array,
  width: number,
  height: number,
): FinderCandidate[] => {
  assertImagePlaneLength(binary.length, width, height, 'detectFinderCandidatesQuad');

  const candidates: FinderCandidate[] = [];
  let active: RunQuad[] = [];

  for (let y = 0; y <= height; y += 1) {
    let length = 0;
    let lastDark = false;
    let scans: [number, number, number, number, number] = [0, 0, 0, 0, 0];

    for (let x = 0; x <= width; x += 1) {
      const isDark: boolean =
        x < width && y < height ? (binary[y * width + x] ?? 255) === 0 : !lastDark;
      if (isDark === lastDark) {
        length += 1;
        continue;
      }

      scans = [scans[1], scans[2], scans[3], scans[4], length];
      length = 1;
      lastDark = isDark;

      if (!isDark && finderRatioMatches(scans)) {
        const endX = x - scans[3] - scans[4];
        const startX = endX - scans[2];
        const line = { startX, endX, y } satisfies RunQuadLine;
        const match = active.find((quad) => overlapsQuad(line, quad, scans[2]));
        if (match) {
          match.bottom = line;
        } else {
          active.push({ top: line, bottom: line });
        }
      }
    }

    candidates.push(
      ...active
        .filter(
          (quad) => quad.bottom.y !== y && quad.bottom.y - quad.top.y >= FINDER_QUAD_MIN_HEIGHT,
        )
        .map((quad) => finalizeFinderQuad(quad, binary, width, height)),
    );
    active = active.filter((quad) => quad.bottom.y === y);
  }

  candidates.push(
    ...active
      .filter((quad) => quad.bottom.y - quad.top.y >= FINDER_QUAD_MIN_HEIGHT)
      .map((quad) => finalizeFinderQuad(quad, binary, width, height)),
  );

  return candidates;
};

export const detectAlignmentCandidatesQuad = (
  binary: Uint8Array,
  width: number,
  height: number,
): AlignmentQuadCandidate[] => {
  assertImagePlaneLength(binary.length, width, height, 'detectAlignmentCandidatesQuad');

  const candidates: AlignmentQuadCandidate[] = [];
  let active: RunQuad[] = [];

  for (let y = 0; y <= height; y += 1) {
    let length = 0;
    let lastDark = false;
    let scans: [number, number, number, number, number] = [0, 0, 0, 0, 0];

    for (let x = 0; x <= width; x += 1) {
      const isDark: boolean =
        x < width && y < height ? (binary[y * width + x] ?? 255) === 0 : !lastDark;
      if (isDark === lastDark) {
        length += 1;
        continue;
      }

      scans = [scans[1], scans[2], scans[3], scans[4], length];
      length = 1;
      lastDark = isDark;

      if (isDark && alignmentRatioMatches(scans[2], scans[3], scans[4])) {
        const endX = x - scans[4];
        const startX = endX - scans[3];
        const line = { startX, endX, y } satisfies RunQuadLine;
        const match = active.find((quad) => overlapsQuad(line, quad, scans[3]));
        if (match) {
          match.bottom = line;
        } else {
          active.push({ top: line, bottom: line });
        }
      }
    }

    candidates.push(
      ...active
        .filter(
          (quad) => quad.bottom.y !== y && quad.bottom.y - quad.top.y >= ALIGNMENT_QUAD_MIN_HEIGHT,
        )
        .map((quad) => finalizeAlignmentQuad(quad, binary, width, height)),
    );
    active = active.filter((quad) => quad.bottom.y === y);
  }

  candidates.push(
    ...active
      .filter((quad) => quad.bottom.y - quad.top.y >= ALIGNMENT_QUAD_MIN_HEIGHT)
      .map((quad) => finalizeAlignmentQuad(quad, binary, width, height)),
  );

  return candidates;
};

export const finderTripleAspect = (triple: FinderTriple): number => {
  return Math.max(
    ...triple.map(
      (finder) =>
        Math.max(finder.hModuleSize, finder.vModuleSize) /
        Math.max(1e-6, Math.min(finder.hModuleSize, finder.vModuleSize)),
    ),
  );
};
