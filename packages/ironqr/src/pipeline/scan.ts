import { Effect } from 'effect';
import type { ScanObservabilityOptions, ScanOptions, ScanResult } from '../contracts/scan.js';
import type { ScannerError } from '../qr/errors.js';
import { clusterRankedProposals } from './clusters.js';
import {
  type DecodeAttempt,
  type DecodeAttemptOutcome,
  runDecodeCascade,
} from './decode-cascade.js';
import { normalizeImageInput } from './frame.js';
import { assessProposalStructure } from './plausibility.js';
import {
  generateProposals,
  type ProposalGenerationSummary,
  type ProposalScoreBreakdown,
  type ProposalViewGenerationSummary,
  rankProposalCandidates,
  type ScanProposal,
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
import { type BinaryViewId, createViewBank, type ScalarViewId } from './views.js';

/**
 * Public runtime scan options that extend the schema-backed structural options
 * with generic diagnostics plumbing.
 */
export interface ScanRuntimeOptions extends ScanOptions {
  /** Optional typed trace sink for diagnostics, tests, and benchmark harnesses. */
  readonly traceSink?: TraceSink;
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

const MAX_CLUSTER_REPRESENTATIVES = 3;
const MAX_CLUSTER_STRUCTURAL_FAILURES = 3;

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
  return scanFrameExecutionEffect(input, options).pipe(
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
  return scanFrameExecutionEffect(input, options).pipe(
    Effect.map((execution) => execution.rankedResults),
  );
};

const scanFrameExecutionEffect = (
  input: Parameters<typeof normalizeImageInput>[0],
  options: ScanRuntimeOptions,
): Effect.Effect<ScanExecution, ScannerError> => {
  return scanFrameExecutionOnce(input, options);
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
    traceSink?.emit({ type: 'scan-started', width: image.width, height: image.height });

    const viewBank = createViewBank(image, traceSink ? { traceSink } : {});

    const proposalGenerationStartedAt = nowMs();
    const maxProposalsPerView = resolveMaxProposalsPerView(options);
    const proposalViewSummaries: ProposalViewGenerationSummary[] = [];
    const generatedProposals = generateProposals(viewBank, {
      ...(maxProposalsPerView === undefined ? {} : { maxProposalsPerView }),
      ...(traceSink === undefined ? {} : { traceSink }),
      onViewGenerated: (summary) => {
        proposalViewSummaries.push(summary);
      },
    });
    const proposalGenerationMs = nowMs() - proposalGenerationStartedAt;

    const rankingStartedAt = nowMs();
    const rankedProposalCandidates = rankProposalCandidates(
      viewBank,
      generatedProposals,
      traceSink === undefined ? {} : { traceSink },
    );
    const rankingMs = nowMs() - rankingStartedAt;

    const maxProposals = normalizeProposalBudget(resolveMaxProposals(options));
    const boundedRankedProposalCandidates = rankedProposalCandidates.slice(0, maxProposals);
    const proposals = rankedProposalCandidates.map((candidate) => candidate.proposal);
    const boundedProposals = boundedRankedProposalCandidates.map((candidate) => candidate.proposal);
    const rankedProposalById = new Map(
      boundedRankedProposalCandidates.map((candidate) => [candidate.proposal.id, candidate]),
    );
    const topProposalScore = boundedProposals[0]?.proposalScore ?? 0;
    const proposalRankById = new Map(
      boundedProposals.map((proposal, index) => [proposal.id, index + 1]),
    );

    const clusteringStartedAt = nowMs();
    const clusters = clusterRankedProposals(boundedProposals, {
      maxRepresentatives: MAX_CLUSTER_REPRESENTATIVES,
    });
    const clusteringMs = nowMs() - clusteringStartedAt;

    const representativeCount = clusters.reduce(
      (sum, cluster) => sum + cluster.representatives.length,
      0,
    );
    traceSink?.emit({
      type: 'proposal-clusters-built',
      rankedProposalCount: proposals.length,
      boundedProposalCount: boundedProposals.length,
      clusterCount: clusters.length,
      representativeCount,
      maxRepresentatives: MAX_CLUSTER_REPRESENTATIVES,
    });

    const results: RankedScanResult[] = [];
    const seen = new Set<string>();
    let processedRepresentativeCount = 0;
    let killedClusterCount = 0;
    let stopScanning = false;

    const clusterProcessingStartedAt = nowMs();
    for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex += 1) {
      const cluster = clusters[clusterIndex];
      if (!cluster) continue;
      const clusterRank = clusterIndex + 1;
      const bestProposal = cluster.proposals[0];
      if (!bestProposal) continue;

      traceSink?.emit({
        type: 'cluster-started',
        clusterId: cluster.id,
        clusterRank,
        proposalCount: cluster.proposals.length,
        representativeCount: cluster.representatives.length,
        bestProposalId: bestProposal.id,
        bestProposalScore: bestProposal.proposalScore,
      });

      let structuralFailures = 0;
      let clusterOutcome: 'decoded' | 'duplicate' | 'killed' | 'exhausted' = 'exhausted';
      let winningProposalId: string | undefined;
      let clusterProcessedRepresentatives = 0;

      for (
        let representativeIndex = 0;
        representativeIndex < cluster.representatives.length;
        representativeIndex += 1
      ) {
        const proposal = cluster.representatives[representativeIndex];
        if (!proposal) continue;
        const proposalRank = proposalRankById.get(proposal.id) ?? 1;
        processedRepresentativeCount += 1;
        clusterProcessedRepresentatives += 1;

        traceSink?.emit({
          type: 'cluster-representative-started',
          clusterId: cluster.id,
          clusterRank,
          representativeIndex: representativeIndex + 1,
          proposalId: proposal.id,
          proposalRank,
          proposalScore: proposal.proposalScore,
          binaryViewId: proposal.binaryViewId,
        });

        const structure = assessProposalStructure(proposal, viewBank);
        traceSink?.emit({
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
          if (structuralFailures >= MAX_CLUSTER_STRUCTURAL_FAILURES) {
            clusterOutcome = 'killed';
            killedClusterCount += 1;
            break;
          }
          continue;
        }

        const initialGeometryCandidates = rankedProposalById.get(
          proposal.id,
        )?.initialGeometryCandidates;
        const success = yield* runDecodeCascade(proposal, viewBank, {
          ...(traceSink === undefined ? {} : { traceSink }),
          ...(initialGeometryCandidates === undefined ? {} : { initialGeometryCandidates }),
          proposalRank,
          topProposalScore,
          onAttemptMeasured: (attempt) => {
            attemptRecords.push({
              sequence: attemptRecords.length + 1,
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
        if (success === null) continue;
        const ranked = toRankedResult(success.result, proposal, success.attempt);
        if (!pushUniqueRankedResult(results, seen, ranked)) {
          clusterOutcome = 'duplicate';
          break;
        }
        clusterOutcome = 'decoded';
        winningProposalId = proposal.id;
        if (options.allowMultiple !== true) {
          stopScanning = true;
        }
        break;
      }

      traceSink?.emit({
        type: 'cluster-finished',
        clusterId: cluster.id,
        clusterRank,
        proposalCount: cluster.proposals.length,
        representativeCount: cluster.representatives.length,
        processedRepresentativeCount: clusterProcessedRepresentatives,
        structuralFailureCount: structuralFailures,
        outcome: clusterOutcome,
        ...(winningProposalId === undefined ? {} : { winningProposalId }),
      });

      if (stopScanning) break;
    }
    const clusterProcessingMs = nowMs() - clusterProcessingStartedAt;

    const summary = {
      successCount: results.length,
      proposalCount: proposals.length,
      boundedProposalCount: boundedProposals.length,
      clusterCount: clusters.length,
      representativeCount,
      processedRepresentativeCount,
      killedClusterCount,
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
      rankedResults: results,
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
      proposalGeneration: {
        viewCount: proposalViewSummaries.length,
        proposalCount: generatedProposals.length,
        views: proposalViewSummaries,
      },
    } satisfies ScanExecution;
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
  return options.maxProposals ?? options.maxCandidates;
};

const resolveMaxProposalsPerView = (options: ScanRuntimeOptions): number | undefined => {
  return options.maxProposalsPerView ?? options.maxCandidates;
};

const normalizeProposalBudget = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 24;
  return Math.max(1, Math.trunc(value));
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

const nowMs = (): number => performance.now();
