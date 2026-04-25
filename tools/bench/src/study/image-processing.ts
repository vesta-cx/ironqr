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
  detectFloodFinders,
  detectMatcherFinders,
  type FinderEvidence,
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

interface DetectorVariantMeasurement {
  readonly id: string;
  readonly area: 'flood' | 'matcher' | 'flood+matcher';
  readonly durationMs: number;
  readonly outputCount: number;
  readonly outputsEqual: boolean;
  readonly mismatchCount: number;
  readonly note: string;
  readonly samples: readonly number[];
}

interface DetectorVariantSummary extends DetectorVariantMeasurement, DetectorLatencySummary {
  readonly controlId: string;
  readonly controlMs: number;
  readonly deltaMs: number;
  readonly improvementPct: number;
}

interface DetectorUnitMeasurement {
  readonly id: string;
  readonly variantId: string;
  readonly area: 'flood' | 'matcher' | 'flood+matcher';
  readonly durationMs: number;
  readonly outputCount: number;
  readonly outputsEqual: boolean;
  readonly mismatchCount: number;
  readonly cached: boolean;
}

interface DetectorUnitSummary extends DetectorLatencySummary {
  readonly id: string;
  readonly variantId: string;
  readonly area: 'flood' | 'matcher' | 'flood+matcher';
  readonly jobs: number;
  readonly cachedJobs: number;
  readonly outputCount: number;
  readonly outputsEqual: boolean;
  readonly mismatchCount: number;
}

interface VariantCacheMeasurement {
  readonly durationMs: number;
  readonly outputCount: number;
  readonly signature: readonly string[];
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

interface FloodCandidateMeasurement {
  readonly controlMs: number;
  readonly variants: readonly DetectorVariantMeasurement[];
  readonly units: readonly DetectorUnitMeasurement[];
}

interface MatcherCandidateMeasurement {
  readonly variants: readonly DetectorVariantMeasurement[];
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
      return readCachedDetectorAssetResult(asset, config, cache, log);
    },
    runAsset: async ({ asset, config, cache, signal, log }) => {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      if (config.focus === 'binary-prefilter-signals') {
        if (!redundantDetectorCachePurged) {
          redundantDetectorCachePurged = true;
          log('detector cache purge starting: scanning binned pattern rows');
          await purgeRedundantDetectorCacheRows(cache, log);
        }
        const cached = await readCachedDetectorAssetResult(asset, config, cache, log);
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
        );
        matcherCandidates = await measureMatcherCandidateVariants(
          viewBank,
          viewIds,
          asset.id,
          asset,
          cache,
          log,
        );
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

const activeDetectorPatternIds = (): readonly string[] => [
  'inline-flood',
  'run-map',
  ...ACTIVE_FLOOD_CANDIDATES.map((candidate) => candidate.id),
  ...ACTIVE_MATCHER_CANDIDATES.map((candidate) => candidate.id),
];

const retainedDetectorPatternIds = (): readonly string[] => [
  'inline-flood',
  'run-map',
  ...FLOOD_CANDIDATES.map((candidate) => candidate.id),
  ...MATCHER_CANDIDATES.map((candidate) => candidate.id),
];

const readCachedDetectorAssetResult = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  config: ImageProcessingConfig,
  cache: StudyCacheHandle<unknown>,
  log: (message: string) => void,
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
    const replayed = await replayCachedDetectorRows(asset, cache, viewIds, requiredIds, log);
    log(
      `${asset.id}: detector cache missing ${missing.length}/${requiredIds.length * viewIds.length} variant-view rows; preloaded ${replayed} cached rows`,
    );
    return null;
  }

  let floodControlMs = 0;
  let matcherControlMs = 0;
  const floodVariants = new Map<string, DetectorVariantMeasurement>();
  const matcherVariants = new Map<string, DetectorVariantMeasurement>();
  const floodUnits: DetectorUnitMeasurement[] = [];
  const matcherUnits: DetectorUnitMeasurement[] = [];

