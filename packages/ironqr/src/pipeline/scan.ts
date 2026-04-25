import { Effect } from 'effect';
import type {
  ScanMetricsSink,
  ScanObservabilityOptions,
  ScanOptions,
  ScanResult,
  ScanTimingSpanName,
} from '../contracts/scan.js';
import { ScannerError } from '../qr/errors.js';
import { clusterRankedProposals } from './clusters.js';
import {
  type DecodeAttempt,
  type DecodeAttemptOutcome,
  runDecodeCascade,
} from './decode-cascade.js';
import { normalizeImageInput } from './frame.js';
import { assessProposalStructure } from './plausibility.js';
import {
  type FinderEvidenceDetectionPolicy,
  generateProposalBatchForView,
  type ProposalGenerationSummary,
  type ProposalScoreBreakdown,
  type ProposalViewBatch,
  type RankedProposalCandidate,
  rankProposalCandidates,
  type ScanProposal,
  summarizeProposalBatches,
} from './proposals.js';
import {
  type ClusterFinishedEvent,
  createTraceCollector,
  createTraceCounter,
  type IronqrTraceEvent,
  type ProposalClustersBuiltEvent,
  type ScanFinishedEvent,
  type TraceCollector,
  type TraceCounter,
  type TraceSink,
} from './trace.js';
import { type BinaryViewId, createViewBank, type ScalarViewId, type ViewBank } from './views.js';

/**
 * Public runtime scan options that extend the schema-backed structural options
 * with generic diagnostics plumbing.
 */
export interface ScanRuntimeOptions extends ScanOptions {
  /** Optional typed trace sink for diagnostics, tests, and benchmark harnesses. */
  readonly traceSink?: TraceSink;
  /** Optional proposal-generation view override. Defaults to the production priority subset. */
  readonly proposalViewIds?: readonly BinaryViewId[];
  /** Optional detector-family policy for proposal-generation studies. */
  readonly proposalDetectorPolicy?: FinderEvidenceDetectionPolicy;
  /** Optional low-overhead timing span sink for performance harnesses. */
  readonly metricsSink?: ScanMetricsSink;
  /** Maximum proposal representatives to try inside one cluster. */
  readonly maxClusterRepresentatives?: number;
  /** Maximum structural failures tolerated inside one cluster before killing it. */
  readonly maxClusterStructuralFailures?: number;
  /** Continue probing cluster representatives after a successful decode. Used by exhaustive studies. */
  readonly continueAfterDecode?: boolean;
  /** Optional limit on decode attempts per scan, for bounded policy studies. */
  readonly maxDecodeAttempts?: number;
  /** Optional cooperative scheduler used between proposal-view batches. */
  readonly scheduler?: ScanScheduler;
}

/**
 * Cooperative scheduling hooks for long scan work.
 *
 * These hooks are Effect-native so browser hosts can yield between proposal
 * batches without introducing worker/runtime-specific APIs into the scanner.
 */
export interface ScanScheduler {
  /** Optional yield point before one proposal view is generated. */
  readonly yieldBeforeProposalView?: (viewId: BinaryViewId) => Effect.Effect<void>;
  /** Optional yield point after one proposal batch is generated. */
  readonly yieldAfterProposalBatch?: (batch: ProposalViewBatch) => Effect.Effect<void>;
}

/**
 * A decoded result annotated with the proposal and search-path metadata that
 * produced it.
 */
export interface RankedScanResult {
  /** Public scan result payload and geometry. */
  readonly result: ScanResult;
  /** Winning proposal id. */
  readonly proposalId: string;
  /** Winning proposal kind. */
  readonly proposalKind: ScanProposal['kind'];
  /** Winning proposal score. */
  readonly score: number;
  /** Winning proposal score breakdown. */
  readonly scoreBreakdown: ProposalScoreBreakdown;
  /** Proposal-generation binary view id. */
  readonly binaryViewId: BinaryViewId;
  /** Detector families that supported the winning proposal. */
  readonly detectorSources: readonly string[];
  /** Decode-attempt metadata that actually succeeded. */
  readonly decodeAttempt: DecodeAttempt;
}

/**
 * Path metadata attached to one observed scan result.
 */
export interface ScanPathMetadata {
  /** Winning proposal id. */
  readonly proposalId: string;
  /** Winning proposal-generation binary view id. */
  readonly proposalBinaryViewId: BinaryViewId;
  /** Detector families that supported the winning proposal. */
  readonly detectorSources: readonly string[];
  /** Successful decode attempt. */
  readonly decodeAttempt: DecodeAttempt;
  /** Winning proposal kind. Present only at `full` detail. */
  readonly proposalKind?: ScanProposal['kind'];
  /** Winning proposal score. Present only at `full` detail. */
  readonly proposalScore?: number;
  /** Winning proposal score breakdown. Present only at `full` detail. */
  readonly scoreBreakdown?: ProposalScoreBreakdown;
}

/**
 * One measured decode attempt.
 */
export interface ScanAttemptRecord {
  /** Monotonic attempt sequence within the scan. */
  readonly sequence: number;
  /** Source proposal id. */
  readonly proposalId: string;
  /** Geometry candidate id. */
  readonly geometryCandidateId: string;
  /** Binary view used for the attempt. */
  readonly decodeBinaryViewId: BinaryViewId;
  /** Sampler used for the attempt. */
  readonly sampler: DecodeAttempt['sampler'];
  /** Refinement mode used for the attempt. */
  readonly refinement: DecodeAttempt['refinement'];
  /** Attempt outcome. */
  readonly outcome: DecodeAttemptOutcome;
  /** Attempt duration in milliseconds. */
  readonly durationMs: number;
}

/**
 * Attempt metadata attached to one observed scan result.
 */
