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
  type BinaryView,
  type BinaryViewId,
  createViewBank,
  readBinaryPixel,
  type ViewBank,
} from '../../../../packages/ironqr/src/pipeline/views.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

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
  readonly binaryRead: BinaryReadMeasurement | null;
  readonly materializedInverted: MaterializedInvertedMeasurement | null;
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

interface MaterializedInvertedMeasurement {
  readonly controlDetectorMs: number;
  readonly candidateMaterializationMs: number;
  readonly candidateDetectorMs: number;
  readonly candidateTotalMs: number;
  readonly deltaMs: number;
  readonly improvementPct: number;
  readonly viewCount: number;
  readonly proposalCountsEqual: boolean;
  readonly rowScanCountsEqual: boolean;
  readonly matcherCountsEqual: boolean;
  readonly floodCountsEqual: boolean;
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
  readonly materializedInvertedControlMs: number;
  readonly materializedInvertedMaterializationMs: number;
  readonly materializedInvertedDetectorMs: number;
  readonly materializedInvertedViews: number;
  readonly materializedInvertedAllCountsEqual: boolean;
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
  title: 'IronQR binary prefilter signals study',
  description:
    'Collects passive whole-view binary signals and correlates them with detector cost and proposal yield.',
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
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    version: STUDY_VERSION,
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
    runAsset: async ({ asset, config, signal, log }) => {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      const image = await asset.loadImage();
      const normalized = createNormalizedImage(image);
      const spans: ScanTimingSpan[] = [];
      const metricsSink = { record: (span: ScanTimingSpan) => spans.push(span) };
      const viewBank = createViewBank(normalized, { metricsSink });
      const viewIds =
        config.viewSet === 'all' ? viewBank.listBinaryViewIds() : viewBank.listProposalViewIds();

      log(
        `${asset.id}: profiling ${viewIds.length} binary view identities over ${sharedPlaneCount(viewIds)} shared threshold planes (${config.focus})`,
      );
      const studyStartedAt = performance.now();
      const proposalStartedAt = performance.now();
      const proposalSummaries: ProposalViewGenerationSummary[] = [];
      let proposalViewIndex = 0;
      for (const viewId of viewIds) {
        proposalViewIndex += 1;
        const summary = generateProposalBatchForView(viewBank, viewId, {
          maxProposalsPerView: EXHAUSTIVE_SCAN_CEILING,
        }).summary;
        proposalSummaries.push(summary);
        logStudyTiming(log, studyTimingId(viewId, 'a'), summary.detectorDurationMs);
        log(`${asset.id}: proposal path ${proposalViewIndex}/${viewIds.length} ${viewId}`);
        await yieldToDashboard();
      }
      const proposalGenerationMs = round(performance.now() - proposalStartedAt);
      const binarySignals: BinaryViewSignal[] = [];
      let binarySignalIndex = 0;
      for (const viewId of viewIds) {
        binarySignalIndex += 1;
        binarySignals.push(measureBinarySignals(viewBank.getBinaryView(viewId)));
        log(`${asset.id}: polarity signal ${binarySignalIndex}/${viewIds.length} ${viewId}`);
        await yieldToDashboard();
      }
      const scalarStats: ScalarStatsMeasurement[] = [];
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
      const scalarFusion = measureScalarFusion(image);
      const sharedArtifacts = summarizeSharedArtifacts(binarySignals);
      const binaryRead =
        config.focus === 'binary-bit-hot-path'
          ? await measureBinaryReadVariants(viewBank, viewIds, asset.id, log)
          : null;
      const materializedInverted =
        config.focus === 'binary-prefilter-signals'
          ? await measureMaterializedInvertedVariant(
              viewBank,
              viewIds,
              proposalSummaries,
              asset.id,
              log,
            )
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
        binaryRead,
        materializedInverted,
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
        binaryRead: result.binaryRead,
        materializedInverted: result.materializedInverted,
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

const logStudyTiming = (log: (message: string) => void, id: string, durationMs: number): void => {
  log(`${STUDY_TIMING_PREFIX}${JSON.stringify({ id, durationMs })}`);
};

const studyTimingId = (viewId: BinaryViewId, variant: string): string => {
  const [scalar = '', threshold = '', polarity = ''] = viewId.split(':');
  return `${variant}:${scalar}:${threshold}:${polarity}`;
};

const sharedPlaneCount = (viewIds: readonly BinaryViewId[]): number =>
  new Set(viewIds.map((viewId) => viewId.split(':').slice(0, 2).join(':'))).size;

const measureMaterializedInvertedVariant = async (
  viewBank: ViewBank,
  viewIds: readonly BinaryViewId[],
  controlSummaries: readonly ProposalViewGenerationSummary[],
  assetId: string,
  log: (message: string) => void,
): Promise<MaterializedInvertedMeasurement> => {
  const controlByView = new Map(controlSummaries.map((summary) => [summary.binaryViewId, summary]));
  const invertedViewIds = viewIds.filter((viewId) => viewId.endsWith(':inverted'));
  let controlDetectorMs = 0;
  let candidateMaterializationMs = 0;
  let candidateDetectorMs = 0;
  let proposalCountsEqual = true;
  let rowScanCountsEqual = true;
  let matcherCountsEqual = true;
  let floodCountsEqual = true;

  for (const viewId of invertedViewIds) {
    const control = controlByView.get(viewId);
    if (control) controlDetectorMs += control.detectorDurationMs;
    const materializedStartedAt = performance.now();
    const materializedView = materializePolarityView(viewBank.getBinaryView(viewId));
    candidateMaterializationMs += performance.now() - materializedStartedAt;
    const materializedBank = createSingleBinaryViewBank(viewBank, materializedView);
    const candidate = generateProposalBatchForView(materializedBank, viewId, {
      maxProposalsPerView: EXHAUSTIVE_SCAN_CEILING,
    }).summary;
    candidateDetectorMs += candidate.detectorDurationMs;
    if (control) {
      proposalCountsEqual &&= control.proposalCount === candidate.proposalCount;
      rowScanCountsEqual &&=
        control.finderEvidence.rowScanCount === candidate.finderEvidence.rowScanCount;
      matcherCountsEqual &&=
        control.finderEvidence.matcherCount === candidate.finderEvidence.matcherCount;
      floodCountsEqual &&=
        control.finderEvidence.floodCount === candidate.finderEvidence.floodCount;
    }
    logStudyTiming(log, studyTimingId(viewId, 'b'), candidate.detectorDurationMs);
    log(`${assetId}: materialized inverted detector variant ${viewId}`);
    await yieldToDashboard();
  }

  const candidateTotalMs = candidateMaterializationMs + candidateDetectorMs;
  const deltaMs = controlDetectorMs - candidateTotalMs;
  return {
    controlDetectorMs: round(controlDetectorMs),
    candidateMaterializationMs: round(candidateMaterializationMs),
    candidateDetectorMs: round(candidateDetectorMs),
    candidateTotalMs: round(candidateTotalMs),
    deltaMs: round(deltaMs),
    improvementPct: percent(deltaMs, controlDetectorMs),
    viewCount: invertedViewIds.length,
    proposalCountsEqual,
    rowScanCountsEqual,
    matcherCountsEqual,
    floodCountsEqual,
  };
};

const materializePolarityView = (view: BinaryView): BinaryView => {
  const data = new Uint8Array(view.plane.data.length);
  const invert = view.polarity === 'inverted' ? 1 : 0;
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (view.plane.data[index] ?? 0) ^ invert;
  }
  const plane = { ...view.plane, data };
  return { ...view, polarity: 'normal', plane, binary: data };
};

const createSingleBinaryViewBank = (viewBank: ViewBank, view: BinaryView): ViewBank => ({
  getScalarView: (id) => viewBank.getScalarView(id),
  getBinaryView: (id) => (id === view.id ? view : viewBank.getBinaryView(id)),
  listScalarViewIds: () => viewBank.listScalarViewIds(),
  listBinaryViewIds: () => viewBank.listBinaryViewIds(),
  listProposalViewIds: () => viewBank.listProposalViewIds(),
  getDecodeNeighborhood: (id) => viewBank.getDecodeNeighborhood(id),
});

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
    if (result.materializedInverted) {
      totals.materializedInvertedControlMs += result.materializedInverted.controlDetectorMs;
      totals.materializedInvertedMaterializationMs +=
        result.materializedInverted.candidateMaterializationMs;
      totals.materializedInvertedDetectorMs += result.materializedInverted.candidateDetectorMs;
      totals.materializedInvertedViews += result.materializedInverted.viewCount;
      totals.materializedInvertedAllCountsEqual &&=
        result.materializedInverted.proposalCountsEqual &&
        result.materializedInverted.rowScanCountsEqual &&
        result.materializedInverted.matcherCountsEqual &&
        result.materializedInverted.floodCountsEqual;
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
  const variants = buildVariantSummaries(config, finalizedTotals);

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
  materializedInvertedControlMs: 0,
  materializedInvertedMaterializationMs: 0,
  materializedInvertedDetectorMs: 0,
  materializedInvertedViews: 0,
  materializedInvertedAllCountsEqual: true,
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
  materializedInvertedControlMs: round(totals.materializedInvertedControlMs),
  materializedInvertedMaterializationMs: round(totals.materializedInvertedMaterializationMs),
  materializedInvertedDetectorMs: round(totals.materializedInvertedDetectorMs),
  materializedInvertedViews: totals.materializedInvertedViews,
  materializedInvertedAllCountsEqual: totals.materializedInvertedAllCountsEqual,
});

