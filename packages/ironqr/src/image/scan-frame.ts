import { Effect } from 'effect';
import type { Point } from '../contracts/geometry.js';
import type { BrowserImageSource, ScanOptions, ScanResult } from '../contracts/scan.js';
import { decodeGridLogical, ScannerError } from '../qr/index.js';
import {
  hybridBinarize,
  otsuBinarize,
  sauvolaBinarize,
  toChannelGray,
  toGrayscale,
} from './binarize.js';
import {
  detectFinderCandidatePool,
  type FinderCandidate,
  type FinderTriple,
  findBestFinderTriples,
} from './detect.js';
import { locateAlignmentPatternCorrespondences } from './detect-alignment.js';
import { detectFinderCandidatesMatcher } from './detect-finders.js';
import { detectFinderCandidatesFlood } from './detect-flood.js';
import { detectAlignmentCandidatesQuad, detectFinderCandidatesQuad } from './detect-quads.js';
import {
  buildGridResolutionFromHomography,
  candidateVersions,
  fitHomography,
  type GridResolution,
  resolveGrid,
  resolveGridFromCorners,
  resolveGridFromCorrespondences,
} from './geometry.js';
import { toImageData } from './image.js';
import { createOklabContrastField, toOklabPlanes } from './oklab.js';
import { refineGridFitness } from './refine-fitness.js';
import { sampleGrid } from './sample.js';

const DEFAULT_MAX_CANDIDATES = 8;
const MAX_TRIPLE_MULTIPLIER = 4;
const MERGED_POOL_DUPLICATE_RADIUS = 3;
const QUAD_FINDER_MAX_ASPECT = 2;
const QUAD_FINDER_CANDIDATE_LIMIT = 24;
const QUAD_ALIGNMENT_CANDIDATE_LIMIT = 5;

/**
 * Builds the single-frame QR scanning pipeline as an Effect program.
 *
 * Pipeline: toImageData → toGrayscale → binarize → detect finder pools
 *   → resolveGrid → sampleGrid → decodeGridLogical → ScanResult[].
 *
 * Tries multiple binarization strategies and both polarities. Otsu (global
 * threshold) is fast and works for clean inputs; Sauvola (adaptive local
 * threshold) handles non-uniform illumination, small QRs in textured
 * scenes, and high-key photos where the QR's local foreground/background
 * relationship differs from the global one. Both polarities cover
 * light-on-dark QR codes.
 *
 * Succeeds with an empty array when no QR symbol is detected or decoding
 * fails. Fails through the Effect error channel when image conversion or an
 * unexpected decoder/internal error fails.
 *
 * @param input - Any supported browser image source.
 * @param options - Scan behavior overrides.
 * @returns An Effect yielding decoded QR symbols from the frame.
 */
