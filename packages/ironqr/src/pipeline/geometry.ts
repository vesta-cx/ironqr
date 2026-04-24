import type { Bounds, CornerSet, Point } from '../contracts/geometry.js';
import type {
  FinderEvidence,
  FinderTripleProposal,
  QuadProposal,
  ScanProposal,
} from './proposals.js';
import type { TraceSink } from './trace.js';
import type { BinaryViewId } from './views.js';

const FINDER_CENTER_OFFSET = 3;
const FINDER_EDGE_OFFSET = 3.5;

/**
 * Geometry strategy used to build a candidate.
 */
export type GeometryMode = 'finder-homography' | 'center-homography' | 'quad-homography';

/**
 * Row-major 3×3 homography matrix.
 */
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Core resolved QR geometry used by samplers and refiners.
 */
export interface GridResolution {
  /** Resolved QR version. */
  readonly version: number;
  /** Modules per side. */
  readonly size: number;
  /** Projective mapping from logical grid coordinates to image coordinates. */
  readonly homography: Homography;
  /** Resolved QR boundary corners in image coordinates. */
  readonly corners: CornerSet;
  /** Bounding box enclosing the resolved corners. */
  readonly bounds: Bounds;
  /** Samples the image coordinate for one logical module center. */
  readonly samplePoint: (gridRow: number, gridCol: number) => Point;
  /** Optional stable geometry candidate id. */
  readonly id?: string;
  /** Optional source proposal id. */
  readonly proposalId?: string;
  /** Optional source binary view id. */
  readonly binaryViewId?: BinaryViewId;
  /** Optional geometry construction mode. */
  readonly geometryMode?: GeometryMode;
  /** Optional heuristic geometry confidence. */
  readonly geometryScore?: number;
}

/**
 * Resolved QR geometry candidate ready for sampling and decode.
 */
export interface GeometryCandidate extends GridResolution {
  /** Stable geometry candidate id. */
  readonly id: string;
  /** Source proposal id. */
  readonly proposalId: string;
  /** Binary view that produced the proposal. */
  readonly binaryViewId: BinaryViewId;
  /** Geometry construction mode. */
  readonly geometryMode: GeometryMode;
  /** Heuristic geometry confidence. */
  readonly geometryScore: number;
}

/**
 * Geometry-stage options.
 */
export interface GeometryOptions {
  /** Optional trace sink used to report geometry materialization. */
  readonly traceSink?: TraceSink;
  /** Optional explicit version list overriding the proposal defaults. */
  readonly versionOverrides?: readonly number[];
}

/**
 * Builds geometry candidates for one ranked proposal.
 *
 * @param proposal - Ranked proposal to resolve.
 * @param options - Optional trace configuration.
 * @returns Cheap geometry candidates ordered best-first.
 */
export const createGeometryCandidates = (
  proposal: ScanProposal,
  options: GeometryOptions = {},
): readonly GeometryCandidate[] => {
  const candidateProposal =
    options.versionOverrides === undefined
      ? proposal
      : ({
          ...proposal,
          estimatedVersions: options.versionOverrides
            .filter(isValidQrVersion)
            .map((version) => Math.trunc(version)),
        } satisfies ScanProposal);
  const candidates =
    candidateProposal.kind === 'finder-triple'
      ? createFinderGeometryCandidates(candidateProposal)
      : createQuadGeometryCandidates(candidateProposal);

  for (const candidate of candidates) {
    options.traceSink?.emit({
      type: 'geometry-candidate-created',
      geometryCandidateId: candidate.id,
      proposalId: candidate.proposalId,
      binaryViewId: candidate.binaryViewId,
      version: candidate.version,
      geometryMode: candidate.geometryMode,
      geometryScore: candidate.geometryScore,
    });
  }

  return candidates;
};

/**
 * Resolves QR geometry directly from three finder evidences.
 *
 * @param finders - Three finder evidences.
 * @param overrideVersion - Optional version override.
 * @returns The best geometry candidate, or `null` when resolution fails.
 */
