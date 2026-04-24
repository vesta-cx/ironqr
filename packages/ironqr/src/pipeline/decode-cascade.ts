import { Effect } from 'effect';
import type { ScanResult } from '../contracts/scan.js';
import { decodeGridLogical } from '../qr/decode-grid.js';
import { ScannerError } from '../qr/errors.js';
import {
  createGeometryCandidates,
  expandVersionNeighborhood,
  type GeometryCandidate,
  type GridResolution,
  rescueVersionsFromFinders,
} from './geometry.js';
import type { ScanProposal } from './proposals.js';
import {
  refineGeometryByFitness,
  refineGeometryWithAlignment,
  selectTopCornerNudges,
} from './refine.js';
import { type DecodeSampler, sampleGrid } from './samplers.js';
import type { TraceSink } from './trace.js';
import type { BinaryViewId, ViewBank } from './views.js';

/**
 * Decode-attempt refinement mode.
 */
export type DecodeAttemptRefinement =
  | 'none'
  | 'fitness'
  | 'alignment-refit'
  | 'corner-nudge'
  | 'version-neighborhood'
  | 'version-neighborhood-fitness';

/**
 * Outcome of one concrete decode attempt.
 */
export type DecodeAttemptOutcome = 'success' | 'timing-check' | 'decode_failed' | 'internal_error';

/**
 * One concrete decode attempt in the proposal-local cascade.
 */
export interface DecodeAttempt {
  /** Source proposal id. */
  readonly proposalId: string;
  /** Geometry candidate id. */
  readonly geometryCandidateId: string;
  /** Binary view used for this decode attempt. */
  readonly decodeBinaryViewId: BinaryViewId;
  /** Sampler strategy. */
  readonly sampler: DecodeSampler;
  /** Refinement mode used to produce the geometry. */
  readonly refinement: DecodeAttemptRefinement;
}

/**
 * Successful proposal-local cascade result.
 */
export interface DecodeCascadeSuccess {
  /** Public scan result. */
  readonly result: ScanResult;
  /** Winning proposal id. */
  readonly proposalId: string;
  /** Winning geometry candidate id. */
  readonly geometryCandidateId: string;
  /** Metadata for the decode attempt that succeeded. */
  readonly attempt: DecodeAttempt;
}

/**
 * Decode-cascade options.
 */
export interface DecodeCascadeOptions {
  /** Optional trace sink. */
  readonly traceSink?: TraceSink;
  /** One-based global proposal rank within the current scan. */
  readonly proposalRank?: number;
  /** Score of the strongest globally ranked proposal in the current scan. */
  readonly topProposalScore?: number;
  /** Optional callback receiving per-attempt timing and outcome data. */
  readonly onAttemptMeasured?: (
    attempt: DecodeAttempt & {
      readonly outcome: DecodeAttemptOutcome;
      readonly durationMs: number;
    },
  ) => void;
  /** Cached initial geometry candidates produced during proposal ranking. */
  readonly initialGeometryCandidates?: readonly GeometryCandidate[];
}

const MAX_DECODE_NEIGHBORHOOD = 12;
const MAX_PRIORITY_RESCUE_DECODE_NEIGHBORHOOD = 4;
const MAX_REDUCED_RESCUE_DECODE_NEIGHBORHOOD = 2;
const MAX_PRIORITY_CORNER_NUDGE_ATTEMPTS = 12;
const MAX_REDUCED_CORNER_NUDGE_ATTEMPTS = 4;
const MAX_PRIORITY_RESCUE_GEOMETRIES = 3;
const MAX_REDUCED_RESCUE_GEOMETRIES = 2;
const MAX_PRIORITY_RESCUE_PROPOSAL_RANK = 5;
const MAX_ANY_RESCUE_SCORE_GAP = 0.9;
const MIN_QR_MODULES = 21;
const TIMING_PATTERN_AXIS = 6;
const TIMING_PATTERN_MARGIN = 7;
const TIMING_PATTERN_END_MARGIN = 8;

/**
 * Runs the proposal-local decode cascade.
 *
 * Search order:
 * 1. top geometry + source view
 * 2. same geometry + decode-neighborhood views
 * 3. fitness refinement
 * 4. alignment-assisted refit
 * 5. corner nudges
 * 6. version-neighborhood rescue
 *
 * @param proposal - Ranked proposal to spend the decode budget on.
 * @param viewBank - Lazy view bank.
 * @param options - Optional trace configuration.
 * @returns The first successful decode for the proposal, or `null`.
 */
