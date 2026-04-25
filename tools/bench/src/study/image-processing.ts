import {
  generateProposalBatchForView,
  type ProposalViewGenerationSummary,
  type ScanTimingSpan,
  scanFrame,
} from '../../../../packages/ironqr/src/index.js';
import {
  createNormalizedImage,
  getOklabPlanes,
} from '../../../../packages/ironqr/src/pipeline/frame.js';
import {
  detectFinderEvidenceWithSummary,
  detectMatcherFinders,
  detectMatcherFindersWithRunMapVariant,
  detectRowScanFindersWithVariant,
  type FinderEvidence,
  type MatcherRunMapVariant,
  type RowScanVariant,
} from '../../../../packages/ironqr/src/pipeline/proposals.js';
import {
  type BinaryView,
  type BinaryViewId,
  createViewBank,
  listDefaultBinaryViewIds,
  listDefaultProposalViewIds,
  readBinaryPixel,
  type ViewBank,
} from '../../../../packages/ironqr/src/pipeline/views.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import type { StudyCacheHandle, StudyPlugin, StudySummaryInput } from './types.js';

type ImageProcessingFocus =
  | 'binary-bit-hot-path'
  | 'finder-run-map'
  | 'threshold-stats-cache'
  | 'scalar-materialization-fusion'
  | 'module-sampling-hot-path'
  | 'shared-binary-detector-artifacts'
  | 'binary-prefilter-signals';

interface ImageProcessingConfig extends Record<string, unknown> {
  readonly focus: ImageProcessingFocus;
  readonly viewSet: 'all' | 'production';
  readonly decode: boolean;
}