export const resolveGrid = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
  overrideVersion?: number,
): GridResolution | null => {
  const versions =
    overrideVersion === undefined ? candidateVersionsFromFinders(finders, 2) : [overrideVersion];
  for (const version of versions) {
    const proposal: FinderTripleProposal = {
      id: `resolve:${version}`,
      kind: 'finder-triple',
      binaryViewId: 'gray:otsu:normal',
      finders,
      estimatedVersions: [version],
      proposalScore: 0,
      scoreBreakdown: emptyScoreBreakdown(),
    };
    const resolved = createFinderGeometryCandidates(proposal)[0];
    if (resolved) return resolved;
  }
  return null;
};

/**
 * Rebuilds geometry from fixed boundary corners.
 *
 * @param original - Existing geometry candidate.
 * @param corners - Replacement corners.
 * @returns A new geometry candidate or `null` if the fit is degenerate.
 */
export const resolveGridFromCorners = (
  original: GridResolution,
  corners: CornerSet,
): GridResolution | null => {
  const pairs: readonly (readonly [Point, Point])[] = [
    [{ x: -0.5, y: -0.5 }, corners.topLeft],
    [{ x: original.size - 0.5, y: -0.5 }, corners.topRight],
    [{ x: original.size - 0.5, y: original.size - 0.5 }, corners.bottomRight],
    [{ x: -0.5, y: original.size - 0.5 }, corners.bottomLeft],
  ];
  const homography = fitHomography(pairs);
  if (homography === null) return null;
  return buildGridResolutionFromHomography(
    original.version,
    original.size,
    homography,
    original.id ?? 'resolve:corners',
    original.proposalId ?? 'resolve',
    original.binaryViewId ?? 'gray:otsu:normal',
    original.geometryMode ?? 'center-homography',
    original.geometryScore ?? 0,
  );
};

/**
 * Rebuilds geometry from a base finder triple plus extra logical/image anchors.
 *
 * @param finders - Finder triple.
 * @param version - Explicit QR version.
 * @param extraPoints - Extra correspondences such as alignment centers.
 * @returns A refined geometry candidate, or `null` on degenerate fit.
 */
export const resolveGridFromCorrespondences = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
  version: number,
  extraPoints: readonly ExtraCorrespondence[],
): GridResolution | null => {
  const oriented = orientFinderTriple(finders);
  if (oriented === null) return null;
  const size = version * 4 + 17;
  const right = normalisePoint(
    oriented.topRight.centerX - oriented.topLeft.centerX,
    oriented.topRight.centerY - oriented.topLeft.centerY,
  );
  const down = normalisePoint(
    oriented.bottomLeft.centerX - oriented.topLeft.centerX,
    oriented.bottomLeft.centerY - oriented.topLeft.centerY,
  );
  if (right === null || down === null) return null;

  const correspondences = [
    ...finderEdgeCorrespondences(
      oriented.topLeft,
      FINDER_CENTER_OFFSET,
      FINDER_CENTER_OFFSET,
      right,
      down,
    ),
    ...finderEdgeCorrespondences(
      oriented.topRight,
      FINDER_CENTER_OFFSET,
      size - 1 - FINDER_CENTER_OFFSET,
      right,
      down,
    ),
    ...finderEdgeCorrespondences(
      oriented.bottomLeft,
      size - 1 - FINDER_CENTER_OFFSET,
      FINDER_CENTER_OFFSET,
      right,
      down,
    ),
    ...extraPoints.map(
      (point) =>
        [
          { x: point.moduleCol, y: point.moduleRow },
          { x: point.pixelX, y: point.pixelY },
        ] as const,
    ),
  ];

  const homography = fitHomography(correspondences);
  if (homography === null) return null;
  return buildGridResolutionFromHomography(
    version,
    size,
    homography,
    'resolve:refit',
    'resolve',
    'gray:otsu:normal',
    'finder-homography',
    0,
  );
};

/**
 * Extra logical/image correspondence used for geometry refits.
 */
export interface ExtraCorrespondence {
  /** Logical module row. */
  readonly moduleRow: number;
  /** Logical module column. */
  readonly moduleCol: number;
  /** Image-space x coordinate. */
  readonly pixelX: number;
  /** Image-space y coordinate. */
  readonly pixelY: number;
}

/**
 * Maps one logical grid coordinate through a homography.
 *
 * @param homography - Projective transform.
 * @param gridCol - Logical column coordinate.
 * @param gridRow - Logical row coordinate.
 * @returns Image-space point.
 */