export interface ScanAttemptMetadata {
  /** Total attempts spent on the winning proposal. */
  readonly attemptCount: number;
  /** Failed timing-gate count. */
  readonly failedTimingChecks: number;
  /** Failed QR decode count. */
  readonly failedDecodes: number;
  /** Failed internal-error count. */
  readonly failedInternalErrors: number;
  /** Ordered unique decode binary views tried for the winning proposal. */
  readonly decodeBinaryViewIdsTried: readonly BinaryViewId[];
  /** Ordered unique refinements used for the winning proposal. */
  readonly refinementsUsed: readonly DecodeAttempt['refinement'][];
  /** Full ordered attempt list. Present only at `full` detail. */
  readonly attempts?: readonly ScanAttemptRecord[];
}

/**
 * Additional metadata attached to one observed scan result.
 */
export interface ScanResultMetadata {
  /** Winning-path metadata, when requested. */
  readonly path?: ScanPathMetadata;
  /** Per-proposal attempt summary, when requested. */
  readonly attempts?: ScanAttemptMetadata;
}

/**
 * One scan result plus optional requested observability metadata.
 */
export interface ScanObservedResult extends ScanResult {
  /** Requested metadata buckets for this decoded result. */
  readonly metadata: ScanResultMetadata;
}

/**
 * Cheap scan-wide execution summary.
 */
export interface ScanExecutionSummary {
  /** Number of successful decoded results returned. */
  readonly successCount: number;
  /** Total ranked proposals before the global budget cap. */
  readonly proposalCount: number;
  /** Ranked proposals kept after the global budget cap. */
  readonly boundedProposalCount: number;
  /** Number of proposal clusters built from bounded proposals. */
  readonly clusterCount: number;
  /** Total representative proposals retained across clusters. */
  readonly representativeCount: number;
  /** Representatives actually processed before termination. */
  readonly processedRepresentativeCount: number;
  /** Clusters killed by repeated structural failure. */
  readonly killedClusterCount: number;
}

/**
 * Scan-wide view materialization summary.
 */
export interface ScanViewSummary {
  /** Scalar views materialized during the scan, in first-use order. */
  readonly materializedScalarViewIds: readonly ScalarViewId[];
  /** Binary views materialized during the scan, in first-use order. */
  readonly materializedBinaryViewIds: readonly BinaryViewId[];
  /** Proposal-generation binary views that actually produced proposals. */
  readonly proposalBinaryViewIds: readonly BinaryViewId[];
  /** Proposal-generation views that produced successful results. */
  readonly winningProposalBinaryViewIds: readonly BinaryViewId[];
  /** Decode views that actually succeeded. */
  readonly winningDecodeBinaryViewIds: readonly BinaryViewId[];
}

/**
 * Scan-wide failure summary, especially useful for zero-result scans.
 */
export interface ScanFailureSummary {
  /** Whether the scan produced any successful result. */
  readonly succeeded: boolean;
  /** Heuristic dominant failure class when no result decoded. */
  readonly dominantFailureClass?: 'no-proposals' | 'structure-screen' | 'decode';
  /** Decode-attempt failures aggregated by subtype. */
  readonly attemptFailures: Partial<
    Record<'timing-check' | 'decode_failed' | 'internal_error', number>
  >;
}

/**
 * Scan-wide timing summary.
 */
export interface ScanTimingSummary {
  /** End-to-end scan duration in milliseconds. */
  readonly totalMs: number;
  /** Input normalization duration. */
  readonly normalizeFrameMs: number;
  /** Proposal-generation duration. */
  readonly proposalGenerationMs: number;
  /** Proposal-ranking duration. */
  readonly rankingMs: number;
  /** Clustering duration. */
  readonly clusteringMs: number;
  /** Cluster-processing duration. */
  readonly clusterProcessingMs: number;
  /** Total measured decode-attempt duration across all attempts. */
  readonly decodeAttemptMs: number;
}

/**
 * Full scan-wide timing metadata including per-attempt timings.
 */
export interface ScanTimingDetails extends ScanTimingSummary {
  /** Ordered per-attempt timings. */
  readonly attempts: readonly ScanAttemptRecord[];
}

/**
 * Low-overhead trace summary returned when requested.
 */
export interface ScanTraceSummary {
  /** Event counts keyed by event type. */
  readonly counts: Partial<Record<IronqrTraceEvent['type'], number>>;
  /** Decode-attempt failures keyed by subtype. */
  readonly attemptFailures: Partial<
    Record<'timing-check' | 'decode_failed' | 'internal_error', number>
  >;
  /** Latest proposal-clustering summary, if one was emitted. */
  readonly clustering: ProposalClustersBuiltEvent | null;
  /** Per-cluster completion summaries. */
  readonly clusterOutcomes: readonly ClusterFinishedEvent[];
  /** Latest scan-finished summary, if one was emitted. */
  readonly scanFinished: ScanFinishedEvent | null;
}

/**
 * Full ordered trace event capture returned when requested.
 */
export interface ScanTraceEvents {
  /** Complete trace event stream in emission order. */
  readonly events: readonly IronqrTraceEvent[];
}

/**
 * Scan-wide metadata buckets requested through observability options.
 */
export interface ScanMetadata {
  /** Always-present cheap execution summary. */
  readonly summary: ScanExecutionSummary;
  /** View summary, when requested. */
  readonly views?: ScanViewSummary;
  /** Proposal-generation summary, when requested. */
  readonly proposals?: ProposalGenerationSummary;
  /** Failure summary, when requested. */
  readonly failure?: ScanFailureSummary;
  /** Timing summary/details, when requested. */
  readonly timings?: ScanTimingSummary | ScanTimingDetails;
  /** Trace summary/full event capture, when requested. */
  readonly trace?: ScanTraceSummary | ScanTraceEvents;
}

/**
 * Envelope returned when scan observability is requested.
 */
export interface ScanReport {
  /** Decoded results plus any requested result-level metadata. */
  readonly results: readonly ScanObservedResult[];
  /** Scan-level metadata, including zero-result diagnostics. */
  readonly scan: ScanMetadata;
}