export const runDecodeCascade = (
  proposal: ScanProposal,
  viewBank: ViewBank,
  options: DecodeCascadeOptions = {},
): Effect.Effect<DecodeCascadeSuccess | null, ScannerError> => {
  return Effect.gen(function* () {
    const traceOptions = options.traceSink ? { traceSink: options.traceSink } : {};
    const geometryCandidates =
      options.initialGeometryCandidates ?? createGeometryCandidates(proposal, traceOptions);
    if (options.initialGeometryCandidates !== undefined) {
      emitGeometryCandidates(options.initialGeometryCandidates, options.traceSink);
    }
    if (geometryCandidates.length === 0) return null;

    const decodeNeighborhood = limitDecodeNeighborhood(
      viewBank.getDecodeNeighborhood(proposal.binaryViewId),
      MAX_DECODE_NEIGHBORHOOD,
    );
    const allowRescue = shouldSpendAnyRescueBudget(proposal, options);
    const allowPriorityRescue = shouldSpendPriorityRescueBudget(options);
    const rescueNeighborhood = limitDecodeNeighborhood(
      decodeNeighborhood,
      allowPriorityRescue
        ? MAX_PRIORITY_RESCUE_DECODE_NEIGHBORHOOD
        : MAX_REDUCED_RESCUE_DECODE_NEIGHBORHOOD,
    );
    const maxCornerNudgeAttempts = allowPriorityRescue
      ? MAX_PRIORITY_CORNER_NUDGE_ATTEMPTS
      : MAX_REDUCED_CORNER_NUDGE_ATTEMPTS;
    const maxRescueGeometries = allowPriorityRescue
      ? MAX_PRIORITY_RESCUE_GEOMETRIES
      : MAX_REDUCED_RESCUE_GEOMETRIES;
    for (const [geometryIndex, geometry] of geometryCandidates.entries()) {
      const sourceBinaryView = viewBank.getBinaryView(geometry.binaryViewId);
      if (!geometryProjectsInsideImage(geometry, sourceBinaryView.width, sourceBinaryView.height))
        continue;

      const plain = yield* tryGeometryAcrossViews(
        proposal,
        geometry,
        decodeNeighborhood,
        viewBank,
        'none',
        ['cross-vote'],
        options.traceSink,
        options.onAttemptMeasured,
      );
      if (plain) return plain;

      const refinedGeometry = refineGeometryByFitness(
        geometry,
        sourceBinaryView.binary,
        sourceBinaryView.width,
        sourceBinaryView.height,
      );
      const refined = yield* tryGeometryAcrossViews(
        proposal,
        refinedGeometry,
        decodeNeighborhood,
        viewBank,
        'fitness',
        ['cross-vote'],
        options.traceSink,
        options.onAttemptMeasured,
      );
      if (refined) return refined;
      if (!allowRescue || geometryIndex >= maxRescueGeometries) continue;

      if (proposal.kind === 'finder-triple') {
        const alignment = refineGeometryWithAlignment(
          proposal,
          refinedGeometry,
          sourceBinaryView.binary,
          sourceBinaryView.width,
          sourceBinaryView.height,
        );
        if (alignment) {
          const alignmentResult = yield* tryGeometryAcrossViews(
            proposal,
            alignment,
            rescueNeighborhood,
            viewBank,
            'alignment-refit',
            ['cross-vote', 'dense-vote', 'nearest'],
            options.traceSink,
            options.onAttemptMeasured,
          );
          if (alignmentResult) return alignmentResult;
        }
      }

      for (const nudged of selectTopCornerNudges(
        refinedGeometry,
        sourceBinaryView.binary,
        sourceBinaryView.width,
        sourceBinaryView.height,
        maxCornerNudgeAttempts,
      )) {
        if (isHopelessRescueCandidate(proposal, nudged, options)) continue;
        const nudgedResult = yield* tryGeometryAcrossViews(
          proposal,
          nudged,
          rescueNeighborhood,
          viewBank,
          'corner-nudge',
          ['cross-vote', 'dense-vote', 'nearest'],
          options.traceSink,
          options.onAttemptMeasured,
        );
        if (nudgedResult) return nudgedResult;
      }
    }

    if (!allowRescue) return null;

    const rescueVersions =
      proposal.kind === 'finder-triple'
        ? rescueVersionsFromFinders(proposal.finders, proposal.estimatedVersions)
        : expandVersionNeighborhood(proposal.estimatedVersions);
    if (rescueVersions.length <= proposal.estimatedVersions.length) return null;

    const rescueGeometryCandidates = createGeometryCandidates(proposal, {
      ...traceOptions,
      versionOverrides: rescueVersions,
    });
    for (const geometry of rescueGeometryCandidates) {
      if (proposal.estimatedVersions.includes(geometry.version)) continue;
      const sourceBinaryView = viewBank.getBinaryView(geometry.binaryViewId);
      if (!geometryProjectsInsideImage(geometry, sourceBinaryView.width, sourceBinaryView.height))
        continue;

      const rescue = yield* tryGeometryAcrossViews(
        proposal,
        geometry,
        rescueNeighborhood,
        viewBank,
        'version-neighborhood',
        ['cross-vote', 'dense-vote'],
        options.traceSink,
        options.onAttemptMeasured,
      );
      if (rescue) return rescue;

      const rescueRefinedGeometry = refineGeometryByFitness(
        geometry,
        sourceBinaryView.binary,
        sourceBinaryView.width,
        sourceBinaryView.height,
      );
      const rescueRefined = yield* tryGeometryAcrossViews(
        proposal,
        rescueRefinedGeometry,
        rescueNeighborhood,
        viewBank,
        'version-neighborhood-fitness',
        ['cross-vote', 'dense-vote'],
        options.traceSink,
        options.onAttemptMeasured,
      );
      if (rescueRefined) return rescueRefined;
    }

    return null;
  });
};