export const applyHomography = (
  homography: Homography,
  gridCol: number,
  gridRow: number,
): Point => {
  const denominator = homography[6] * gridCol + homography[7] * gridRow + homography[8];
  if (Math.abs(denominator) < 1e-9) {
    return { x: Number.NaN, y: Number.NaN };
  }
  return {
    x: (homography[0] * gridCol + homography[1] * gridRow + homography[2]) / denominator,
    y: (homography[3] * gridCol + homography[4] * gridRow + homography[5]) / denominator,
  };
};

/**
 * Fits a homography from logical/image correspondences.
 *
 * @param correspondences - At least four point correspondences.
 * @returns A projective transform or `null` when the fit is degenerate.
 */
export const fitHomography = (
  correspondences: readonly (readonly [Point, Point])[],
): Homography | null => {
  if (correspondences.length < 4) return null;
  if (
    correspondences.some(
      ([grid, image]) =>
        !Number.isFinite(grid.x) ||
        !Number.isFinite(grid.y) ||
        !Number.isFinite(image.x) ||
        !Number.isFinite(image.y),
    )
  ) {
    return null;
  }
  const normalMatrix = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const normalVector = new Array<number>(8).fill(0);

  for (const [grid, image] of correspondences) {
    const rows = [
      [grid.x, grid.y, 1, 0, 0, 0, -grid.x * image.x, -grid.y * image.x],
      [0, 0, 0, grid.x, grid.y, 1, -grid.x * image.y, -grid.y * image.y],
    ] as const;
    const targets = [image.x, image.y] as const;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      const target = targets[rowIndex] ?? 0;
      for (let i = 0; i < 8; i += 1) {
        const rowValue = row[i] ?? 0;
        normalVector[i] = (normalVector[i] ?? 0) + rowValue * target;
        for (let j = 0; j < 8; j += 1) {
          normalMatrix[i]![j] = (normalMatrix[i]![j] ?? 0) + rowValue * (row[j] ?? 0);
        }
      }
    }
  }

  const solution = solveLinearSystem(normalMatrix, normalVector);
  if (solution === null) return null;
  return [
    solution[0] ?? 0,
    solution[1] ?? 0,
    solution[2] ?? 0,
    solution[3] ?? 0,
    solution[4] ?? 0,
    solution[5] ?? 0,
    solution[6] ?? 0,
    solution[7] ?? 0,
    1,
  ];
};

/**
 * Builds a geometry candidate from a homography.
 *
 * @param version - QR version.
 * @param size - Modules per side.
 * @param homography - Projective transform.
 * @param id - Geometry candidate id.
 * @param proposalId - Source proposal id.
 * @param binaryViewId - Source binary view id.
 * @param geometryMode - Geometry strategy.
 * @param geometryScore - Geometry confidence.
 * @returns A geometry candidate or `null` when corners become non-finite.
 */
export const buildGridResolutionFromHomography = (
  version: number,
  size: number,
  homography: Homography,
  id: string,
  proposalId: string,
  binaryViewId: BinaryViewId,
  geometryMode: GeometryMode,
  geometryScore: number,
): GeometryCandidate | null => {
  if (!isValidQrVersion(version) || !Number.isInteger(size) || size !== version * 4 + 17) {
    return null;
  }

  const corners = {
    topLeft: applyHomography(homography, -0.5, -0.5),
    topRight: applyHomography(homography, size - 0.5, -0.5),
    bottomRight: applyHomography(homography, size - 0.5, size - 0.5),
    bottomLeft: applyHomography(homography, -0.5, size - 0.5),
  } satisfies CornerSet;
  if (!areFiniteCorners(corners) || polygonArea(corners) < 1e-6) return null;

  const xs = [corners.topLeft.x, corners.topRight.x, corners.bottomRight.x, corners.bottomLeft.x];
  const ys = [corners.topLeft.y, corners.topRight.y, corners.bottomRight.y, corners.bottomLeft.y];
  const bounds = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  } satisfies Bounds;

  return {
    id,
    proposalId,
    binaryViewId,
    version,
    size,
    geometryMode,
    homography,
    corners,
    bounds,
    geometryScore,
    samplePoint(gridRow, gridCol) {
      return applyHomography(homography, gridCol, gridRow);
    },
  } satisfies GeometryCandidate;
};