interface ImageProcessingAssetResult {
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

interface ImageProcessingTimingSummary {
  readonly scalarViewMs: number;
  readonly binaryPlaneMs: number;
  readonly binaryViewMs: number;
  readonly proposalViewMs: number;
  readonly moduleSamplingMs: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

interface BinaryViewSignal {
  readonly binaryViewId: string;
  readonly scalarViewId: string;
  readonly threshold: string;
  readonly polarity: string;
  readonly durationMs: number;
  readonly darkRatio: number;
  readonly horizontalTransitionDensity: number;
  readonly verticalTransitionDensity: number;
  readonly horizontalRunCount: number;
  readonly verticalRunCount: number;
}

interface ScalarStatsMeasurement {
  readonly scalarViewId: string;
  readonly histogramMs: number;
  readonly otsuMs: number;
  readonly integralMs: number;
  readonly integralBytes: number;
  readonly otsuThreshold: number;
}

interface ScalarFusionMeasurement {
  readonly rgbFamilyMs: number;
  readonly oklabFamilyMs: number;
  readonly rgbPlaneBytes: number;
  readonly oklabPlaneBytes: number;
}

interface SharedArtifactMeasurement {
  readonly planeCount: number;
  readonly polarityViewCount: number;
  readonly shareableRunSignalMs: number;
  readonly perPolarityRunSignalMs: number;
  readonly estimatedSavedMs: number;
}

interface BinaryReadMeasurement {
  readonly byteReaderMs: number;
  readonly directBitReaderMs: number;
  readonly deltaMs: number;
  readonly improvementPct: number;
  readonly pixelReads: number;
  readonly countsEqual: boolean;
}

interface DetectorLatencySummary {
  readonly avgMs: number;
  readonly p85Ms: number;
  readonly p95Ms: number;
  readonly p98Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

type DetectorPatternArea = 'row' | 'flood' | 'matcher' | 'dedupe' | 'flood+matcher';

interface DetectorVariantMeasurement {
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

interface DetectorVariantSummary extends DetectorVariantMeasurement, DetectorLatencySummary {
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

interface DetectorUnitMeasurement {
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

interface DetectorUnitSummary extends DetectorLatencySummary {
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

interface VariantCacheMeasurement {
  readonly durationMs: number;
  readonly outputCount: number;
  readonly signature: readonly string[];
  readonly schedulerWaitMs?: number;
}

interface BenchComponentStats {
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

interface DenseLabelScratch {
  readonly labels: Int32Array;
  readonly queue: Int32Array;
}

interface ScanlineLabelScratch {
  readonly labels: Int32Array;
  readonly seedX: Int32Array;
  readonly seedY: Int32Array;
}

interface FloodCandidateMeasurement {
  readonly controlMs: number;
  readonly variants: readonly DetectorVariantMeasurement[];
  readonly units: readonly DetectorUnitMeasurement[];
}

interface DetectorFamilyOverlapMeasurement {
  readonly viewId: BinaryViewId;
  readonly rowScanCount: number;
  readonly floodCount: number;
  readonly matcherCount: number;
  readonly dedupedCount: number;
  readonly rowScanRetainedCount: number;
  readonly floodRetainedCount: number;
  readonly matcherRetainedCount: number;
  readonly dedupeRemovedCount: number;
}

interface DetectorFamilyOverlapSummary {
  readonly views: number;
  readonly rowScanCount: number;
  readonly floodCount: number;
  readonly matcherCount: number;
  readonly dedupedCount: number;
  readonly rowScanRetainedCount: number;
  readonly floodRetainedCount: number;
  readonly matcherRetainedCount: number;
  readonly dedupeRemovedCount: number;
  readonly rowScanRetentionPct: number;
  readonly floodRetentionPct: number;
  readonly matcherRetentionPct: number;
  readonly dedupeRemovalPct: number;
}

interface MatcherCandidateMeasurement {
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

interface DecodeMeasurement {
  readonly scanDurationMs: number;
  readonly moduleSamplingMs: number;
  readonly sampledModuleCount: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

interface ImageProcessingSummary extends Record<string, unknown> {
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

interface ImageProcessingTotals {
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

interface ImageProcessingVariantSummary {
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

interface ImageProcessingViewSummary {
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

interface ImageProcessingScalarSummary {
  readonly scalarViewId: string;
  readonly assetCount: number;
  readonly histogramMs: number;
  readonly otsuMs: number;
  readonly integralMs: number;
  readonly integralBytes: number;
}

const STUDY_VERSION = 'study-v1';
const WHITE = 255;
const EXHAUSTIVE_SCAN_CEILING = 10_000;

const ironqrDescriptor = () => describeAccuracyEngine(getAccuracyEngineById('ironqr'));

export const binaryBitHotPathStudyPlugin = makeImageProcessingStudyPlugin({
  id: 'binary-bit-hot-path',
  title: 'IronQR binary bit hot-path study',
  description:
    'Profiles byte-oriented binary pixel read hotspots in finder detection and optional module sampling.',
  focus: 'binary-bit-hot-path',
  decodeDefault: false,
});

export const finderRunMapStudyPlugin = makeImageProcessingStudyPlugin({
  id: 'finder-run-map',
  title: 'IronQR finder run-map study',
  description:
    'Measures row/column run-signal costs and detector correlations before adding run-map scanner internals.',
  focus: 'finder-run-map',
  decodeDefault: false,
});

export const thresholdStatsCacheStudyPlugin = makeImageProcessingStudyPlugin({
  id: 'threshold-stats-cache',
  title: 'IronQR threshold statistics cache study',
  description:
    'Measures scalar histogram, Otsu threshold, and integral-image dependency costs for threshold reuse.',
  focus: 'threshold-stats-cache',
  decodeDefault: false,
});

export const scalarMaterializationFusionStudyPlugin = makeImageProcessingStudyPlugin({
  id: 'scalar-materialization-fusion',
  title: 'IronQR scalar materialization fusion study',
  description:
    'Compares existing lazy scalar-view materialization with study-side fused RGB and OKLab family passes.',
  focus: 'scalar-materialization-fusion',
  decodeDefault: false,
});

export const moduleSamplingHotPathStudyPlugin = makeImageProcessingStudyPlugin({
  id: 'module-sampling-hot-path',
  title: 'IronQR module sampling hot-path study',
  description: 'Profiles module-sampling time per sampled module during decode attempts.',
  focus: 'module-sampling-hot-path',
  decodeDefault: true,
});

export const sharedBinaryDetectorArtifactsStudyPlugin = makeImageProcessingStudyPlugin({
  id: 'shared-binary-detector-artifacts',
  title: 'IronQR shared binary detector artifacts study',
  description:
    'Estimates the cost available to save by sharing threshold-plane detector artifacts across polarities.',
  focus: 'shared-binary-detector-artifacts',
  decodeDefault: false,
});

export const binaryPrefilterSignalsStudyPlugin = makeImageProcessingStudyPlugin({
  id: 'binary-prefilter-signals',
  title: 'IronQR legacy vs run-map matcher study',
  description:
    'Compares legacy pixel-walk matcher cross-check output against the run-map matcher control across binary views.',
  focus: 'binary-prefilter-signals',
  decodeDefault: false,
});

function makeImageProcessingStudyPlugin(input: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly focus: ImageProcessingFocus;
  readonly decodeDefault: boolean;
}): StudyPlugin<ImageProcessingSummary, ImageProcessingConfig, ImageProcessingAssetResult> {
  let redundantDetectorCachePurged = false;
  const preloadedDetectorRows = new Set<string>();
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    version: STUDY_VERSION,
    usesInternalCache: input.focus === 'binary-prefilter-signals',
    flags: [
      {
        name: 'max-assets',
        type: 'number',
        description: 'Limit approved corpus assets processed by the study.',
      },
      {
        name: 'view-set',
        type: 'string',
        description: 'Binary views to profile: all or production.',
        default: 'all',
      },
      {
        name: 'decode',
        type: 'boolean',
        description: 'Run the full decode scanner after proposal/materialization profiling.',
        default: input.decodeDefault,
      },
    ],
    parseConfig: ({ flags }) => {
      const viewSet = flags['view-set'] ?? 'all';
      if (viewSet !== 'all' && viewSet !== 'production') {
        throw new Error(`${input.id} --view-set must be all or production, got ${String(viewSet)}`);
      }
      return {
        focus: input.focus,
        viewSet,
        decode: typeof flags.decode === 'boolean' ? flags.decode : input.decodeDefault,
      };
    },
    cacheKey: (config) => JSON.stringify(config),
    engines: () => [ironqrDescriptor()],
    observability: (config) => ({
      focus: config.focus,
      viewSet: config.viewSet,
      decode: config.decode,
      metrics: 'materialization,proposal,signals,stats,fusion,decode',
    }),
    estimateUnits: (config, assets) =>
      config.focus === 'binary-prefilter-signals'
        ? assets.length * detectorStudyViewIds(config).length * activeDetectorPatternIds().length
        : null,
    readCachedAsset: async ({ asset, config, cache, signal, log }) => {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      if (config.focus !== 'binary-prefilter-signals') return null;
      if (!redundantDetectorCachePurged) {
        redundantDetectorCachePurged = true;
        log('detector cache purge starting: scanning binned pattern rows');
        await purgeRedundantDetectorCacheRows(cache, log);
      }
      return readCachedDetectorAssetResult(asset, config, cache, log, {
        replayPartialRows: true,
        preloadedRows: preloadedDetectorRows,
      });
    },
    runAsset: async ({ asset, config, cache, signal, log }) => {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      if (config.focus === 'binary-prefilter-signals') {
        if (!redundantDetectorCachePurged) {
          redundantDetectorCachePurged = true;
          log('detector cache purge starting: scanning binned pattern rows');
          await purgeRedundantDetectorCacheRows(cache, log);
        }
        const cached = await readCachedDetectorAssetResult(asset, config, cache, log, {
          replayPartialRows: false,
          preloadedRows: preloadedDetectorRows,
        });
        if (cached) return cached;
      }
      const image = await asset.loadImage();
      const normalized = createNormalizedImage(image);
      const spans: ScanTimingSpan[] = [];
      const metricsSink = { record: (span: ScanTimingSpan) => spans.push(span) };
      const viewBank = createViewBank(normalized, { metricsSink });
      const viewIds = detectorStudyViewIds(config);

      log(
        `${asset.id}: profiling ${viewIds.length} binary view identities over ${sharedPlaneCount(viewIds)} shared threshold planes (${config.focus})`,
      );
      const studyStartedAt = performance.now();
      const proposalSummaries: ProposalViewGenerationSummary[] = [];
      const binarySignals: BinaryViewSignal[] = [];
      const scalarStats: ScalarStatsMeasurement[] = [];
      let scalarFusion = emptyScalarFusionMeasurement();
      let sharedArtifacts = emptySharedArtifactMeasurement();
      let matcherCandidates: MatcherCandidateMeasurement | null = null;
      let floodCandidates: FloodCandidateMeasurement | null = null;
      let proposalGenerationMs = 0;

      if (config.focus === 'binary-prefilter-signals') {
        const detectorStartedAt = performance.now();
        floodCandidates = await measureFloodCandidateVariants(
          viewBank,
          viewIds,
          asset.id,
          asset,
          cache,
          log,
          preloadedDetectorRows,
          signal,
        );
        if (activeMatcherPatternIds().length > 0) {
          matcherCandidates = await measureMatcherCandidateVariants(
            viewBank,
            viewIds,
            asset.id,
            asset,
            cache,
            log,
            preloadedDetectorRows,
            signal,
          );
        }
        proposalGenerationMs = round(performance.now() - detectorStartedAt);
      } else {
        const proposalStartedAt = performance.now();
        let proposalViewIndex = 0;
        for (const viewId of viewIds) {
          proposalViewIndex += 1;
          const summary = generateProposalBatchForView(viewBank, viewId, {
            maxProposalsPerView: EXHAUSTIVE_SCAN_CEILING,
          }).summary;
          proposalSummaries.push(summary);
          logStudyTiming(
            log,
            studyTimingId(viewId, 'c'),
            summary.detectorDurationMs,
            'view',
            summary.proposalCount,
          );
          logFinderDetectorTimings(log, viewId, 'c', summary);
          log(`${asset.id}: proposal path ${proposalViewIndex}/${viewIds.length} ${viewId}`);
          await yieldToDashboard();
        }
        proposalGenerationMs = round(performance.now() - proposalStartedAt);
        let binarySignalIndex = 0;
        for (const viewId of viewIds) {
          binarySignalIndex += 1;
          binarySignals.push(measureBinarySignals(viewBank.getBinaryView(viewId)));
          log(`${asset.id}: polarity signal ${binarySignalIndex}/${viewIds.length} ${viewId}`);
          await yieldToDashboard();
        }
        const scalarViewIds = viewBank.listScalarViewIds();
        let scalarViewIndex = 0;
        for (const scalarId of scalarViewIds) {
          scalarViewIndex += 1;
          scalarStats.push(
            measureScalarStats(
              scalarId,
              viewBank.getScalarView(scalarId).values,
              image.width,
              image.height,
            ),
          );
          log(`${asset.id}: scalar stats ${scalarViewIndex}/${scalarViewIds.length} ${scalarId}`);
          await yieldToDashboard();
        }
        scalarFusion = measureScalarFusion(image);
        sharedArtifacts = summarizeSharedArtifacts(binarySignals);
      }
      const binaryRead =
        config.focus === 'binary-bit-hot-path'
          ? await measureBinaryReadVariants(viewBank, viewIds, asset.id, log)
          : null;
      const decode = config.decode ? await runDecodeMeasurement(image, viewIds, asset, log) : null;
      const expectedTexts = uniqueTexts(
        asset.expectedTexts.map(normalizeDecodedText).filter(Boolean),
      );
      const decodedTexts = decode?.decodedTexts ?? [];
      const matchedTexts = decodedTexts.filter((text) => expectedTexts.includes(text));
      const falsePositiveTexts = asset.label === 'qr-neg' ? decodedTexts : [];
      return {
        assetId: asset.id,
        label: asset.label,
        width: image.width,
        height: image.height,
        pixelCount: image.width * image.height,
        expectedTexts,
        decodedTexts,
        matchedTexts,
        falsePositiveTexts,
        success: config.decode
          ? asset.label === 'qr-neg'
            ? decodedTexts.length === 0
            : matchedTexts.length > 0
          : true,
        scanDurationMs: round(performance.now() - studyStartedAt),
        proposalGenerationMs,
        proposalSummaries,
        timing: summarizeTimingSpans(spans),
        binarySignals,
        scalarStats,
        scalarFusion,
        sharedArtifacts,
        matcherCandidates,
        floodCandidates,
        floodSchedulerLimit: floodSchedulerLimit(),
        binaryRead,
        decode: decode === null ? null : stripDecodedTexts(decode),
      };
    },
    summarize: (summaryInput) => summarizeImageProcessingStudy(summaryInput),
    renderReport: ({ config, results, summary }) => ({
      config,
      totals: summary.totals,
      variants: summary.variants,
      perView: summary.perView,
      perScalar: summary.perScalar,
      recommendations: summary.recommendations,
      sampledAssets: results.map((result) => ({
        assetId: result.assetId,
        label: result.label,
        width: result.width,
        height: result.height,
        success: result.success,
        decodedTexts: result.decodedTexts,
        matchedTexts: result.matchedTexts,
        scanDurationMs: result.scanDurationMs,
        falsePositiveTexts: result.falsePositiveTexts,
        proposalGenerationMs: result.proposalGenerationMs,
        timing: result.timing,
        scalarFusion: result.scalarFusion,
        sharedArtifacts: result.sharedArtifacts,
        matcherCandidates: result.matcherCandidates,
        floodSchedulerLimit: result.floodSchedulerLimit,
        binaryRead: result.binaryRead,
        decode: result.decode,
      })),
      rows: results.flatMap((result) =>
        result.proposalSummaries.map((proposal) => ({
          assetId: result.assetId,
          label: result.label,
          ...flattenProposalSummary(proposal),
          signal:
            result.binarySignals.find((signal) => signal.binaryViewId === proposal.binaryViewId) ??
            null,
        })),
      ),
      scalarStats: results.flatMap((result) =>
        result.scalarStats.map((stats) => ({
          assetId: result.assetId,
          label: result.label,
          ...stats,
        })),
      ),
    }),
  };
}

const STUDY_TIMING_PREFIX = '__bench_study_timing__';

const logStudyTiming = (
  log: (message: string) => void,
  id: string,
  durationMs: number,
  group: 'view' | 'detector' = 'view',
  outputCount = 0,
  cached = false,
): void => {
  log(`${STUDY_TIMING_PREFIX}${JSON.stringify({ id, durationMs, group, outputCount, cached })}`);
};

const logFinderDetectorTimings = (
  log: (message: string) => void,
  viewId: BinaryViewId,
  variant: string,
  summary: ProposalViewGenerationSummary,
): void => {
  logStudyTiming(
    log,
    detectorTimingId(viewId, variant, 'row'),
    summary.finderEvidence.rowScanDurationMs,
    'detector',
    summary.finderEvidence.rowScanCount,
  );
  logStudyTiming(
    log,
    detectorTimingId(viewId, variant, 'flood'),
    summary.finderEvidence.floodDurationMs,
    'detector',
    summary.finderEvidence.floodCount,
  );
  logStudyTiming(
    log,
    detectorTimingId(viewId, variant, 'matcher'),
    summary.finderEvidence.matcherDurationMs,
    'detector',
    summary.finderEvidence.matcherCount,
  );
  logStudyTiming(
    log,
    detectorTimingId(viewId, variant, 'dedupe'),
    summary.finderEvidence.dedupeDurationMs,
    'detector',
    summary.finderEvidence.dedupedCount,
  );
};

const studyTimingId = (
  viewId: BinaryViewId,
  variant: string,
  polarityOverride?: string,
): string => {
  const [scalar = '', threshold = '', polarity = ''] = viewId.split(':');
  return `${shortVariantId(variant)}:${shortBinaryViewPart(scalar)}:${shortBinaryViewPart(threshold)}:${shortBinaryViewPart(polarityOverride ?? polarity)}`;
};

const detectorTimingId = (viewId: BinaryViewId, variant: string, detector: string): string => {
  const [scalar = '', threshold = '', polarity = ''] = viewId.split(':');
  return `${shortVariantId(variant)}:${shortDetectorFamily(detector)}:${shortBinaryViewPart(scalar)}:${shortBinaryViewPart(threshold)}:${shortBinaryViewPart(polarity)}`;
};

const sharedPlaneCount = (viewIds: readonly BinaryViewId[]): number =>
  new Set(viewIds.map((viewId) => viewId.split(':').slice(0, 2).join(':'))).size;

const detectorStudyViewIds = (config: ImageProcessingConfig): readonly BinaryViewId[] =>
  config.viewSet === 'all' ? listDefaultBinaryViewIds() : listDefaultProposalViewIds();

const FLOOD_CONTROL_ID = 'scanline-squared';

const activeDetectorPatternIds = (): readonly string[] => [
  'row-scan',
  ...ACTIVE_ROW_CANDIDATES.map((candidate) => candidate.id),
  FLOOD_CONTROL_ID,
  ...ACTIVE_FLOOD_CANDIDATES.map((candidate) => candidate.id),
  ...activeMatcherPatternIds(),
  'dedupe',
];

const activeMatcherPatternIds = (): readonly string[] => [
  'run-map',
  ...ACTIVE_MATCHER_CANDIDATES.map((candidate) => candidate.id),
];

const retainedDetectorPatternIds = (): readonly string[] => activeDetectorPatternIds();

const readCachedDetectorAssetResult = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  config: ImageProcessingConfig,
  cache: StudyCacheHandle<unknown>,
  log: (message: string) => void,
  options: { readonly replayPartialRows: boolean; readonly preloadedRows: Set<string> },
): Promise<ImageProcessingAssetResult | null> => {
  const viewIds = detectorStudyViewIds(config);
  const requiredIds = activeDetectorPatternIds();
  const missing = viewIds.flatMap((viewId) =>
    requiredIds
      .filter((variantId) =>
        detectorVariantCacheKeys(variantId, viewId).every(
          (cacheKey) => !cache.has(asset, cacheKey),
        ),
      )
      .map((variantId) => `${variantId}:${viewId}`),
  );
  if (missing.length > 0) {
    if (options.replayPartialRows) {
      const replayed = await replayCachedDetectorRows(
        asset,
        cache,
        viewIds,
        requiredIds,
        log,
        options.preloadedRows,
      );
      log(
        `${asset.id}: detector cache missing ${missing.length}/${requiredIds.length * viewIds.length} variant-view rows; preloaded ${replayed} cached rows`,
      );
    } else {
      log(
        `${asset.id}: detector cache missing ${missing.length}/${requiredIds.length * viewIds.length} variant-view rows`,
      );
    }
    return null;
  }

  let floodControlMs = 0;
  let matcherControlMs = 0;
  const floodVariants = new Map<string, DetectorVariantMeasurement>();
  const matcherVariants = new Map<string, DetectorVariantMeasurement>();
  const floodUnits: DetectorUnitMeasurement[] = [];
  const matcherUnits: DetectorUnitMeasurement[] = [];
  const measureMatchers = activeMatcherPatternIds().length > 0;

  for (const viewId of viewIds) {
    await yieldToDashboard();
    const rowScan = await readVariantMeasurement(asset, cache, 'row-scan', viewId);
    if (!rowScan) return null;
    const floodControl = await readVariantMeasurement(asset, cache, FLOOD_CONTROL_ID, viewId);
    if (!floodControl) return null;
    const matcherControl = measureMatchers
      ? await readVariantMeasurement(asset, cache, 'run-map', viewId)
      : null;
    if (measureMatchers && !matcherControl) return null;
    const dedupe = await readVariantMeasurement(asset, cache, 'dedupe', viewId);
    if (!dedupe) return null;
    floodControlMs += floodControl.durationMs;
    if (matcherControl) matcherControlMs += matcherControl.durationMs;
    const rowScanId = detectorTimingId(viewId, 'row-scan', 'row');
    matcherUnits.push(detectorUnit(rowScanId, 'row-scan', 'row', rowScan, true, true));
    logStudyTiming(log, rowScanId, rowScan.durationMs, 'detector', rowScan.outputCount, true);
    for (const candidate of ACTIVE_ROW_CANDIDATES) {
      const measured = await readVariantMeasurement(asset, cache, candidate.id, viewId);
      if (!measured) return null;
      const compared = compareVariant(
        candidate.id,
        'row',
        rowScan.signature,
        measured,
        candidate.note,
      );
      mergeDetectorVariant(matcherVariants, compared);
      const unitId = detectorTimingId(viewId, candidate.id, 'row');
      matcherUnits.push(
        detectorUnit(unitId, candidate.id, 'row', measured, true, compared.outputsEqual),
      );
      logStudyTiming(log, unitId, measured.durationMs, 'detector', measured.outputCount, true);
    }
    const floodControlId = detectorTimingId(viewId, FLOOD_CONTROL_ID, 'flood');
    floodUnits.push(
      detectorUnit(floodControlId, FLOOD_CONTROL_ID, 'flood', floodControl, true, true),
    );
    if (matcherControl) {
      const matcherControlId = detectorTimingId(viewId, 'run-map', 'matcher');
      matcherUnits.push(
        detectorUnit(matcherControlId, 'run-map', 'matcher', matcherControl, true, true),
      );
      logStudyTiming(
        log,
        matcherControlId,
        matcherControl.durationMs,
        'detector',
        matcherControl.outputCount,
        true,
      );
    }
    logStudyTiming(
      log,
      floodControlId,
      floodControl.durationMs,
      'detector',
      floodControl.outputCount,
      true,
    );
    const dedupeId = detectorTimingId(viewId, 'dedupe', 'dedupe');
    matcherUnits.push(detectorUnit(dedupeId, 'dedupe', 'dedupe', dedupe, true, true));
    logStudyTiming(log, dedupeId, dedupe.durationMs, 'detector', dedupe.outputCount, true);

    for (const candidate of ACTIVE_FLOOD_CANDIDATES) {
      const measured = await readVariantMeasurement(asset, cache, candidate.id, viewId);
      if (!measured) return null;
      const compared = compareVariant(
        candidate.id,
        'flood',
        floodControl.signature,
        measured,
        candidate.note,
      );
      mergeDetectorVariant(floodVariants, compared);
      const unitId = detectorTimingId(viewId, candidate.id, 'flood');
      floodUnits.push(
        detectorUnit(unitId, candidate.id, 'flood', measured, true, compared.outputsEqual),
      );
      logStudyTiming(log, unitId, measured.durationMs, 'detector', measured.outputCount, true);
    }
    for (const candidate of ACTIVE_MATCHER_CANDIDATES) {
      const measured = await readVariantMeasurement(asset, cache, candidate.id, viewId);
      if (!measured) return null;
      const area = 'matcher';
      const compared = compareVariant(
        candidate.id,
        area,
        matcherControl?.signature ?? [],
        measured,
        candidate.note,
      );
      mergeDetectorVariant(matcherVariants, compared);
      const unitId = detectorTimingId(viewId, candidate.id, 'matcher');
      matcherUnits.push(
        detectorUnit(unitId, candidate.id, area, measured, true, compared.outputsEqual),
      );
      logStudyTiming(log, unitId, measured.durationMs, 'detector', measured.outputCount, true);
    }
  }

  log(
    `${asset.id}: cache replayed ${requiredIds.length * viewIds.length} detector pattern rows; no variant work queued`,
  );
  return {
    cacheHit: true,
    assetId: asset.id,
    label: asset.label,
    width: 0,
    height: 0,
    pixelCount: 0,
    expectedTexts: asset.expectedTexts,
    decodedTexts: [],
    matchedTexts: [],
    falsePositiveTexts: [],
    success: true,
    scanDurationMs: 0,
    proposalGenerationMs: 0,
    proposalSummaries: [],
    timing: emptyTimingSummary(),
    binarySignals: [],
    scalarStats: [],
    scalarFusion: emptyScalarFusionMeasurement(),
    sharedArtifacts: emptySharedArtifactMeasurement(),
    matcherCandidates: measureMatchers
      ? cachedMatcherMeasurement(matcherControlMs, viewIds, matcherVariants, matcherUnits)
      : null,
    floodCandidates: {
      controlMs: round(floodControlMs),
      variants: [...floodVariants.values()],
      units: floodUnits,
    },
    floodSchedulerLimit: 0,
    binaryRead: null,
    decode: null,
  };
};

const replayCachedDetectorRows = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read'>,
  viewIds: readonly BinaryViewId[],
  variantIds: readonly string[],
  log: (message: string) => void,
  preloadedRows: Set<string>,
): Promise<number> => {
  let replayed = 0;
  for (const viewId of viewIds) {
    await yieldToDashboard();
    for (const variantId of variantIds) {
      const measurement = await readVariantMeasurement(asset, cache, variantId, viewId);
      if (!measurement) continue;
      replayed += 1;
      preloadedRows.add(detectorRowKey(asset.id, variantId, viewId));
      const detector = detectorAreaId(variantId) === 'f' ? 'flood' : 'matcher';
      logStudyTiming(
        log,
        detectorTimingId(viewId, variantId, detector),
        measurement.durationMs,
        'detector',
        measurement.outputCount,
        true,
      );
    }
  }
  return replayed;
};

const purgeRedundantDetectorCacheRows = async (
  cache: Pick<StudyCacheHandle, 'purge'>,
  log: (message: string) => void,
): Promise<void> => {
  const activeIds = new Set(retainedDetectorPatternIds());
  const activeVariantIds = [...activeIds].flatMap((variantId) => [
    variantId,
    ...(LEGACY_VARIANT_IDS[variantId] ?? []),
  ]);
  const activePatternPrefixes = new Set(
    activeVariantIds.flatMap((variantId) => [
      detectorPatternPrefix(variantId),
      legacyDetectorPatternPrefix(variantId),
      `${legacyShortVariantId(variantId)}:${detectorAreaId(variantId)}:`,
    ]),
  );
  const startedAt = performance.now();
  const purged = await cache.purge((cacheKey) => {
    const parsed = parseDetectorCacheKey(cacheKey);
    if (!parsed) return false;
    if (parsed.kind === 'detector-variant') return !activeVariantIds.includes(parsed.variantId);
    return ![...activePatternPrefixes].some((prefix) => parsed.patternId.startsWith(prefix));
  });
  const elapsed = round(performance.now() - startedAt);
  log(
    purged > 0
      ? `detector cache purge complete: removed ${purged} binned pattern rows in ${elapsed}ms`
      : `detector cache purge complete: no binned pattern rows found in ${elapsed}ms`,
  );
};

const parseDetectorCacheKey = (
  cacheKey: string,
):
  | { readonly kind: 'detector-variant'; readonly variantId: string }
  | { readonly kind: 'detector-pattern'; readonly patternId: string }
  | null => {
  try {
    const parsed = JSON.parse(cacheKey) as Record<string, unknown>;
    if (parsed.kind === 'detector-variant' && typeof parsed.variantId === 'string') {
      return { kind: 'detector-variant', variantId: parsed.variantId };
    }
    if (parsed.kind === 'detector-pattern' && typeof parsed.patternId === 'string') {
      return { kind: 'detector-pattern', patternId: parsed.patternId };
    }
  } catch {
    return null;
  }
  return null;
};

const readVariantMeasurement = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read'>,
  variantId: string,
  viewId: BinaryViewId,
): Promise<VariantCacheMeasurement | null> => {
  for (const cacheKey of detectorVariantCacheKeys(variantId, viewId)) {
    if (!cache.has(asset, cacheKey)) continue;
    const value = await cache.read(asset, cacheKey);
    if (isVariantCacheMeasurement(value)) return value;
  }
  return null;
};

const cachedMatcherMeasurement = (
  controlMatcherMs: number,
  viewIds: readonly BinaryViewId[],
  variants: ReadonlyMap<string, DetectorVariantMeasurement>,
  units: readonly DetectorUnitMeasurement[],
): MatcherCandidateMeasurement => ({
  variants: [...variants.values()],
  detectorOverlap: [],
  units,
  controlMatcherMs: round(controlMatcherMs),
  legacyControlMs: 0,
  legacyControlOutputsEqual: true,
  legacyControlMismatchCount: 0,
  runMapMs: round(controlMatcherMs),
  prunedCenterMs: 0,
  legacyPrunedCenterMs: 0,
  runMapOutputsEqual: true,
  prunedCenterOutputsEqual: true,
  legacyPrunedCenterOutputsEqual: true,
  runMapMismatchCount: 0,
  prunedCenterMismatchCount: 0,
  legacyPrunedCenterMismatchCount: 0,
  seededMatcherMs: 0,
  legacySeededMatcherMs: 0,
  fusedPolarityMs: 0,
  legacyFusedPolarityMs: 0,
  seededMatcherOutputsEqual: true,
  legacySeededMatcherOutputsEqual: true,
  fusedPolarityOutputsEqual: true,
  legacyFusedPolarityOutputsEqual: true,
  seededMatcherMismatchCount: 0,
  legacySeededMatcherMismatchCount: 0,
  fusedPolarityMismatchCount: 0,
  legacyFusedPolarityMismatchCount: 0,
  seededMatcherEstimatedCenters: 0,
  sampledCenterCount: 0,
  prunedCenterCount: 0,
  fusedDarkCenterCount: 0,
  fusedLightCenterCount: 0,
  sharedPlaneCount: sharedPlaneCount(viewIds),
});

const emptyTimingSummary = (): ImageProcessingTimingSummary => ({
  scalarViewMs: 0,
  binaryPlaneMs: 0,
  binaryViewMs: 0,
  proposalViewMs: 0,
  moduleSamplingMs: 0,
  decodeAttemptMs: 0,
  decodeCascadeMs: 0,
});

const ROW_CANDIDATES = [
  {
    id: 'row-scan-scalar-score',
    note: 'Row-scan detector with scalar ratio-score arithmetic.',
  },
  {
    id: 'row-scan-u16',
    note: 'Row-scan detector using compact run maps for cross-checks.',
  },
  {
    id: 'row-scan-u16-scalar-score',
    note: 'Row-scan detector combining compact run-map cross-checks with scalar scoring.',
  },
  {
    id: 'row-scan-packed-u16',
    note: 'Row-scan detector using packed run-map cross-checks.',
  },
  {
    id: 'row-scan-packed-u16-scalar-score',
    note: 'Row-scan detector combining packed run-map cross-checks with scalar scoring.',
  },
] as const satisfies readonly { id: RowScanVariant; note: string }[];

const ACTIVE_ROW_CANDIDATES: readonly (typeof ROW_CANDIDATES)[number][] = ROW_CANDIDATES;

const FLOOD_CANDIDATES = [
  {
    id: 'legacy-flood',
    note: 'Historical two-pass connected-component flood detector retained as a control row.',
  },
  {
    id: 'dense-index',
    note: 'Dense stats plus min-x indexed containment lookup.',
  },
  {
    id: 'dense-squared',
    note: 'Dense stats plus squared-distance geometry tests.',
  },
  {
    id: 'dense-index-squared',
    note: 'Dense stats plus indexed containment and squared-distance tests.',
  },
  {
    id: 'scanline-stats',
    note: 'Scanline component labeling with dense stats and linear containment lookup.',
  },
  {
    id: 'scanline-index',
    note: 'Scanline component labeling plus min-x indexed containment lookup.',
  },
  {
    id: 'scanline-squared',
    note: 'Scanline component labeling plus squared-distance geometry tests.',
  },
  {
    id: 'scanline-index-squared',
    note: 'Scanline component labeling plus indexed containment and squared-distance tests.',
  },
  {
    id: 'spatial-bin',
    note: 'Historical typed-array stats plus spatially indexed contained-component lookup.',
  },
  { id: 'run-length-ccl', note: 'Historical run-length connected components prototype.' },
] as const;

const ACTIVE_FLOOD_CANDIDATES: readonly (typeof FLOOD_CANDIDATES)[number][] =
  FLOOD_CANDIDATES.filter((candidate) => candidate.id === 'legacy-flood');

const MATCHER_CANDIDATES = [
  {
    id: 'legacy-matcher',
    note: 'Historical pixel-walk cross-check matcher retained as a control row.',
  },
  {
    id: 'run-map-u16',
    note: 'Run-map matcher with 16-bit axis maps when image dimensions fit.',
  },
  {
    id: 'run-map-u16-fill-horizontal',
    note: 'Run-map matcher with compact axis maps and typed-array fill for horizontal runs.',
  },
  {
    id: 'run-map-scalar-score',
    note: 'Run-map matcher with scalar ratio-score arithmetic instead of tuple reduction.',
  },
  {
    id: 'run-map-u16-scalar-score',
    note: 'Run-map matcher combining compact axis maps with scalar ratio-score arithmetic.',
  },
  {
    id: 'run-map-packed-u16',
    note: 'Run-map matcher with start/end packed into one 32-bit word per axis.',
  },
  {
    id: 'run-map-packed-u16-fill-horizontal',
    note: 'Packed run-map matcher plus typed-array fill for horizontal runs.',
  },
  {
    id: 'run-map-packed-u16-scalar-score',
    note: 'Packed run-map matcher plus scalar ratio-score arithmetic.',
  },
] as const satisfies readonly { id: MatcherRunMapVariant; note: string }[];

const ACTIVE_MATCHER_CANDIDATES: readonly (typeof MATCHER_CANDIDATES)[number][] =
  MATCHER_CANDIDATES.filter((candidate) => candidate.id === 'legacy-matcher');

const throwIfStudyAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
};

interface VariantScheduler {
  readonly acquire: () => Promise<number>;
  readonly release: () => void;
}

const createFloodScheduler = (): VariantScheduler | undefined => {
  const buffer = Reflect.get(globalThis, '__BENCH_STUDY_FLOOD_SEMAPHORE__');
  if (!(buffer instanceof SharedArrayBuffer)) return undefined;
  const permits = new Int32Array(buffer);
  return {
    async acquire() {
      const startedAt = performance.now();
      while (true) {
        const available = Atomics.load(permits, 0);
        if (
          available > 0 &&
          Atomics.compareExchange(permits, 0, available, available - 1) === available
        ) {
          return round(performance.now() - startedAt);
        }
        Atomics.wait(permits, 0, 0, 50);
      }
    },
    release() {
      Atomics.add(permits, 0, 1);
      Atomics.notify(permits, 0, 1);
    },
  };
};

const floodSchedulerLimit = (): number => {
  const value = Reflect.get(globalThis, '__BENCH_STUDY_FLOOD_CONCURRENCY_LIMIT__');
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const measureKnownDurationVariant = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  variantId: string,
  viewId: BinaryViewId,
  preloadedRows: ReadonlySet<string>,
  produce: () => VariantCacheMeasurement,
): Promise<{
  readonly measurement: VariantCacheMeasurement;
  readonly cached: boolean;
  readonly preloaded: boolean;
}> => {
  const cached = await readVariantMeasurement(asset, cache, variantId, viewId);
  if (cached)
    return {
      measurement: cached,
      cached: true,
      preloaded: preloadedRows.has(detectorRowKey(asset.id, variantId, viewId)),
    };
  const measurement = produce();
  await cache.write(asset, detectorVariantCacheKey(variantId, viewId), measurement);
  return { measurement, cached: false, preloaded: false };
};

const measureVariant = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  variantId: string,
  viewId: BinaryViewId,
  preloadedRows: ReadonlySet<string>,
  run: () => FinderEvidence[] | Promise<FinderEvidence[]>,
  scheduler?: VariantScheduler,
): Promise<{
  readonly output: FinderEvidence[];
  readonly measurement: VariantCacheMeasurement;
  readonly cached: boolean;
  readonly preloaded: boolean;
}> => {
  const cached = await readVariantMeasurement(asset, cache, variantId, viewId);
  if (cached)
    return {
      output: [],
      measurement: cached,
      cached: true,
      preloaded: preloadedRows.has(detectorRowKey(asset.id, variantId, viewId)),
    };
  const cacheKey = detectorVariantCacheKey(variantId, viewId);
  const schedulerWaitMs = scheduler ? await scheduler.acquire() : 0;
  try {
    const startedAt = performance.now();
    const output = await run();
    const cachedMeasurement = {
      durationMs: round(performance.now() - startedAt),
      outputCount: output.length,
      signature: finderSignature(output),
    };
    await cache.write(asset, cacheKey, cachedMeasurement);
    return {
      output,
      measurement: { ...cachedMeasurement, schedulerWaitMs },
      cached: false,
      preloaded: false,
    };
  } finally {
    scheduler?.release();
  }
};

const detectorRowKey = (assetId: string, variantId: string, viewId: BinaryViewId): string =>
  `${assetId}\u0000${variantId}\u0000${viewId}`;

const compareVariant = (
  id: string,
  area: DetectorVariantMeasurement['area'],
  controlSignature: readonly string[],
  measurement: VariantCacheMeasurement,
  note: string,
): DetectorVariantMeasurement => {
  const outputsEqual = signaturesEqual(controlSignature, measurement.signature);
  const schedulerWaitMs = measurement.schedulerWaitMs ?? 0;
  return {
    id,
    area,
    durationMs: measurement.durationMs,
    outputCount: measurement.outputCount,
    outputsEqual,
    mismatchCount: outputsEqual ? 0 : 1,
    note,
    schedulerWaitMs,
    samples: [measurement.durationMs],
    schedulerWaitSamples: [schedulerWaitMs],
    queuedSamples: [measurement.durationMs + schedulerWaitMs],
  };
};

const detectorTimingMeasurement = (
  durationMs: number,
  outputCount: number,
): VariantCacheMeasurement => ({
  durationMs: round(durationMs),
  outputCount,
  signature: [],
});

const detectorUnit = (
  id: string,
  variantId: string,
  area: DetectorUnitMeasurement['area'],
  measurement: VariantCacheMeasurement,
  cached: boolean,
  outputsEqual: boolean,
): DetectorUnitMeasurement => ({
  id,
  variantId,
  area,
  durationMs: measurement.durationMs,
  outputCount: measurement.outputCount,
  outputsEqual,
  mismatchCount: outputsEqual ? 0 : 1,
  cached,
  schedulerWaitMs: measurement.schedulerWaitMs ?? 0,
});

const finderSignature = (evidence: readonly FinderEvidence[]): readonly string[] =>
  evidence
    .map((entry) =>
      [
        entry.source,
        entry.centerX.toFixed(2),
        entry.centerY.toFixed(2),
        entry.moduleSize.toFixed(3),
        entry.hModuleSize.toFixed(3),
        entry.vModuleSize.toFixed(3),
        (entry.score ?? 0).toFixed(3),
      ].join(':'),
    )
    .sort();

const signaturesEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const isVariantCacheMeasurement = (value: unknown): value is VariantCacheMeasurement =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { durationMs?: unknown }).durationMs === 'number' &&
  typeof (value as { outputCount?: unknown }).outputCount === 'number' &&
  Array.isArray((value as { signature?: unknown }).signature);

const floodCandidateOutput = async (
  variantId: string,
  view: BinaryView,
): Promise<FinderEvidence[]> => {
  if (variantId === 'legacy-flood') return legacyFloodCandidateOutput(view);
  const options = floodVariantOptions(variantId);
  const yieldIfDue = createCooperativeYield();
  if (options.useScanline) {
    return floodFromComponentsWithOptions(await labelScanlineComponents(view, yieldIfDue), options);
  }
  return floodFromComponentsWithOptions(await labelDenseComponents(view, yieldIfDue), options);
};

const floodVariantOptions = (
  variantId: string,
): {
  readonly useScanline: boolean;
  readonly indexedLookup: boolean;
  readonly squaredDistance: boolean;
} => ({
  useScanline: variantId.startsWith('scanline-'),
  indexedLookup: variantId.includes('index') || variantId === 'spatial-bin',
  squaredDistance: variantId.includes('squared'),
});

const componentLabelScratch = <T>(
  key: string,
  create: () => T,
  hasCapacity: (value: T) => boolean,
): T => {
  const existing = Reflect.get(globalThis, key);
  if (existing && hasCapacity(existing as T)) return existing as T;
  const next = create();
  Reflect.set(globalThis, key, next);
  return next;
};

const scanlineLabelScratch = (size: number): ScanlineLabelScratch =>
  componentLabelScratch(
    '__BENCH_STUDY_SCANLINE_LABEL_SCRATCH__',
    () => ({
      labels: new Int32Array(size),
      seedX: new Int32Array(size),
      seedY: new Int32Array(size),
    }),
    (scratch: ScanlineLabelScratch) => scratch.labels.length >= size,
  );

const denseLabelScratch = (size: number): DenseLabelScratch =>
  componentLabelScratch(
    '__BENCH_STUDY_DENSE_LABEL_SCRATCH__',
    () => ({ labels: new Int32Array(size), queue: new Int32Array(size) }),
    (scratch: DenseLabelScratch) => scratch.labels.length >= size,
  );

const labelScanlineComponents = (
  binary: BinaryView,
  yieldIfDue?: () => Promise<void> | undefined,
): readonly BenchComponentStats[] | Promise<readonly BenchComponentStats[]> =>
  yieldIfDue
    ? labelScanlineComponentsCooperative(binary, yieldIfDue)
    : labelScanlineComponentsSync(binary);

const labelScanlineComponentsSync = (binary: BinaryView): readonly BenchComponentStats[] => {
  const width = binary.width;
  const height = binary.height;
  const size = width * height;
  const scratch = scanlineLabelScratch(size);
  const labels = scratch.labels;
  const seedX = scratch.seedX;
  const seedY = scratch.seedY;
  labels.fill(0, 0, size);
  const stats: BenchComponentStats[] = [];
  let nextLabel = 1;

  for (let start = 0; start < size; start += 1) {
    if (labels[start] !== 0) continue;
    const color = readBinaryPixel(binary, start);
    let head = 0;
    let tail = 1;
    let pixelCount = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let sumX = 0;
    let sumY = 0;
    seedX[0] = minX;
    seedY[0] = minY;

    while (head < tail) {
      const x = seedX[head] ?? 0;
      const y = seedY[head] ?? 0;
      head += 1;
      const index = y * width + x;
      if (labels[index] !== 0 || readBinaryPixel(binary, index) !== color) continue;

      let left = x;
      while (left > 0) {
        const next = y * width + left - 1;
        if (labels[next] !== 0 || readBinaryPixel(binary, next) !== color) break;
        left -= 1;
      }
      let right = x;
      while (right + 1 < width) {
        const next = y * width + right + 1;
        if (labels[next] !== 0 || readBinaryPixel(binary, next) !== color) break;
        right += 1;
      }

      for (let spanX = left; spanX <= right; spanX += 1) labels[y * width + spanX] = nextLabel;
      const runLength = right - left + 1;
      pixelCount += runLength;
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += ((left + right) * runLength) / 2;
      sumY += y * runLength;

      if (y > 0)
        tail = enqueueAdjacentScanlineSeeds(
          binary,
          labels,
          seedX,
          seedY,
          tail,
          left,
          right,
          y - 1,
          color,
        );
      if (y + 1 < height)
        tail = enqueueAdjacentScanlineSeeds(
          binary,
          labels,
          seedX,
          seedY,
          tail,
          left,
          right,
          y + 1,
          color,
        );
    }

    stats.push({
      id: nextLabel,
      color,
      pixelCount,
      minX,
      minY,
      maxX,
      maxY,
      centroidX: sumX / pixelCount,
      centroidY: sumY / pixelCount,
    });
    nextLabel += 1;
  }

  return stats;
};

const labelScanlineComponentsCooperative = async (
  binary: BinaryView,
  yieldIfDue?: () => Promise<void> | undefined,
): Promise<readonly BenchComponentStats[]> => {
  const width = binary.width;
  const height = binary.height;
  const labels = new Int32Array(width * height);
  const seedX = new Int32Array(width * height);
  const seedY = new Int32Array(width * height);
  const stats: BenchComponentStats[] = [];
  let nextLabel = 1;

  for (let start = 0; start < labels.length; start += 1) {
    const yielded = yieldIfDue?.();
    if (yielded) await yielded;
    if (labels[start] !== 0) continue;
    const color = readBinaryPixel(binary, start);
    let head = 0;
    let tail = 1;
    let pixelCount = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let sumX = 0;
    let sumY = 0;
    seedX[0] = minX;
    seedY[0] = minY;

    while (head < tail) {
      const yielded = yieldIfDue?.();
      if (yielded) await yielded;
      const x = seedX[head] ?? 0;
      const y = seedY[head] ?? 0;
      head += 1;
      const index = y * width + x;
      if (labels[index] !== 0 || readBinaryPixel(binary, index) !== color) continue;

      let left = x;
      while (left > 0) {
        const next = y * width + left - 1;
        if (labels[next] !== 0 || readBinaryPixel(binary, next) !== color) break;
        left -= 1;
      }
      let right = x;
      while (right + 1 < width) {
        const next = y * width + right + 1;
        if (labels[next] !== 0 || readBinaryPixel(binary, next) !== color) break;
        right += 1;
      }

      for (let spanX = left; spanX <= right; spanX += 1) labels[y * width + spanX] = nextLabel;
      const runLength = right - left + 1;
      pixelCount += runLength;
      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += ((left + right) * runLength) / 2;
      sumY += y * runLength;

      if (y > 0)
        tail = enqueueAdjacentScanlineSeeds(
          binary,
          labels,
          seedX,
          seedY,
          tail,
          left,
          right,
          y - 1,
          color,
        );
      if (y + 1 < height)
        tail = enqueueAdjacentScanlineSeeds(
          binary,
          labels,
          seedX,
          seedY,
          tail,
          left,
          right,
          y + 1,
          color,
        );
    }

    stats.push({
      id: nextLabel,
      color,
      pixelCount,
      minX,
      minY,
      maxX,
      maxY,
      centroidX: sumX / pixelCount,
      centroidY: sumY / pixelCount,
    });
    nextLabel += 1;
  }

  return stats;
};

const enqueueAdjacentScanlineSeeds = (
  binary: BinaryView,
  labels: Int32Array,
  seedX: Int32Array,
  seedY: Int32Array,
  tail: number,
  left: number,
  right: number,
  y: number,
  color: number,
): number => {
  const width = binary.width;
  let inRun = false;
  for (let x = left; x <= right; x += 1) {
    const index = y * width + x;
    const same = labels[index] === 0 && readBinaryPixel(binary, index) === color;
    if (same && !inRun) {
      seedX[tail] = x;
      seedY[tail] = y;
      tail += 1;
    }
    inRun = same;
  }
  return tail;
};

const floodFromComponentsWithOptions = (
  components: readonly BenchComponentStats[],
  options: { readonly indexedLookup: boolean; readonly squaredDistance: boolean },
): FinderEvidence[] => {
  if (options.indexedLookup) {
    return floodFromIndexedComponentSets(
      components.filter((component) => component.color === 0),
      components.filter((component) => component.color === 255),
      components.filter((component) => component.color === 0),
      options,
    );
  }
  return floodFromComponentSets(
    components.filter((component) => component.color === 0),
    components.filter((component) => component.color === 255),
    components.filter((component) => component.color === 0),
    options,
  );
};

const floodFromIndexedComponentSets = (
  rings: readonly BenchComponentStats[],
  gaps: readonly BenchComponentStats[],
  stones: readonly BenchComponentStats[],
  options: { readonly squaredDistance: boolean },
): FinderEvidence[] => {
  const gapsByMinX = [...gaps].sort((left, right) => left.minX - right.minX);
  const stonesByMinX = [...stones].sort((left, right) => left.minX - right.minX);
  const evidence: FinderEvidence[] = [];
  for (const ring of rings) {
    if (!isBenchFloodRing(ring)) continue;
    const ringWidth = ring.maxX - ring.minX + 1;
    const ringHeight = ring.maxY - ring.minY + 1;
    const gap = findContainedCandidate(
      gapsByMinX,
      ring,
      Math.min(ringWidth, ringHeight) * 0.25,
      options.squaredDistance,
    );
    if (!gap) continue;
    const stone = findContainedCandidate(
      stonesByMinX,
      gap,
      Math.min(gap.maxX - gap.minX + 1, gap.maxY - gap.minY + 1) * 0.2,
      options.squaredDistance,
      ring.id,
    );
    if (!stone) continue;
    appendFloodEvidence(evidence, ring, stone);
  }
  return finalizeFloodEvidence(evidence);
};

const findContainedCandidate = (
  candidatesByMinX: readonly BenchComponentStats[],
  outer: BenchComponentStats,
  centerTolerance: number,
  squaredDistance: boolean,
  excludedId?: number,
): BenchComponentStats | null => {
  for (const candidate of candidatesByMinX) {
    if (candidate.minX <= outer.minX) continue;
    if (candidate.minX >= outer.maxX) break;
    if (candidate.id === excludedId || !containedIn(candidate, outer)) continue;
    if (!centersNear(candidate, outer, centerTolerance, squaredDistance)) continue;
    return candidate;
  }
  return null;
};

const appendFloodEvidence = (
  evidence: FinderEvidence[],
  ring: BenchComponentStats,
  stone: BenchComponentStats,
): void => {
  const areaRatio = stone.pixelCount / Math.max(1, ring.pixelCount);
  if (areaRatio < 0.18 || areaRatio > 0.72) return;
  const moduleSize = Math.sqrt(ring.pixelCount / 24);
  evidence.push({
    source: 'flood',
    centerX: ring.centroidX,
    centerY: ring.centroidY,
    moduleSize,
    hModuleSize: moduleSize,
    vModuleSize: moduleSize,
    score: 1.5 - Math.abs(areaRatio - 0.375),
  });
};

const finalizeFloodEvidence = (evidence: readonly FinderEvidence[]): FinderEvidence[] =>
  dedupeBenchEvidence(evidence)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12);

const centersNear = (
  candidate: BenchComponentStats,
  outer: BenchComponentStats,
  tolerance: number,
  squaredDistance: boolean,
): boolean => {
  const dx = candidate.centroidX - outer.centroidX;
  const dy = candidate.centroidY - outer.centroidY;
  return squaredDistance
    ? dx * dx + dy * dy < tolerance * tolerance
    : Math.hypot(dx, dy) < tolerance;
};

const labelDenseComponents = (
  binary: BinaryView,
  yieldIfDue?: () => Promise<void> | undefined,
): readonly BenchComponentStats[] | Promise<readonly BenchComponentStats[]> =>
  yieldIfDue
    ? labelDenseComponentsCooperative(binary, yieldIfDue)
    : labelDenseComponentsSync(binary);

const labelDenseComponentsSync = (binary: BinaryView): readonly BenchComponentStats[] => {
  const width = binary.width;
  const height = binary.height;
  const size = width * height;
  const scratch = denseLabelScratch(size);
  const labels = scratch.labels;
  const queue = scratch.queue;
  labels.fill(0, 0, size);
  const stats: BenchComponentStats[] = [];
  let nextLabel = 1;
  for (let start = 0; start < size; start += 1) {
    if (labels[start] !== 0) continue;
    const color = readBinaryPixel(binary, start);
    let head = 0;
    let tail = 1;
    let pixelCount = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let sumX = 0;
    let sumY = 0;
    queue[0] = start;
    labels[start] = nextLabel;
    while (head < tail) {
      const index = queue[head] ?? 0;
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      pixelCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;
      if (x > 0) tail = enqueueSame(binary, labels, queue, tail, index - 1, color, nextLabel);
      if (x + 1 < width)
        tail = enqueueSame(binary, labels, queue, tail, index + 1, color, nextLabel);
      if (y > 0) tail = enqueueSame(binary, labels, queue, tail, index - width, color, nextLabel);
      if (y + 1 < height)
        tail = enqueueSame(binary, labels, queue, tail, index + width, color, nextLabel);
    }
    stats.push({
      id: nextLabel,
      color,
      pixelCount,
      minX,
      minY,
      maxX,
      maxY,
      centroidX: sumX / pixelCount,
      centroidY: sumY / pixelCount,
    });
    nextLabel += 1;
  }
  return stats;
};

const labelDenseComponentsCooperative = async (
  binary: BinaryView,
  yieldIfDue?: () => Promise<void> | undefined,
): Promise<readonly BenchComponentStats[]> => {
  const width = binary.width;
  const height = binary.height;
  const labels = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  const stats: BenchComponentStats[] = [];
  let nextLabel = 1;
  for (let start = 0; start < labels.length; start += 1) {
    const yielded = yieldIfDue?.();
    if (yielded) await yielded;
    if (labels[start] !== 0) continue;
    const color = readBinaryPixel(binary, start);
    let head = 0;
    let tail = 1;
    let pixelCount = 0;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let sumX = 0;
    let sumY = 0;
    queue[0] = start;
    labels[start] = nextLabel;
    while (head < tail) {
      const yielded = yieldIfDue?.();
      if (yielded) await yielded;
      const index = queue[head] ?? 0;
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      pixelCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;
      if (x > 0) tail = enqueueSame(binary, labels, queue, tail, index - 1, color, nextLabel);
      if (x + 1 < width)
        tail = enqueueSame(binary, labels, queue, tail, index + 1, color, nextLabel);
      if (y > 0) tail = enqueueSame(binary, labels, queue, tail, index - width, color, nextLabel);
      if (y + 1 < height)
        tail = enqueueSame(binary, labels, queue, tail, index + width, color, nextLabel);
    }
    stats.push({
      id: nextLabel,
      color,
      pixelCount,
      minX,
      minY,
      maxX,
      maxY,
      centroidX: sumX / pixelCount,
      centroidY: sumY / pixelCount,
    });
    nextLabel += 1;
  }
  return stats;
};

const enqueueSame = (
  binary: BinaryView,
  labels: Int32Array,
  queue: Int32Array,
  tail: number,
  index: number,
  color: number,
  label: number,
): number => {
  if (labels[index] !== 0 || readBinaryPixel(binary, index) !== color) return tail;
  labels[index] = label;
  queue[tail] = index;
  return tail + 1;
};

const floodFromComponents = (components: readonly BenchComponentStats[]): FinderEvidence[] =>
  floodFromComponentsWithOptions(components, { indexedLookup: false, squaredDistance: false });

const legacyFloodCandidateOutput = (binary: BinaryView): FinderEvidence[] =>
  floodFromComponents(legacyTwoPassComponents(binary));

const legacyTwoPassComponents = (binary: BinaryView): readonly BenchComponentStats[] => {
  const width = binary.width;
  const height = binary.height;
  const size = width * height;
  const labels = new Int32Array(size);
  const queue = new Int32Array(size);
  const colors: number[] = [255];
  let nextLabel = 1;

  for (let start = 0; start < size; start += 1) {
    if (labels[start] !== 0) continue;
    const color = readBinaryPixel(binary, start);
    colors[nextLabel] = color;
    let head = 0;
    let tail = 1;
    labels[start] = nextLabel;
    queue[0] = start;

    while (head < tail) {
      const index = queue[head] ?? 0;
      head += 1;
      const x = index % width;
      if (x > 0)
        tail = enqueueLegacyComponentPixel(
          binary,
          labels,
          queue,
          tail,
          index - 1,
          color,
          nextLabel,
        );
      if (x + 1 < width)
        tail = enqueueLegacyComponentPixel(
          binary,
          labels,
          queue,
          tail,
          index + 1,
          color,
          nextLabel,
        );
      if (index >= width)
        tail = enqueueLegacyComponentPixel(
          binary,
          labels,
          queue,
          tail,
          index - width,
          color,
          nextLabel,
        );
      if (index + width < size)
        tail = enqueueLegacyComponentPixel(
          binary,
          labels,
          queue,
          tail,
          index + width,
          color,
          nextLabel,
        );
    }

    nextLabel += 1;
  }

  const pixelCounts = new Int32Array(nextLabel);
  const minX = new Int32Array(nextLabel);
  const minY = new Int32Array(nextLabel);
  const maxX = new Int32Array(nextLabel);
  const maxY = new Int32Array(nextLabel);
  const sumX = new Float64Array(nextLabel);
  const sumY = new Float64Array(nextLabel);
  minX.fill(width);
  minY.fill(height);

  for (let index = 0; index < size; index += 1) {
    const label = labels[index] ?? 0;
    if (label === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    pixelCounts[label] = (pixelCounts[label] ?? 0) + 1;
    if (x < (minX[label] ?? width)) minX[label] = x;
    if (y < (minY[label] ?? height)) minY[label] = y;
    if (x > (maxX[label] ?? 0)) maxX[label] = x;
    if (y > (maxY[label] ?? 0)) maxY[label] = y;
    sumX[label] = (sumX[label] ?? 0) + x;
    sumY[label] = (sumY[label] ?? 0) + y;
  }

  const components: BenchComponentStats[] = [];
  for (let id = 1; id < nextLabel; id += 1) {
    const pixelCount = pixelCounts[id] ?? 0;
    if (pixelCount === 0) continue;
    components.push({
      id,
      color: colors[id] ?? 255,
      pixelCount,
      minX: minX[id] ?? 0,
      minY: minY[id] ?? 0,
      maxX: maxX[id] ?? 0,
      maxY: maxY[id] ?? 0,
      centroidX: (sumX[id] ?? 0) / pixelCount,
      centroidY: (sumY[id] ?? 0) / pixelCount,
    });
  }
  return components;
};

const enqueueLegacyComponentPixel = (
  binary: BinaryView,
  labels: Int32Array,
  queue: Int32Array,
  tail: number,
  index: number,
  color: number,
  label: number,
): number => {
  if (labels[index] !== 0 || readBinaryPixel(binary, index) !== color) return tail;
  labels[index] = label;
  queue[tail] = index;
  return tail + 1;
};

const floodFromComponentSets = (
  rings: readonly BenchComponentStats[],
  gaps: readonly BenchComponentStats[],
  stones: readonly BenchComponentStats[],
  options: { readonly squaredDistance: boolean } = { squaredDistance: false },
): FinderEvidence[] => {
  const evidence: FinderEvidence[] = [];
  for (const ring of rings) {
    if (!isBenchFloodRing(ring)) continue;
    const ringWidth = ring.maxX - ring.minX + 1;
    const ringHeight = ring.maxY - ring.minY + 1;
    const gap = gaps.find(
      (candidate) =>
        containedIn(candidate, ring) &&
        centersNear(
          candidate,
          ring,
          Math.min(ringWidth, ringHeight) * 0.25,
          options.squaredDistance,
        ),
    );
    if (!gap) continue;
    const stone = stones.find(
      (candidate) =>
        candidate.id !== ring.id &&
        containedIn(candidate, gap) &&
        centersNear(
          candidate,
          gap,
          Math.min(gap.maxX - gap.minX + 1, gap.maxY - gap.minY + 1) * 0.2,
          options.squaredDistance,
        ),
    );
    if (!stone) continue;
    appendFloodEvidence(evidence, ring, stone);
  }
  return finalizeFloodEvidence(evidence);
};

const containedIn = (inner: BenchComponentStats, outer: BenchComponentStats): boolean =>
  inner.minX > outer.minX &&
  inner.maxX < outer.maxX &&
  inner.minY > outer.minY &&
  inner.maxY < outer.maxY;

const isBenchFloodRing = (component: BenchComponentStats): boolean => {
  const width = component.maxX - component.minX + 1;
  const height = component.maxY - component.minY + 1;
  const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
  return component.pixelCount >= 16 && aspect <= 1.7;
};

const dedupeBenchEvidence = (evidence: readonly FinderEvidence[]): FinderEvidence[] => {
  const kept: FinderEvidence[] = [];
  for (const entry of evidence)
    if (
      !kept.some(
        (other) =>
          distancePoint(entry.centerX, entry.centerY, other.centerX, other.centerY) <
          Math.max(2, Math.min(entry.moduleSize, other.moduleSize)),
      )
    )
      kept.push(entry);
  return kept;
};

const distancePoint = (x0: number, y0: number, x1: number, y1: number): number =>
  Math.hypot(x1 - x0, y1 - y0);

const measureFloodCandidateVariants = async (
  viewBank: ViewBank,
  viewIds: readonly BinaryViewId[],
  _assetId: string,
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  log: (message: string) => void,
  preloadedRows: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<FloodCandidateMeasurement> => {
  let controlMs = 0;
  const variants = new Map<string, DetectorVariantMeasurement>();
  const units: DetectorUnitMeasurement[] = [];

  for (const viewId of viewIds) {
    throwIfStudyAborted(signal);
    const view = viewBank.getBinaryView(viewId);
    const floodScheduler = createFloodScheduler();
    const control = await measureVariant(
      asset,
      cache,
      FLOOD_CONTROL_ID,
      viewId,
      preloadedRows,
      async () => floodFromComponents(await labelDenseComponents(view, createCooperativeYield())),
      floodScheduler,
    );
    controlMs += control.measurement.durationMs;
    const controlId = detectorTimingId(viewId, FLOOD_CONTROL_ID, 'flood');
    units.push(
      detectorUnit(controlId, FLOOD_CONTROL_ID, 'flood', control.measurement, control.cached, true),
    );
    if (!control.preloaded) {
      logStudyTiming(
        log,
        controlId,
        control.measurement.durationMs,
        'detector',
        control.measurement.outputCount,
        control.cached,
      );
      await yieldToDashboard();
    }

    for (const candidate of ACTIVE_FLOOD_CANDIDATES) {
      throwIfStudyAborted(signal);
      const measured = await measureVariant(
        asset,
        cache,
        candidate.id,
        viewId,
        preloadedRows,
        () => floodCandidateOutput(candidate.id, view),
        floodScheduler,
      );
      const compared = compareVariant(
        candidate.id,
        'flood',
        control.measurement.signature,
        measured.measurement,
        candidate.note,
      );
      mergeDetectorVariant(variants, compared);
      const unitId = detectorTimingId(viewId, candidate.id, 'flood');
      units.push(
        detectorUnit(
          unitId,
          candidate.id,
          'flood',
          measured.measurement,
          measured.cached,
          compared.outputsEqual,
        ),
      );
      if (!measured.preloaded) {
        logStudyTiming(
          log,
          unitId,
          measured.measurement.durationMs,
          'detector',
          measured.measurement.outputCount,
          measured.cached,
        );
      }
      await yieldToDashboard();
    }
  }

  return { controlMs: round(controlMs), variants: [...variants.values()], units };
};

const measureFinderFamilyRows = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  view: BinaryView,
  viewId: BinaryViewId,
  preloadedRows: ReadonlySet<string>,
  log: (message: string) => void,
): Promise<{
  readonly units: readonly DetectorUnitMeasurement[];
  readonly rowScanSignature: readonly string[];
  readonly overlap: DetectorFamilyOverlapMeasurement;
}> => {
  let detection: ReturnType<typeof detectFinderEvidenceWithSummary> | null = null;
  const getDetection = (): ReturnType<typeof detectFinderEvidenceWithSummary> => {
    detection ??= detectFinderEvidenceWithSummary(view);
    return detection;
  };
  const rowScan = await measureKnownDurationVariant(
    asset,
    cache,
    'row-scan',
    viewId,
    preloadedRows,
    () => {
      const result = getDetection();
      return {
        durationMs: round(result.summary.rowScanDurationMs),
        outputCount: result.summary.rowScanCount,
        signature: finderSignature(result.rowScan),
      };
    },
  );
  const dedupe = await measureKnownDurationVariant(
    asset,
    cache,
    'dedupe',
    viewId,
    preloadedRows,
    () => {
      const result = getDetection();
      return {
        durationMs: round(result.summary.dedupeDurationMs),
        outputCount: result.summary.dedupedCount,
        signature: finderSignature(result.evidence),
      };
    },
  );
  const rows = [
    { variantId: 'row-scan', area: 'row' as const, measurement: rowScan },
    { variantId: 'dedupe', area: 'dedupe' as const, measurement: dedupe },
  ];
  for (const row of rows) {
    if (row.measurement.preloaded) continue;
    logStudyTiming(
      log,
      detectorTimingId(viewId, row.variantId, row.area),
      row.measurement.measurement.durationMs,
      'detector',
      row.measurement.measurement.outputCount,
      row.measurement.cached,
    );
  }
  const result = getDetection();
  const retainedBySource = (source: FinderEvidence['source']): number =>
    result.evidence.filter((entry) => entry.source === source).length;
  return {
    rowScanSignature: rowScan.measurement.signature,
    overlap: {
      viewId,
      rowScanCount: result.rowScan.length,
      floodCount: result.flood.length,
      matcherCount: result.matcher.length,
      dedupedCount: result.evidence.length,
      rowScanRetainedCount: retainedBySource('row-scan'),
      floodRetainedCount: retainedBySource('flood'),
      matcherRetainedCount: retainedBySource('matcher'),
      dedupeRemovedCount:
        result.rowScan.length +
        result.flood.length +
        result.matcher.length -
        result.evidence.length,
    },
    units: rows.map((row) =>
      detectorUnit(
        detectorTimingId(viewId, row.variantId, row.area),
        row.variantId,
        row.area,
        row.measurement.measurement,
        row.measurement.cached,
        true,
      ),
    ),
  };
};

const mergeDetectorVariant = (
  variants: Map<string, DetectorVariantMeasurement>,
  next: DetectorVariantMeasurement,
): void => {
  const current = variants.get(next.id);
  if (!current) {
    variants.set(next.id, next);
    return;
  }
  variants.set(next.id, {
    ...next,
    durationMs: round(current.durationMs + next.durationMs),
    outputCount: current.outputCount + next.outputCount,
    outputsEqual: current.outputsEqual && next.outputsEqual,
    mismatchCount: current.mismatchCount + next.mismatchCount,
    schedulerWaitMs: round(current.schedulerWaitMs + next.schedulerWaitMs),
    samples: [...current.samples, ...next.samples],
    schedulerWaitSamples: [...current.schedulerWaitSamples, ...next.schedulerWaitSamples],
    queuedSamples: [...current.queuedSamples, ...next.queuedSamples],
  });
};

const measureMatcherCandidateVariants = async (
  viewBank: ViewBank,
  viewIds: readonly BinaryViewId[],
  _assetId: string,
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  log: (message: string) => void,
  preloadedRows: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<MatcherCandidateMeasurement> => {
  let controlMatcherMs = 0;
  const variants = new Map<string, DetectorVariantMeasurement>();
  const units: DetectorUnitMeasurement[] = [];
  const detectorOverlap: DetectorFamilyOverlapMeasurement[] = [];

  for (const viewId of viewIds) {
    throwIfStudyAborted(signal);
    const view = viewBank.getBinaryView(viewId);
    const finderDetection = await measureFinderFamilyRows(
      asset,
      cache,
      view,
      viewId,
      preloadedRows,
      log,
    );
    units.push(...finderDetection.units);
    detectorOverlap.push(finderDetection.overlap);

    for (const candidate of ACTIVE_ROW_CANDIDATES) {
      throwIfStudyAborted(signal);
      const measured = await measureVariant(asset, cache, candidate.id, viewId, preloadedRows, () =>
        detectRowScanFindersWithVariant(view, view.width, view.height, candidate.id),
      );
      const compared = compareVariant(
        candidate.id,
        'row',
        finderDetection.rowScanSignature,
        measured.measurement,
        candidate.note,
      );
      mergeDetectorVariant(variants, compared);
      const unitId = detectorTimingId(viewId, candidate.id, 'row');
      units.push(
        detectorUnit(
          unitId,
          candidate.id,
          'row',
          measured.measurement,
          measured.cached,
          compared.outputsEqual,
        ),
      );
      if (!measured.preloaded) {
        logStudyTiming(
          log,
          unitId,
          measured.measurement.durationMs,
          'detector',
          measured.measurement.outputCount,
          measured.cached,
        );
      }
      await yieldToDashboard();
    }
    const control = await measureVariant(asset, cache, 'run-map', viewId, preloadedRows, () =>
      detectMatcherFinders(view, view.width, view.height),
    );
    controlMatcherMs += control.measurement.durationMs;
    const controlId = detectorTimingId(viewId, 'run-map', 'matcher');
    units.push(
      detectorUnit(controlId, 'run-map', 'matcher', control.measurement, control.cached, true),
    );
    if (!control.preloaded) {
      logStudyTiming(
        log,
        controlId,
        control.measurement.durationMs,
        'detector',
        control.measurement.outputCount,
        control.cached,
      );
      await yieldToDashboard();
    }

    for (const candidate of ACTIVE_MATCHER_CANDIDATES) {
      throwIfStudyAborted(signal);
      const measured = await measureVariant(asset, cache, candidate.id, viewId, preloadedRows, () =>
        detectMatcherFindersWithRunMapVariant(view, view.width, view.height, candidate.id),
      );
      const area = 'matcher';
      const compared = compareVariant(
        candidate.id,
        area,
        control.measurement.signature,
        measured.measurement,
        candidate.note,
      );
      mergeDetectorVariant(variants, compared);
      const unitId = detectorTimingId(viewId, candidate.id, 'matcher');
      units.push(
        detectorUnit(
          unitId,
          candidate.id,
          area,
          measured.measurement,
          measured.cached,
          compared.outputsEqual,
        ),
      );
      if (!measured.preloaded) {
        logStudyTiming(
          log,
          unitId,
          measured.measurement.durationMs,
          'detector',
          measured.measurement.outputCount,
          measured.cached,
        );
      }
      await yieldToDashboard();
    }
  }

  return {
    variants: [...variants.values()],
    detectorOverlap,
    units,
    controlMatcherMs: round(controlMatcherMs),
    legacyControlMs: 0,
    legacyControlOutputsEqual: true,
    legacyControlMismatchCount: 0,
    runMapMs: round(controlMatcherMs),
    prunedCenterMs: 0,
    legacyPrunedCenterMs: 0,
    runMapOutputsEqual: true,
    prunedCenterOutputsEqual: true,
    legacyPrunedCenterOutputsEqual: true,
    runMapMismatchCount: 0,
    prunedCenterMismatchCount: 0,
    legacyPrunedCenterMismatchCount: 0,
    seededMatcherMs: 0,
    legacySeededMatcherMs: 0,
    fusedPolarityMs: 0,
    legacyFusedPolarityMs: 0,
    seededMatcherOutputsEqual: true,
    legacySeededMatcherOutputsEqual: true,
    fusedPolarityOutputsEqual: true,
    legacyFusedPolarityOutputsEqual: true,
    seededMatcherMismatchCount: 0,
    legacySeededMatcherMismatchCount: 0,
    fusedPolarityMismatchCount: 0,
    legacyFusedPolarityMismatchCount: 0,
    seededMatcherEstimatedCenters: 0,
    sampledCenterCount: 0,
    prunedCenterCount: 0,
    fusedDarkCenterCount: 0,
    fusedLightCenterCount: 0,
    sharedPlaneCount: sharedPlaneCount(viewIds),
  };
};

const detectorVariantCacheKey = (variantId: string, viewId: BinaryViewId): string =>
  JSON.stringify({
    kind: 'detector-pattern',
    version: 2,
    patternId: detectorPatternId(variantId, viewId),
  });

const detectorVariantCacheKeys = (variantId: string, viewId: BinaryViewId): readonly string[] => {
  const keys = new Set<string>([detectorVariantCacheKey(variantId, viewId)]);
  for (const legacyId of [variantId, ...(LEGACY_VARIANT_IDS[variantId] ?? [])]) {
    keys.add(
      JSON.stringify({
        kind: 'detector-pattern',
        version: 1,
        patternId: legacyDetectorPatternId(legacyId, viewId),
      }),
    );
    keys.add(
      JSON.stringify({
        kind: 'detector-pattern',
        version: 2,
        patternId: `${legacyShortVariantId(legacyId)}:${detectorAreaId(legacyId)}:${shortBinaryViewId(viewId)}`,
      }),
    );
    keys.add(JSON.stringify({ kind: 'detector-variant', version: 1, variantId: legacyId, viewId }));
  }
  return [...keys];
};

const detectorPatternId = (variantId: string, viewId: BinaryViewId): string =>
  `${detectorPatternPrefix(variantId)}${shortBinaryViewId(viewId)}`;

const detectorPatternPrefix = (variantId: string): string =>
  `${shortVariantId(variantId)}:${detectorAreaId(variantId)}:`;

const legacyDetectorPatternId = (variantId: string, viewId: BinaryViewId): string =>
  `${legacyDetectorPatternPrefix(variantId)}${viewId}`;

const legacyDetectorPatternPrefix = (variantId: string): string => {
  const area = detectorAreaId(variantId) === 'f' ? 'flood' : 'matcher';
  const shortId = variantId
    .replace(/-control$/, '')
    .replace(/-candidate$/, '')
    .replace(/-components?/, '')
    .replace(/-connected-/, '-ccl-');
  return `${shortId}:${area}:`;
};

const detectorAreaId = (variantId: string): 'f' | 'm' =>
  FLOOD_DETECTOR_IDS.has(variantId) ? 'f' : 'm';

const shortVariantId = (variantId: string): string =>
  VARIANT_ID_ALIASES[variantId] ??
  variantId
    .replace(/-control$/, '')
    .replace(/-matcher$/, '')
    .replace(/-components?/, '')
    .replace(/-connected-/, '-ccl-');

const shortDetectorFamily = (detector: string): string =>
  DETECTOR_FAMILY_ALIASES[detector] ?? detector;

const shortBinaryViewId = (viewId: BinaryViewId): string => {
  const [scalar = '', threshold = '', polarity = ''] = viewId.split(':');
  return `${shortBinaryViewPart(scalar)}:${shortBinaryViewPart(threshold)}:${shortBinaryViewPart(polarity)}`;
};

const shortBinaryViewPart = (part: string): string => BINARY_VIEW_PART_ALIASES[part] ?? part;

const VARIANT_ID_ALIASES: Record<string, string> = {
  'row-scan': 'row-scan',
  'row-scan-scalar-score': 'row-scan-scalar',
  'row-scan-u16': 'row-scan-u16',
  'row-scan-u16-scalar-score': 'row-scan-u16-scalar',
  'row-scan-packed-u16': 'row-scan-pack-u16',
  'row-scan-packed-u16-scalar-score': 'row-scan-pack-u16-scalar',
  dedupe: 'dedupe',
  'legacy-flood': 'legacy-flood',
  'inline-flood': 'inline',
  'legacy-matcher': 'legacy-match',
  'run-map': 'run-map',
  'dense-stats': 'dense',
  'dense-index': 'dense-index',
  'dense-squared': 'dense-sq',
  'dense-index-squared': 'dense-idx-sq',
  'scanline-stats': 'scanline',
  'scanline-index': 'scan-idx',
  'scanline-squared': 'scan-sq',
  'scanline-index-squared': 'scan-idx-sq',
  'spatial-bin': 'spatial',
  'run-length-ccl': 'run-length',
  'run-pattern': 'run-pattern',
  'axis-intersect': 'axis-x',
  'shared-runs': 'shared-runs',
  'run-map-u16': 'run-map-u16',
  'run-map-u16-fill-horizontal': 'run-map-u16-fill-h',
  'run-map-scalar-score': 'run-map-scalar',
  'run-map-u16-scalar-score': 'run-map-u16-scalar',
  'run-map-packed-u16': 'run-map-pack-u16',
  'run-map-packed-u16-fill-horizontal': 'run-map-pack-u16-fill-h',
  'run-map-packed-u16-scalar-score': 'run-map-pack-u16-scalar',
};

const LEGACY_VARIANT_IDS: Record<string, readonly string[]> = {
  'legacy-flood': ['legacy-two-pass-flood'],
  'inline-flood': ['inline-flood-control'],
  'legacy-matcher': ['legacy-matcher-control'],
  'run-map': ['run-map-matcher-control'],
  'dense-stats': ['dense-typed-array-component-stats'],
  'dense-index': ['dense-indexed-component-lookup'],
  'dense-squared': ['dense-squared-distance'],
  'dense-index-squared': ['dense-indexed-squared-distance'],
  'scanline-stats': ['scanline-component-stats'],
  'scanline-index': ['scanline-indexed-component-lookup'],
  'scanline-squared': ['scanline-squared-distance'],
  'scanline-index-squared': ['scanline-indexed-squared-distance'],
  'spatial-bin': ['spatial-binned-component-lookup'],
  'run-length-ccl': ['run-length-connected-components'],
  'run-pattern': ['run-pattern-center-matcher'],
  'axis-intersect': ['axis-run-intersection-matcher'],
  'shared-runs': ['shared-run-length-detector-artifacts'],
};

const LEGACY_VARIANT_ALIASES: Record<string, string> = {
  'legacy-two-pass-flood': 'legacy-flood',
  'inline-flood-control': 'in',
  'legacy-matcher-control': 'legacy-match',
  'run-map-matcher-control': 'rm',
  'dense-typed-array-component-stats': 'dta',
  'dense-indexed-component-lookup': 'di',
  'dense-squared-distance': 'dsq',
  'dense-indexed-squared-distance': 'disq',
  'scanline-component-stats': 'sl',
  'scanline-indexed-component-lookup': 'sli',
  'scanline-squared-distance': 'slsq',
  'scanline-indexed-squared-distance': 'slisq',
  'spatial-binned-component-lookup': 'sb',
  'run-length-connected-components': 'rlc',
  'run-pattern-center-matcher': 'rpc',
  'axis-run-intersection-matcher': 'ari',
  'shared-run-length-detector-artifacts': 'srla',
};

const FLOOD_DETECTOR_IDS = new Set([
  'legacy-flood',
  'inline-flood',
  'dense-stats',
  'dense-index',
  'dense-squared',
  'dense-index-squared',
  'scanline-stats',
  'scanline-index',
  'scanline-squared',
  'scanline-index-squared',
  'spatial-bin',
  'run-length-ccl',
  'inline-flood-control',
  'dense-typed-array-component-stats',
  'dense-indexed-component-lookup',
  'dense-squared-distance',
  'dense-indexed-squared-distance',
  'scanline-component-stats',
  'scanline-indexed-component-lookup',
  'scanline-squared-distance',
  'scanline-indexed-squared-distance',
  'spatial-binned-component-lookup',
  'run-length-connected-components',
  'legacy-two-pass-flood',
]);

const legacyShortVariantId = (variantId: string): string =>
  LEGACY_VARIANT_ALIASES[variantId] ?? shortVariantId(variantId);

const DETECTOR_FAMILY_ALIASES: Record<string, string> = {
  flood: 'f',
  matcher: 'm',
  row: 'r',
  dedupe: 'd',
};

const BINARY_VIEW_PART_ALIASES: Record<string, string> = {
  otsu: 'o',
  sauvola: 's',
  hybrid: 'h',
  normal: 'n',
  inverted: 'i',
};

const measureBinaryReadVariants = async (
  viewBank: ReturnType<typeof createViewBank>,
  viewIds: readonly BinaryViewId[],
  assetId: string,
  log: (message: string) => void,
): Promise<BinaryReadMeasurement> => {
  let byteReaderMs = 0;
  let directBitReaderMs = 0;
  let byteDarkCount = 0;
  let directDarkCount = 0;
  let pixelReads = 0;

  for (const viewId of viewIds) {
    const view = viewBank.getBinaryView(viewId);
    const byteStartedAt = performance.now();
    for (let index = 0; index < view.plane.data.length; index += 1) {
      if (readBinaryPixel(view, index) === 0) byteDarkCount += 1;
    }
    byteReaderMs += performance.now() - byteStartedAt;

    const directStartedAt = performance.now();
    const invert = view.polarity === 'inverted' ? 1 : 0;
    for (let index = 0; index < view.plane.data.length; index += 1) {
      directDarkCount += (view.plane.data[index] ?? 0) ^ invert;
    }
    directBitReaderMs += performance.now() - directStartedAt;
    pixelReads += view.plane.data.length;
    log(`${assetId}: binary read polarity variant ${viewId}`);
    await yieldToDashboard();
  }

  const deltaMs = byteReaderMs - directBitReaderMs;
  return {
    byteReaderMs: round(byteReaderMs),
    directBitReaderMs: round(directBitReaderMs),
    deltaMs: round(deltaMs),
    improvementPct: percent(deltaMs, byteReaderMs),
    pixelReads,
    countsEqual: byteDarkCount === directDarkCount,
  };
};

const runDecodeMeasurement = async (
  image: Parameters<typeof scanFrame>[0],
  viewIds: readonly BinaryViewId[],
  asset: { readonly id: string },
  log: (message: string) => void,
): Promise<DecodeMeasurement & { readonly decodedTexts: readonly string[] }> => {
  const spans: ScanTimingSpan[] = [];
  const startedAt = performance.now();
  log(`${asset.id}: running decode scanner for module-sampling evidence`);
  const results = await scanFrame(image, {
    allowMultiple: true,
    maxProposals: EXHAUSTIVE_SCAN_CEILING,
    maxClusterRepresentatives: EXHAUSTIVE_SCAN_CEILING,
    maxClusterStructuralFailures: EXHAUSTIVE_SCAN_CEILING,
    continueAfterDecode: true,
    proposalViewIds: viewIds,
    metricsSink: { record: (span: ScanTimingSpan) => spans.push(span) },
  });
  const decodedTexts = uniqueTexts(
    results.map((result) => normalizeDecodedText(result.payload.text)).filter(Boolean),
  );
  return {
    scanDurationMs: round(performance.now() - startedAt),
    moduleSamplingMs: sumSpans(spans, 'module-sampling'),
    sampledModuleCount: spans
      .filter((span) => span.name === 'module-sampling')
      .reduce((sum, span) => sum + numberMetadata(span.metadata?.moduleCount), 0),
    decodeAttemptMs: sumSpans(spans, 'decode-attempt'),
    decodeCascadeMs: sumSpans(spans, 'decode-cascade'),
    decodedTexts,
  };
};

const stripDecodedTexts = (
  decode: DecodeMeasurement & { readonly decodedTexts: readonly string[] },
): DecodeMeasurement => ({
  scanDurationMs: decode.scanDurationMs,
  moduleSamplingMs: decode.moduleSamplingMs,
  sampledModuleCount: decode.sampledModuleCount,
  decodeAttemptMs: decode.decodeAttemptMs,
  decodeCascadeMs: decode.decodeCascadeMs,
});

const measureBinarySignals = (view: BinaryView): BinaryViewSignal => {
  const startedAt = performance.now();
  const { scalarViewId, threshold, polarity, width, height } = view;
  const data = view.plane.data;
  const invert = polarity === 'inverted' ? 1 : 0;
  let darkCount = 0;
  let horizontalTransitions = 0;
  let verticalTransitions = 0;
  let horizontalRunCount = 0;
  let verticalRunCount = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const bit = (data[index] ?? 0) ^ invert;
      darkCount += bit;
      if (x === 0) horizontalRunCount += 1;
      else {
        const left = (data[index - 1] ?? 0) ^ invert;
        if (left !== bit) {
          horizontalTransitions += 1;
          horizontalRunCount += 1;
        }
      }
      if (y === 0) verticalRunCount += 1;
      else {
        const up = (data[index - width] ?? 0) ^ invert;
        if (up !== bit) {
          verticalTransitions += 1;
          verticalRunCount += 1;
        }
      }
    }
  }

  const pixelCount = Math.max(1, width * height);
  return {
    binaryViewId: view.id,
    scalarViewId,
    threshold,
    polarity,
    durationMs: round(performance.now() - startedAt),
    darkRatio: roundRatio(darkCount / pixelCount),
    horizontalTransitionDensity: roundRatio(
      horizontalTransitions / Math.max(1, height * Math.max(1, width - 1)),
    ),
    verticalTransitionDensity: roundRatio(
      verticalTransitions / Math.max(1, width * Math.max(1, height - 1)),
    ),
    horizontalRunCount,
    verticalRunCount,
  };
};

const measureScalarStats = (
  scalarViewId: string,
  values: Uint8Array,
  width: number,
  height: number,
): ScalarStatsMeasurement => {
  const histogramStartedAt = performance.now();
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value] = (histogram[value] ?? 0) + 1;
  const histogramMs = round(performance.now() - histogramStartedAt);