/**
 * Public return value of `scanFrameEffect()`.
 */
export type ScanFrameOutput = readonly ScanResult[] | ScanReport;

interface ScanExecution {
  readonly rankedResults: readonly RankedScanResult[];
  readonly summary: ScanExecutionSummary;
  readonly timings: ScanTimingDetails;
  readonly traceCollector: TraceCollector | null;
  readonly traceCounter: TraceCounter | null;
  readonly proposalBinaryViewIds: readonly BinaryViewId[];
  readonly proposalGeneration: ProposalGenerationSummary;
}

interface FrontierSnapshot {
  readonly proposals: readonly ScanProposal[];
  readonly boundedProposals: readonly ScanProposal[];
  readonly rankedProposalById: ReadonlyMap<string, RankedProposalCandidate>;
  readonly proposalRankById: ReadonlyMap<string, number>;
  readonly topProposalScore: number;
  readonly clusters: ReturnType<typeof clusterRankedProposals>;
  readonly representativeCount: number;
  readonly rankingMs: number;
  readonly clusteringMs: number;
}

interface ClusterProcessingState {
  readonly results: RankedScanResult[];
  readonly seenResults: Set<string>;
  readonly attemptedProposalIds: Set<string>;
  readonly attemptRecords: ScanAttemptRecord[];
  processedRepresentativeCount: number;
  killedClusterCount: number;
  readonly structuralFailuresByClusterId: Map<string, number>;
}

interface ClusterProcessingResult {
  readonly stopScanning: boolean;
}

interface ProposalBatchSource {
  next(): Effect.Effect<ProposalViewBatch | null, ScannerError>;
  cancel(): Effect.Effect<void>;
}

const MAX_CLUSTER_REPRESENTATIVES = 3;
const MAX_CLUSTER_STRUCTURAL_FAILURES = 3;
const MAX_EARLY_FRONTIER_PASSES = 4;
const MAX_SCAN_BUDGET = 10_000;
// No evidence-backed default cluster cap yet. Studies can use this uncapped
// ceiling to derive a production budget from first-success cluster ranks.
const DEFAULT_MAX_PROPOSALS = MAX_SCAN_BUDGET;

/**
 * Runs the full ranked proposal pipeline and returns either plain results or an
 * observability envelope depending on the requested options.
 *
 * @param input - Any supported image-like source.
 * @param options - Scan behavior and optional observability.
 * @returns Public scan results or a scan report envelope.
 */
export const scanFrameEffect = (
  input: Parameters<typeof normalizeImageInput>[0],
  options: ScanRuntimeOptions = {},
): Effect.Effect<ScanFrameOutput, ScannerError> => {
  return scanFrameExecutionOnce(input, options).pipe(
    Effect.map((execution) =>
      options.observability === undefined
        ? execution.rankedResults.map((entry) => entry.result)
        : buildScanReport(execution, options.observability),
    ),
  );
};

/**
 * Runs the full ranked proposal pipeline and returns the winning-path metadata
 * for each successful decode.
 *
 * @param input - Any supported image-like source.
 * @param options - Scan behavior and optional diagnostics.
 * @returns Ranked decoded results for the frame.
 */
export const scanFrameRankedEffect = (
  input: Parameters<typeof normalizeImageInput>[0],
  options: ScanRuntimeOptions = {},
): Effect.Effect<readonly RankedScanResult[], ScannerError> => {
  return scanFrameExecutionOnce(input, options).pipe(
    Effect.map((execution) => execution.rankedResults),
  );
};