const PRIMARY_VERSION_SCALE_FACTORS = [1] as const;
const RESCUE_VERSION_SCALE_FACTORS = [1, 1.25, 1.5, 2, 2.5, 3, 4] as const;
const MAX_PRIMARY_VERSION_CANDIDATES = 8;
const MAX_RESCUE_VERSION_CANDIDATES = 24;

/**
 * Returns plausible primary QR versions for a finder triple in best-first order.
 *
 * @param finders - Finder triple.
 * @param span - Symmetric retry span around the nearest estimate.
 * @returns Unique candidate versions.
 */
export const candidateVersionsFromFinders = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
  span = 2,
): readonly number[] => {
  const oriented = orientFinderTriple(finders);
  if (oriented === null) return [];
  return buildAdaptiveVersionCandidates(oriented, {
    span,
    scaleFactors: PRIMARY_VERSION_SCALE_FACTORS,
    maxCandidates: MAX_PRIMARY_VERSION_CANDIDATES,
  });
};

/**
 * Returns a wider QR-version rescue neighborhood for hard decode attempts.
 *
 * @param finders - Finder triple.
 * @param current - Current primary version candidates.
 * @returns Unique rescue candidates in retry order.
 */
export const rescueVersionsFromFinders = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
  current: readonly number[] = [],
): readonly number[] => {
  const oriented = orientFinderTriple(finders);
  if (oriented === null) return expandVersionNeighborhood(current);
  return mergeVersionCandidates(
    current,
    buildAdaptiveVersionCandidates(oriented, {
      span: 1,
      scaleFactors: RESCUE_VERSION_SCALE_FACTORS,
      maxCandidates: MAX_RESCUE_VERSION_CANDIDATES,
    }),
    MAX_RESCUE_VERSION_CANDIDATES,
  );
};

/**
 * Expands a version list with nearby and scale-adjusted rescue candidates.
 *
 * @param current - Current primary version candidates.
 * @param maxCandidates - Maximum returned candidate count.
 * @returns Unique rescue candidates in retry order.
 */
export const expandVersionNeighborhood = (
  current: readonly number[],
  maxCandidates = MAX_RESCUE_VERSION_CANDIDATES,
): readonly number[] => {
  if (current.length === 0) {
    return [1, 2, 3, 5, 7, 10, 14, 19, 25, 32, 40].slice(0, maxCandidates);
  }

  const ordered: number[] = [];
  const seen = new Set<number>();
  const push = (value: number): void => {
    const clamped = clampQrVersion(value);
    if (seen.has(clamped)) return;
    seen.add(clamped);
    ordered.push(clamped);
  };

  for (const version of current) push(version);
  for (const version of current) {
    for (const neighbor of [version - 1, version + 1, version + 2]) {
      push(neighbor);
    }
  }
  for (const factor of RESCUE_VERSION_SCALE_FACTORS) {
    for (const version of current) {
      const modulesAcross = versionToModulesAcross(version);
      push(modulesAcrossToVersion(modulesAcross * factor));
    }
  }

  push(1);
  return ordered.slice(0, maxCandidates);
};

interface AdaptiveVersionOptions {
  readonly span: number;
  readonly scaleFactors: readonly number[];
  readonly maxCandidates: number;
}

