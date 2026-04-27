import type { ProposalViewGenerationSummary } from '../../../../packages/ironqr/src/index.js';
import type { BinaryViewId } from '../../../../packages/ironqr/src/pipeline/views.js';
import type {
  BinaryViewSignal,
  ScalarFusionMeasurement,
  ScalarStatsMeasurement,
  SharedArtifactMeasurement,
} from './image-processing-measurements.js';
import type { StudySummaryInput } from './types.js';

export type ImageProcessingFocus =
  | 'binary-bit-hot-path'
  | 'finder-run-map'
  | 'threshold-stats-cache'
  | 'scalar-materialization-fusion'
  | 'module-sampling-hot-path'
  | 'shared-binary-detector-artifacts'
  | 'binary-prefilter-signals';

export interface ImageProcessingConfig extends Record<string, unknown> {
  readonly focus: ImageProcessingFocus;
  readonly viewSet: 'all' | 'production';
  readonly decode: boolean;
}

export interface ImageProcessingAssetResult {
  readonly cacheHit?: boolean;
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly width: number;
  readonly height: number;
  readonly pixelCount: number;
  readonly expectedTexts: readonly string[];
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly falsePositiveTexts: readonly string[];
  readonly success: boolean;
  readonly scanDurationMs: number;
  readonly proposalGenerationMs: number;
  readonly proposalSummaries: readonly ProposalViewGenerationSummary[];
  readonly timing: ImageProcessingTimingSummary;
  readonly binarySignals: readonly BinaryViewSignal[];
  readonly scalarStats: readonly ScalarStatsMeasurement[];
  readonly scalarFusion: ScalarFusionMeasurement;
  readonly sharedArtifacts: SharedArtifactMeasurement;
  readonly matcherCandidates: MatcherCandidateMeasurement | null;
  readonly floodCandidates: FloodCandidateMeasurement | null;
  readonly floodSchedulerLimit: number;
  readonly binaryRead: BinaryReadMeasurement | null;
  readonly decode: DecodeMeasurement | null;
}