export const scanFrame = (input: BrowserImageSource, options: ScanOptions = {}) => {
  return Effect.gen(function* () {
    const imageData = yield* Effect.tryPromise(() => toImageData(input));
    const { width, height } = imageData;
    const allowMultiple = options.allowMultiple === true;
    const tripleLimit = normalizeMaxCandidates(options.maxCandidates);

    const luma = toGrayscale(imageData);
    const contrast = createOklabContrastField(toOklabPlanes(imageData));

    const otsu = otsuBinarize(luma, width, height);
    let sauvolaLarge: Uint8Array | null = null;
    let sauvolaSmall: Uint8Array | null = null;
    let blueGray: Uint8Array | null = null;
    let redGray: Uint8Array | null = null;
    let blueOtsu: Uint8Array | null = null;
    let redOtsu: Uint8Array | null = null;

    const lazySauvolaLarge = (): Uint8Array => {
      if (sauvolaLarge === null) sauvolaLarge = sauvolaBinarize(luma, width, height);
      return sauvolaLarge;
    };
    const lazySauvolaSmall = (): Uint8Array => {
      if (sauvolaSmall === null) sauvolaSmall = sauvolaBinarize(luma, width, height, 24);
      return sauvolaSmall;
    };
    const lazyBlueOtsu = (): Uint8Array => {
      if (blueGray === null) blueGray = toChannelGray(imageData, 2);
      if (blueOtsu === null) blueOtsu = otsuBinarize(blueGray, width, height);
      return blueOtsu;
    };
    const lazyRedOtsu = (): Uint8Array => {
      if (redGray === null) redGray = toChannelGray(imageData, 0);
      if (redOtsu === null) redOtsu = otsuBinarize(redGray, width, height);
      return redOtsu;
    };

    const variants: readonly (() => Uint8Array)[] = [
      () => otsu,
      () => invertBinary(otsu),
      lazySauvolaLarge,
      () => invertBinary(lazySauvolaLarge()),
      lazySauvolaSmall,
      () => invertBinary(lazySauvolaSmall()),
      lazyBlueOtsu,
      () => invertBinary(lazyBlueOtsu()),
      lazyRedOtsu,
      () => invertBinary(lazyRedOtsu()),
    ];

    const results: ScanResult[] = [];
    const seen = new Set<string>();

    for (const makeCandidate of variants) {
      const candidate = makeCandidate();
      const rowScanPool = detectFinderCandidatePool(candidate, width, height);
      const floodPool = detectFinderCandidatesFlood(candidate, width, height);
      const matcherPool = detectFinderCandidatesMatcher(candidate, width, height, contrast);
      const triples = collectFinderTriples(rowScanPool, floodPool, matcherPool, tripleLimit);
      if (triples.length === 0) continue;

      for (const triple of triples) {
        for (const version of candidateVersions(triple, 2)) {
          const initialResolution = resolveGrid(triple, version);
          if (initialResolution === null) continue;

          const baseResolution = refineGridFitness(initialResolution, candidate, width, height);
          const candidateResolutions: GridResolution[] = [baseResolution];

          if (version >= 2) {
            const alignmentPoints = locateAlignmentPatternCorrespondences(
              baseResolution,
              candidate,
              width,
              height,
            );
            if (alignmentPoints.length > 0) {
              const alignmentRefit = resolveGridFromCorrespondences(
                triple,
                version,
                alignmentPoints,
              );
              if (alignmentRefit !== null) {
                candidateResolutions.push(
                  refineGridFitness(alignmentRefit, candidate, width, height),
                );
              }
            }
          }

          for (const resolution of candidateResolutions) {
            const result = yield* tryDecodeResolution(resolution, candidate, width, height);
            if (result !== null && pushUniqueResult(results, seen, result)) {
              if (!allowMultiple) return results;
            }

            if (resolution.version !== 1) continue;
            for (const nudged of bottomRightCornerFallbacks(resolution)) {
              const nudgedResult = yield* tryDecodeResolution(nudged, candidate, width, height);
              if (nudgedResult !== null && pushUniqueResult(results, seen, nudgedResult)) {
                if (!allowMultiple) return results;
              }
            }
          }
        }
      }
    }

    if (results.length > 0) return results;

    const quadFallbackResult = yield* tryDecodeQuadFallback(luma, contrast, width, height);
    if (quadFallbackResult !== null) results.push(quadFallbackResult);
    return results;
  });
};

const tryDecodeResolution = (
  resolution: GridResolution,
  binary: Uint8Array,
  width: number,
  height: number,
): Effect.Effect<ScanResult | null, ScannerError> => {
  return Effect.gen(function* () {
    const grid = sampleGrid(width, height, resolution, binary);
    if (!timingRowLooksValid(grid)) return null;

    const decoded = yield* decodeGridLogical({ grid }).pipe(
      Effect.catchIf(
        (error): error is ScannerError =>
          error instanceof ScannerError && error.code === 'decode_failed',
        () => Effect.succeed(null),
      ),
    );
    if (decoded === null) return null;

    return {
      payload: decoded.payload,
      confidence: decoded.confidence,
      version: decoded.version,
      errorCorrectionLevel: decoded.errorCorrectionLevel,
      bounds: resolution.bounds,
      corners: resolution.corners,
      headers: decoded.headers,
      segments: decoded.segments,
    } satisfies ScanResult;
  });
};