  const otsuStartedAt = performance.now();
  const threshold = otsuThresholdFromHistogram(histogram, values.length);
  const otsuMs = round(performance.now() - otsuStartedAt);

  const integralStartedAt = performance.now();
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const sumSq = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < width; x += 1) {
      const value = values[y * width + x] ?? 0;
      rowSum += value;
      rowSumSq += value * value;
      const index = (y + 1) * stride + (x + 1);
      sum[index] = (sum[y * stride + (x + 1)] ?? 0) + rowSum;
      sumSq[index] = (sumSq[y * stride + (x + 1)] ?? 0) + rowSumSq;
    }
  }
  const integralMs = round(performance.now() - integralStartedAt);

  return {
    scalarViewId,
    histogramMs,
    otsuMs,
    integralMs,
    integralBytes: sum.byteLength + sumSq.byteLength,
    otsuThreshold: threshold,
  };
};

const measureScalarFusion = (image: {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}): ScalarFusionMeasurement => {
  const pixelCount = image.width * image.height;
  const rgbStartedAt = performance.now();
  const gray = new Uint8Array(pixelCount);
  const rPlane = new Uint8Array(pixelCount);
  const gPlane = new Uint8Array(pixelCount);
  const bPlane = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const base = index * 4;
    const alpha = (image.data[base + 3] ?? WHITE) / WHITE;
    const background = 1 - alpha;
    const r = ((image.data[base] ?? WHITE) / WHITE) * alpha + background;
    const g = ((image.data[base + 1] ?? WHITE) / WHITE) * alpha + background;
    const b = ((image.data[base + 2] ?? WHITE) / WHITE) * alpha + background;
    rPlane[index] = Math.round(r * WHITE);
    gPlane[index] = Math.round(g * WHITE);
    bPlane[index] = Math.round(b * WHITE);
    gray[index] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * WHITE);
  }
  const rgbFamilyMs = round(performance.now() - rgbStartedAt);

