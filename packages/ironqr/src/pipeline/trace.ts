import type { DecodeAttemptRefinement } from './decode-cascade.js';
import type { GeometryMode } from './geometry.js';
import type { ProposalScoreBreakdown, ProposalSource } from './proposals.js';
import type { DecodeSampler } from './samplers.js';
import type { BinaryPolarity, BinaryViewId, ScalarViewId, ThresholdMethod } from './views.js';

/**
 * Typed event sink used by scans, tests, and benchmark tooling.
 */
export interface TraceSink {
  /** Emits one pipeline event. */
  emit(event: IronqrTraceEvent): void;
}

/**
 * In-memory trace collector for diagnostics and tests.
 */
export interface TraceCollector extends TraceSink {
  /** All events emitted so far. */
  readonly events: readonly IronqrTraceEvent[];
}

/**
 * Counting trace sink for low-overhead diagnostics.
 */
export interface TraceCounter extends TraceSink {
  /** Event counts keyed by trace event type. */
  readonly counts: Partial<Record<IronqrTraceEvent['type'], number>>;
  /** Decode-attempt failures keyed by failure subtype. */
  readonly attemptFailures: Partial<Record<DecodeAttemptFailedEvent['failure'], number>>;
  /** Latest proposal-clustering summary, if emitted. */
  readonly clustering: ProposalClustersBuiltEvent | null;
  /** Per-cluster completion summaries, in scan order. */
  readonly clusterOutcomes: readonly ClusterFinishedEvent[];
  /** Latest scan-finished summary, if emitted. */
  readonly scanFinished: ScanFinishedEvent | null;
}

/**
 * Scan lifecycle start event.
 */
export interface ScanStartedEvent {
  readonly type: 'scan-started';
  readonly width: number;
  readonly height: number;
}

/**
 * Scalar-view materialization event.
 */
export interface ScalarViewBuiltEvent {
  readonly type: 'scalar-view-built';
  readonly scalarViewId: ScalarViewId;
  readonly width: number;
  readonly height: number;
  readonly family: 'rgb' | 'oklab' | 'derived';
}

/**
 * Binary-view materialization event.
 */
export interface BinaryViewBuiltEvent {
  readonly type: 'binary-view-built';
  readonly binaryViewId: BinaryViewId;
  readonly scalarViewId: ScalarViewId;
  readonly threshold: ThresholdMethod;
  readonly polarity: BinaryPolarity;
  readonly width: number;
  readonly height: number;
}

/**
 * Per-view proposal-generation summary event.
 */
export interface ProposalViewGeneratedEvent {
  readonly type: 'proposal-view-generated';
  readonly binaryViewId: BinaryViewId;
  readonly rowScanFinderCount: number;
  readonly floodFinderCount: number;
  readonly matcherFinderCount: number;
  readonly dedupedFinderCount: number;
  readonly expensiveDetectorsRan: boolean;
  readonly tripleCount: number;
  readonly proposalCount: number;
  readonly durationMs: number;
  readonly detectorDurationMs: number;
  readonly tripleAssemblyDurationMs: number;
  readonly proposalConstructionDurationMs: number;
}

/**
 * Proposal-generation event.
 */
export interface ProposalGeneratedEvent {
  readonly type: 'proposal-generated';
  readonly proposalId: string;
  readonly proposalKind: 'finder-triple' | 'quad';
  readonly binaryViewId: BinaryViewId;
  readonly sources: readonly ProposalSource[];
  readonly estimatedVersions: readonly number[];
}

/**
 * Proposal ranking event.
 */
export interface ProposalRankedEvent {
  readonly type: 'proposal-ranked';
  readonly proposalId: string;
  readonly proposalKind: 'finder-triple' | 'quad';
  readonly binaryViewId: BinaryViewId;
  readonly rank: number;
  readonly scoreBreakdown: ProposalScoreBreakdown;
}

/**
 * Proposal-clustering summary event.
 */
export interface ProposalClustersBuiltEvent {
  readonly type: 'proposal-clusters-built';
  readonly rankedProposalCount: number;
  readonly boundedProposalCount: number;
  readonly clusterCount: number;
  readonly representativeCount: number;
  readonly maxRepresentatives: number;
}

/**
 * One cluster is about to be processed.
 */
export interface ClusterStartedEvent {
  readonly type: 'cluster-started';
  readonly clusterId: string;
  readonly clusterRank: number;
  readonly proposalCount: number;
  readonly representativeCount: number;
  readonly bestProposalId: string;
  readonly bestProposalScore: number;
}

/**
 * One representative proposal is being probed inside a cluster.
 */
export interface ClusterRepresentativeStartedEvent {
  readonly type: 'cluster-representative-started';
  readonly clusterId: string;
  readonly clusterRank: number;
  readonly representativeIndex: number;
  readonly proposalId: string;
  readonly proposalRank: number;
  readonly proposalScore: number;
  readonly binaryViewId: BinaryViewId;
}

/**
 * Cheap structural screening result for one representative proposal.
 */