const tryDecodeQuadFallback = (
  luma: Uint8Array,
  _contrast: ReturnType<typeof createOklabContrastField>,
  width: number,
  height: number,
): Effect.Effect<ScanResult | null, ScannerError> => {
  return Effect.gen(function* () {
    const binary = hybridBinarize(luma, width, height);
    const quadFinders = detectFinderCandidatesQuad(binary, width, height)
      .filter((finder) => finderAspect(finder) <= QUAD_FINDER_MAX_ASPECT)
      .sort((left, right) => right.moduleSize - left.moduleSize)
      .slice(0, QUAD_FINDER_CANDIDATE_LIMIT);
    if (quadFinders.length < 3) return null;

    const alignmentCandidates = detectAlignmentCandidatesQuad(binary, width, height);
    if (alignmentCandidates.length === 0) return null;

    for (const triple of enumerateFinderTriples(quadFinders)) {
      for (const version of candidateVersions(triple, 4)) {
        if (version < 2) continue;
        const { topLeft, topRight, bottomLeft } = orientFinderTriple(triple);
        const expectedAlignment = expectedAlignmentPoint(topLeft, topRight, bottomLeft);
        const candidateAlignments = alignmentCandidates
          .slice()
          .sort(
            (left, right) =>
              Math.hypot(left.x - expectedAlignment.x, left.y - expectedAlignment.y) -
              Math.hypot(right.x - expectedAlignment.x, right.y - expectedAlignment.y),
          )
          .slice(0, QUAD_ALIGNMENT_CANDIDATE_LIMIT);

        for (const alignment of candidateAlignments) {
          const resolution = resolveCenterBasedGrid(triple, version, alignment);
          if (resolution === null) continue;

          const result = yield* tryDecodeResolutionNearest(resolution, binary, width, height);
          if (result !== null) return result;
        }
      }
    }

    return null;
  });
};

const tryDecodeResolutionNearest = (
  resolution: GridResolution,
  binary: Uint8Array,
  width: number,
  height: number,
): Effect.Effect<ScanResult | null, ScannerError> => {
  return Effect.gen(function* () {
    const grid = sampleGridNearest(width, height, resolution, binary);
    const decoded = yield* decodeGridLogical({ grid }).pipe(
      Effect.catchIf(
        (error): error is ScannerError =>
          error instanceof ScannerError && error.code === 'decode_failed',
        () => Effect.succeed(null),
      ),
    );
    if (decoded === null) return null;

    return {
      payload: decoded.payload,
      confidence: decoded.confidence,
      version: decoded.version,
      errorCorrectionLevel: decoded.errorCorrectionLevel,
      bounds: resolution.bounds,
      corners: resolution.corners,
      headers: decoded.headers,
      segments: decoded.segments,
    } satisfies ScanResult;
  });
};

const sampleGridNearest = (
  width: number,
  height: number,
  resolution: GridResolution,
  binary: Uint8Array,
): boolean[][] => {
  return Array.from({ length: resolution.size }, (_, row) =>
    Array.from({ length: resolution.size }, (_, col) => {
      const point = resolution.samplePoint(row, col);
      const px = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
      const py = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
      return binary[py * width + px] === 0;
    }),
  );
};

const orientFinderTriple = (
  triple: FinderTriple,
): {
  readonly topLeft: FinderCandidate;
  readonly topRight: FinderCandidate;
  readonly bottomLeft: FinderCandidate;
} => {
  const [fa, fb, fc] = triple;
  const dAB = Math.hypot(fb.cx - fa.cx, fb.cy - fa.cy);
  const dAC = Math.hypot(fc.cx - fa.cx, fc.cy - fa.cy);
  const dBC = Math.hypot(fc.cx - fb.cx, fc.cy - fb.cy);

  let topLeft: FinderCandidate;
  let topRight: FinderCandidate;
  let bottomLeft: FinderCandidate;
  if (dAB >= dAC && dAB >= dBC) {
    topLeft = fc;
    topRight = fa;
    bottomLeft = fb;
  } else if (dAC >= dAB && dAC >= dBC) {
    topLeft = fb;
    topRight = fa;
    bottomLeft = fc;
  } else {
    topLeft = fa;
    topRight = fb;
    bottomLeft = fc;
  }

  const cross =
    (topRight.cx - topLeft.cx) * (bottomLeft.cy - topLeft.cy) -
    (topRight.cy - topLeft.cy) * (bottomLeft.cx - topLeft.cx);
  if (cross < 0) [topRight, bottomLeft] = [bottomLeft, topRight];

  return { topLeft, topRight, bottomLeft };
};