  for (const viewId of viewIds) {
    const floodControl = await readVariantMeasurement(asset, cache, 'inline-flood', viewId);
    const matcherControl = await readVariantMeasurement(asset, cache, 'run-map', viewId);
    if (!floodControl || !matcherControl) return null;
    floodControlMs += floodControl.durationMs;
    matcherControlMs += matcherControl.durationMs;
    const floodControlId = detectorTimingId(viewId, 'inline-flood', 'flood');
    const matcherControlId = detectorTimingId(viewId, 'run-map', 'matcher');
    floodUnits.push(
      detectorUnit(floodControlId, 'inline-flood', 'flood', floodControl, true, true),
    );
    matcherUnits.push(
      detectorUnit(matcherControlId, 'run-map', 'matcher', matcherControl, true, true),
    );
    logStudyTiming(
      log,
      floodControlId,
      floodControl.durationMs,
      'detector',
      floodControl.outputCount,
      true,
    );
    logStudyTiming(
      log,
      matcherControlId,
      matcherControl.durationMs,
      'detector',
      matcherControl.outputCount,
      true,
    );

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
      const area = candidate.id === 'shared-runs' ? 'flood+matcher' : 'matcher';
      const compared = compareVariant(
        candidate.id,
        area,
        matcherControl.signature,
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
    matcherCandidates: cachedMatcherMeasurement(
      matcherControlMs,
      viewIds,
      matcherVariants,
      matcherUnits,
    ),
    floodCandidates: {
      controlMs: round(floodControlMs),
      variants: [...floodVariants.values()],
      units: floodUnits,
    },
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
): Promise<number> => {
  let replayed = 0;
  for (const viewId of viewIds) {
    for (const variantId of variantIds) {
      const measurement = await readVariantMeasurement(asset, cache, variantId, viewId);
      if (!measurement) continue;
      replayed += 1;
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

const FLOOD_CANDIDATES = [
  {
    id: 'dense-stats',
    note: 'Typed-array stats and no per-pixel neighbor allocation.',
  },
  {
    id: 'spatial-bin',
    note: 'Typed-array stats plus spatially indexed contained-component lookup.',
  },
  { id: 'run-length-ccl', note: 'Run-length connected components prototype.' },
] as const;

const ACTIVE_FLOOD_CANDIDATES: readonly (typeof FLOOD_CANDIDATES)[number][] = [FLOOD_CANDIDATES[0]];

const MATCHER_CANDIDATES = [
  {
    id: 'run-pattern',
    note: 'Centers enumerated from horizontal 1:1:3:1:1 run patterns.',
  },
  {
    id: 'axis-intersect',
    note: 'Centers enumerated from intersecting horizontal and vertical run patterns.',
  },
  {
    id: 'shared-runs',
    note: 'Shared run-pattern artifact prototype feeding matcher enumeration.',
  },
] as const;

const ACTIVE_MATCHER_CANDIDATES: readonly (typeof MATCHER_CANDIDATES)[number][] = [];

const measureVariant = async (
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  variantId: string,
  viewId: BinaryViewId,
  run: () => FinderEvidence[],
): Promise<{
  readonly output: FinderEvidence[];
  readonly measurement: VariantCacheMeasurement;
  readonly cached: boolean;
}> => {
  const cached = await readVariantMeasurement(asset, cache, variantId, viewId);
  if (cached) return { output: [], measurement: cached, cached: true };
  const cacheKey = detectorVariantCacheKey(variantId, viewId);
  const startedAt = performance.now();
  const output = run();
  const measurement = {
    durationMs: round(performance.now() - startedAt),
    outputCount: output.length,
    signature: finderSignature(output),
  };
  await cache.write(asset, cacheKey, measurement);
  return { output, measurement, cached: false };
};

const compareVariant = (
  id: string,
  area: DetectorVariantMeasurement['area'],
  controlSignature: readonly string[],
  measurement: VariantCacheMeasurement,
  note: string,
): DetectorVariantMeasurement => {
  const outputsEqual = signaturesEqual(controlSignature, measurement.signature);
  return {
    id,
    area,
    durationMs: measurement.durationMs,
    outputCount: measurement.outputCount,
    outputsEqual,
    mismatchCount: outputsEqual ? 0 : 1,
    note,
    samples: [measurement.durationMs],
  };
};

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

const labelDenseComponents = (binary: BinaryView): readonly BenchComponentStats[] => {
  const width = binary.width;
  const height = binary.height;
  const labels = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  const stats: BenchComponentStats[] = [];
  let nextLabel = 1;
  for (let start = 0; start < labels.length; start += 1) {
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
  floodFromComponentSets(
    components.filter((component) => component.color === 0),
    components.filter((component) => component.color === 255),
    components.filter((component) => component.color === 0),
  );

const floodFromComponentSets = (
  rings: readonly BenchComponentStats[],
  gaps: readonly BenchComponentStats[],
  stones: readonly BenchComponentStats[],
): FinderEvidence[] => {
  const evidence: FinderEvidence[] = [];
  for (const ring of rings) {
    if (!isBenchFloodRing(ring)) continue;
    const ringWidth = ring.maxX - ring.minX + 1;
    const ringHeight = ring.maxY - ring.minY + 1;
    const gap = gaps.find(
      (candidate) =>
        containedIn(candidate, ring) &&
        distancePoint(candidate.centroidX, candidate.centroidY, ring.centroidX, ring.centroidY) <
          Math.min(ringWidth, ringHeight) * 0.25,
    );
    if (!gap) continue;
    const stone = stones.find(
      (candidate) =>
        candidate.id !== ring.id &&
        containedIn(candidate, gap) &&
        distancePoint(candidate.centroidX, candidate.centroidY, gap.centroidX, gap.centroidY) <
          Math.min(gap.maxX - gap.minX + 1, gap.maxY - gap.minY + 1) * 0.2,
    );
    if (!stone) continue;
    const areaRatio = stone.pixelCount / Math.max(1, ring.pixelCount);
    if (areaRatio < 0.18 || areaRatio > 0.72) continue;
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
  }
  return dedupeBenchEvidence(evidence)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12);
};

const floodWithSpatialBins = (components: readonly BenchComponentStats[]): FinderEvidence[] => {
  const gaps = components.filter((component) => component.color === 255);
  const stones = components.filter((component) => component.color === 0);
  return floodFromComponentSets(stones, gaps, stones);
};

const floodWithRunLengthComponents = (binary: BinaryView): FinderEvidence[] =>
  floodFromComponents(labelDenseComponents(binary));

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

const matcherPatternCenters = (
  binary: BinaryView,
  mode: 'horizontal' | 'intersection' | 'coarse',
): readonly { x: number; y: number }[] => {
  const width = binary.width;
  const height = binary.height;
  if (mode === 'coarse') {
    const step = Math.max(1, Math.floor(Math.min(width, height) / 90));
    const centers: { x: number; y: number }[] = [];
    for (let y = 2; y < height - 2; y += step)
      for (let x = 2; x < width - 2; x += step)
        if (readBinaryPixel(binary, y * width + x) === 0) centers.push({ x, y });
    return centers;
  }
  const horizontal: { x: number; y: number }[] = [];
  const verticalKeys = new Set<string>();
  for (let y = 0; y < height; y += 1)
    collectRunCenters(binary, width, height, y, true, horizontal, verticalKeys);
  if (mode === 'horizontal') return horizontal;
  for (let x = 0; x < width; x += 1)
    collectRunCenters(binary, width, height, x, false, [], verticalKeys);
  return horizontal.filter((center) =>
    verticalKeys.has(`${Math.round(center.x)}:${Math.round(center.y)}`),
  );
};

const collectRunCenters = (
  binary: BinaryView,
  width: number,
  height: number,
  fixed: number,
  horizontal: boolean,
  centers: { x: number; y: number }[],
  keys: Set<string>,
): void => {
  const limit = horizontal ? width : height;
  const runs: { color: number; start: number; end: number }[] = [];
  let start = 0;
  let color = readBinaryPixel(binary, horizontal ? fixed * width : fixed);
  for (let pos = 1; pos < limit; pos += 1) {
    const index = horizontal ? fixed * width + pos : pos * width + fixed;
    const next = readBinaryPixel(binary, index);
    if (next === color) continue;
    runs.push({ color, start, end: pos - 1 });
    start = pos;
    color = next;
  }
  runs.push({ color, start, end: limit - 1 });
  for (let i = 0; i + 4 < runs.length; i += 1) {
    const slice = runs.slice(i, i + 5);
    if (slice.map((run) => run.color).join(',') !== '0,255,0,255,0') continue;
    const lengths = slice.map((run) => run.end - run.start + 1);
    const moduleSize = lengths.reduce((sum, value) => sum + value, 0) / 7;
    if (
      moduleSize < 0.8 ||
      lengths.some(
        (value, index) => Math.abs(value - moduleSize * (index === 2 ? 3 : 1)) > moduleSize,
      )
    )
      continue;
    const centerRun = slice[2];
    if (!centerRun) continue;
    const center = (centerRun.start + centerRun.end) / 2;
    if (horizontal) centers.push({ x: center, y: fixed });
    else keys.add(`${Math.round(fixed)}:${Math.round(center)}`);
  }
};

const matcherFromCenters = (
  binary: BinaryView,
  centers: readonly { x: number; y: number }[],
): FinderEvidence[] => {
  const evidence: FinderEvidence[] = [];
  for (const center of centers) {
    const horizontal = benchCrossCheck(binary, center.x, center.y, 1, 0);
    const vertical = benchCrossCheck(binary, center.x, center.y, 0, 1);
    if (!horizontal || !vertical) continue;
    const moduleSize = (horizontal.moduleSize + vertical.moduleSize) / 2;
    if (moduleSize < 0.8) continue;
    evidence.push({
      source: 'matcher',
      centerX: horizontal.centerX,
      centerY: vertical.centerY,
      moduleSize,
      hModuleSize: horizontal.moduleSize,
      vModuleSize: vertical.moduleSize,
      score: horizontal.score + vertical.score + 0.75,
    });
  }
  return dedupeBenchEvidence(evidence)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12);
};

const benchCrossCheck = (
  binary: BinaryView,
  centerX: number,
  centerY: number,
  dx: number,
  dy: number,
): { centerX: number; centerY: number; moduleSize: number; score: number } | null => {
  const width = binary.width;
  const height = binary.height;
  const x = Math.round(centerX);
  const y = Math.round(centerY);
  if (!insideBench(x, y, width, height) || readBinaryPixel(binary, y * width + x) !== 0)
    return null;
  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let cursorX = x;
  let cursorY = y;
  for (const [slot, color, step] of [
    [2, 0, -1],
    [1, 255, -1],
    [0, 0, -1],
    [2, 0, 1],
    [3, 255, 1],
    [4, 0, 1],
  ] as const) {
    if (step === 1 && slot === 2) {
      cursorX = x + dx;
      cursorY = y + dy;
    }
    while (
      insideBench(cursorX, cursorY, width, height) &&
      readBinaryPixel(binary, cursorY * width + cursorX) === color
    ) {
      counts[slot] += 1;
      cursorX += dx * step;
      cursorY += dy * step;
    }
  }
  const score = benchRatioScore(counts);
  if (score <= 0) return null;
  const before = counts[0] + counts[1] + counts[2] / 2;
  const after = counts[4] + counts[3] + counts[2] / 2;
  return {
    centerX: centerX + dx * ((after - before) / 2),
    centerY: centerY + dy * ((after - before) / 2),
    moduleSize: counts.reduce((sum, value) => sum + value, 0) / 7,
    score,
  };
};

const benchRatioScore = (counts: readonly number[]): number => {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total < 7) return 0;
  const moduleSize = total / 7;
  const variance =
    counts.reduce(
      (sum, value, index) => sum + Math.abs(value - moduleSize * (index === 2 ? 3 : 1)),
      0,
    ) / total;
  return variance > 0.9 ? 0 : 1 - variance;
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

const insideBench = (x: number, y: number, width: number, height: number): boolean =>
  x >= 0 && y >= 0 && x < width && y < height;

const distancePoint = (x0: number, y0: number, x1: number, y1: number): number =>
  Math.hypot(x1 - x0, y1 - y0);

const measureFloodCandidateVariants = async (
  viewBank: ViewBank,
  viewIds: readonly BinaryViewId[],
  assetId: string,
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  log: (message: string) => void,
): Promise<FloodCandidateMeasurement> => {
  let controlMs = 0;
  const variants = new Map<string, DetectorVariantMeasurement>();
  const units: DetectorUnitMeasurement[] = [];

  for (const viewId of viewIds) {
    const view = viewBank.getBinaryView(viewId);
    const control = await measureVariant(asset, cache, 'inline-flood', viewId, () =>
      detectFloodFinders(view, view.width, view.height),
    );
    controlMs += control.measurement.durationMs;
    const controlId = detectorTimingId(viewId, 'inline-flood', 'flood');
    units.push(
      detectorUnit(controlId, 'inline-flood', 'flood', control.measurement, control.cached, true),
    );
    if (!control.cached) {
      logStudyTiming(
        log,
        controlId,
        control.measurement.durationMs,
        'detector',
        control.measurement.outputCount,
        false,
      );
    }

    for (const candidate of ACTIVE_FLOOD_CANDIDATES) {
      const measured = await measureVariant(asset, cache, candidate.id, viewId, () => {
        if (candidate.id === 'spatial-bin') {
          return floodWithSpatialBins(labelDenseComponents(view));
        }
        if (candidate.id === 'run-length-ccl') {
          return floodWithRunLengthComponents(view);
        }
        return floodFromComponents(labelDenseComponents(view));
      });
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
      if (!measured.cached) {
        logStudyTiming(
          log,
          unitId,
          measured.measurement.durationMs,
          'detector',
          measured.measurement.outputCount,
          false,
        );
      }
      log(
        `${assetId}: flood ${shortVariantId(candidate.id)} ${shortBinaryViewId(viewId)} ${measured.cached ? 'cache hit' : 'fresh'} p=${measured.measurement.outputCount}`,
      );
      await yieldToDashboard();
    }
  }

  return { controlMs: round(controlMs), variants: [...variants.values()], units };
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
    samples: [...current.samples, ...next.samples],
  });
};

const measureMatcherCandidateVariants = async (
  viewBank: ViewBank,
  viewIds: readonly BinaryViewId[],
  assetId: string,
  asset: Parameters<StudyCacheHandle['read']>[0],
  cache: Pick<StudyCacheHandle, 'has' | 'read' | 'write'>,
  log: (message: string) => void,
): Promise<MatcherCandidateMeasurement> => {
  let controlMatcherMs = 0;
  const variants = new Map<string, DetectorVariantMeasurement>();
  const units: DetectorUnitMeasurement[] = [];

  for (const viewId of viewIds) {
    const view = viewBank.getBinaryView(viewId);
    const control = await measureVariant(asset, cache, 'run-map', viewId, () =>
      detectMatcherFinders(view, view.width, view.height),
    );
    controlMatcherMs += control.measurement.durationMs;
    const controlId = detectorTimingId(viewId, 'run-map', 'matcher');
    units.push(
      detectorUnit(controlId, 'run-map', 'matcher', control.measurement, control.cached, true),
    );
    if (!control.cached) {
      logStudyTiming(
        log,
        controlId,
        control.measurement.durationMs,
        'detector',
        control.measurement.outputCount,
        false,
      );
    }

    for (const candidate of ACTIVE_MATCHER_CANDIDATES) {
      const measured = await measureVariant(asset, cache, candidate.id, viewId, () => {
        if (candidate.id === 'axis-intersect') {
          return matcherFromCenters(view, matcherPatternCenters(view, 'intersection'));
        }
        return matcherFromCenters(view, matcherPatternCenters(view, 'horizontal'));
      });
      const area = candidate.id === 'shared-runs' ? 'flood+matcher' : 'matcher';
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
      if (!measured.cached) {
        logStudyTiming(
          log,
          unitId,
          measured.measurement.durationMs,
          'detector',
          measured.measurement.outputCount,
          false,
        );
      }
      log(
        `${assetId}: matcher ${shortVariantId(candidate.id)} ${shortBinaryViewId(viewId)} ${measured.cached ? 'cache hit' : 'fresh'} p=${measured.measurement.outputCount}`,
      );
      await yieldToDashboard();
    }
  }

  return {
    variants: [...variants.values()],
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
  'inline-flood': 'inline',
  'run-map': 'run-map',
  'dense-stats': 'dense',
  'spatial-bin': 'spatial',
  'run-length-ccl': 'run-length',
  'run-pattern': 'run-pattern',
  'axis-intersect': 'axis-x',
  'shared-runs': 'shared-runs',
};

const LEGACY_VARIANT_IDS: Record<string, readonly string[]> = {
  'inline-flood': ['inline-flood-control'],
  'run-map': ['run-map-matcher-control'],
  'dense-stats': ['dense-typed-array-component-stats'],
  'spatial-bin': ['spatial-binned-component-lookup'],
  'run-length-ccl': ['run-length-connected-components'],
  'run-pattern': ['run-pattern-center-matcher'],
  'axis-intersect': ['axis-run-intersection-matcher'],
  'shared-runs': ['shared-run-length-detector-artifacts'],
};

const LEGACY_VARIANT_ALIASES: Record<string, string> = {
  'inline-flood-control': 'in',
  'run-map-matcher-control': 'rm',
  'dense-typed-array-component-stats': 'dta',
  'spatial-binned-component-lookup': 'sb',
  'run-length-connected-components': 'rlc',
  'run-pattern-center-matcher': 'rpc',
  'axis-run-intersection-matcher': 'ari',
  'shared-run-length-detector-artifacts': 'srla',
};

const FLOOD_DETECTOR_IDS = new Set([
  'inline-flood',
  'dense-stats',
  'spatial-bin',
  'run-length-ccl',
  'inline-flood-control',
  'dense-typed-array-component-stats',
  'spatial-binned-component-lookup',
  'run-length-connected-components',
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
      totals.detectorMs += result.floodCandidates.controlMs;
      detectorUnits.push(...result.floodCandidates.units);
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
      for (const variant of result.matcherCandidates.variants) {
        mergeDetectorVariant(detectorVariantRows, variant);
      }
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
    const controlId = variant.area === 'flood' ? 'inline-flood' : 'run-map';
    const controlMs = variant.area === 'flood' ? totals.floodControlMs : totals.matcherControlMs;
    return {
      ...variant,
      ...latencySummary(variant.samples),
      controlId,
      controlMs,
      deltaMs: round(controlMs - variant.durationMs),
      improvementPct: percent(controlMs - variant.durationMs, controlMs),
    };
  });

const summarizeDetectorUnits = (
  units: readonly DetectorUnitMeasurement[],
  keyFor: (unit: DetectorUnitMeasurement) => string,
): readonly DetectorUnitSummary[] => {
  const rows = new Map<string, Mutable<DetectorUnitSummary> & { samples: number[] }>();
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
        samples: [unit.durationMs],
      });
      continue;
    }
    row.jobs += 1;
    row.cachedJobs += unit.cached ? 1 : 0;
    row.outputCount += unit.outputCount;
    row.outputsEqual &&= unit.outputsEqual;
    row.mismatchCount += unit.mismatchCount;
    row.samples.push(unit.durationMs);
  }
  return [...rows.values()]
    .map(({ samples, ...row }) => ({ ...row, ...latencySummary(samples) }))
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
      id: 'inline-flood',
      title: 'Inline component-stats flood detector control',
      controlMetric: 'inline component-stats flood duration',
      candidateMetric: 'inline component-stats flood duration',
      controlMs: totals.floodControlMs,
      candidateMs: totals.floodControlMs,
      deltaMs: 0,
      improvementPct: 0,
      evidence:
        'canonical flood-fill control; active candidates are measured separately in detectorCandidates.',
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