export interface ProposalStructureAssessedEvent {
  readonly type: 'proposal-structure-assessed';
  readonly clusterId: string;
  readonly clusterRank: number;
  readonly proposalId: string;
  readonly proposalRank: number;
  readonly proposalScore: number;
  readonly passed: boolean;
  readonly score: number;
  readonly timingScore: number;
  readonly finderScore: number;
  readonly separatorScore: number;
  readonly pitchScore: number;
}

/**
 * Geometry-candidate creation event.
 */
export interface GeometryCandidateCreatedEvent {
  readonly type: 'geometry-candidate-created';
  readonly geometryCandidateId: string;
  readonly proposalId: string;
  readonly binaryViewId: BinaryViewId;
  readonly version: number;
  readonly geometryMode: GeometryMode;
  readonly geometryScore: number;
}

/**
 * Decode-attempt start event.
 */
export interface DecodeAttemptStartedEvent {
  readonly type: 'decode-attempt-started';
  readonly proposalId: string;
  readonly geometryCandidateId: string;
  readonly decodeBinaryViewId: BinaryViewId;
  readonly sampler: DecodeSampler;
  readonly refinement: DecodeAttemptRefinement;
}

/**
 * Decode-attempt failure event.
 */
export interface DecodeAttemptFailedEvent {
  readonly type: 'decode-attempt-failed';
  readonly proposalId: string;
  readonly geometryCandidateId: string;
  readonly decodeBinaryViewId: BinaryViewId;
  readonly sampler: DecodeSampler;
  readonly refinement: DecodeAttemptRefinement;
  readonly failure: 'timing-check' | 'decode_failed' | 'internal_error';
}

/**
 * Decode-attempt success event.
 */
export interface DecodeAttemptSucceededEvent {
  readonly type: 'decode-attempt-succeeded';
  readonly proposalId: string;
  readonly geometryCandidateId: string;
  readonly decodeBinaryViewId: BinaryViewId;
  readonly sampler: DecodeSampler;
  readonly refinement: DecodeAttemptRefinement;
  readonly payloadText: string;
}

/**
 * Cluster processing outcome.
 */
export interface ClusterFinishedEvent {
  readonly type: 'cluster-finished';
  readonly clusterId: string;
  readonly clusterRank: number;
  readonly proposalCount: number;
  readonly representativeCount: number;
  readonly processedRepresentativeCount: number;
  readonly structuralFailureCount: number;
  readonly outcome: 'decoded' | 'duplicate' | 'killed' | 'exhausted';
  readonly winningProposalId?: string;
}

/**
 * Scan lifecycle finish event.
 */
export interface ScanFinishedEvent {
  readonly type: 'scan-finished';
  readonly successCount: number;
  readonly proposalCount: number;
  readonly boundedProposalCount: number;
  readonly clusterCount: number;
  readonly representativeCount: number;
  readonly processedRepresentativeCount: number;
  readonly killedClusterCount: number;
}

/**
 * Complete union of public scan-trace events.
 */
export type IronqrTraceEvent =
  | ScanStartedEvent
  | ScalarViewBuiltEvent
  | BinaryViewBuiltEvent
  | ProposalViewGeneratedEvent
  | ProposalGeneratedEvent
  | ProposalRankedEvent
  | ProposalClustersBuiltEvent
  | ClusterStartedEvent
  | ClusterRepresentativeStartedEvent
  | ProposalStructureAssessedEvent
  | GeometryCandidateCreatedEvent
  | DecodeAttemptStartedEvent
  | DecodeAttemptFailedEvent
  | DecodeAttemptSucceededEvent
  | ClusterFinishedEvent
  | ScanFinishedEvent;

/**
 * Creates an in-memory collector that records every emitted event.
 *
 * @returns A mutable collector suitable for tests and benchmarks.
 */
export const createTraceCollector = (): TraceCollector => {
  const events: IronqrTraceEvent[] = [];
  return {
    get events() {
      return events;
    },
    emit(event) {
      events.push(event);
    },
  };
};

/**
 * Creates a low-overhead trace sink that only counts events by type.
 *
 * @returns A mutable counting sink suitable for benchmarks.
 */
export const createTraceCounter = (): TraceCounter => {
  const counts: Partial<Record<IronqrTraceEvent['type'], number>> = {};
  const attemptFailures: Partial<Record<DecodeAttemptFailedEvent['failure'], number>> = {};
  const clusterOutcomes: ClusterFinishedEvent[] = [];
  let clustering: ProposalClustersBuiltEvent | null = null;
  let scanFinished: ScanFinishedEvent | null = null;
  return {
    get counts() {
      return counts;
    },
    get attemptFailures() {
      return attemptFailures;
    },
    get clustering() {
      return clustering;
    },
    get clusterOutcomes() {
      return clusterOutcomes;
    },
    get scanFinished() {
      return scanFinished;
    },
    emit(event) {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      if (event.type === 'decode-attempt-failed') {
        attemptFailures[event.failure] = (attemptFailures[event.failure] ?? 0) + 1;
        return;
      }
      if (event.type === 'proposal-clusters-built') {
        clustering = event;
        return;
      }
      if (event.type === 'cluster-finished') {
        clusterOutcomes.push(event);
        return;
      }
      if (event.type === 'scan-finished') {
        scanFinished = event;
      }
    },
  };
};