const expectedAlignmentPoint = (
  topLeft: FinderCandidate,
  topRight: FinderCandidate,
  bottomLeft: FinderCandidate,
): Point => {
  const bottomRight = {
    x: topRight.cx - topLeft.cx + bottomLeft.cx,
    y: topRight.cy - topLeft.cy + bottomLeft.cy,
  };
  const moduleSize = (topLeft.moduleSize + topRight.moduleSize + bottomLeft.moduleSize) / 3;
  const modulesBetweenFinderPatterns =
    (Math.hypot(bottomLeft.cx - topLeft.cx, bottomLeft.cy - topLeft.cy) +
      Math.hypot(topRight.cx - topLeft.cx, topRight.cy - topLeft.cy)) /
    2 /
    moduleSize;
  const correctionToTopLeft = 1 - 3 / Math.max(modulesBetweenFinderPatterns, 1);

  return {
    x: topLeft.cx + correctionToTopLeft * (bottomRight.x - topLeft.cx),
    y: topLeft.cy + correctionToTopLeft * (bottomRight.y - topLeft.cy),
  };
};

const resolveCenterBasedGrid = (
  triple: FinderTriple,
  version: number,
  alignment: Point,
): GridResolution | null => {
  const { topLeft, topRight, bottomLeft } = orientFinderTriple(triple);
  const size = version * 4 + 17;
  const pairs = [
    [
      { x: 3, y: 3 },
      { x: topLeft.cx, y: topLeft.cy },
    ],
    [
      { x: size - 4, y: 3 },
      { x: topRight.cx, y: topRight.cy },
    ],
    [
      { x: 3, y: size - 4 },
      { x: bottomLeft.cx, y: bottomLeft.cy },
    ],
    [{ x: size - 7, y: size - 7 }, alignment],
  ] as const;

  const homography = fitHomography(pairs);
  if (homography === null) return null;
  return buildGridResolutionFromHomography(version, size, homography);
};

const enumerateFinderTriples = (finders: readonly FinderCandidate[]): readonly FinderTriple[] => {
  const triples: FinderTriple[] = [];
  for (let i = 0; i < finders.length - 2; i += 1) {
    for (let j = i + 1; j < finders.length - 1; j += 1) {
      for (let k = j + 1; k < finders.length; k += 1) {
        const first = finders[i];
        const second = finders[j];
        const third = finders[k];
        if (!first || !second || !third) continue;
        triples.push([first, second, third]);
      }
    }
  }
  return triples;
};

const finderAspect = (finder: FinderCandidate): number => {
  return (
    Math.max(finder.hModuleSize, finder.vModuleSize) /
    Math.max(1e-6, Math.min(finder.hModuleSize, finder.vModuleSize))
  );
};

const normalizeMaxCandidates = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_MAX_CANDIDATES;
  if (!Number.isFinite(value)) return DEFAULT_MAX_CANDIDATES;
  return Math.max(1, Math.trunc(value));
};

const pushUniqueResult = (
  results: ScanResult[],
  seen: Set<string>,
  result: ScanResult,
): boolean => {
  const key = [
    result.version,
    result.payload.kind,
    Array.from(result.payload.bytes).join(','),
    Math.round(result.bounds.x),
    Math.round(result.bounds.y),
    Math.round(result.bounds.width),
    Math.round(result.bounds.height),
  ].join('|');
  if (seen.has(key)) return false;
  seen.add(key);
  results.push(result);
  return true;
};