  const oklabStartedAt = performance.now();
  const normalized = createNormalizedImage(image);
  const planes = getOklabPlanes(normalized);
  const oklabL = new Uint8Array(pixelCount);
  const oklabPlusA = new Uint8Array(pixelCount);
  const oklabMinusA = new Uint8Array(pixelCount);
  const oklabPlusB = new Uint8Array(pixelCount);
  const oklabMinusB = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const l = planes.l[index] ?? 0;
    const a = planes.a[index] ?? 0;
    const b = planes.b[index] ?? 0;
    oklabL[index] = clampByte(l * WHITE);
    oklabPlusA[index] = clampByte(128 + a * 180);
    oklabMinusA[index] = clampByte(128 - a * 180);
    oklabPlusB[index] = clampByte(128 + b * 180);
    oklabMinusB[index] = clampByte(128 - b * 180);
  }
  const oklabFamilyMs = round(performance.now() - oklabStartedAt);

  return {
    rgbFamilyMs,
    oklabFamilyMs,
    rgbPlaneBytes: gray.byteLength + rPlane.byteLength + gPlane.byteLength + bPlane.byteLength,
    oklabPlaneBytes:
      oklabL.byteLength +
      oklabPlusA.byteLength +
      oklabMinusA.byteLength +
      oklabPlusB.byteLength +
      oklabMinusB.byteLength,
  };
};

