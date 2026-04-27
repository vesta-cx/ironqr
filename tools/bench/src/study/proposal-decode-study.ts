import type { ScanResult, ScanTimingSpan } from '../../../../packages/ironqr/src/contracts/scan.js';
import {
  createTraceCollector,
  listDefaultBinaryViewIds,
  scanFrame,
} from '../../../../packages/ironqr/src/index.js';
import type { ScanRuntimeOptions } from '../../../../packages/ironqr/src/pipeline/scan.js';
import type { IronqrTraceEvent } from '../../../../packages/ironqr/src/pipeline/trace.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import { average, positiveIntegerFlag, round, sumBy, uniqueValues } from './summary-helpers.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const TIMING_ROWS_PER_VARIANT = 6;

export interface ProposalDecodeConfig<Variant extends string> extends Record<string, unknown> {
  readonly variants: readonly Variant[];
  readonly maxProposals: number;
  readonly maxClusterRepresentatives: number;
  readonly maxDecodeAttempts?: number;
  readonly maxViews: number;
}

export interface ProposalDecodeAssetResult<Variant extends string> {
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly expectedTexts: readonly string[];
  readonly variants: readonly ProposalDecodeVariantResult<Variant>[];
}

export interface ProposalDecodeVariantResult<Variant extends string> {
  readonly variantId: Variant;
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly falsePositiveTexts: readonly string[];
  readonly success: boolean;
  readonly scanDurationMs: number;
  readonly proposalCount: number;
  readonly clusterCount: number;
  readonly processedRepresentativeCount: number;
  readonly decodeAttemptCount: number;
  readonly decodeSuccessCount: number;
  readonly timings: ProposalDecodeTimingSummary;
}

export interface ProposalDecodeTimingSummary {
  readonly proposalViewMs: number;
  readonly rankingMs: number;
  readonly clusteringMs: number;
  readonly structureMs: number;
  readonly geometryMs: number;
  readonly moduleSamplingMs: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

export interface ProposalDecodeVariantSummary<Variant extends string>
  extends ProposalDecodeTimingSummary {
  readonly variantId: Variant;
  readonly assetCount: number;
  readonly positiveDecodedAssetCount: number;
  readonly falsePositiveAssetCount: number;
  readonly successAssetCount: number;
  readonly proposalCount: number;
  readonly clusterCount: number;
  readonly processedRepresentativeCount: number;
  readonly decodeAttemptCount: number;
  readonly decodeSuccessCount: number;
  readonly scanDurationMs: number;
  readonly avgScanDurationMs: number;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
  readonly falsePositiveAssetIds: readonly string[];
}

export interface ProposalDecodeComparison<Variant extends string> {
  readonly variantId: Variant;
  readonly comparedTo: Variant;
  readonly positiveDelta: number;
  readonly falsePositiveDelta: number;
  readonly proposalDelta: number;
  readonly decodeAttemptDelta: number;
  readonly scanDurationDeltaMs: number;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
}

export interface ProposalDecodeSummary<Variant extends string> extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly cache: StudySummaryInput<
    ProposalDecodeConfig<Variant>,
    ProposalDecodeAssetResult<Variant>
  >['cache'];
  readonly variants: readonly ProposalDecodeVariantSummary<Variant>[];
  readonly comparisons: readonly ProposalDecodeComparison<Variant>[];
  readonly recommendation: readonly string[];
}

export interface ProposalDecodeStudyDefinition<Variant extends string> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly variants: readonly Variant[];
  readonly controlVariant: Variant;
  readonly variantFlagName?: string;
  readonly variantFlagLabel?: string;
  readonly unknownVariantLabel: string;
  readonly recommendation: readonly string[];
  readonly runtimeOptions: (variant: Variant) => Partial<ScanRuntimeOptions>;
}

export const makeProposalDecodeStudyPlugin = <Variant extends string>({
  id,
  title,
  description,
  version,
  variants: defaultVariants,
  controlVariant,
  variantFlagName = 'variants',
  variantFlagLabel = 'variants',
  unknownVariantLabel,
  recommendation,
  runtimeOptions,
}: ProposalDecodeStudyDefinition<Variant>): StudyPlugin<
  ProposalDecodeSummary<Variant>,
  ProposalDecodeConfig<Variant>,
  ProposalDecodeAssetResult<Variant>