const emitGeometryCandidates = (
  candidates: readonly GeometryCandidate[],
  traceSink?: TraceSink,
): void => {
  for (const candidate of candidates) {
    traceSink?.emit({
      type: 'geometry-candidate-created',
      geometryCandidateId: candidate.id,
      proposalId: candidate.proposalId,
      binaryViewId: candidate.binaryViewId,
      version: candidate.version,
      geometryMode: candidate.geometryMode,
      geometryScore: candidate.geometryScore,
    });
  }
};

const tryGeometryAcrossViews = (
  proposal: ScanProposal,
  geometry: GridResolution,
  decodeNeighborhood: readonly BinaryViewId[],
  viewBank: ViewBank,
  refinement: DecodeAttemptRefinement,
  samplers: readonly DecodeSampler[],
  traceSink?: TraceSink,
  onAttemptMeasured?: DecodeCascadeOptions['onAttemptMeasured'],
): Effect.Effect<DecodeCascadeSuccess | null, ScannerError> => {
  return Effect.gen(function* () {
    for (const decodeBinaryViewId of decodeNeighborhood) {
      const binaryView = viewBank.getBinaryView(decodeBinaryViewId);
      for (const sampler of samplers) {
        const geometryCandidateId = `${geometry.id ?? proposal.id}:${refinement}:${decodeBinaryViewId}:${sampler}`;
        const attempt = {
          proposalId: proposal.id,
          geometryCandidateId,
          decodeBinaryViewId,
          sampler,
          refinement,
        } satisfies DecodeAttempt;
        traceSink?.emit({
          type: 'decode-attempt-started',
          proposalId: attempt.proposalId,
          geometryCandidateId: attempt.geometryCandidateId,
          decodeBinaryViewId: attempt.decodeBinaryViewId,
          sampler: attempt.sampler,
          refinement: attempt.refinement,
        });

        const startedAt = nowMs();
        const grid = sampleGrid(
          binaryView.width,
          binaryView.height,
          geometry,
          binaryView.binary,
          sampler,
        );
        const decoded = yield* decodeGridVariants(
          grid,
          minimumTimingScore(attempt.refinement, attempt.sampler),
        ).pipe(
          Effect.catchIf(
            (error: unknown): error is ScannerError =>
              error instanceof ScannerError && error.code === 'internal_error',
            (error) => {
              recordAttemptFailure(
                attempt,
                'internal_error',
                startedAt,
                traceSink,
                onAttemptMeasured,
              );
              return Effect.fail(error);
            },
          ),
        );
        if (decoded.kind === 'timing-check') {
          recordAttemptFailure(attempt, 'timing-check', startedAt, traceSink, onAttemptMeasured);
          continue;
        }
        if (decoded.kind === 'decode-failed') {
          recordAttemptFailure(attempt, 'decode_failed', startedAt, traceSink, onAttemptMeasured);
          continue;
        }

        const result = {
          ...decoded.result,
          bounds: geometry.bounds,
          corners: geometry.corners,
        } satisfies ScanResult;

        traceSink?.emit({
          type: 'decode-attempt-succeeded',
          proposalId: attempt.proposalId,
          geometryCandidateId: attempt.geometryCandidateId,
          decodeBinaryViewId: attempt.decodeBinaryViewId,
          sampler: attempt.sampler,
          refinement: attempt.refinement,
          payloadText: result.payload.text,
        });
        onAttemptMeasured?.({ ...attempt, outcome: 'success', durationMs: nowMs() - startedAt });

        return {
          result,
          proposalId: proposal.id,
          geometryCandidateId,
          attempt,
        } satisfies DecodeCascadeSuccess;
      }
    }

    return null;
  });
};