const emptyScalarFusionMeasurement = (): ScalarFusionMeasurement => ({
  rgbFamilyMs: 0,
  oklabFamilyMs: 0,
  rgbPlaneBytes: 0,
  oklabPlaneBytes: 0,
});

const emptySharedArtifactMeasurement = (): SharedArtifactMeasurement => ({
  planeCount: 0,
  polarityViewCount: 0,
  shareableRunSignalMs: 0,
  perPolarityRunSignalMs: 0,
  estimatedSavedMs: 0,
});

const summarizeSharedArtifacts = (
  signals: readonly BinaryViewSignal[],
): SharedArtifactMeasurement => {
  const planeIds = new Set(signals.map((signal) => `${signal.scalarViewId}:${signal.threshold}`));
  const fastestPerPlane = new Map<string, number>();
  for (const signal of signals) {
    const key = `${signal.scalarViewId}:${signal.threshold}`;
    fastestPerPlane.set(
      key,
      Math.min(fastestPerPlane.get(key) ?? Number.POSITIVE_INFINITY, signal.durationMs),
    );
  }
  const shareableRunSignalMs = round(
    [...fastestPerPlane.values()].reduce((sum, value) => sum + value, 0),
  );
  const perPolarityRunSignalMs = round(signals.reduce((sum, signal) => sum + signal.durationMs, 0));
  return {
    planeCount: planeIds.size,
    polarityViewCount: signals.length,
    shareableRunSignalMs,
    perPolarityRunSignalMs,
    estimatedSavedMs: round(Math.max(0, perPolarityRunSignalMs - shareableRunSignalMs)),
  };
};