> => ({
  id,
  title,
  description,
  version,
  flags: [
    { name: 'max-assets', type: 'number', description: 'Limit approved corpus assets.' },
    {
      name: variantFlagName,
      type: 'string',
      description: `Comma-separated ${variantFlagLabel}. Defaults to ${defaultVariants.join(',')}.`,
    },
    { name: 'max-proposals', type: 'number', description: 'Maximum proposals per view.' },
    {
      name: 'max-cluster-representatives',
      type: 'number',
      description: 'Maximum representatives per cluster.',
    },
    {
      name: 'max-decode-attempts',
      type: 'number',
      description: 'Optional maximum decode attempts per scan. Defaults to unbounded.',
    },
    { name: 'max-views', type: 'number', description: 'Maximum binary views per asset.' },
  ],
  parseConfig: ({ flags }) =>
    parseProposalDecodeConfig(
      flags,
      defaultVariants,
      controlVariant,
      variantFlagName,
      unknownVariantLabel,
      id,
    ),
  cacheKey: (config) =>
    JSON.stringify({ config, engine: describeAccuracyEngine(getAccuracyEngineById('ironqr')) }),
  estimateUnits: (config, assets) =>
    assets.length * config.variants.length * TIMING_ROWS_PER_VARIANT,
  replayCachedAsset: ({ result, log }) => {
    for (const variant of result.variants) logVariantMetrics(log, variant);
  },
  runAsset: async ({ asset, config, signal, log }) => {
    const image = await asset.loadImage();
    const expectedTexts = uniqueTexts(
      asset.expectedTexts.map(normalizeDecodedText).filter(Boolean),
    );
    const variantResults: ProposalDecodeVariantResult<Variant>[] = [];
    for (const variant of config.variants) {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      const result = await runVariant(
        image,
        asset.label,
        expectedTexts,
        variant,
        config,
        runtimeOptions(variant),
      );
      variantResults.push(result);
      logVariantMetrics(log, result);
      log(
        `${asset.id}: ${variant} success=${result.success} proposals=${result.proposalCount} attempts=${result.decodeAttemptCount}`,
      );
    }
    return { assetId: asset.id, label: asset.label, expectedTexts, variants: variantResults };
  },
  summarize: (input) => summarize(input, controlVariant, recommendation),
  renderReport: ({ config, results, summary }) => ({ config, summary, sampledAssets: results }),
});

const parseProposalDecodeConfig = <Variant extends string>(
  flags: Readonly<Record<string, string | number | boolean>>,
  defaultVariants: readonly Variant[],
  controlVariant: Variant,
  variantFlagName: string,
  unknownVariantLabel: string,
  studyId: string,
): ProposalDecodeConfig<Variant> => {
  const configuredVariants = flags[variantFlagName];
  const variantFlag = typeof configuredVariants === 'string' ? configuredVariants.trim() : '';
  const variants =
    variantFlag.length === 0
      ? defaultVariants
      : variantFlag.split(',').map((variant) => variant.trim() as Variant);
  const known = new Set<Variant>(defaultVariants);
  for (const variant of variants) {
    if (!known.has(variant)) throw new Error(`unknown ${unknownVariantLabel} variant: ${variant}`);
  }
  if (!variants.includes(controlVariant)) throw new Error(`${studyId} requires ${controlVariant}`);
  return {
    variants,
    maxProposals: positiveIntegerFlag(flags['max-proposals'], 24, 'max-proposals', studyId),
    maxClusterRepresentatives: positiveIntegerFlag(
      flags['max-cluster-representatives'],
      1,
      'max-cluster-representatives',
      studyId,
    ),
    ...(flags['max-decode-attempts'] === undefined
      ? {}
      : {
          maxDecodeAttempts: positiveIntegerFlag(
            flags['max-decode-attempts'],
            1,
            'max-decode-attempts',
            studyId,
          ),
        }),
    maxViews: positiveIntegerFlag(
      flags['max-views'],
      listDefaultBinaryViewIds().length,
      'max-views',
      studyId,
    ),
  };
};

const runVariant = async <Variant extends string>(
  image: Parameters<typeof scanFrame>[0],
  label: 'qr-pos' | 'qr-neg',
  expectedTexts: readonly string[],
  variant: Variant,
  config: ProposalDecodeConfig<Variant>,
  variantOptions: Partial<ScanRuntimeOptions>,
): Promise<ProposalDecodeVariantResult<Variant>> => {
  const trace = createTraceCollector();
  const spans: ScanTimingSpan[] = [];
  const startedAt = performance.now();
  const results = (await scanFrame(image, {
    allowMultiple: false,
    maxProposals: config.maxProposals,
    maxClusterRepresentatives: config.maxClusterRepresentatives,
    ...(config.maxDecodeAttempts === undefined
      ? {}
      : { maxDecodeAttempts: config.maxDecodeAttempts }),
    maxClusterStructuralFailures: 10_000,
    continueAfterDecode: false,
    proposalViewIds: listDefaultBinaryViewIds().slice(0, config.maxViews),
    proposalDetectorPolicy: { enabledFamilies: ['row-scan', 'matcher'] },
    ...variantOptions,
    traceSink: trace,
    metricsSink: { record: (span) => spans.push(span) },
  })) as readonly ScanResult[];
  const decodedTexts = uniqueTexts(
    results.map((result: ScanResult) => normalizeDecodedText(result.payload.text)).filter(Boolean),
  );
  const matchedTexts = decodedTexts.filter((text) => expectedTexts.includes(text));
  const falsePositiveTexts = label === 'qr-neg' ? decodedTexts : [];
  return {
    variantId: variant,
    decodedTexts,
    matchedTexts,
    falsePositiveTexts,
    success: label === 'qr-neg' ? decodedTexts.length === 0 : matchedTexts.length > 0,
    scanDurationMs: round(performance.now() - startedAt),
    ...summarizeTrace(trace.events, spans),
  };
};

