import type { ScanTimingSpan } from '../../../../packages/ironqr/src/contracts/scan.js';
import {
  createTraceCollector,
  listDefaultBinaryViewIds,
  scanFrame,
} from '../../../../packages/ironqr/src/index.js';
import type { ProposalGeometryVariant } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import type { IronqrTraceEvent } from '../../../../packages/ironqr/src/pipeline/trace.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const STUDY_VERSION = 'study-v1';
const TIMING_ROWS_PER_VARIANT = 6;

const VARIANTS = [
  'baseline',
  'aspect-reject-conservative',
  'timing-corridor-reject-conservative',
  'aspect-timing-penalty',
] as const satisfies readonly ProposalGeometryVariant[];

interface Config extends Record<string, unknown> {
  readonly variants: readonly ProposalGeometryVariant[];
  readonly maxProposals: number;
  readonly maxClusterRepresentatives: number;
  readonly maxDecodeAttempts: number;
  readonly maxViews: number;
}

interface AssetResult {
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly expectedTexts: readonly string[];
  readonly variants: readonly VariantResult[];
}

interface VariantResult {
  readonly variantId: ProposalGeometryVariant;
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
  readonly timings: TimingSummary;
}

interface TimingSummary {
  readonly proposalViewMs: number;
  readonly rankingMs: number;
  readonly clusteringMs: number;
  readonly structureMs: number;
  readonly geometryMs: number;
  readonly moduleSamplingMs: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

interface VariantSummary extends TimingSummary {
  readonly variantId: ProposalGeometryVariant;
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

interface Comparison {
  readonly variantId: ProposalGeometryVariant;
  readonly comparedTo: ProposalGeometryVariant;
  readonly positiveDelta: number;
  readonly falsePositiveDelta: number;
  readonly proposalDelta: number;
  readonly decodeAttemptDelta: number;
  readonly scanDurationDeltaMs: number;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
}

interface Summary extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly cache: StudySummaryInput<Config, AssetResult>['cache'];
  readonly variants: readonly VariantSummary[];
  readonly comparisons: readonly Comparison[];
  readonly recommendation: readonly string[];
}

const parseConfig = ({
  flags,
}: {
  readonly flags: Readonly<Record<string, string | number | boolean>>;
}): Config => {
  const variantFlag = typeof flags.variants === 'string' ? flags.variants.trim() : '';
  const variants =
    variantFlag.length === 0
      ? VARIANTS
      : variantFlag.split(',').map((id) => id.trim() as ProposalGeometryVariant);
  const known = new Set<ProposalGeometryVariant>(VARIANTS);
  for (const variant of variants)
    if (!known.has(variant)) throw new Error(`unknown geometry decode variant: ${variant}`);
  if (!variants.includes('baseline'))
    throw new Error('proposal-geometry-decode-confirmation requires baseline');
  return {
    variants,
    maxProposals: numericFlag(flags['max-proposals'], 24, 'max-proposals'),
    maxClusterRepresentatives: numericFlag(
      flags['max-cluster-representatives'],
      1,
      'max-cluster-representatives',
    ),
    maxDecodeAttempts: numericFlag(flags['max-decode-attempts'], 200, 'max-decode-attempts'),
    maxViews: numericFlag(flags['max-views'], listDefaultBinaryViewIds().length, 'max-views'),
  };
};

export const proposalGeometryDecodeConfirmationStudyPlugin: StudyPlugin<
  Summary,
  Config,
  AssetResult
> = {
  id: 'proposal-geometry-decode-confirmation',
  title: 'IronQR proposal geometry decode confirmation study',
  description: 'Confirms semantic proposal geometry filters against decode outcomes and costs.',
  version: STUDY_VERSION,
  flags: [
    { name: 'max-assets', type: 'number', description: 'Limit approved corpus assets.' },
    {
      name: 'variants',
      type: 'string',
      description: `Comma-separated variants. Defaults to ${VARIANTS.join(',')}.`,
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
      description: 'Maximum decode attempts per scan.',
    },
    { name: 'max-views', type: 'number', description: 'Maximum binary views per asset.' },
  ],
  parseConfig,
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
    const variants: VariantResult[] = [];
    for (const variant of config.variants) {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      const result = await runVariant(image, asset.label, expectedTexts, variant, config);
      variants.push(result);
      logVariantMetrics(log, result);
      log(
        `${asset.id}: ${variant} success=${result.success} proposals=${result.proposalCount} attempts=${result.decodeAttemptCount}`,
      );
    }
    return { assetId: asset.id, label: asset.label, expectedTexts, variants };
  },
  summarize: (input) => summarize(input),
  renderReport: ({ config, results, summary }) => ({ config, summary, sampledAssets: results }),
};