const summarizeImageProcessingStudy = ({
  config,
  results,
  cache,
}: StudySummaryInput<
  ImageProcessingConfig,
  ImageProcessingAssetResult
>): ImageProcessingSummary => {
  const viewRows = new Map<string, MutableViewSummary>();
  const scalarRows = new Map<string, MutableScalarSummary>();
  const totals: MutableTotals = emptyTotals();
  const detectorVariantRows = new Map<string, DetectorVariantMeasurement>();
  const detectorUnits: DetectorUnitMeasurement[] = [];
  const detectorOverlapRows: DetectorFamilyOverlapMeasurement[] = [];

  for (const result of results) {
    totals.pixelCount += result.pixelCount;
    totals.proposalGenerationMs += result.proposalGenerationMs;
    totals.scalarViewMs += result.timing.scalarViewMs;
    totals.binaryPlaneMs += result.timing.binaryPlaneMs;
    totals.binaryViewMs += result.timing.binaryViewMs;
    totals.proposalViewMs += result.timing.proposalViewMs;
    totals.moduleSamplingMs += result.timing.moduleSamplingMs;
    totals.decodeAttemptMs += result.timing.decodeAttemptMs;
    totals.decodeCascadeMs += result.timing.decodeCascadeMs;
    totals.rgbFusionMs += result.scalarFusion.rgbFamilyMs;
    totals.oklabFusionMs += result.scalarFusion.oklabFamilyMs;
    totals.shareableRunSignalMs += result.sharedArtifacts.shareableRunSignalMs;
    totals.perPolarityRunSignalMs += result.sharedArtifacts.perPolarityRunSignalMs;
    totals.estimatedSharedArtifactSavedMs += result.sharedArtifacts.estimatedSavedMs;
    if (result.binaryRead) {
      totals.binaryReadByteMs += result.binaryRead.byteReaderMs;
      totals.binaryReadDirectMs += result.binaryRead.directBitReaderMs;
      totals.binaryReadPixels += result.binaryRead.pixelReads;
    }
    if (result.floodCandidates) {
      totals.floodControlMs += result.floodCandidates.controlMs;
      totals.floodSchedulerLimit = Math.max(totals.floodSchedulerLimit, result.floodSchedulerLimit);
      totals.detectorMs += result.floodCandidates.controlMs;
      detectorUnits.push(...result.floodCandidates.units);
      totals.floodSchedulerWaitMs += result.floodCandidates.units.reduce(
        (sum, unit) => sum + unit.schedulerWaitMs,
        0,
      );
      for (const variant of result.floodCandidates.variants) {
        mergeDetectorVariant(detectorVariantRows, variant);
      }
    }
    if (result.matcherCandidates) {
      totals.matcherControlMs += result.matcherCandidates.controlMatcherMs;
      totals.detectorMs += result.matcherCandidates.controlMatcherMs;
      totals.matcherLegacyControlMs += result.matcherCandidates.legacyControlMs;
      totals.matcherRunMapMs += result.matcherCandidates.runMapMs;
      totals.matcherPrunedCenterMs += result.matcherCandidates.prunedCenterMs;
      totals.matcherLegacyPrunedCenterMs += result.matcherCandidates.legacyPrunedCenterMs;
      totals.matcherSeededMs += result.matcherCandidates.seededMatcherMs;
      totals.matcherLegacySeededMs += result.matcherCandidates.legacySeededMatcherMs;
      totals.matcherFusedPolarityMs += result.matcherCandidates.fusedPolarityMs;
      totals.matcherLegacyFusedPolarityMs += result.matcherCandidates.legacyFusedPolarityMs;
      totals.matcherLegacyControlOutputsEqual &&=
        result.matcherCandidates.legacyControlOutputsEqual;
      totals.matcherRunMapOutputsEqual &&= result.matcherCandidates.runMapOutputsEqual;
      totals.matcherPrunedCenterOutputsEqual &&= result.matcherCandidates.prunedCenterOutputsEqual;
      totals.matcherLegacyPrunedCenterOutputsEqual &&=
        result.matcherCandidates.legacyPrunedCenterOutputsEqual;
      totals.matcherSeededOutputsEqual &&= result.matcherCandidates.seededMatcherOutputsEqual;
      totals.matcherLegacySeededOutputsEqual &&=
        result.matcherCandidates.legacySeededMatcherOutputsEqual;
      totals.matcherFusedPolarityOutputsEqual &&=
        result.matcherCandidates.fusedPolarityOutputsEqual;
      totals.matcherLegacyFusedPolarityOutputsEqual &&=
        result.matcherCandidates.legacyFusedPolarityOutputsEqual;
      totals.matcherLegacyControlMismatchCount +=
        result.matcherCandidates.legacyControlMismatchCount;
      totals.matcherRunMapMismatchCount += result.matcherCandidates.runMapMismatchCount;
      totals.matcherPrunedCenterMismatchCount += result.matcherCandidates.prunedCenterMismatchCount;
      totals.matcherLegacyPrunedCenterMismatchCount +=
        result.matcherCandidates.legacyPrunedCenterMismatchCount;
      totals.matcherSeededMismatchCount += result.matcherCandidates.seededMatcherMismatchCount;
      totals.matcherLegacySeededMismatchCount +=
        result.matcherCandidates.legacySeededMatcherMismatchCount;
      totals.matcherFusedPolarityMismatchCount +=
        result.matcherCandidates.fusedPolarityMismatchCount;
      totals.matcherLegacyFusedPolarityMismatchCount +=
        result.matcherCandidates.legacyFusedPolarityMismatchCount;
      totals.matcherSeededEstimatedCenters +=
        result.matcherCandidates.seededMatcherEstimatedCenters;
      totals.matcherSampledCenterCount += result.matcherCandidates.sampledCenterCount;
      totals.matcherPrunedCenterCount += result.matcherCandidates.prunedCenterCount;
      totals.matcherFusedDarkCenterCount += result.matcherCandidates.fusedDarkCenterCount;
      totals.matcherFusedLightCenterCount += result.matcherCandidates.fusedLightCenterCount;
      totals.matcherSharedPlaneCount += result.matcherCandidates.sharedPlaneCount;
      detectorUnits.push(...result.matcherCandidates.units);
      detectorOverlapRows.push(...result.matcherCandidates.detectorOverlap);
      for (const variant of result.matcherCandidates.variants) {
        mergeDetectorVariant(detectorVariantRows, variant);
      }
    }
    for (const proposal of result.proposalSummaries) {
      const rowScanMeasurement = detectorTimingMeasurement(
        proposal.finderEvidence.rowScanDurationMs,
        proposal.finderEvidence.rowScanCount,
      );
      detectorUnits.push(
        detectorUnit(
          detectorTimingId(proposal.binaryViewId, 'row-scan', 'row'),
          'row-scan',
          'row',
          rowScanMeasurement,
          result.cacheHit === true,
          true,
        ),
      );
      const dedupeMeasurement = detectorTimingMeasurement(
        proposal.finderEvidence.dedupeDurationMs,
        proposal.finderEvidence.dedupedCount,
      );
      detectorUnits.push(
        detectorUnit(
          detectorTimingId(proposal.binaryViewId, 'dedupe', 'dedupe'),
          'dedupe',
          'dedupe',
          dedupeMeasurement,
          result.cacheHit === true,
          true,
        ),
      );
      totals.detectorMs += rowScanMeasurement.durationMs + dedupeMeasurement.durationMs;
    }
    if (result.decode) {
      totals.scanDurationMs += result.decode.scanDurationMs;
      totals.moduleSamplingMs += result.decode.moduleSamplingMs;
      totals.sampledModuleCount += result.decode.sampledModuleCount;
      totals.decodeAttemptMs += result.decode.decodeAttemptMs;
      totals.decodeCascadeMs += result.decode.decodeCascadeMs;
    }
    for (const stats of result.scalarStats) {
      totals.histogramMs += stats.histogramMs;
      totals.otsuMs += stats.otsuMs;
      totals.integralMs += stats.integralMs;
      const scalar = ensureScalarRow(scalarRows, stats.scalarViewId);
      scalar.assetCount += 1;
      scalar.histogramMs += stats.histogramMs;
      scalar.otsuMs += stats.otsuMs;
      scalar.integralMs += stats.integralMs;
      scalar.integralBytes = Math.max(scalar.integralBytes, stats.integralBytes);
    }
    for (const signal of result.binarySignals) {
      totals.signalMs += signal.durationMs;
      const row = ensureViewRow(viewRows, signal.binaryViewId);
      row.assetCount += 1;
      row.signalMs += signal.durationMs;
      row.darkRatioTotal += signal.darkRatio;
      row.horizontalTransitionDensityTotal += signal.horizontalTransitionDensity;
      row.verticalTransitionDensityTotal += signal.verticalTransitionDensity;
    }
    for (const proposal of result.proposalSummaries) {
      totals.detectorMs += proposal.detectorDurationMs;
      const row = ensureViewRow(viewRows, proposal.binaryViewId);
      row.detectorMs += proposal.detectorDurationMs;
      row.rowScanMs += proposal.finderEvidence.rowScanDurationMs;
      row.floodMs += proposal.finderEvidence.floodDurationMs;
      row.matcherMs += proposal.finderEvidence.matcherDurationMs;
      row.dedupeMs += proposal.finderEvidence.dedupeDurationMs;
      row.proposalCount += proposal.proposalCount;
      row.rowScanFinderCount += proposal.finderEvidence.rowScanCount;
      row.floodFinderCount += proposal.finderEvidence.floodCount;
      row.matcherFinderCount += proposal.finderEvidence.matcherCount;
    }
  }

  const perView = [...viewRows.values()]
    .map(finalizeViewRow)
    .sort((left, right) => right.detectorMs - left.detectorMs);
  const perScalar = [...scalarRows.values()]
    .map(finalizeScalarRow)
    .sort((left, right) => right.integralMs - left.integralMs);
  const finalizedTotals = finalizeTotals(totals);
  const detectorCandidates = summarizeDetectorVariants(detectorVariantRows, finalizedTotals);
  const detectorLatency = summarizeDetectorUnits(detectorUnits, (unit) => unit.variantId);
  const detectorUnitRows = summarizeDetectorUnits(detectorUnits, (unit) => unit.id);
  const detectorOverlap = summarizeDetectorOverlap(detectorOverlapRows);
  const variants = buildVariantSummaries(config, finalizedTotals, detectorCandidates);

  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    decodedAssetCount: results.filter((result) => result.decodedTexts.length > 0).length,
    falsePositiveAssetCount: results.filter((result) => result.falsePositiveTexts.length > 0)
      .length,
    cache,
    totals: finalizedTotals,
    variants,
    perView,
    perScalar,
    recommendations: buildRecommendations(perView, perScalar, finalizedTotals),
    detectorCandidates,
    detectorLatency,
    detectorOverlap,
    detectorUnits: detectorUnitRows,
  };
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type MutableTotals = Mutable<ImageProcessingTotals>;
type MutableViewSummary = Mutable<
  Omit<
    ImageProcessingViewSummary,
    'averageDarkRatio' | 'averageHorizontalTransitionDensity' | 'averageVerticalTransitionDensity'
  >