const summarizeTrace = (
  events: readonly IronqrTraceEvent[],
  spans: readonly ScanTimingSpan[],
): Omit<
  ProposalDecodeVariantResult<string>,
  | 'variantId'
  | 'decodedTexts'
  | 'matchedTexts'
  | 'falsePositiveTexts'
  | 'success'
  | 'scanDurationMs'
> => {
  const proposalViews = events.filter((event) => event.type === 'proposal-view-generated');
  const scanFinished = [...events].reverse().find((event) => event.type === 'scan-finished');
  return {
    proposalCount:
      scanFinished?.proposalCount ?? sumBy(proposalViews, (event) => event.proposalCount),
    clusterCount: scanFinished?.clusterCount ?? 0,
    processedRepresentativeCount: scanFinished?.processedRepresentativeCount ?? 0,
    decodeAttemptCount: events.filter((event) => event.type === 'decode-attempt-started').length,
    decodeSuccessCount: events.filter((event) => event.type === 'decode-attempt-succeeded').length,
    timings: {
      proposalViewMs: spanSum(spans, 'proposal-view'),
      rankingMs: spanSum(spans, 'ranking'),
      clusteringMs: spanSum(spans, 'clustering'),
      structureMs: spanSum(spans, 'structure'),
      geometryMs: spanSum(spans, 'geometry'),
      moduleSamplingMs: spanSum(spans, 'module-sampling'),
      decodeAttemptMs: spanSum(spans, 'decode-attempt'),
      decodeCascadeMs: spanSum(spans, 'decode-cascade'),
    },
  };
};

const summarize = <Variant extends string>(
  {
    config,
    results,
    cache,
  }: StudySummaryInput<ProposalDecodeConfig<Variant>, ProposalDecodeAssetResult<Variant>>,
  controlVariant: Variant,
  recommendation: readonly string[],
): ProposalDecodeSummary<Variant> => {
  const controlSuccessAssetIds = successfulPositiveAssetIds(controlVariant, results);
  const control = summarizeVariant(controlVariant, results, controlSuccessAssetIds);
  const variantSummaries = config.variants.map((variant) =>
    summarizeVariant(variant, results, controlSuccessAssetIds),
  );
  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    cache,
    variants: variantSummaries,
    comparisons: variantSummaries
      .filter((variant) => variant.variantId !== controlVariant)
      .map((variant) => compareVariant(variant, control)),
    recommendation,
  };
};

const summarizeVariant = <Variant extends string>(
  variantId: Variant,
  results: readonly ProposalDecodeAssetResult<Variant>[],
  controlSuccessAssetIds: ReadonlySet<string>,
): ProposalDecodeVariantSummary<Variant> => {
  const rows = results
    .map((result) => ({
      asset: result,
      row: result.variants.find((variant) => variant.variantId === variantId),
    }))
    .filter(
      (
        entry,
      ): entry is {
        asset: ProposalDecodeAssetResult<Variant>;
        row: ProposalDecodeVariantResult<Variant>;
      } => entry.row !== undefined,
    );
  const positiveRows = rows.filter(({ asset }) => asset.label === 'qr-pos');
  const successAssetIds = new Set(
    positiveRows.filter(({ row }) => row.matchedTexts.length > 0).map(({ asset }) => asset.assetId),
  );
  const falsePositiveAssetIds = rows
    .filter(({ asset, row }) => asset.label === 'qr-neg' && row.falsePositiveTexts.length > 0)
    .map(({ asset }) => asset.assetId);
  const timings = rows.reduce((total, { row }) => addTimings(total, row.timings), emptyTimings());
  return {
    variantId,
    assetCount: rows.length,
    positiveDecodedAssetCount: successAssetIds.size,
    falsePositiveAssetCount: falsePositiveAssetIds.length,
    successAssetCount: rows.filter(({ row }) => row.success).length,
    proposalCount: sumBy(rows, ({ row }) => row.proposalCount),
    clusterCount: sumBy(rows, ({ row }) => row.clusterCount),
    processedRepresentativeCount: sumBy(rows, ({ row }) => row.processedRepresentativeCount),
    decodeAttemptCount: sumBy(rows, ({ row }) => row.decodeAttemptCount),
    decodeSuccessCount: sumBy(rows, ({ row }) => row.decodeSuccessCount),
    scanDurationMs: round(sumBy(rows, ({ row }) => row.scanDurationMs)),
    avgScanDurationMs: average(rows.map(({ row }) => row.scanDurationMs)),
    lostPositiveAssetIds: [...controlSuccessAssetIds].filter(
      (assetId) => !successAssetIds.has(assetId),
    ),
    gainedPositiveAssetIds: [...successAssetIds].filter(
      (assetId) => !controlSuccessAssetIds.has(assetId),
    ),
    falsePositiveAssetIds,
    ...timings,
  };
};