const scanFrameExecutionOnce = (
  input: Parameters<typeof normalizeImageInput>[0],
  options: ScanRuntimeOptions,
): Effect.Effect<ScanExecution, ScannerError> => {
  return Effect.gen(function* () {
    const observability = options.observability;
    const traceArtifacts = createInternalTraceArtifacts(observability, options.traceSink);
    const traceSink = traceArtifacts.sink;
    const attemptRecords: ScanAttemptRecord[] = [];
    const totalStartedAt = nowMs();

    const normalizeStartedAt = nowMs();
    const image = yield* normalizeImageInput(input);
    const normalizeFrameMs = nowMs() - normalizeStartedAt;
    recordTimingSpan(options.metricsSink, 'normalize', normalizeStartedAt, {
      width: image.width,
      height: image.height,
    });
    traceSink?.emit({ type: 'scan-started', width: image.width, height: image.height });

    const viewBank = createViewBank(image, {
      ...(traceSink === undefined ? {} : { traceSink }),
      ...(options.metricsSink === undefined ? {} : { metricsSink: options.metricsSink }),
    });

    const maxProposalsPerView = resolveMaxProposalsPerView(options);
    const maxProposals = normalizeProposalBudget(resolveMaxProposals(options));
    const proposalBatches: ProposalViewBatch[] = [];
    const generatedProposals: ScanProposal[] = [];
    const processingState: ClusterProcessingState = {
      results: [],
      seenResults: new Set(),
      attemptedProposalIds: new Set(),
      attemptRecords,
      processedRepresentativeCount: 0,
      killedClusterCount: 0,
      structuralFailuresByClusterId: new Map(),
    };
    let proposalGenerationMs = 0;
    let rankingMs = 0;
    let clusteringMs = 0;
    let clusterProcessingMs = 0;
    let latestSnapshot = buildFrontierSnapshot(
      viewBank,
      generatedProposals,
      maxProposals,
      traceSink,
      options.metricsSink,
      options.maxClusterRepresentatives,
    );
    let stopScanning = false;
    let earlyFrontierPasses = 0;
    const batchSource = createSequentialProposalBatchSource({
      viewBank,
      viewIds: options.proposalViewIds ?? viewBank.listProposalViewIds(),
      ...(maxProposalsPerView === undefined ? {} : { maxProposalsPerView }),
      ...(options.proposalDetectorPolicy === undefined
        ? {}
        : { detectorPolicy: options.proposalDetectorPolicy }),
      ...(traceSink === undefined ? {} : { traceSink }),
      ...(options.metricsSink === undefined ? {} : { metricsSink: options.metricsSink }),
      scheduler: options.scheduler ?? defaultScanScheduler,
    });

    while (true) {
      const proposalGenerationStartedAt = nowMs();
      const batch = yield* batchSource.next();
      proposalGenerationMs += nowMs() - proposalGenerationStartedAt;
      if (batch === null) break;
      proposalBatches.push(batch);
      generatedProposals.push(...batch.proposals);

      if (
        options.allowMultiple === true ||
        batch.proposals.length === 0 ||
        earlyFrontierPasses >= MAX_EARLY_FRONTIER_PASSES
      ) {
        continue;
      }
      earlyFrontierPasses += 1;

      latestSnapshot = buildFrontierSnapshot(
        viewBank,
        generatedProposals,
        maxProposals,
        traceSink,
        options.metricsSink,
      );
      rankingMs += latestSnapshot.rankingMs;
      clusteringMs += latestSnapshot.clusteringMs;

      const clusterProcessingStartedAt = nowMs();
      const processed = yield* processFrontierClusters(latestSnapshot, viewBank, processingState, {
        allowMultiple: false,
        maxNewRepresentatives: 1,
        maxStructuralFailures:
          options.maxClusterStructuralFailures ?? MAX_CLUSTER_STRUCTURAL_FAILURES,
        continueAfterDecode: options.continueAfterDecode === true,
        ...(options.maxDecodeAttempts === undefined
          ? {}
          : { maxDecodeAttempts: options.maxDecodeAttempts }),
        ...(traceSink === undefined ? {} : { traceSink }),
        ...(options.metricsSink === undefined ? {} : { metricsSink: options.metricsSink }),
      });
      clusterProcessingMs += nowMs() - clusterProcessingStartedAt;
      stopScanning = processed.stopScanning;
      if (stopScanning) {
        yield* batchSource.cancel();
        break;
      }
    }

    if (!stopScanning) {
      latestSnapshot = buildFrontierSnapshot(
        viewBank,
        generatedProposals,
        maxProposals,
        traceSink,
        options.metricsSink,
      );
      rankingMs += latestSnapshot.rankingMs;
      clusteringMs += latestSnapshot.clusteringMs;

      const clusterProcessingStartedAt = nowMs();
      const processed = yield* processFrontierClusters(latestSnapshot, viewBank, processingState, {
        allowMultiple: options.allowMultiple === true,
        maxNewRepresentatives: Number.POSITIVE_INFINITY,
        maxStructuralFailures:
          options.maxClusterStructuralFailures ?? MAX_CLUSTER_STRUCTURAL_FAILURES,
        continueAfterDecode: options.continueAfterDecode === true,
        ...(options.maxDecodeAttempts === undefined
          ? {}
          : { maxDecodeAttempts: options.maxDecodeAttempts }),
        ...(traceSink === undefined ? {} : { traceSink }),
        ...(options.metricsSink === undefined ? {} : { metricsSink: options.metricsSink }),
      });
      clusterProcessingMs += nowMs() - clusterProcessingStartedAt;
      stopScanning = processed.stopScanning;
    }

    const summary = {
      successCount: processingState.results.length,
      proposalCount: latestSnapshot.proposals.length,
      boundedProposalCount: latestSnapshot.boundedProposals.length,
      clusterCount: latestSnapshot.clusters.length,
      representativeCount: latestSnapshot.representativeCount,
      processedRepresentativeCount: processingState.processedRepresentativeCount,
      killedClusterCount: processingState.killedClusterCount,
    } satisfies ScanExecutionSummary;

    traceSink?.emit({
      type: 'scan-finished',
      successCount: summary.successCount,
      proposalCount: summary.proposalCount,
      boundedProposalCount: summary.boundedProposalCount,
      clusterCount: summary.clusterCount,
      representativeCount: summary.representativeCount,
      processedRepresentativeCount: summary.processedRepresentativeCount,
      killedClusterCount: summary.killedClusterCount,
    });

    return {
      rankedResults: processingState.results,
      summary,
      timings: {
        totalMs: nowMs() - totalStartedAt,
        normalizeFrameMs,
        proposalGenerationMs,
        rankingMs,
        clusteringMs,
        clusterProcessingMs,
        decodeAttemptMs: attemptRecords.reduce((sum, attempt) => sum + attempt.durationMs, 0),
        attempts: attemptRecords,
      },
      traceCollector: traceArtifacts.collector,
      traceCounter: traceArtifacts.counter,
      proposalBinaryViewIds: uniquePreservingOrder(
        generatedProposals.map((proposal) => proposal.binaryViewId),
      ),
      proposalGeneration: summarizeProposalBatches(proposalBatches),
    } satisfies ScanExecution;
  });
};

const defaultScanScheduler: Required<ScanScheduler> = {
  yieldBeforeProposalView: () => Effect.yieldNow,
  yieldAfterProposalBatch: () => Effect.yieldNow,
};