const buildAdaptiveVersionCandidates = (
  oriented: {
    readonly topLeft: FinderEvidence;
    readonly topRight: FinderEvidence;
    readonly bottomLeft: FinderEvidence;
  },
  options: AdaptiveVersionOptions,
): readonly number[] => {
  const modulesAcrossSignals = buildFinderModulesAcrossSignals(oriented);
  if (modulesAcrossSignals.length === 0) return [];

  const baseVersions = uniqueSortedVersions(modulesAcrossSignals.map(modulesAcrossToVersion));
  const anchor = modulesAcrossToVersion(modulesAcrossSignals[0] ?? 21);
  const ordered: number[] = [];
  const seen = new Set<number>();
  const push = (value: number): void => {
    const clamped = clampQrVersion(value);
    if (seen.has(clamped)) return;
    seen.add(clamped);
    ordered.push(clamped);
  };

  push(anchor);
  push(1);
  for (let offset = 1; offset <= options.span; offset += 1) {
    push(anchor + offset);
    push(anchor - offset);
  }
  for (const version of sortByAnchorDistance(baseVersions, anchor)) {
    push(version);
  }

  for (const factor of options.scaleFactors) {
    if (factor <= 1) continue;
    const scaledVersions = uniqueSortedVersions(
      modulesAcrossSignals.map((modulesAcross) => modulesAcrossToVersion(modulesAcross * factor)),
    );
    const scaledAnchor = medianRounded(scaledVersions);
    push(scaledAnchor);
    push(scaledAnchor - 1);
    push(scaledAnchor + 1);
    for (const version of sortByAnchorDistance(scaledVersions, scaledAnchor)) {
      push(version);
    }
  }

  return ordered.slice(0, options.maxCandidates);
};

const buildFinderModulesAcrossSignals = (oriented: {
  readonly topLeft: FinderEvidence;
  readonly topRight: FinderEvidence;
  readonly bottomLeft: FinderEvidence;
}): readonly number[] => {
  const horizontal = distance(oriented.topLeft, oriented.topRight);
  const vertical = distance(oriented.topLeft, oriented.bottomLeft);
  const diagonal = distance(oriented.topRight, oriented.bottomLeft);
  const signals = [
    (horizontal + vertical) /
      2 /
      average([
        oriented.topLeft.moduleSize,
        oriented.topRight.moduleSize,
        oriented.bottomLeft.moduleSize,
      ]),
    horizontal / average([oriented.topLeft.hModuleSize, oriented.topRight.hModuleSize]),
    vertical / average([oriented.topLeft.vModuleSize, oriented.bottomLeft.vModuleSize]),
    horizontal /
      Math.max(1e-6, Math.min(oriented.topLeft.hModuleSize, oriented.topRight.hModuleSize)),
    vertical /
      Math.max(1e-6, Math.min(oriented.topLeft.vModuleSize, oriented.bottomLeft.vModuleSize)),
    diagonal / average([oriented.topRight.moduleSize, oriented.bottomLeft.moduleSize]),
  ];
  return signals.filter((value) => Number.isFinite(value) && value > 0);
};

const average = (values: readonly number[]): number => {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
};

const weightedPitch = (observed: number, target: number): number => {
  return Math.max(1e-6, observed * 0.25 + target * 0.75);
};

const uniqueSortedVersions = (values: readonly number[]): number[] => {
  return Array.from(new Set(values.map(clampQrVersion))).sort((left, right) => left - right);
};

const sortByAnchorDistance = (versions: readonly number[], anchor: number): number[] => {
  return [...versions].sort((left, right) => {
    const leftDistance = Math.abs(left - anchor);
    const rightDistance = Math.abs(right - anchor);
    return leftDistance === rightDistance ? left - right : leftDistance - rightDistance;
  });
};

const medianRounded = (values: readonly number[]): number => {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
};

const mergeVersionCandidates = (
  primary: readonly number[],
  secondary: readonly number[],
  maxCandidates: number,
): readonly number[] => {
  const ordered: number[] = [];
  const seen = new Set<number>();
  const push = (value: number): void => {
    const clamped = clampQrVersion(value);
    if (seen.has(clamped)) return;
    seen.add(clamped);
    ordered.push(clamped);
  };
  for (const version of primary) push(version);
  for (const version of secondary) push(version);
  return ordered.slice(0, maxCandidates);
};

const modulesAcrossToVersion = (modulesAcross: number): number => {
  return clampQrVersion(Math.round((modulesAcross - 10) / 4));
};

const versionToModulesAcross = (version: number): number => {
  return clampQrVersion(version) * 4 + 10;
};

const isValidQrVersion = (version: number): boolean => {
  return Number.isInteger(version) && version >= 1 && version <= 40;
};

const clampQrVersion = (version: number): number => {
  return Math.max(1, Math.min(40, Math.round(version)));
};