const successfulPositiveAssetIds = <Variant extends string>(
  variantId: Variant,
  results: readonly ProposalDecodeAssetResult<Variant>[],
): ReadonlySet<string> =>
  new Set(
    results
      .filter((result) => result.label === 'qr-pos')
      .filter(
        (result) =>
          (result.variants.find((variant) => variant.variantId === variantId)?.matchedTexts
            .length ?? 0) > 0,
      )
      .map((result) => result.assetId),
  );

const compareVariant = <Variant extends string>(
  variant: ProposalDecodeVariantSummary<Variant>,
  control: ProposalDecodeVariantSummary<Variant>,
): ProposalDecodeComparison<Variant> => ({
  variantId: variant.variantId,
  comparedTo: control.variantId,
  positiveDelta: variant.positiveDecodedAssetCount - control.positiveDecodedAssetCount,
  falsePositiveDelta: variant.falsePositiveAssetCount - control.falsePositiveAssetCount,
  proposalDelta: variant.proposalCount - control.proposalCount,
  decodeAttemptDelta: variant.decodeAttemptCount - control.decodeAttemptCount,
  scanDurationDeltaMs: round(variant.scanDurationMs - control.scanDurationMs),
  lostPositiveAssetIds: variant.lostPositiveAssetIds,
  gainedPositiveAssetIds: variant.gainedPositiveAssetIds,
});

const logVariantMetrics = <Variant extends string>(
  log: (message: string) => void,
  result: ProposalDecodeVariantResult<Variant>,
): void => {
  logStudyTiming(
    log,
    `${result.variantId}:scan`,
    result.scanDurationMs,
    'view',
    result.success ? 1 : 0,
  );
  logStudyTiming(
    log,
    `${result.variantId}:proposals`,
    result.timings.proposalViewMs,
    'view',
    result.proposalCount,
  );
  logStudyTiming(
    log,
    `${result.variantId}:decode-attempts`,
    result.timings.decodeAttemptMs,
    'view',
    result.decodeAttemptCount,
  );
  logStudyTiming(
    log,
    `${result.variantId}:geometry`,
    result.timings.geometryMs,
    'view',
    result.decodeAttemptCount,
  );
  logStudyTiming(
    log,
    `${result.variantId}:module-sampling`,
    result.timings.moduleSamplingMs,
    'view',
    result.decodeAttemptCount,
  );
  logStudyTiming(
    log,
    `${result.variantId}:structure`,
    result.timings.structureMs,
    'view',
    result.clusterCount,
  );
};

const logStudyTiming = (
  log: (message: string) => void,
  id: string,
  durationMs: number,
  group: 'view' | 'detector',
  outputCount: number,
): void => {
  log(`${STUDY_TIMING_PREFIX}${JSON.stringify({ id, durationMs, group, outputCount })}`);
};

const addTimings = (
  left: ProposalDecodeTimingSummary,
  right: ProposalDecodeTimingSummary,
): ProposalDecodeTimingSummary => ({
  proposalViewMs: round(left.proposalViewMs + right.proposalViewMs),
  rankingMs: round(left.rankingMs + right.rankingMs),
  clusteringMs: round(left.clusteringMs + right.clusteringMs),
  structureMs: round(left.structureMs + right.structureMs),
  geometryMs: round(left.geometryMs + right.geometryMs),
  moduleSamplingMs: round(left.moduleSamplingMs + right.moduleSamplingMs),
  decodeAttemptMs: round(left.decodeAttemptMs + right.decodeAttemptMs),
  decodeCascadeMs: round(left.decodeCascadeMs + right.decodeCascadeMs),
});

const emptyTimings = (): ProposalDecodeTimingSummary => ({
  proposalViewMs: 0,
  rankingMs: 0,
  clusteringMs: 0,
  structureMs: 0,
  geometryMs: 0,
  moduleSamplingMs: 0,
  decodeAttemptMs: 0,
  decodeCascadeMs: 0,
});

const spanSum = (spans: readonly ScanTimingSpan[], name: ScanTimingSpan['name']): number =>
  round(
    sumBy(
      spans.filter((span) => span.name === name),
      (span) => span.durationMs,
    ),
  );

const uniqueTexts = uniqueValues;