export interface ImageProcessingTimingSummary {
  readonly scalarViewMs: number;
  readonly binaryPlaneMs: number;
  readonly binaryViewMs: number;
  readonly proposalViewMs: number;
  readonly moduleSamplingMs: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

export interface BinaryReadMeasurement {
  readonly byteReaderMs: number;
  readonly directBitReaderMs: number;
  readonly deltaMs: number;
  readonly improvementPct: number;
  readonly pixelReads: number;
  readonly countsEqual: boolean;
}

export interface DetectorLatencySummary {
  readonly avgMs: number;
  readonly p85Ms: number;
  readonly p95Ms: number;
  readonly p98Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export type DetectorPatternArea = 'row' | 'flood' | 'matcher' | 'dedupe' | 'flood+matcher';

export interface DetectorVariantMeasurement {
  readonly id: string;
  readonly area: DetectorPatternArea;
  readonly durationMs: number;
  readonly outputCount: number;
  readonly outputsEqual: boolean;
  readonly mismatchCount: number;
  readonly note: string;
  readonly schedulerWaitMs: number;
  readonly samples: readonly number[];
  readonly schedulerWaitSamples: readonly number[];
  readonly queuedSamples: readonly number[];
}

export interface DetectorVariantSummary extends DetectorVariantMeasurement, DetectorLatencySummary {
  readonly controlId: string;
  readonly controlMs: number;
  readonly deltaMs: number;
  readonly improvementPct: number;
  readonly avgSchedulerWaitMs: number;
  readonly p95SchedulerWaitMs: number;
  readonly p98SchedulerWaitMs: number;
  readonly maxSchedulerWaitMs: number;
  readonly avgQueuedMs: number;
  readonly p95QueuedMs: number;
  readonly p98QueuedMs: number;
  readonly maxQueuedMs: number;
}

export interface DetectorUnitMeasurement {
  readonly id: string;
  readonly variantId: string;
  readonly area: DetectorPatternArea;
  readonly durationMs: number;
  readonly outputCount: number;
  readonly outputsEqual: boolean;
  readonly mismatchCount: number;
  readonly cached: boolean;
  readonly schedulerWaitMs: number;
}

export interface DetectorUnitSummary extends DetectorLatencySummary {
  readonly id: string;
  readonly variantId: string;
  readonly area: DetectorPatternArea;
  readonly jobs: number;
  readonly cachedJobs: number;
  readonly outputCount: number;
  readonly outputsEqual: boolean;
  readonly mismatchCount: number;
  readonly schedulerWaitMs: number;
  readonly avgSchedulerWaitMs: number;
  readonly p95SchedulerWaitMs: number;
  readonly p98SchedulerWaitMs: number;
  readonly maxSchedulerWaitMs: number;
  readonly avgQueuedMs: number;
  readonly p95QueuedMs: number;
  readonly p98QueuedMs: number;
  readonly maxQueuedMs: number;
}

export interface VariantCacheMeasurement {
  readonly durationMs: number;
  readonly outputCount: number;
  readonly signature: readonly string[];
  readonly schedulerWaitMs?: number;
}

export interface BenchComponentStats {
  readonly id: number;
  readonly color: number;
  readonly pixelCount: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly centroidX: number;
  readonly centroidY: number;
}

export interface DenseLabelScratch {
  readonly labels: Int32Array;
  readonly queue: Int32Array;
}

export interface ScanlineLabelScratch {
  readonly labels: Int32Array;
  readonly seedX: Int32Array;
  readonly seedY: Int32Array;
}

export interface FloodCandidateMeasurement {
  readonly controlMs: number;
  readonly variants: readonly DetectorVariantMeasurement[];
  readonly units: readonly DetectorUnitMeasurement[];
}

export interface DetectorFamilyOverlapMeasurement {
  readonly viewId: BinaryViewId;
  readonly rowScanCount: number;
  readonly floodCount: number;
  readonly matcherCount: number;
  readonly dedupedCount: number;
  readonly rowScanRetainedCount: number;
  readonly floodRetainedCount: number;
  readonly matcherRetainedCount: number;
  readonly dedupeRemovedCount: number;
  readonly floodOverlapsRowScanCount: number;
  readonly floodOverlapsMatcherCount: number;
  readonly floodOverlapsBothCount: number;
  readonly floodOverlapsNeitherCount: number;
  readonly rowScanOverlapsMatcherCount: number;
}

export interface DetectorFamilyOverlapSummary {
  readonly views: number;
  readonly rowScanCount: number;
  readonly floodCount: number;
  readonly matcherCount: number;
  readonly dedupedCount: number;
  readonly rowScanRetainedCount: number;
  readonly floodRetainedCount: number;
  readonly matcherRetainedCount: number;
  readonly dedupeRemovedCount: number;
  readonly floodOverlapsRowScanCount: number;
  readonly floodOverlapsMatcherCount: number;
  readonly floodOverlapsBothCount: number;
  readonly floodOverlapsNeitherCount: number;
  readonly rowScanOverlapsMatcherCount: number;
  readonly rowScanRetentionPct: number;
  readonly floodRetentionPct: number;
  readonly matcherRetentionPct: number;
  readonly dedupeRemovalPct: number;
  readonly floodRowScanOverlapPct: number;
  readonly floodMatcherOverlapPct: number;
  readonly floodBothOverlapPct: number;
  readonly floodNeitherOverlapPct: number;
  readonly rowScanMatcherOverlapPct: number;
}

export interface MatcherCandidateMeasurement {
  readonly variants: readonly DetectorVariantMeasurement[];
  readonly detectorOverlap: readonly DetectorFamilyOverlapMeasurement[];
  readonly units: readonly DetectorUnitMeasurement[];
  readonly controlMatcherMs: number;
  readonly legacyControlMs: number;
  readonly legacyControlOutputsEqual: boolean;
  readonly legacyControlMismatchCount: number;
  readonly runMapMs: number;
  readonly prunedCenterMs: number;
  readonly legacyPrunedCenterMs: number;
  readonly runMapOutputsEqual: boolean;
  readonly prunedCenterOutputsEqual: boolean;
  readonly legacyPrunedCenterOutputsEqual: boolean;
  readonly runMapMismatchCount: number;
  readonly prunedCenterMismatchCount: number;
  readonly legacyPrunedCenterMismatchCount: number;
  readonly seededMatcherMs: number;
  readonly legacySeededMatcherMs: number;
  readonly fusedPolarityMs: number;
  readonly legacyFusedPolarityMs: number;
  readonly seededMatcherOutputsEqual: boolean;
  readonly legacySeededMatcherOutputsEqual: boolean;
  readonly fusedPolarityOutputsEqual: boolean;
  readonly legacyFusedPolarityOutputsEqual: boolean;
  readonly seededMatcherMismatchCount: number;
  readonly legacySeededMatcherMismatchCount: number;
  readonly fusedPolarityMismatchCount: number;
  readonly legacyFusedPolarityMismatchCount: number;
  readonly seededMatcherEstimatedCenters: number;
  readonly sampledCenterCount: number;
  readonly prunedCenterCount: number;
  readonly fusedDarkCenterCount: number;
  readonly fusedLightCenterCount: number;
  readonly sharedPlaneCount: number;
}

export interface DecodeMeasurement {
  readonly scanDurationMs: number;
  readonly moduleSamplingMs: number;
  readonly sampledModuleCount: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

export interface ImageProcessingSummary extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly decodedAssetCount: number;
  readonly falsePositiveAssetCount: number;
  readonly cache: StudySummaryInput<ImageProcessingConfig, ImageProcessingAssetResult>['cache'];
  readonly totals: ImageProcessingTotals;
  readonly variants: readonly ImageProcessingVariantSummary[];
  readonly perView: readonly ImageProcessingViewSummary[];
  readonly perScalar: readonly ImageProcessingScalarSummary[];
  readonly recommendations: readonly string[];
  readonly detectorCandidates: readonly DetectorVariantSummary[];
  readonly detectorLatency: readonly DetectorUnitSummary[];
  readonly detectorOverlap: DetectorFamilyOverlapSummary;
  readonly detectorUnits: readonly DetectorUnitSummary[];
}

export interface ImageProcessingTotals {
  readonly pixelCount: number;
  readonly proposalGenerationMs: number;
  readonly detectorMs: number;
  readonly scalarViewMs: number;
  readonly binaryPlaneMs: number;
  readonly binaryViewMs: number;
  readonly proposalViewMs: number;
  readonly signalMs: number;
  readonly histogramMs: number;
  readonly otsuMs: number;
  readonly integralMs: number;
  readonly rgbFusionMs: number;
  readonly oklabFusionMs: number;
  readonly shareableRunSignalMs: number;
  readonly perPolarityRunSignalMs: number;
  readonly estimatedSharedArtifactSavedMs: number;
  readonly scanDurationMs: number;
  readonly moduleSamplingMs: number;
  readonly sampledModuleCount: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
  readonly binaryReadByteMs: number;
  readonly binaryReadDirectMs: number;
  readonly binaryReadPixels: number;
  readonly rowScanControlMs: number;
  readonly matcherControlMs: number;
  readonly matcherLegacyControlMs: number;
  readonly matcherLegacyControlOutputsEqual: boolean;
  readonly matcherLegacyControlMismatchCount: number;
  readonly matcherRunMapMs: number;
  readonly matcherPrunedCenterMs: number;
  readonly matcherLegacyPrunedCenterMs: number;
  readonly matcherRunMapOutputsEqual: boolean;
  readonly matcherPrunedCenterOutputsEqual: boolean;
  readonly matcherLegacyPrunedCenterOutputsEqual: boolean;
  readonly matcherRunMapMismatchCount: number;
  readonly matcherPrunedCenterMismatchCount: number;
  readonly matcherLegacyPrunedCenterMismatchCount: number;
  readonly matcherSeededMs: number;
  readonly matcherLegacySeededMs: number;
  readonly matcherFusedPolarityMs: number;
  readonly matcherLegacyFusedPolarityMs: number;
  readonly matcherSeededOutputsEqual: boolean;
  readonly matcherLegacySeededOutputsEqual: boolean;
  readonly matcherFusedPolarityOutputsEqual: boolean;
  readonly matcherLegacyFusedPolarityOutputsEqual: boolean;
  readonly matcherSeededMismatchCount: number;
  readonly matcherLegacySeededMismatchCount: number;
  readonly matcherFusedPolarityMismatchCount: number;
  readonly matcherLegacyFusedPolarityMismatchCount: number;
  readonly matcherSeededEstimatedCenters: number;
  readonly matcherSampledCenterCount: number;
  readonly matcherPrunedCenterCount: number;
  readonly matcherFusedDarkCenterCount: number;
  readonly matcherFusedLightCenterCount: number;
  readonly matcherSharedPlaneCount: number;
  readonly floodControlMs: number;
  readonly floodSchedulerLimit: number;
  readonly floodSchedulerWaitMs: number;
}

export interface ImageProcessingVariantSummary {
  readonly id: string;
  readonly title: string;
  readonly controlMetric: string;
  readonly candidateMetric: string;
  readonly controlMs: number;
  readonly candidateMs: number;
  readonly deltaMs: number;
  readonly improvementPct: number;
  readonly evidence: string;
}

export interface ImageProcessingViewSummary {
  readonly binaryViewId: string;
  readonly assetCount: number;
  readonly detectorMs: number;
  readonly rowScanMs: number;
  readonly floodMs: number;
  readonly matcherMs: number;
  readonly dedupeMs: number;
  readonly proposalCount: number;
  readonly rowScanFinderCount: number;
  readonly floodFinderCount: number;
  readonly matcherFinderCount: number;
  readonly signalMs: number;
  readonly averageDarkRatio: number;
  readonly averageHorizontalTransitionDensity: number;
  readonly averageVerticalTransitionDensity: number;
}

export interface ImageProcessingScalarSummary {
  readonly scalarViewId: string;
  readonly assetCount: number;
  readonly histogramMs: number;
  readonly otsuMs: number;
  readonly integralMs: number;
  readonly integralBytes: number;
}