const createFinderGeometryCandidates = (
  proposal: FinderTripleProposal,
): readonly GeometryCandidate[] => {
  const oriented = orientFinderTriple(proposal.finders);
  if (oriented === null) return [];

  const candidates: GeometryCandidate[] = [];
  const geometrySeeds = proposal.geometrySeeds ?? [];
  let index = 0;
  for (const version of proposal.estimatedVersions) {
    const size = version * 4 + 17;
    const right = normalisePoint(
      oriented.topRight.centerX - oriented.topLeft.centerX,
      oriented.topRight.centerY - oriented.topLeft.centerY,
    );
    const down = normalisePoint(
      oriented.bottomLeft.centerX - oriented.topLeft.centerX,
      oriented.bottomLeft.centerY - oriented.topLeft.centerY,
    );
    if (right === null || down === null) continue;

    const calibratedFinders = calibrateFinderModuleSizes(oriented, version);
    const correspondences = [
      ...finderEdgeCorrespondences(
        calibratedFinders.topLeft,
        FINDER_CENTER_OFFSET,
        FINDER_CENTER_OFFSET,
        right,
        down,
      ),
      ...finderEdgeCorrespondences(
        calibratedFinders.topRight,
        FINDER_CENTER_OFFSET,
        size - 1 - FINDER_CENTER_OFFSET,
        right,
        down,
      ),
      ...finderEdgeCorrespondences(
        calibratedFinders.bottomLeft,
        size - 1 - FINDER_CENTER_OFFSET,
        FINDER_CENTER_OFFSET,
        right,
        down,
      ),
    ];
    const homography = fitHomography(correspondences);
    if (homography !== null) {
      const geometryScore = scoreGeometryCandidate(homography, size, 1);
      const candidate = buildGridResolutionFromHomography(
        version,
        size,
        homography,
        `${proposal.id}:finder:${index}`,
        proposal.id,
        proposal.binaryViewId,
        'finder-homography',
        geometryScore,
      );
      if (candidate) candidates.push(candidate);
      index += 1;
    }

    const centerHomography = fitHomography([
      [
        { x: 3, y: 3 },
        { x: oriented.topLeft.centerX, y: oriented.topLeft.centerY },
      ],
      [
        { x: size - 4, y: 3 },
        { x: oriented.topRight.centerX, y: oriented.topRight.centerY },
      ],
      [
        { x: 3, y: size - 4 },
        { x: oriented.bottomLeft.centerX, y: oriented.bottomLeft.centerY },
      ],
      [
        { x: size - 4, y: size - 4 },
        {
          x: oriented.topRight.centerX + oriented.bottomLeft.centerX - oriented.topLeft.centerX,
          y: oriented.topRight.centerY + oriented.bottomLeft.centerY - oriented.topLeft.centerY,
        },
      ],
    ]);
    if (centerHomography !== null) {
      const geometryScore = scoreGeometryCandidate(centerHomography, size, 0);
      const candidate = buildGridResolutionFromHomography(
        version,
        size,
        centerHomography,
        `${proposal.id}:center:${index}`,
        proposal.id,
        proposal.binaryViewId,
        'center-homography',
        geometryScore,
      );
      if (candidate) candidates.push(candidate);
      index += 1;
    }

    for (const seed of geometrySeeds) {
      if (seed.kind !== 'inferred-quad') continue;
      const candidate = createQuadGeometryCandidateFromCorners(
        proposal.id,
        proposal.binaryViewId,
        seed.corners,
        version,
        index,
        0.5,
      );
      if (candidate) candidates.push(candidate);
      index += 1;
    }
  }

  return candidates.sort((left, right) => right.geometryScore - left.geometryScore);
};

const createQuadGeometryCandidates = (proposal: QuadProposal): readonly GeometryCandidate[] => {
  if (!proposal.corners) return [];
  const candidates: GeometryCandidate[] = [];
  let index = 0;
  for (const version of proposal.estimatedVersions) {
    const candidate = createQuadGeometryCandidateFromCorners(
      proposal.id,
      proposal.binaryViewId,
      proposal.corners,
      version,
      index,
      0.5,
    );
    if (candidate) candidates.push(candidate);
    index += 1;
  }
  return candidates.sort((left, right) => right.geometryScore - left.geometryScore);
};