const finalizeViewRow = (row: MutableViewSummary): ImageProcessingViewSummary => ({
  binaryViewId: row.binaryViewId,
  assetCount: row.assetCount,
  detectorMs: round(row.detectorMs),
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

const buildVariantSummaries = (
  config: ImageProcessingConfig,
  totals: ImageProcessingTotals,
): readonly ImageProcessingVariantSummary[] => {
  const variants: ImageProcessingVariantSummary[] = [];
  if (config.focus === 'binary-prefilter-signals' && totals.materializedInvertedViews > 0) {
    const candidateMs = round(
      totals.materializedInvertedMaterializationMs + totals.materializedInvertedDetectorMs,
    );
    variants.push({
      id: 'materialized-inverted-detector',
      title: 'Materialized inverted buffers vs polarity-proxy detector reads',
      controlMetric: 'current inverted detector pass over polarity proxy',
      candidateMetric:
        'one materialized inverted bit buffer plus detector pass with normal polarity reads',
      controlMs: totals.materializedInvertedControlMs,
      candidateMs,
      deltaMs: round(totals.materializedInvertedControlMs - candidateMs),
      improvementPct: percent(
        totals.materializedInvertedControlMs - candidateMs,
        totals.materializedInvertedControlMs,
      ),
      evidence: `${totals.materializedInvertedViews} inverted view identities; proposal/finder counts equal=${totals.materializedInvertedAllCountsEqual}.`,
    });
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