const runVariant = async (
  image: Parameters<typeof scanFrame>[0],
  label: 'qr-pos' | 'qr-neg',
  expectedTexts: readonly string[],
  variant: ProposalGeometryVariant,
  config: Config,
): Promise<VariantResult> => {
  const trace = createTraceCollector();
  const spans: ScanTimingSpan[] = [];
  const startedAt = performance.now();
  const results = await scanFrame(image, {
    allowMultiple: false,
    maxProposals: config.maxProposals,
    maxClusterRepresentatives: config.maxClusterRepresentatives,
    maxDecodeAttempts: config.maxDecodeAttempts,
    maxClusterStructuralFailures: 10_000,
    continueAfterDecode: false,
    proposalViewIds: listDefaultBinaryViewIds().slice(0, config.maxViews),
    proposalDetectorPolicy: { enabledFamilies: ['row-scan', 'matcher'] },
    proposalGeometryVariant: variant,
    traceSink: trace,
    metricsSink: { record: (span) => spans.push(span) },
  });
  const decodedTexts = uniqueTexts(
    results.map((result) => normalizeDecodedText(result.payload.text)).filter(Boolean),
  );
  const matchedTexts = decodedTexts.filter((text) => expectedTexts.includes(text));
  const falsePositiveTexts = label === 'qr-neg' ? decodedTexts : [];
  const traceSummary = summarizeTrace(trace.events, spans);
  return {
    variantId: variant,
    decodedTexts,
    matchedTexts,
    falsePositiveTexts,
    success: label === 'qr-neg' ? decodedTexts.length === 0 : matchedTexts.length > 0,
    scanDurationMs: round(performance.now() - startedAt),
    ...traceSummary,
  };
};

const summarizeTrace = (
  events: readonly IronqrTraceEvent[],
  spans: readonly ScanTimingSpan[],
): Omit<
  VariantResult,
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
      scanFinished?.proposalCount ?? sum(proposalViews, (event) => event.proposalCount),
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

const summarize = ({ config, results, cache }: StudySummaryInput<Config, AssetResult>): Summary => {
  const controlSuccessAssetIds = successfulPositiveAssetIds('baseline', results);
  const control = summarizeVariant('baseline', results, controlSuccessAssetIds);
  const variants = config.variants.map((variant) =>
    summarizeVariant(variant, results, controlSuccessAssetIds),
  );
  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    cache,
    variants,
    comparisons: variants
      .filter((variant) => variant.variantId !== 'baseline')
      .map((variant) => compareVariant(variant, control)),
    recommendation: [
      'Promote only variants with zero positive decode loss and no false-positive increase relative to baseline.',
      'Use proposal/decode attempt deltas to decide whether semantic filtering reduces downstream work.',
    ],
  };
};

const summarizeVariant = (
  variantId: ProposalGeometryVariant,
  results: readonly AssetResult[],
  controlSuccessAssetIds: ReadonlySet<string>,
): VariantSummary => {
  const rows = results
    .map((result) => ({
      asset: result,
      row: result.variants.find((variant) => variant.variantId === variantId),
    }))
    .filter(
      (entry): entry is { asset: AssetResult; row: VariantResult } => entry.row !== undefined,
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
    proposalCount: sum(rows, ({ row }) => row.proposalCount),
    clusterCount: sum(rows, ({ row }) => row.clusterCount),
    processedRepresentativeCount: sum(rows, ({ row }) => row.processedRepresentativeCount),
    decodeAttemptCount: sum(rows, ({ row }) => row.decodeAttemptCount),
    decodeSuccessCount: sum(rows, ({ row }) => row.decodeSuccessCount),
    scanDurationMs: round(sum(rows, ({ row }) => row.scanDurationMs)),
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

const successfulPositiveAssetIds = (
  variantId: ProposalGeometryVariant,
  results: readonly AssetResult[],
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

const compareVariant = (variant: VariantSummary, control: VariantSummary): Comparison => ({
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

const logVariantMetrics = (log: (message: string) => void, result: VariantResult): void => {
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

const addTimings = (left: TimingSummary, right: TimingSummary): TimingSummary => ({
  proposalViewMs: round(left.proposalViewMs + right.proposalViewMs),
  rankingMs: round(left.rankingMs + right.rankingMs),
  clusteringMs: round(left.clusteringMs + right.clusteringMs),
  structureMs: round(left.structureMs + right.structureMs),
  geometryMs: round(left.geometryMs + right.geometryMs),
  moduleSamplingMs: round(left.moduleSamplingMs + right.moduleSamplingMs),
  decodeAttemptMs: round(left.decodeAttemptMs + right.decodeAttemptMs),
  decodeCascadeMs: round(left.decodeCascadeMs + right.decodeCascadeMs),
});

const emptyTimings = (): TimingSummary => ({
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
    sum(
      spans.filter((span) => span.name === name),
      (span) => span.durationMs,
    ),
  );

const numericFlag = (
  value: string | number | boolean | undefined,
  fallback: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`proposal-geometry-decode-confirmation --${name} must be a positive integer`);
  }
  return value;
};

const uniqueTexts = (texts: readonly string[]): readonly string[] => [...new Set(texts)];
const sum = <T>(items: readonly T[], value: (item: T) => number): number =>
  items.reduce((total, item) => total + value(item), 0);
const average = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : round(values.reduce((total, value) => total + value, 0) / values.length);
const round = (value: number): number => Math.round(value * 100) / 100;