> & {
  darkRatioTotal: number;
  horizontalTransitionDensityTotal: number;
  verticalTransitionDensityTotal: number;
};
type MutableScalarSummary = Mutable<ImageProcessingScalarSummary>;

const emptyTotals = (): MutableTotals => ({
  pixelCount: 0,
  proposalGenerationMs: 0,
  detectorMs: 0,
  scalarViewMs: 0,
  binaryPlaneMs: 0,
  binaryViewMs: 0,
  proposalViewMs: 0,
  signalMs: 0,
  histogramMs: 0,
  otsuMs: 0,
  integralMs: 0,
  rgbFusionMs: 0,
  oklabFusionMs: 0,
  shareableRunSignalMs: 0,
  perPolarityRunSignalMs: 0,
  estimatedSharedArtifactSavedMs: 0,
  scanDurationMs: 0,
  moduleSamplingMs: 0,
  sampledModuleCount: 0,
  decodeAttemptMs: 0,
  decodeCascadeMs: 0,
  binaryReadByteMs: 0,
  binaryReadDirectMs: 0,
  binaryReadPixels: 0,
  matcherControlMs: 0,
  matcherLegacyControlMs: 0,
  matcherRunMapMs: 0,
  matcherPrunedCenterMs: 0,
  matcherLegacyPrunedCenterMs: 0,
  matcherSeededMs: 0,
  matcherLegacySeededMs: 0,
  matcherFusedPolarityMs: 0,
  matcherLegacyFusedPolarityMs: 0,
  matcherLegacyControlOutputsEqual: true,
  matcherRunMapOutputsEqual: true,
  matcherPrunedCenterOutputsEqual: true,
  matcherLegacyPrunedCenterOutputsEqual: true,
  matcherSeededOutputsEqual: true,
  matcherLegacySeededOutputsEqual: true,
  matcherFusedPolarityOutputsEqual: true,
  matcherLegacyFusedPolarityOutputsEqual: true,
  matcherLegacyControlMismatchCount: 0,
  matcherRunMapMismatchCount: 0,
  matcherPrunedCenterMismatchCount: 0,
  matcherLegacyPrunedCenterMismatchCount: 0,
  matcherSeededMismatchCount: 0,
  matcherLegacySeededMismatchCount: 0,
  matcherFusedPolarityMismatchCount: 0,
  matcherLegacyFusedPolarityMismatchCount: 0,
  matcherSeededEstimatedCenters: 0,
  matcherSampledCenterCount: 0,
  matcherPrunedCenterCount: 0,
  matcherFusedDarkCenterCount: 0,
  matcherFusedLightCenterCount: 0,
  matcherSharedPlaneCount: 0,
  floodControlMs: 0,
  floodSchedulerLimit: 0,
  floodSchedulerWaitMs: 0,
});

const ensureViewRow = (
  rows: Map<string, MutableViewSummary>,
  binaryViewId: string,
): MutableViewSummary => {
  const existing = rows.get(binaryViewId);
  if (existing) return existing;
  const row = {
    binaryViewId,
    assetCount: 0,
    detectorMs: 0,
    rowScanMs: 0,
    floodMs: 0,
    matcherMs: 0,
    dedupeMs: 0,
    proposalCount: 0,
    rowScanFinderCount: 0,
    floodFinderCount: 0,
    matcherFinderCount: 0,
    signalMs: 0,
    darkRatioTotal: 0,
    horizontalTransitionDensityTotal: 0,
    verticalTransitionDensityTotal: 0,
  };
  rows.set(binaryViewId, row);
  return row;
};

const ensureScalarRow = (
  rows: Map<string, MutableScalarSummary>,
  scalarViewId: string,
): MutableScalarSummary => {
  const existing = rows.get(scalarViewId);
  if (existing) return existing;
  const row = {
    scalarViewId,
    assetCount: 0,
    histogramMs: 0,
    otsuMs: 0,
    integralMs: 0,
    integralBytes: 0,
  };
  rows.set(scalarViewId, row);
  return row;
};

const finalizeTotals = (totals: MutableTotals): ImageProcessingTotals => ({
  pixelCount: totals.pixelCount,
  proposalGenerationMs: round(totals.proposalGenerationMs),
  detectorMs: round(totals.detectorMs),
  scalarViewMs: round(totals.scalarViewMs),
  binaryPlaneMs: round(totals.binaryPlaneMs),
  binaryViewMs: round(totals.binaryViewMs),
  proposalViewMs: round(totals.proposalViewMs),
  signalMs: round(totals.signalMs),
  histogramMs: round(totals.histogramMs),
  otsuMs: round(totals.otsuMs),
  integralMs: round(totals.integralMs),
  rgbFusionMs: round(totals.rgbFusionMs),
  oklabFusionMs: round(totals.oklabFusionMs),
  shareableRunSignalMs: round(totals.shareableRunSignalMs),
  perPolarityRunSignalMs: round(totals.perPolarityRunSignalMs),
  estimatedSharedArtifactSavedMs: round(totals.estimatedSharedArtifactSavedMs),
  scanDurationMs: round(totals.scanDurationMs),
  moduleSamplingMs: round(totals.moduleSamplingMs),
  sampledModuleCount: totals.sampledModuleCount,
  decodeAttemptMs: round(totals.decodeAttemptMs),
  decodeCascadeMs: round(totals.decodeCascadeMs),
  binaryReadByteMs: round(totals.binaryReadByteMs),
  binaryReadDirectMs: round(totals.binaryReadDirectMs),
  binaryReadPixels: totals.binaryReadPixels,
  matcherControlMs: round(totals.matcherControlMs),
  matcherLegacyControlMs: round(totals.matcherLegacyControlMs),
  matcherRunMapMs: round(totals.matcherRunMapMs),
  matcherPrunedCenterMs: round(totals.matcherPrunedCenterMs),
  matcherLegacyPrunedCenterMs: round(totals.matcherLegacyPrunedCenterMs),
  matcherSeededMs: round(totals.matcherSeededMs),
  matcherLegacySeededMs: round(totals.matcherLegacySeededMs),
  matcherFusedPolarityMs: round(totals.matcherFusedPolarityMs),
  matcherLegacyFusedPolarityMs: round(totals.matcherLegacyFusedPolarityMs),
  matcherLegacyControlOutputsEqual: totals.matcherLegacyControlOutputsEqual,
  matcherRunMapOutputsEqual: totals.matcherRunMapOutputsEqual,
  matcherPrunedCenterOutputsEqual: totals.matcherPrunedCenterOutputsEqual,
  matcherLegacyPrunedCenterOutputsEqual: totals.matcherLegacyPrunedCenterOutputsEqual,
  matcherSeededOutputsEqual: totals.matcherSeededOutputsEqual,
  matcherLegacySeededOutputsEqual: totals.matcherLegacySeededOutputsEqual,
  matcherFusedPolarityOutputsEqual: totals.matcherFusedPolarityOutputsEqual,
  matcherLegacyFusedPolarityOutputsEqual: totals.matcherLegacyFusedPolarityOutputsEqual,
  matcherLegacyControlMismatchCount: totals.matcherLegacyControlMismatchCount,
  matcherRunMapMismatchCount: totals.matcherRunMapMismatchCount,
  matcherPrunedCenterMismatchCount: totals.matcherPrunedCenterMismatchCount,
  matcherLegacyPrunedCenterMismatchCount: totals.matcherLegacyPrunedCenterMismatchCount,
  matcherSeededMismatchCount: totals.matcherSeededMismatchCount,
  matcherLegacySeededMismatchCount: totals.matcherLegacySeededMismatchCount,
  matcherFusedPolarityMismatchCount: totals.matcherFusedPolarityMismatchCount,
  matcherLegacyFusedPolarityMismatchCount: totals.matcherLegacyFusedPolarityMismatchCount,
  matcherSeededEstimatedCenters: totals.matcherSeededEstimatedCenters,
  matcherSampledCenterCount: totals.matcherSampledCenterCount,
  matcherPrunedCenterCount: totals.matcherPrunedCenterCount,
  matcherFusedDarkCenterCount: totals.matcherFusedDarkCenterCount,
  matcherFusedLightCenterCount: totals.matcherFusedLightCenterCount,
  matcherSharedPlaneCount: totals.matcherSharedPlaneCount,
  floodControlMs: round(totals.floodControlMs),
  floodSchedulerLimit: totals.floodSchedulerLimit,
  floodSchedulerWaitMs: round(totals.floodSchedulerWaitMs),
});

const finalizeViewRow = (row: MutableViewSummary): ImageProcessingViewSummary => ({
  binaryViewId: row.binaryViewId,
  assetCount: row.assetCount,
  detectorMs: round(row.detectorMs),
  rowScanMs: round(row.rowScanMs),
  floodMs: round(row.floodMs),
  matcherMs: round(row.matcherMs),
  dedupeMs: round(row.dedupeMs),
  proposalCount: row.proposalCount,
  rowScanFinderCount: row.rowScanFinderCount,
  floodFinderCount: row.floodFinderCount,
  matcherFinderCount: row.matcherFinderCount,
  signalMs: round(row.signalMs),
  averageDarkRatio: row.assetCount === 0 ? 0 : roundRatio(row.darkRatioTotal / row.assetCount),
  averageHorizontalTransitionDensity:
    row.assetCount === 0 ? 0 : roundRatio(row.horizontalTransitionDensityTotal / row.assetCount),
  averageVerticalTransitionDensity:
    row.assetCount === 0 ? 0 : roundRatio(row.verticalTransitionDensityTotal / row.assetCount),
});

const finalizeScalarRow = (row: MutableScalarSummary): ImageProcessingScalarSummary => ({
  scalarViewId: row.scalarViewId,
  assetCount: row.assetCount,
  histogramMs: round(row.histogramMs),
  otsuMs: round(row.otsuMs),
  integralMs: round(row.integralMs),
  integralBytes: row.integralBytes,
});

const summarizeDetectorVariants = (
  variants: ReadonlyMap<string, DetectorVariantMeasurement>,
  totals: ImageProcessingTotals,
): readonly DetectorVariantSummary[] =>
  [...variants.values()].map((variant) => {
    const controlId = variant.area === 'flood' ? FLOOD_CONTROL_ID : 'run-map';
    const controlMs = variant.area === 'flood' ? totals.floodControlMs : totals.matcherControlMs;
    return {
      ...variant,
      ...latencySummary(variant.samples),
      controlId,
      controlMs,
      deltaMs: round(controlMs - variant.durationMs),
      improvementPct: percent(controlMs - variant.durationMs, controlMs),
      ...schedulerWaitSummary(variant.schedulerWaitSamples),
      ...queuedLatencySummary(variant.queuedSamples),
    };
  });