const createSequentialProposalBatchSource = (options: {
  readonly viewBank: ViewBank;
  readonly viewIds: readonly BinaryViewId[];
  readonly maxProposalsPerView?: number;
  readonly detectorPolicy?: FinderEvidenceDetectionPolicy;
  readonly traceSink?: TraceSink;
  readonly metricsSink?: ScanMetricsSink;
  readonly scheduler: ScanScheduler;
}): ProposalBatchSource => {
  let index = 0;
  let cancelled = false;
  return {
    next() {
      return Effect.gen(function* () {
        if (cancelled) return null;
        const binaryViewId = options.viewIds[index];
        if (binaryViewId === undefined) return null;
        index += 1;

        yield* options.scheduler.yieldBeforeProposalView?.(binaryViewId) ?? Effect.void;
        if (cancelled) return null;

        const startedAtMs = nowMs();
        const batch = generateProposalBatchForView(options.viewBank, binaryViewId, {
          ...(options.maxProposalsPerView === undefined
            ? {}
            : { maxProposalsPerView: options.maxProposalsPerView }),
          ...(options.detectorPolicy === undefined
            ? {}
            : { detectorPolicy: options.detectorPolicy }),
          ...(options.traceSink === undefined ? {} : { traceSink: options.traceSink }),
        });
        recordTimingSpan(options.metricsSink, 'proposal-view', startedAtMs, {
          binaryViewId,
          proposalCount: batch.proposals.length,
        });

        yield* options.scheduler.yieldAfterProposalBatch?.(batch) ?? Effect.void;
        return cancelled ? null : batch;
      });
    },
    cancel() {
      return Effect.sync(() => {
        cancelled = true;
      });
    },
  } satisfies ProposalBatchSource;
};

const buildFrontierSnapshot = (
  viewBank: ViewBank,
  generatedProposals: readonly ScanProposal[],
  maxProposals: number,
  traceSink?: TraceSink,
  metricsSink?: ScanMetricsSink,
  maxClusterRepresentatives?: number,
): FrontierSnapshot => {
  const rankingStartedAt = nowMs();
  const rankedProposalCandidates = rankProposalCandidates(
    viewBank,
    generatedProposals,
    traceSink === undefined ? {} : { traceSink },
  );
  const rankingMs = nowMs() - rankingStartedAt;
  recordTimingSpan(metricsSink, 'ranking', rankingStartedAt, {
    proposalCount: generatedProposals.length,
  });

  const viableRankedProposalCandidates = rankedProposalCandidates.filter((candidate) =>
    hasViableGeometry(candidate, viewBank),
  );
  const proposals = rankedProposalCandidates.map((candidate) => candidate.proposal);
  const viableProposals = viableRankedProposalCandidates.map((candidate) => candidate.proposal);

  const clusteringStartedAt = nowMs();
  const allClusters = clusterRankedProposals(viableProposals, {
    maxRepresentatives: maxClusterRepresentatives ?? MAX_CLUSTER_REPRESENTATIVES,
  });
  const clusters = allClusters.slice(0, maxProposals);
  const clusteringMs = nowMs() - clusteringStartedAt;
  const boundedProposals = clusters.flatMap((cluster) => cluster.proposals);
  const rankedProposalById = new Map(
    viableRankedProposalCandidates.map((candidate) => [candidate.proposal.id, candidate]),
  );
  const topProposalScore = clusters[0]?.clusterScore ?? boundedProposals[0]?.proposalScore ?? 0;
  const proposalRankById = new Map(
    clusters.flatMap((cluster, clusterIndex) =>
      cluster.representatives.map((proposal) => [proposal.id, clusterIndex + 1] as const),
    ),
  );
  recordTimingSpan(metricsSink, 'clustering', clusteringStartedAt, {
    proposalCount: proposals.length,
    viableProposalCount: viableProposals.length,
    boundedProposalCount: boundedProposals.length,
    totalClusterCount: allClusters.length,
    clusterCount: clusters.length,
  });

  const representativeCount = clusters.reduce(
    (sum, cluster) => sum + cluster.representatives.length,
    0,
  );
  if (proposals.length > 0) {
    traceSink?.emit({
      type: 'proposal-clusters-built',
      rankedProposalCount: proposals.length,
      boundedProposalCount: boundedProposals.length,
      clusterCount: clusters.length,
      representativeCount,
      maxRepresentatives: MAX_CLUSTER_REPRESENTATIVES,
    });
  }

  return {
    proposals,
    boundedProposals,
    rankedProposalById,
    proposalRankById,
    topProposalScore,
    clusters,
    representativeCount,
    rankingMs,
    clusteringMs,
  } satisfies FrontierSnapshot;
};

const hasViableGeometry = (candidate: RankedProposalCandidate, viewBank: ViewBank): boolean => {
  for (const geometry of candidate.initialGeometryCandidates) {
    const sourceView = viewBank.getBinaryView(geometry.binaryViewId);
    if (geometryProjectsNearImage(geometry, sourceView.width, sourceView.height)) return true;
  }
  return false;
};

const geometryProjectsNearImage = (
  geometry: RankedProposalCandidate['initialGeometryCandidates'][number],
  width: number,
  height: number,
): boolean => {
  if (!Number.isFinite(geometry.bounds.width) || !Number.isFinite(geometry.bounds.height))
    return false;
  if (geometry.bounds.width < 8 || geometry.bounds.height < 8) return false;
  const margin = Math.max(geometry.bounds.width, geometry.bounds.height) * 0.5;
  return (
    geometry.bounds.x + geometry.bounds.width >= -margin &&
    geometry.bounds.y + geometry.bounds.height >= -margin &&
    geometry.bounds.x <= width - 1 + margin &&
    geometry.bounds.y <= height - 1 + margin
  );
};