const shouldSpendPriorityRescueBudget = (options: DecodeCascadeOptions): boolean => {
  return (options.proposalRank ?? 1) <= MAX_PRIORITY_RESCUE_PROPOSAL_RANK;
};

const shouldSpendAnyRescueBudget = (
  proposal: ScanProposal,
  options: DecodeCascadeOptions,
): boolean => {
  const topProposalScore = options.topProposalScore ?? proposal.proposalScore;
  return (
    shouldSpendPriorityRescueBudget(options) ||
    proposal.proposalScore >= topProposalScore - MAX_ANY_RESCUE_SCORE_GAP
  );
};

const isHopelessRescueCandidate = (
  proposal: ScanProposal,
  geometry: GridResolution,
  options: DecodeCascadeOptions,
): boolean => {
  const proposalRank = options.proposalRank ?? 1;
  const topProposalScore = options.topProposalScore ?? proposal.proposalScore;
  if (proposalRank <= MAX_PRIORITY_RESCUE_PROPOSAL_RANK) return false;
  if (proposal.proposalScore >= topProposalScore - MAX_ANY_RESCUE_SCORE_GAP) return false;
  return geometry.geometryScore !== undefined && geometry.geometryScore < proposal.proposalScore;
};

const limitDecodeNeighborhood = (
  decodeNeighborhood: readonly BinaryViewId[],
  maxViews: number,
): readonly BinaryViewId[] => {
  return decodeNeighborhood.slice(0, Math.max(1, maxViews));
};

const geometryProjectsInsideImage = (
  geometry: GridResolution,
  width: number,
  height: number,
): boolean => {
  const probePoints = [
    geometry.samplePoint(0, 0),
    geometry.samplePoint(0, geometry.size - 1),
    geometry.samplePoint(geometry.size - 1, geometry.size - 1),
    geometry.samplePoint(geometry.size - 1, 0),
    geometry.samplePoint((geometry.size - 1) / 2, (geometry.size - 1) / 2),
  ];
  if (geometry.version >= 2) {
    const alignmentAnchor = geometry.size - 7;
    probePoints.push(geometry.samplePoint(alignmentAnchor, alignmentAnchor));
  }
  return probePoints.every((point) => pointProjectsInsideImage(point.x, point.y, width, height));
};

const pointProjectsInsideImage = (x: number, y: number, width: number, height: number): boolean => {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    x <= width - 1 &&
    y >= 0 &&
    y <= height - 1
  );
};

const nowMs = (): number => performance.now();

type DecodeGridVariantOutcome =
  | { readonly kind: 'success'; readonly result: ScanResult }
  | { readonly kind: 'timing-check' }
  | { readonly kind: 'decode-failed' };

const decodeGridVariants = (
  grid: boolean[][],
  minimumTimingScoreForVariant: number,
): Effect.Effect<DecodeGridVariantOutcome, ScannerError> => {
  return Effect.gen(function* () {
    let passedTimingCheck = false;

    for (const createVariant of buildMirroredDecodeVariants(grid)) {
      const variant = createVariant();
      if (scoreTimingPattern(variant) < minimumTimingScoreForVariant) continue;
      passedTimingCheck = true;

      const decoded = yield* decodeGridLogical({ grid: variant }).pipe(
        Effect.catchIf(
          (error: unknown): error is ScannerError =>
            error instanceof ScannerError && error.code === 'decode_failed',
          () => Effect.succeed(null),
        ),
      );
      if (decoded !== null) return { kind: 'success', result: decoded };
    }

    return { kind: passedTimingCheck ? 'decode-failed' : 'timing-check' };
  });
};