const summarizeDetectorOverlap = (
  rows: readonly DetectorFamilyOverlapMeasurement[],
): DetectorFamilyOverlapSummary => {
  const totals = rows.reduce(
    (acc, row) => ({
      views: acc.views + 1,
      rowScanCount: acc.rowScanCount + row.rowScanCount,
      floodCount: acc.floodCount + row.floodCount,
      matcherCount: acc.matcherCount + row.matcherCount,
      dedupedCount: acc.dedupedCount + row.dedupedCount,
      rowScanRetainedCount: acc.rowScanRetainedCount + row.rowScanRetainedCount,
      floodRetainedCount: acc.floodRetainedCount + row.floodRetainedCount,
      matcherRetainedCount: acc.matcherRetainedCount + row.matcherRetainedCount,
      dedupeRemovedCount: acc.dedupeRemovedCount + row.dedupeRemovedCount,
    }),
    {
      views: 0,
      rowScanCount: 0,
      floodCount: 0,
      matcherCount: 0,
      dedupedCount: 0,
      rowScanRetainedCount: 0,
      floodRetainedCount: 0,
      matcherRetainedCount: 0,
      dedupeRemovedCount: 0,
    },
  );
  const inputCount = totals.rowScanCount + totals.floodCount + totals.matcherCount;
  return {
    ...totals,
    rowScanRetentionPct: percent(totals.rowScanRetainedCount, totals.rowScanCount),
    floodRetentionPct: percent(totals.floodRetainedCount, totals.floodCount),
    matcherRetentionPct: percent(totals.matcherRetainedCount, totals.matcherCount),
    dedupeRemovalPct: percent(totals.dedupeRemovedCount, inputCount),
  };
};

const summarizeDetectorUnits = (
  units: readonly DetectorUnitMeasurement[],
  keyFor: (unit: DetectorUnitMeasurement) => string,
): readonly DetectorUnitSummary[] => {
  const rows = new Map<
    string,
    Mutable<DetectorUnitSummary> & {
      samples: number[];
      schedulerWaitSamples: number[];
      queuedSamples: number[];
    }
  >();
  for (const unit of units) {
    const key = keyFor(unit);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        id: key,
        variantId: unit.variantId,
        area: unit.area,
        jobs: 1,
        cachedJobs: unit.cached ? 1 : 0,
        outputCount: unit.outputCount,
        outputsEqual: unit.outputsEqual,
        mismatchCount: unit.mismatchCount,
        avgMs: 0,
        p85Ms: 0,
        p95Ms: 0,
        p98Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        schedulerWaitMs: unit.schedulerWaitMs,
        avgSchedulerWaitMs: 0,
        p95SchedulerWaitMs: 0,
        p98SchedulerWaitMs: 0,
        maxSchedulerWaitMs: 0,
        avgQueuedMs: 0,
        p95QueuedMs: 0,
        p98QueuedMs: 0,
        maxQueuedMs: 0,
        samples: [unit.durationMs],
        schedulerWaitSamples: [unit.schedulerWaitMs],
        queuedSamples: [unit.durationMs + unit.schedulerWaitMs],
      });
      continue;
    }
    row.jobs += 1;
    row.cachedJobs += unit.cached ? 1 : 0;
    row.outputCount += unit.outputCount;
    row.outputsEqual &&= unit.outputsEqual;
    row.mismatchCount += unit.mismatchCount;
    row.schedulerWaitMs = round(row.schedulerWaitMs + unit.schedulerWaitMs);
    row.samples.push(unit.durationMs);
    row.schedulerWaitSamples.push(unit.schedulerWaitMs);
    row.queuedSamples.push(unit.durationMs + unit.schedulerWaitMs);
  }
  return [...rows.values()]
    .map(({ samples, schedulerWaitSamples, queuedSamples, ...row }) => ({
      ...row,
      ...latencySummary(samples),
      ...schedulerWaitSummary(schedulerWaitSamples),
      ...queuedLatencySummary(queuedSamples),
    }))
    .sort((left, right) => right.p95Ms - left.p95Ms);
};

const latencySummary = (samples: readonly number[]): DetectorLatencySummary => ({
  avgMs: round(samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length)),
  p85Ms: percentileMs(samples, 0.85),
  p95Ms: percentileMs(samples, 0.95),
  p98Ms: percentileMs(samples, 0.98),
  p99Ms: percentileMs(samples, 0.99),
  maxMs: round(samples.reduce((max, value) => Math.max(max, value), 0)),
});

const schedulerWaitSummary = (
  samples: readonly number[],
): Pick<
  DetectorUnitSummary,
  'avgSchedulerWaitMs' | 'p95SchedulerWaitMs' | 'p98SchedulerWaitMs' | 'maxSchedulerWaitMs'
> => ({
  avgSchedulerWaitMs: round(
    samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
  ),
  p95SchedulerWaitMs: percentileMs(samples, 0.95),
  p98SchedulerWaitMs: percentileMs(samples, 0.98),
  maxSchedulerWaitMs: round(samples.reduce((max, value) => Math.max(max, value), 0)),
});

const queuedLatencySummary = (
  samples: readonly number[],
): Pick<DetectorUnitSummary, 'avgQueuedMs' | 'p95QueuedMs' | 'p98QueuedMs' | 'maxQueuedMs'> => ({
  avgQueuedMs: round(samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length)),
  p95QueuedMs: percentileMs(samples, 0.95),
  p98QueuedMs: percentileMs(samples, 0.98),
  maxQueuedMs: round(samples.reduce((max, value) => Math.max(max, value), 0)),
});

const percentileMs = (samples: readonly number[], quantile: number): number => {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return round(sorted[index] ?? 0);
};

const buildVariantSummaries = (
  config: ImageProcessingConfig,
  totals: ImageProcessingTotals,
  detectorCandidates: readonly DetectorVariantSummary[],
): readonly ImageProcessingVariantSummary[] => {
  const variants: ImageProcessingVariantSummary[] = [];
  if (config.focus === 'binary-prefilter-signals' && totals.floodControlMs > 0) {
    variants.push({
      id: FLOOD_CONTROL_ID,
      title: 'Scanline squared-distance flood detector control',
      controlMetric: 'scanline-squared flood duration',
      candidateMetric: 'scanline-squared flood duration',
      controlMs: totals.floodControlMs,
      candidateMs: totals.floodControlMs,
      deltaMs: 0,
      improvementPct: 0,
      evidence:
        'canonical scanline-squared flood control; active candidates are measured separately in detectorCandidates.',
    });
    for (const candidate of detectorCandidates) {
      variants.push({
        id: candidate.id,
        title: candidate.id,
        controlMetric: candidate.controlId,
        candidateMetric: candidate.note,
        controlMs: candidate.controlMs,
        candidateMs: candidate.durationMs,
        deltaMs: candidate.deltaMs,
        improvementPct: candidate.improvementPct,
        evidence: `outputsEqual=${candidate.outputsEqual} mismatches=${candidate.mismatchCount} p=${candidate.outputCount}`,
      });
    }
  }
  if (config.focus === 'binary-bit-hot-path' && totals.binaryReadPixels > 0) {
    variants.push({
      id: 'direct-bit-reader',
      title: 'Direct bit-plane reader vs public byte pixel helper',
      controlMetric: 'readBinaryPixel(view, index) === 0 full-plane sweep',
      candidateMetric: 'view.plane.data[index] ^ polarityMask full-plane sweep',
      controlMs: totals.binaryReadByteMs,
      candidateMs: totals.binaryReadDirectMs,
      deltaMs: round(totals.binaryReadByteMs - totals.binaryReadDirectMs),
      improvementPct: percent(
        totals.binaryReadByteMs - totals.binaryReadDirectMs,
        totals.binaryReadByteMs,
      ),
      evidence: `${totals.binaryReadPixels} polarity-aware pixel reads; dark counts must match per asset.`,
    });
  }
  if (config.focus === 'scalar-materialization-fusion') {
    const fusedMs = round(totals.rgbFusionMs + totals.oklabFusionMs);
    variants.push({
      id: 'fused-scalar-families',
      title: 'Fused RGB/OKLab family materialization prototype',
      controlMetric: 'current scalar-view materialization spans',
      candidateMetric: 'study-side fused RGB plus OKLab family passes',
      controlMs: totals.scalarViewMs,
      candidateMs: fusedMs,
      deltaMs: round(totals.scalarViewMs - fusedMs),
      improvementPct: percent(totals.scalarViewMs - fusedMs, totals.scalarViewMs),
      evidence:
        'Prototype materializes equivalent scalar families in shared passes; byte equality still needs implementation tests before production adoption.',
    });
  }
  if (config.focus === 'shared-binary-detector-artifacts') {
    variants.push({
      id: 'shared-polarity-run-artifacts',
      title: 'Polarity-neutral run signal sharing estimate',
      controlMetric: 'per-polarity run signal construction',
      candidateMetric: 'one shareable threshold-plane run signal per scalar/threshold',
      controlMs: totals.perPolarityRunSignalMs,
      candidateMs: totals.shareableRunSignalMs,
      deltaMs: totals.estimatedSharedArtifactSavedMs,
      improvementPct: percent(totals.estimatedSharedArtifactSavedMs, totals.perPolarityRunSignalMs),
      evidence:
        'Uses measured signal construction time grouped by scalar/threshold plane; validates artifact-sharing upside before changing detector internals.',
    });
  }
  if (config.focus === 'threshold-stats-cache') {
    const candidateDependencyMs = round(totals.histogramMs + totals.otsuMs + totals.integralMs);
    variants.push({
      id: 'cached-threshold-dependencies',
      title: 'Cached scalar threshold dependency measurement',
      controlMetric: 'current binary-plane materialization spans',
      candidateMetric: 'measured reusable histogram + Otsu + integral dependencies',
      controlMs: totals.binaryPlaneMs,
      candidateMs: candidateDependencyMs,
      deltaMs: round(totals.binaryPlaneMs - candidateDependencyMs),
      improvementPct: percent(totals.binaryPlaneMs - candidateDependencyMs, totals.binaryPlaneMs),
      evidence:
        'This is a dependency-cost study, not a production-equivalent optimized scanner yet; implementation must rerun with byte-identical binary planes.',
    });
  }
  if (config.focus === 'module-sampling-hot-path' && totals.sampledModuleCount > 0) {
    variants.push({
      id: 'module-sampling-control',
      title: 'Current module sampling control',
      controlMetric: 'current module-sampling spans',
      candidateMetric: 'candidate sampler not implemented in this study run',
      controlMs: totals.moduleSamplingMs,
      candidateMs: totals.moduleSamplingMs,
      deltaMs: 0,
      improvementPct: 0,
      evidence: `${round((totals.moduleSamplingMs * 1_000_000) / totals.sampledModuleCount)}ns/module baseline for future sampler variants.`,
    });
  }
  if (config.focus === 'finder-run-map') {
    variants.push({
      id: 'run-map-control',
      title: 'Current finder detector control plus run-signal prototype cost',
      controlMetric: 'current finder detector spans',
      candidateMetric: 'passive row/column run signal construction',
      controlMs: totals.detectorMs,
      candidateMs: totals.signalMs,
      deltaMs: round(totals.detectorMs - totals.signalMs),
      improvementPct: percent(totals.detectorMs - totals.signalMs, totals.detectorMs),
      evidence:
        'Run-signal construction is not a behavior-equivalent detector replacement; it estimates headroom for a later run-map candidate implementation.',
    });
  }
  return variants;
};

const buildRecommendations = (
  perView: readonly ImageProcessingViewSummary[],
  perScalar: readonly ImageProcessingScalarSummary[],
  totals: ImageProcessingTotals,
): readonly string[] => {
  const recommendations = [
    `Hottest detector view: ${perView[0]?.binaryViewId ?? 'none'} (${perView[0]?.detectorMs ?? 0}ms).`,
    `Largest scalar integral cost: ${perScalar[0]?.scalarViewId ?? 'none'} (${perScalar[0]?.integralMs ?? 0}ms).`,
    `Shared polarity-neutral run artifacts could save about ${totals.estimatedSharedArtifactSavedMs}ms in this run.`,
  ];
  if (totals.sampledModuleCount > 0) {
    recommendations.push(
      `Module sampling cost: ${round((totals.moduleSamplingMs * 1_000_000) / totals.sampledModuleCount)}ns/module.`,
    );
  }
  return recommendations;
};

const flattenProposalSummary = (summary: ProposalViewGenerationSummary) => ({
  binaryViewId: summary.binaryViewId,
  rowScanFinderCount: summary.finderEvidence.rowScanCount,
  floodFinderCount: summary.finderEvidence.floodCount,
  matcherFinderCount: summary.finderEvidence.matcherCount,
  dedupedFinderCount: summary.finderEvidence.dedupedCount,
  expensiveDetectorsRan: summary.finderEvidence.expensiveDetectorsRan,
  rowScanDurationMs: round(summary.finderEvidence.rowScanDurationMs),
  floodDurationMs: round(summary.finderEvidence.floodDurationMs),
  matcherDurationMs: round(summary.finderEvidence.matcherDurationMs),
  dedupeDurationMs: round(summary.finderEvidence.dedupeDurationMs),
  tripleCount: summary.tripleCount,
  proposalCount: summary.proposalCount,
  durationMs: round(summary.durationMs),
  detectorDurationMs: round(summary.detectorDurationMs),
  tripleAssemblyDurationMs: round(summary.tripleAssemblyDurationMs),
  proposalConstructionDurationMs: round(summary.proposalConstructionDurationMs),
});

const summarizeTimingSpans = (spans: readonly ScanTimingSpan[]): ImageProcessingTimingSummary => ({
  scalarViewMs: sumSpans(spans, 'scalar-view'),
  binaryPlaneMs: sumSpans(spans, 'binary-plane'),
  binaryViewMs: sumSpans(spans, 'binary-view'),
  proposalViewMs: sumSpans(spans, 'proposal-view'),
  moduleSamplingMs: sumSpans(spans, 'module-sampling'),
  decodeAttemptMs: sumSpans(spans, 'decode-attempt'),
  decodeCascadeMs: sumSpans(spans, 'decode-cascade'),
});

const sumSpans = (spans: readonly ScanTimingSpan[], name: ScanTimingSpan['name']): number =>
  round(spans.filter((span) => span.name === name).reduce((sum, span) => sum + span.durationMs, 0));

const otsuThresholdFromHistogram = (histogram: Uint32Array, total: number): number => {
  let totalWeighted = 0;
  for (let value = 0; value < 256; value += 1) totalWeighted += value * (histogram[value] ?? 0);
  let bestThreshold = 128;
  let bestVariance = -1;
  let backgroundWeight = 0;
  let backgroundWeighted = 0;
  for (let threshold = 0; threshold < 256; threshold += 1) {
    const count = histogram[threshold] ?? 0;
    backgroundWeight += count;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundWeighted += threshold * count;
    const meanBackground = backgroundWeighted / backgroundWeight;
    const meanForeground = (totalWeighted - backgroundWeighted) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
};

export const warmImageProcessingStudyWorker = async (): Promise<void> => {
  const width = 96;
  const height = 96;
  const binary = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      binary[y * width + x] = (x >> 3) % 2 === (y >> 3) % 2 ? 1 : 0;
    }
  }
  const view: BinaryView = {
    id: 'gray:otsu:normal',
    scalarViewId: 'gray',
    threshold: 'otsu',
    polarity: 'normal',
    width,
    height,
    plane: { scalarViewId: 'gray', threshold: 'otsu', width, height, data: binary },
    binary,
  };
  await labelDenseComponents(view);
  await labelScanlineComponents(view);
  await floodCandidateOutput('dense-stats', view);
  await floodCandidateOutput('scanline-stats', view);
};

const COOPERATIVE_YIELD_INTERVAL_MS = 25;

const createCooperativeYield = (): (() => Promise<void> | undefined) | undefined => {
  if (
    Reflect.get(globalThis, '__BENCH_STUDY_WORKER__') === true ||
    Reflect.get(globalThis, '__BENCH_STUDY_DISABLE_COOPERATIVE_YIELD__') === true
  )
    return undefined;
  let nextYieldAt = performance.now() + COOPERATIVE_YIELD_INTERVAL_MS;
  return () => {
    if (performance.now() < nextYieldAt) return undefined;
    nextYieldAt = performance.now() + COOPERATIVE_YIELD_INTERVAL_MS;
    return yieldToDashboard();
  };
};

const yieldToDashboard = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
const round = (value: number): number => Math.round(value * 100) / 100;
const percent = (delta: number, baseline: number): number =>
  baseline <= 0 ? 0 : round((delta / baseline) * 100);
const roundRatio = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const numberMetadata = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const uniqueTexts = (values: readonly string[]): readonly string[] => [...new Set(values)];