const processFrontierClusters = (
  snapshot: FrontierSnapshot,
  viewBank: ViewBank,
  state: ClusterProcessingState,
  options: {
    readonly allowMultiple: boolean;
    readonly maxNewRepresentatives: number;
    readonly maxStructuralFailures: number;
    readonly continueAfterDecode: boolean;
    readonly maxDecodeAttempts?: number;
    readonly traceSink?: TraceSink;
    readonly metricsSink?: ScanMetricsSink;
  },
): Effect.Effect<ClusterProcessingResult, ScannerError> => {
  return Effect.gen(function* () {
    let processedThisPass = 0;

    for (let clusterIndex = 0; clusterIndex < snapshot.clusters.length; clusterIndex += 1) {
      if (processedThisPass >= options.maxNewRepresentatives) break;
      if (
        options.maxDecodeAttempts !== undefined &&
        state.attemptRecords.length >= options.maxDecodeAttempts
      ) {
        break;
      }
      const cluster = snapshot.clusters[clusterIndex];
      if (!cluster) continue;
      const clusterRank = clusterIndex + 1;
      const bestProposal = cluster.proposals[0];
      if (!bestProposal) continue;

      const pendingRepresentatives = cluster.representatives.filter(
        (proposal) => !state.attemptedProposalIds.has(proposal.id),
      );
      if (pendingRepresentatives.length === 0) continue;

      options.traceSink?.emit({
        type: 'cluster-started',
        clusterId: cluster.id,
        clusterRank,
        proposalCount: cluster.proposals.length,
        representativeCount: cluster.representatives.length,
        bestProposalId: bestProposal.id,
        bestProposalScore: bestProposal.proposalScore,
      });

      let structuralFailures = state.structuralFailuresByClusterId.get(cluster.id) ?? 0;
      let clusterOutcome: 'decoded' | 'duplicate' | 'killed' | 'exhausted' = 'exhausted';
      let winningProposalId: string | undefined;
      let clusterProcessedRepresentatives = 0;

      for (const proposal of pendingRepresentatives) {
        if (processedThisPass >= options.maxNewRepresentatives) break;
        if (
          options.maxDecodeAttempts !== undefined &&
          state.attemptRecords.length >= options.maxDecodeAttempts
        ) {
          break;
        }
        const representativeIndex = cluster.representatives.indexOf(proposal);
        const proposalRank = snapshot.proposalRankById.get(proposal.id) ?? 1;
        state.attemptedProposalIds.add(proposal.id);
        state.processedRepresentativeCount += 1;
        clusterProcessedRepresentatives += 1;
        processedThisPass += 1;

        options.traceSink?.emit({
          type: 'cluster-representative-started',
          clusterId: cluster.id,
          clusterRank,
          representativeIndex: representativeIndex + 1,
          proposalId: proposal.id,
          proposalRank,
          proposalScore: proposal.proposalScore,
          binaryViewId: proposal.binaryViewId,
        });

        const structureStartedAt = nowMs();
        const structure = assessProposalStructure(proposal, viewBank);
        recordTimingSpan(options.metricsSink, 'structure', structureStartedAt, {
          clusterId: cluster.id,
          proposalId: proposal.id,
          proposalRank,
          passed: structure.passed,
          score: structure.score,
        });
        options.traceSink?.emit({
          type: 'proposal-structure-assessed',
          clusterId: cluster.id,
          clusterRank,
          proposalId: proposal.id,
          proposalRank,
          proposalScore: proposal.proposalScore,
          passed: structure.passed,
          score: structure.score,
          timingScore: structure.timingScore,
          finderScore: structure.finderScore,
          separatorScore: structure.separatorScore,
          pitchScore: structure.pitchScore,
        });
        if (!structure.passed) {
          structuralFailures += 1;
          state.structuralFailuresByClusterId.set(cluster.id, structuralFailures);
          if (structuralFailures >= options.maxStructuralFailures) {
            clusterOutcome = 'killed';
            state.killedClusterCount += 1;
            break;
          }
          continue;
        }

        const initialGeometryCandidates = snapshot.rankedProposalById.get(
          proposal.id,
        )?.initialGeometryCandidates;
        const decodeCascadeStartedAt = nowMs();
        const success = yield* runDecodeCascade(proposal, viewBank, {
          ...(options.traceSink === undefined ? {} : { traceSink: options.traceSink }),
          ...(options.metricsSink === undefined ? {} : { metricsSink: options.metricsSink }),
          ...(initialGeometryCandidates === undefined ? {} : { initialGeometryCandidates }),
          proposalRank,
          topProposalScore: snapshot.topProposalScore,
          onAttemptMeasured: (attempt) => {
            recordTimingSpan(options.metricsSink, 'decode-attempt', nowMs() - attempt.durationMs, {
              proposalId: attempt.proposalId,
              geometryCandidateId: attempt.geometryCandidateId,
              decodeBinaryViewId: attempt.decodeBinaryViewId,
              sampler: attempt.sampler,
              refinement: attempt.refinement,
              outcome: attempt.outcome,
            });
            state.attemptRecords.push({
              sequence: state.attemptRecords.length + 1,
              proposalId: attempt.proposalId,
              geometryCandidateId: attempt.geometryCandidateId,
              decodeBinaryViewId: attempt.decodeBinaryViewId,
              sampler: attempt.sampler,
              refinement: attempt.refinement,
              outcome: attempt.outcome,
              durationMs: attempt.durationMs,
            });
          },
        });
        recordTimingSpan(options.metricsSink, 'decode-cascade', decodeCascadeStartedAt, {
          proposalId: proposal.id,
          proposalRank,
          outcome: success === null ? 'no-decode' : 'success',
        });
        if (success === null) continue;
        const ranked = toRankedResult(success.result, proposal, success.attempt);
        if (!pushUniqueRankedResult(state.results, state.seenResults, ranked)) {
          clusterOutcome = 'duplicate';
          if (!options.continueAfterDecode) break;
          continue;
        }
        clusterOutcome = 'decoded';
        winningProposalId = proposal.id;
        if (!options.allowMultiple) {
          emitClusterFinished(
            options.traceSink,
            cluster,
            clusterRank,
            clusterProcessedRepresentatives,
            structuralFailures,
            clusterOutcome,
            winningProposalId,
          );
          return { stopScanning: true };
        }
        if (!options.continueAfterDecode) break;
      }

      emitClusterFinished(
        options.traceSink,
        cluster,
        clusterRank,
        clusterProcessedRepresentatives,
        structuralFailures,
        clusterOutcome,
        winningProposalId,
      );
    }

    return { stopScanning: false };
  });
};