const createQuadGeometryCandidateFromCorners = (
  proposalId: string,
  binaryViewId: BinaryViewId,
  corners: CornerSet,
  version: number,
  index: number,
  baseScore: number,
): GeometryCandidate | null => {
  const size = version * 4 + 17;
  const homography = fitHomography([
    [{ x: -0.5, y: -0.5 }, corners.topLeft],
    [{ x: size - 0.5, y: -0.5 }, corners.topRight],
    [{ x: size - 0.5, y: size - 0.5 }, corners.bottomRight],
    [{ x: -0.5, y: size - 0.5 }, corners.bottomLeft],
  ]);
  if (homography === null) return null;
  return buildGridResolutionFromHomography(
    version,
    size,
    homography,
    `${proposalId}:quad:${index}`,
    proposalId,
    binaryViewId,
    'quad-homography',
    scoreGeometryCandidate(homography, size, baseScore),
  );
};

const calibrateFinderModuleSizes = (
  oriented: {
    readonly topLeft: FinderEvidence;
    readonly topRight: FinderEvidence;
    readonly bottomLeft: FinderEvidence;
  },
  version: number,
): {
  readonly topLeft: FinderEvidence;
  readonly topRight: FinderEvidence;
  readonly bottomLeft: FinderEvidence;
} => {
  const modulesAcross = version * 4 + 10;
  const horizontalPitch = distance(oriented.topLeft, oriented.topRight) / modulesAcross;
  const verticalPitch = distance(oriented.topLeft, oriented.bottomLeft) / modulesAcross;
  const averagePitch = (horizontalPitch + verticalPitch) / 2;
  const calibrate = (finder: FinderEvidence): FinderEvidence => ({
    ...finder,
    moduleSize: weightedPitch(finder.moduleSize, averagePitch),
    hModuleSize: weightedPitch(finder.hModuleSize, horizontalPitch),
    vModuleSize: weightedPitch(finder.vModuleSize, verticalPitch),
  });
  return {
    topLeft: calibrate(oriented.topLeft),
    topRight: calibrate(oriented.topRight),
    bottomLeft: calibrate(oriented.bottomLeft),
  };
};

const finderEdgeCorrespondences = (
  finder: FinderEvidence,
  centerRow: number,
  centerCol: number,
  right: Point,
  down: Point,
): readonly (readonly [Point, Point])[] => {
  const halfX = finder.hModuleSize * FINDER_EDGE_OFFSET;
  const halfY = finder.vModuleSize * FINDER_EDGE_OFFSET;
  return [
    [
      { x: centerCol, y: centerRow },
      { x: finder.centerX, y: finder.centerY },
    ],
    [
      { x: centerCol + FINDER_EDGE_OFFSET, y: centerRow },
      { x: finder.centerX + right.x * halfX, y: finder.centerY + right.y * halfX },
    ],
    [
      { x: centerCol - FINDER_EDGE_OFFSET, y: centerRow },
      { x: finder.centerX - right.x * halfX, y: finder.centerY - right.y * halfX },
    ],
    [
      { x: centerCol, y: centerRow + FINDER_EDGE_OFFSET },
      { x: finder.centerX + down.x * halfY, y: finder.centerY + down.y * halfY },
    ],
    [
      { x: centerCol, y: centerRow - FINDER_EDGE_OFFSET },
      { x: finder.centerX - down.x * halfY, y: finder.centerY - down.y * halfY },
    ],
  ];
};

const scoreGeometryCandidate = (
  homography: Homography,
  size: number,
  proposalScore: number,
): number => {
  const corners = [
    applyHomography(homography, -0.5, -0.5),
    applyHomography(homography, size - 0.5, -0.5),
    applyHomography(homography, size - 0.5, size - 0.5),
    applyHomography(homography, -0.5, size - 0.5),
  ];
  if (corners.some((corner) => !Number.isFinite(corner.x) || !Number.isFinite(corner.y)))
    return -Infinity;
  const top = euclidean(corners[0]!, corners[1]!);
  const right = euclidean(corners[1]!, corners[2]!);
  const bottom = euclidean(corners[2]!, corners[3]!);
  const left = euclidean(corners[3]!, corners[0]!);
  const average = (top + right + bottom + left) / 4;
  const perimeterConsistency =
    average > 0 ? 1 - (Math.abs(top - bottom) + Math.abs(left - right)) / (2 * average) : 0;
  return proposalScore + perimeterConsistency;
};