const bottomRightCornerFallbacks = (resolution: GridResolution): readonly GridResolution[] => {
  const { corners, size } = resolution;
  const stepDenominator = Math.max(1, size - 1);
  const colStep = {
    x: (corners.bottomRight.x - corners.bottomLeft.x) / stepDenominator,
    y: (corners.bottomRight.y - corners.bottomLeft.y) / stepDenominator,
  };
  const rowStep = {
    x: (corners.bottomRight.x - corners.topRight.x) / stepDenominator,
    y: (corners.bottomRight.y - corners.topRight.y) / stepDenominator,
  };

  const deltas: readonly (readonly [number, number])[] = [
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

  const candidates: GridResolution[] = [];
  for (const [deltaCol, deltaRow] of deltas) {
    const rebuilt = resolveGridFromCorners(resolution, {
      ...corners,
      bottomRight: {
        x: corners.bottomRight.x + deltaCol * colStep.x + deltaRow * rowStep.x,
        y: corners.bottomRight.y + deltaCol * colStep.y + deltaRow * rowStep.y,
      },
    });
    if (rebuilt !== null) candidates.push(rebuilt);
  }
  return candidates;
};

const mergeFinderPools = (
  primary: readonly FinderCandidate[],
  secondary: readonly FinderCandidate[],
): FinderCandidate[] => {
  const merged: FinderCandidate[] = [...primary];
  for (const candidate of secondary) {
    const duplicate = merged.some((existing) => {
      const minModuleSize = Math.min(existing.moduleSize, candidate.moduleSize);
      const distance = Math.hypot(existing.cx - candidate.cx, existing.cy - candidate.cy);
      // Cross-detector merging stays looser than per-detector compaction because
      // row-scan, flood, and matcher centers can land a couple of modules apart
      // on the same finder under skew/noise while still representing one symbol.
      return distance < minModuleSize * MERGED_POOL_DUPLICATE_RADIUS;
    });
    if (!duplicate) merged.push(candidate);
  }
  return merged;
};

const collectFinderTriples = (
  rowScanPool: readonly FinderCandidate[],
  floodPool: readonly FinderCandidate[],
  matcherPool: readonly FinderCandidate[],
  limit: number,
): readonly FinderTriple[] => {
  const seen = new Set<string>();
  const deduped: FinderTriple[] = [];
  const poolFactories: readonly (() => readonly FinderCandidate[])[] = [
    () => rowScanPool,
    () => [...rowScanPool, ...floodPool],
    () => matcherPool,
    () => [...rowScanPool, ...floodPool, ...matcherPool],
    () => mergeFinderPools(mergeFinderPools(rowScanPool, floodPool), matcherPool),
  ];

  for (const makePool of poolFactories) {
    if (deduped.length >= limit * MAX_TRIPLE_MULTIPLIER) break;
    const pool = makePool();
    if (pool.length < 3) continue;

    for (const triple of findBestFinderTriples(pool, limit)) {
      const key = triple
        .map((finder) => `${Math.round(finder.cx)}:${Math.round(finder.cy)}`)
        .sort()
        .join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(triple);
      if (deduped.length >= limit * MAX_TRIPLE_MULTIPLIER) break;
    }
  }

  return deduped;
};

/** Returns a new binary array with 0↔255 swapped. */
const invertBinary = (binary: Uint8Array): Uint8Array => {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary[i] === 0 ? 255 : 0;
  }
  return out;
};

/**
 * Validates that a sampled grid's row-6 timing pattern alternates dark/light
 * for the expected fraction of cells. The QR spec requires perfect
 * alternation between the two top finders (columns 8..size-9), starting and
 * ending with dark. We tolerate up to 25% error to allow for one or two bad
 * cells from sampling noise; below that, the grid geometry is almost
 * certainly wrong and we should skip the expensive decode attempt.
 */
const timingRowLooksValid = (grid: boolean[][]): boolean => {
  const size = grid.length;
  if (size < 21) return false;
  const row = grid[6];
  if (!row) return false;

  let total = 0;
  let correct = 0;
  for (let col = 8; col <= size - 9; col += 1) {
    const cell = row[col];
    if (cell === undefined) continue;
    const expected = col % 2 === 0;
    total += 1;
    if (cell === expected) correct += 1;
  }

  return total > 0 && correct / total >= 0.75;
};