const emitClusterFinished = (
  traceSink: TraceSink | undefined,
  cluster: ReturnType<typeof clusterRankedProposals>[number],
  clusterRank: number,
  processedRepresentativeCount: number,
  structuralFailureCount: number,
  outcome: 'decoded' | 'duplicate' | 'killed' | 'exhausted',
  winningProposalId?: string,
): void => {
  traceSink?.emit({
    type: 'cluster-finished',
    clusterId: cluster.id,
    clusterRank,
    proposalCount: cluster.proposals.length,
    representativeCount: cluster.representatives.length,
    processedRepresentativeCount,
    structuralFailureCount,
    outcome,
    ...(winningProposalId === undefined ? {} : { winningProposalId }),
  });
};

const buildScanReport = (
  execution: ScanExecution,
  observability: NonNullable<ScanObservabilityOptions>,
): ScanReport => {
  return {
    results: execution.rankedResults.map((ranked) =>
      buildObservedResult(ranked, execution, observability),
    ),
    scan: {
      summary: execution.summary,
      ...(observability.scan?.views === 'summary' ? { views: buildViewSummary(execution) } : {}),
      ...(observability.scan?.proposals === 'summary'
        ? { proposals: execution.proposalGeneration }
        : {}),
      ...(observability.scan?.failure === 'summary'
        ? { failure: buildFailureSummary(execution) }
        : {}),
      ...(observability.scan?.timings === 'summary'
        ? { timings: omitAttemptTimings(execution.timings) }
        : observability.scan?.timings === 'full'
          ? { timings: execution.timings }
          : {}),
      ...(observability.trace?.events === 'summary'
        ? { trace: buildTraceSummary(execution) }
        : observability.trace?.events === 'full'
          ? { trace: buildTraceEvents(execution) }
          : {}),
    },
  } satisfies ScanReport;
};

const buildObservedResult = (
  ranked: RankedScanResult,
  execution: ScanExecution,
  observability: NonNullable<ScanObservabilityOptions>,
): ScanObservedResult => {
  const metadata: { path?: ScanPathMetadata; attempts?: ScanAttemptMetadata } = {};
  const pathLevel = observability.result?.path ?? 'none';
  const attemptsLevel = observability.result?.attempts ?? 'none';

  if (pathLevel !== 'none') {
    metadata.path = {
      proposalId: ranked.proposalId,
      proposalBinaryViewId: ranked.binaryViewId,
      detectorSources: ranked.detectorSources,
      decodeAttempt: ranked.decodeAttempt,
      ...(pathLevel === 'full'
        ? {
            proposalKind: ranked.proposalKind,
            proposalScore: ranked.score,
            scoreBreakdown: ranked.scoreBreakdown,
          }
        : {}),
    } satisfies ScanPathMetadata;
  }

  if (attemptsLevel !== 'none') {
    const attempts = execution.timings.attempts.filter(
      (attempt) => attempt.proposalId === ranked.proposalId,
    );
    metadata.attempts = {
      attemptCount: attempts.length,
      failedTimingChecks: attempts.filter((attempt) => attempt.outcome === 'timing-check').length,
      failedDecodes: attempts.filter((attempt) => attempt.outcome === 'decode_failed').length,
      failedInternalErrors: attempts.filter((attempt) => attempt.outcome === 'internal_error')
        .length,
      decodeBinaryViewIdsTried: uniquePreservingOrder(
        attempts.map((attempt) => attempt.decodeBinaryViewId),
      ),
      refinementsUsed: uniquePreservingOrder(attempts.map((attempt) => attempt.refinement)),
      ...(attemptsLevel === 'full' ? { attempts } : {}),
    } satisfies ScanAttemptMetadata;
  }

  return {
    ...ranked.result,
    metadata,
  } satisfies ScanObservedResult;
};

const buildViewSummary = (execution: ScanExecution): ScanViewSummary => {
  const events = execution.traceCollector?.events ?? [];
  return {
    materializedScalarViewIds: uniquePreservingOrder(
      events
        .filter(
          (event): event is Extract<IronqrTraceEvent, { type: 'scalar-view-built' }> =>
            event.type === 'scalar-view-built',
        )
        .map((event) => event.scalarViewId),
    ),
    materializedBinaryViewIds: uniquePreservingOrder(
      events
        .filter(
          (event): event is Extract<IronqrTraceEvent, { type: 'binary-view-built' }> =>
            event.type === 'binary-view-built',
        )
        .map((event) => event.binaryViewId),
    ),
    proposalBinaryViewIds: execution.proposalBinaryViewIds,
    winningProposalBinaryViewIds: uniquePreservingOrder(
      execution.rankedResults.map((result) => result.binaryViewId),
    ),
    winningDecodeBinaryViewIds: uniquePreservingOrder(
      execution.rankedResults.map((result) => result.decodeAttempt.decodeBinaryViewId),
    ),
  } satisfies ScanViewSummary;
};

const buildFailureSummary = (execution: ScanExecution): ScanFailureSummary => {
  const attemptFailures = aggregateAttemptFailures(execution.timings.attempts);
  return {
    succeeded: execution.summary.successCount > 0,
    ...(execution.summary.successCount > 0
      ? {}
      : {
          dominantFailureClass:
            execution.summary.proposalCount === 0
              ? 'no-proposals'
              : execution.timings.attempts.length === 0
                ? 'structure-screen'
                : 'decode',
        }),
    attemptFailures,
  } satisfies ScanFailureSummary;
};