const solveLinearSystem = (
  matrix: readonly (readonly number[])[],
  vector: readonly number[],
): readonly number[] | null => {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index] ?? 0]);

  for (let pivot = 0; pivot < size; pivot += 1) {
    let bestRow = pivot;
    let bestValue = Math.abs(augmented[pivot]?.[pivot] ?? 0);
    for (let row = pivot + 1; row < size; row += 1) {
      const value = Math.abs(augmented[row]?.[pivot] ?? 0);
      if (value > bestValue) {
        bestValue = value;
        bestRow = row;
      }
    }
    if (bestValue < 1e-9) return null;
    if (bestRow !== pivot) {
      [augmented[pivot], augmented[bestRow]] = [augmented[bestRow]!, augmented[pivot]!];
    }

    const pivotValue = augmented[pivot]![pivot] ?? 1;
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot]![column] = (augmented[pivot]![column] ?? 0) / pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot] ?? 0;
      if (factor === 0) continue;
      for (let column = pivot; column <= size; column += 1) {
        augmented[row]![column] =
          (augmented[row]![column] ?? 0) - factor * (augmented[pivot]![column] ?? 0);
      }
    }
  }

  return augmented.map((row) => row[size] ?? 0);
};

const orientFinderTriple = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
): {
  readonly topLeft: FinderEvidence;
  readonly topRight: FinderEvidence;
  readonly bottomLeft: FinderEvidence;
} | null => {
  const [a, b, c] = finders;
  const ab = euclideanPoint(a.centerX, a.centerY, b.centerX, b.centerY);
  const ac = euclideanPoint(a.centerX, a.centerY, c.centerX, c.centerY);
  const bc = euclideanPoint(b.centerX, b.centerY, c.centerX, c.centerY);

  let topLeft: FinderEvidence;
  let topRight: FinderEvidence;
  let bottomLeft: FinderEvidence;
  if (ab >= ac && ab >= bc) {
    topLeft = c;
    topRight = a;
    bottomLeft = b;
  } else if (ac >= ab && ac >= bc) {
    topLeft = b;
    topRight = a;
    bottomLeft = c;
  } else {
    topLeft = a;
    topRight = b;
    bottomLeft = c;
  }

  const cross =
    (topRight.centerX - topLeft.centerX) * (bottomLeft.centerY - topLeft.centerY) -
    (topRight.centerY - topLeft.centerY) * (bottomLeft.centerX - topLeft.centerX);
  if (cross < 0) {
    [topRight, bottomLeft] = [bottomLeft, topRight];
  }

  const horizontal = euclideanPoint(
    topLeft.centerX,
    topLeft.centerY,
    topRight.centerX,
    topRight.centerY,
  );
  const vertical = euclideanPoint(
    topLeft.centerX,
    topLeft.centerY,
    bottomLeft.centerX,
    bottomLeft.centerY,
  );
  if (horizontal < 1 || vertical < 1) return null;
  return { topLeft, topRight, bottomLeft };
};

const normalisePoint = (x: number, y: number): Point | null => {
  const length = Math.hypot(x, y);
  if (length < 1e-9) return null;
  return { x: x / length, y: y / length };
};

const distance = (left: FinderEvidence, right: FinderEvidence): number => {
  return euclideanPoint(left.centerX, left.centerY, right.centerX, right.centerY);
};

const euclidean = (left: Point, right: Point): number => {
  return euclideanPoint(left.x, left.y, right.x, right.y);
};

const euclideanPoint = (x0: number, y0: number, x1: number, y1: number): number => {
  return Math.hypot(x1 - x0, y1 - y0);
};

const areFiniteCorners = (corners: CornerSet): boolean => {
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft].every(
    (corner) => Number.isFinite(corner.x) && Number.isFinite(corner.y),
  );
};

const polygonArea = (corners: CornerSet): number => {
  const points = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
};

const emptyScoreBreakdown = () => ({
  detectorScore: 0,
  geometryScore: 0,
  quietZoneScore: 0,
  timingScore: 0,
  alignmentScore: 0,
  penalties: 0,
  total: 0,
});
