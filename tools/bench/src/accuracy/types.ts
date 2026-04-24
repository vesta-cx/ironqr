import type { IronqrTraceEvent } from '../../../../packages/ironqr/src/pipeline/trace.js';
import type { BenchImageData } from '../shared/image.js';

export type CorpusAssetLabel = 'qr-pos' | 'qr-neg';

export interface CorpusBenchAsset {
  readonly id: string;
  readonly label: CorpusAssetLabel;
  readonly sha256: string;
  readonly imagePath: string;
  readonly relativePath: string;
  readonly expectedTexts: readonly string[];
  readonly loadImage: () => Promise<BenchImageData>;
}

export type EngineFailureReason =
  | 'failed_to_find_finders'
  | 'failed_to_resolve_geometry'
  | 'failed_to_decode'
  | 'no_decode'
  | 'text_mismatch'
  | 'false_positive'
  | 'engine_error';

export interface AccuracyScanCode {
  readonly text: string;
  readonly kind?: string;
}

export type IronqrTraceMode = 'off' | 'summary' | 'full';

export interface IronqrTraceDiagnostics {
  readonly kind: 'ironqr-trace';
  readonly traceMode: IronqrTraceMode;
  readonly counts: Partial<Record<IronqrTraceEvent['type'], number>>;
  readonly clustering: {
    readonly rankedProposalCount: number;
    readonly boundedProposalCount: number;
    readonly clusterCount: number;
    readonly representativeCount: number;
    readonly maxRepresentatives: number;
  } | null;
  readonly scanFinished: {
    readonly successCount: number;
    readonly proposalCount: number;
    readonly boundedProposalCount: number;
    readonly clusterCount: number;
    readonly representativeCount: number;
    readonly processedRepresentativeCount: number;
    readonly killedClusterCount: number;
  } | null;
  readonly clusterOutcomes: {
    readonly decoded: number;
    readonly duplicate: number;
    readonly killed: number;
    readonly exhausted: number;
  };
  readonly attemptFailures: {
    readonly timingCheck: number;
    readonly decodeFailed: number;
    readonly internalError: number;
  };
  readonly eventCount?: number;
  readonly events?: readonly IronqrTraceEvent[];
}

export type AccuracyScanDiagnostics = IronqrTraceDiagnostics;

interface AccuracyScanBase {
  readonly attempted: true;
  readonly diagnostics?: AccuracyScanDiagnostics | null;
}

export interface AccuracyDecodedScanResult extends AccuracyScanBase {
  readonly status: 'decoded';
  readonly succeeded: true;
  readonly results: readonly AccuracyScanCode[];
  readonly failureReason: null;
  readonly error: null;
}

export interface AccuracyNoDecodeScanResult extends AccuracyScanBase {
  readonly status: 'no-decode';
  readonly succeeded: true;
  readonly results: readonly [];
  readonly failureReason: Exclude<
    EngineFailureReason,
    'engine_error' | 'text_mismatch' | 'false_positive'
  >;
  readonly error: null;
}

export interface AccuracyErrorScanResult extends AccuracyScanBase {
  readonly status: 'error';
  readonly succeeded: false;
  readonly results: readonly [];
  readonly failureReason: EngineFailureReason;
  readonly error: string;
}

export type AccuracyScanResult =
  | AccuracyDecodedScanResult
  | AccuracyNoDecodeScanResult
  | AccuracyErrorScanResult;

export interface AccuracyEngineCapabilities {
  readonly multiCode: boolean;
  readonly inversion: 'native' | 'caller' | 'none';
  readonly rotation: 'native' | 'none';
  readonly runtime: 'js' | 'wasm';
}

export type AccuracyEngineAvailability =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string };

export type AccuracyEngineCacheMode = 'all' | 'pass-only';

export interface AccuracyEngineCachePolicy {
  readonly enabled: boolean;
  readonly version: string;
  readonly mode?: AccuracyEngineCacheMode;
}

export interface AccuracyEngineRunOptions {
  readonly verbose?: boolean;
  readonly ironqrTraceMode?: IronqrTraceMode;
}

export interface AccuracyEngine {
  readonly id: string;
  readonly kind: 'first-party' | 'third-party';
  readonly capabilities: AccuracyEngineCapabilities;
  readonly cache: AccuracyEngineCachePolicy;
  availability: () => AccuracyEngineAvailability;
  scan: (
    asset: CorpusBenchAsset,
    options?: AccuracyEngineRunOptions,
  ) => Promise<AccuracyScanResult>;
}

export type PositiveOutcomeKind =
  | 'pass'
  | 'partial-pass'
  | 'fail-mismatch'
  | 'fail-no-decode'
  | 'fail-error';

export type NegativeOutcomeKind = 'pass' | 'false-positive' | 'fail-error';

export interface PositiveOutcome {
  readonly kind: PositiveOutcomeKind;
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly expectedTexts: readonly string[];
  readonly failureReason: EngineFailureReason | null;
  readonly error: string | null;
}

export interface NegativeOutcome {
  readonly kind: NegativeOutcomeKind;
  readonly decodedTexts: readonly string[];
  readonly failureReason: EngineFailureReason | null;
  readonly error: string | null;
}

export interface EngineAssetResult {
  readonly engineId: string;
  readonly label: CorpusAssetLabel;
  readonly outcome: PositiveOutcomeKind | NegativeOutcomeKind;
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly failureReason: EngineFailureReason | null;
  readonly error: string | null;
  readonly durationMs: number;
  readonly cached: boolean;
  readonly diagnostics?: AccuracyScanDiagnostics | null;
}

export interface AccuracyAssetResult {
  readonly assetId: string;
  readonly label: CorpusAssetLabel;
  readonly relativePath: string;
  readonly expectedTexts: readonly string[];
  readonly results: readonly EngineAssetResult[];
}

export interface AccuracyEngineSummary {
  readonly engineId: string;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly fullPasses: number;
  readonly partialPasses: number;
  readonly positiveFailures: number;
  readonly falsePositives: number;
  readonly negativeErrors: number;
  readonly fullPassRate: number;
  readonly anyPassRate: number;
  readonly falsePositiveRate: number;
  readonly totalDurationMs: number;
  readonly averageDurationMs: number;
  readonly cachedAssets: number;
  readonly freshAssets: number;
}

export type AccuracyEngineDescriptor = Pick<AccuracyEngine, 'id' | 'kind' | 'capabilities'> &
  AccuracyEngineAvailability;

export interface AccuracyBenchmarkCacheSummary {
  readonly enabled: boolean;
  readonly file: string | null;
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
}

export interface AccuracyBenchmarkOptions {
  readonly cache?: {
    readonly enabled?: boolean;
    readonly refresh?: boolean;
    readonly file?: string;
    readonly disabledEngineIds?: readonly string[];
  };
  readonly progress?: {
    readonly enabled?: boolean;
  };
  readonly execution?: {
    readonly workers?: number;
  };
  readonly observability?: {
    readonly verbose?: boolean;
    readonly ironqrTraceMode?: IronqrTraceMode;
  };
}

export interface AccuracyBenchmarkResult {
  readonly repoRoot: string;
  readonly reportFile: string;
  readonly corpusAssetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly engines: readonly AccuracyEngineDescriptor[];
  readonly assets: readonly AccuracyAssetResult[];
  readonly summaries: readonly AccuracyEngineSummary[];
  readonly cache: AccuracyBenchmarkCacheSummary;
}