const buildTraceSummary = (execution: ScanExecution): ScanTraceSummary => {
  if (execution.traceCounter) {
    return {
      counts: execution.traceCounter.counts,
      attemptFailures: execution.traceCounter.attemptFailures,
      clustering: execution.traceCounter.clustering,
      clusterOutcomes: execution.traceCounter.clusterOutcomes,
      scanFinished: execution.traceCounter.scanFinished,
    } satisfies ScanTraceSummary;
  }

  const events = execution.traceCollector?.events ?? [];
  const counts: Partial<Record<IronqrTraceEvent['type'], number>> = {};
  const attemptFailures: Partial<
    Record<'timing-check' | 'decode_failed' | 'internal_error', number>
  > = {};
  let clustering: ProposalClustersBuiltEvent | null = null;
  const clusterOutcomes: ClusterFinishedEvent[] = [];
  let scanFinished: ScanFinishedEvent | null = null;

  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    if (event.type === 'decode-attempt-failed') {
      attemptFailures[event.failure] = (attemptFailures[event.failure] ?? 0) + 1;
      continue;
    }
    if (event.type === 'proposal-clusters-built') {
      clustering = event;
      continue;
    }
    if (event.type === 'cluster-finished') {
      clusterOutcomes.push(event);
      continue;
    }
    if (event.type === 'scan-finished') {
      scanFinished = event;
    }
  }

  return {
    counts,
    attemptFailures,
    clustering,
    clusterOutcomes,
    scanFinished,
  } satisfies ScanTraceSummary;
};

const buildTraceEvents = (execution: ScanExecution): ScanTraceEvents => {
  return { events: execution.traceCollector?.events ?? [] } satisfies ScanTraceEvents;
};

const toRankedResult = (
  result: ScanResult,
  proposal: ScanProposal,
  decodeAttempt: DecodeAttempt,
): RankedScanResult => {
  return {
    result,
    proposalId: proposal.id,
    proposalKind: proposal.kind,
    score: proposal.proposalScore,
    scoreBreakdown: proposal.scoreBreakdown,
    binaryViewId: proposal.binaryViewId,
    detectorSources: listDetectorSources(proposal),
    decodeAttempt,
  } satisfies RankedScanResult;
};

const listDetectorSources = (proposal: ScanProposal): readonly string[] => {
  if (proposal.kind === 'finder-triple') {
    return Array.from(new Set(proposal.finders.map((finder) => finder.source)));
  }
  return Array.from(new Set(proposal.finderLikeEvidence.map((finder) => finder.source)));
};

const pushUniqueRankedResult = (
  results: RankedScanResult[],
  seen: Set<string>,
  ranked: RankedScanResult,
): boolean => {
  const key = [
    ranked.result.version,
    ranked.result.payload.kind,
    Array.from(ranked.result.payload.bytes).join(','),
    Math.round(ranked.result.bounds.x),
    Math.round(ranked.result.bounds.y),
    Math.round(ranked.result.bounds.width),
    Math.round(ranked.result.bounds.height),
  ].join('|');
  if (seen.has(key)) return false;
  seen.add(key);
  results.push(ranked);
  return true;
};

const resolveMaxProposals = (options: ScanRuntimeOptions): number | undefined => {
  if (options.maxCandidates !== undefined && options.maxProposals !== undefined) {
    throw new ScannerError(
      'invalid_input',
      'Use maxProposals or deprecated maxCandidates, not both.',
    );
  }
  return options.maxProposals ?? options.maxCandidates;
};

const resolveMaxProposalsPerView = (options: ScanRuntimeOptions): number | undefined => {
  const value = options.maxProposalsPerView ?? options.maxCandidates;
  return value === undefined ? undefined : normalizeProposalBudget(value);
};

const normalizeProposalBudget = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_PROPOSALS;
  return Math.max(1, Math.min(MAX_SCAN_BUDGET, Math.trunc(value)));
};

const aggregateAttemptFailures = (
  attempts: readonly ScanAttemptRecord[],
): Partial<Record<'timing-check' | 'decode_failed' | 'internal_error', number>> => {
  const failures: Partial<Record<'timing-check' | 'decode_failed' | 'internal_error', number>> = {};
  for (const attempt of attempts) {
    if (attempt.outcome === 'success') continue;
    failures[attempt.outcome] = (failures[attempt.outcome] ?? 0) + 1;
  }
  return failures;
};

const uniquePreservingOrder = <T>(values: readonly T[]): readonly T[] => {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const omitAttemptTimings = (timings: ScanTimingDetails): ScanTimingSummary => {
  return {
    totalMs: timings.totalMs,
    normalizeFrameMs: timings.normalizeFrameMs,
    proposalGenerationMs: timings.proposalGenerationMs,
    rankingMs: timings.rankingMs,
    clusteringMs: timings.clusteringMs,
    clusterProcessingMs: timings.clusterProcessingMs,
    decodeAttemptMs: timings.decodeAttemptMs,
  } satisfies ScanTimingSummary;
};

const createInternalTraceArtifacts = (
  observability: ScanRuntimeOptions['observability'],
  externalTraceSink?: TraceSink,
): {
  readonly collector: TraceCollector | null;
  readonly counter: TraceCounter | null;
  readonly sink?: TraceSink;
} => {
  const needsCollector =
    observability?.trace?.events === 'full' || observability?.scan?.views === 'summary';
  const needsCounter = observability?.trace?.events === 'summary' && !needsCollector;
  const collector = needsCollector ? createTraceCollector() : null;
  const counter = needsCounter ? createTraceCounter() : null;
  const sinks = [externalTraceSink, collector, counter].filter(
    (sink): sink is TraceSink => sink !== undefined && sink !== null,
  );
  if (sinks.length === 0) {
    return { collector, counter };
  }
  const sink: TraceSink =
    sinks.length === 1
      ? sinks[0]!
      : {
          emit(event) {
            for (const sink of sinks) sink.emit(event);
          },
        };
  return {
    collector,
    counter,
    sink,
  };
};

const recordTimingSpan = (
  metricsSink: ScanMetricsSink | undefined,
  name: ScanTimingSpanName,
  startedAtMs: number,
  metadata: Record<string, unknown>,
): void => {
  metricsSink?.record({ name, startedAtMs, durationMs: nowMs() - startedAtMs, metadata });
};

const nowMs = (): number => performance.now();