const recordAttemptFailure = (
  attempt: DecodeAttempt,
  outcome: Exclude<DecodeAttemptOutcome, 'success'>,
  startedAt: number,
  traceSink?: TraceSink,
  onAttemptMeasured?: DecodeCascadeOptions['onAttemptMeasured'],
): void => {
  traceSink?.emit({
    type: 'decode-attempt-failed',
    proposalId: attempt.proposalId,
    geometryCandidateId: attempt.geometryCandidateId,
    decodeBinaryViewId: attempt.decodeBinaryViewId,
    sampler: attempt.sampler,
    refinement: attempt.refinement,
    failure: outcome,
  });
  onAttemptMeasured?.({
    ...attempt,
    outcome,
    durationMs: nowMs() - startedAt,
  });
};

const buildMirroredDecodeVariants = (grid: boolean[][]): ReadonlyArray<() => boolean[][]> => {
  let transpose: boolean[][] | null = null;
  const getTranspose = (): boolean[][] => {
    transpose ??= transposeGrid(grid);
    return transpose;
  };

  return [
    () => cloneGrid(grid),
    () => cloneGrid(getTranspose()),
    () => reverseRows(grid),
    () => reverseColumns(grid),
    () => reverseRows(getTranspose()),
    () => reverseColumns(getTranspose()),
  ];
};

const BASE_TIMING_PATTERN_THRESHOLD = 0.5;
const RESCUE_TIMING_PATTERN_THRESHOLD = 0.35;
const DENSE_SAMPLER_TIMING_PATTERN_THRESHOLD = 0.4;

const minimumTimingScore = (
  refinement: DecodeAttemptRefinement,
  sampler: DecodeSampler,
): number => {
  if (sampler !== 'cross-vote') return DENSE_SAMPLER_TIMING_PATTERN_THRESHOLD;
  return refinement === 'none' || refinement === 'fitness'
    ? BASE_TIMING_PATTERN_THRESHOLD
    : RESCUE_TIMING_PATTERN_THRESHOLD;
};

const scoreTimingPattern = (grid: readonly (readonly boolean[])[]): number => {
  if (grid.length < MIN_QR_MODULES) return 0;
  let rowMatches = 0;
  let rowTotal = 0;
  for (let col = TIMING_PATTERN_MARGIN; col <= grid.length - TIMING_PATTERN_END_MARGIN; col += 1) {
    const value = grid[TIMING_PATTERN_AXIS]?.[col];
    if (value === undefined) return 0;
    rowMatches += value === (col % 2 === 0) ? 1 : 0;
    rowTotal += 1;
  }
  let colMatches = 0;
  let colTotal = 0;
  for (let row = TIMING_PATTERN_MARGIN; row <= grid.length - TIMING_PATTERN_END_MARGIN; row += 1) {
    const value = grid[row]?.[TIMING_PATTERN_AXIS];
    if (value === undefined) return 0;
    colMatches += value === (row % 2 === 0) ? 1 : 0;
    colTotal += 1;
  }
  const rowScore = rowMatches / Math.max(1, rowTotal);
  const colScore = colMatches / Math.max(1, colTotal);
  return Math.min(rowScore, colScore);
};

const cloneGrid = (grid: readonly (readonly boolean[])[]): boolean[][] => {
  return grid.map((row) => [...row]);
};

const transposeGrid = (grid: readonly (readonly boolean[])[]): boolean[][] => {
  return Array.from({ length: grid.length }, (_, row) =>
    Array.from({ length: grid.length }, (_, col) => grid[col]?.[row] ?? false),
  );
};

const reverseRows = (grid: readonly (readonly boolean[])[]): boolean[][] => {
  return grid.map((row) => [...row].reverse());
};

const reverseColumns = (grid: readonly (readonly boolean[])[]): boolean[][] => {
  return [...grid].reverse().map((row) => [...row]);
};
