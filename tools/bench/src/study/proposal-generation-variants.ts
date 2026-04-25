import { listDefaultBinaryViewIds } from '../../../../packages/ironqr/src/index.js';
import { createNormalizedImage } from '../../../../packages/ironqr/src/pipeline/frame.js';
import {
  type FinderEvidenceDetectionPolicy,
  generateProposalBatchForView,
  type ProposalAssemblyVariant,
  type ScanProposal,
} from '../../../../packages/ironqr/src/pipeline/proposals.js';
import { createViewBank } from '../../../../packages/ironqr/src/pipeline/views.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const STUDY_VERSION = 'study-v1';
const TIMING_ROWS_PER_VARIANT = 6;

const VARIANTS = [
  'sort-all',
  'streaming-topk',
] as const satisfies readonly ProposalAssemblyVariant[];

type DetectorPolicyId = 'full-current' | 'no-flood' | 'row-only' | 'matcher-only';

interface ProposalGenerationVariantConfig extends Record<string, unknown> {
  readonly variants: readonly ProposalAssemblyVariant[];
  readonly detectorPolicyId: DetectorPolicyId;
  readonly maxProposals: number;
  readonly maxViews: number;
}

interface VariantAssetResult {
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly variants: readonly VariantResult[];
}

interface VariantResult {
  readonly variantId: ProposalAssemblyVariant;
  readonly proposalCount: number;
  readonly proposalSignatures: readonly string[];
  readonly rowScanFinderCount: number;
  readonly floodFinderCount: number;
  readonly matcherFinderCount: number;
  readonly dedupedFinderCount: number;
  readonly tripleCount: number;
  readonly expensiveDetectorViewCount: number;
  readonly scanDurationMs: number;
  readonly timings: VariantTimingSummary;
}

interface VariantTimingSummary {
  readonly proposalViewMs: number;
  readonly rowScanMs: number;
  readonly floodMs: number;
  readonly matcherMs: number;
  readonly dedupeMs: number;
  readonly tripleAssemblyMs: number;
  readonly proposalConstructionMs: number;
}

interface VariantSummary extends VariantTimingSummary {
  readonly variantId: ProposalAssemblyVariant;
  readonly assetCount: number;
  readonly proposalAssetCount: number;
  readonly positiveProposalAssetCount: number;
  readonly negativeProposalAssetCount: number;
  readonly proposalCount: number;
  readonly rowScanFinderCount: number;
  readonly floodFinderCount: number;
  readonly matcherFinderCount: number;
  readonly dedupedFinderCount: number;
  readonly tripleCount: number;
  readonly expensiveDetectorViewCount: number;
  readonly scanDurationMs: number;
  readonly avgScanDurationMs: number;
  readonly mismatchAssetCount: number;
  readonly proposalCountMismatchAssetCount: number;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
}

interface VariantComparison {
  readonly variantId: ProposalAssemblyVariant;
  readonly comparedTo: ProposalAssemblyVariant;
  readonly proposalAssetDelta: number;
  readonly positiveProposalAssetDelta: number;
  readonly negativeProposalAssetDelta: number;
  readonly proposalDelta: number;
  readonly scanDurationDeltaMs: number;
  readonly tripleAssemblyDeltaMs: number;
  readonly mismatchAssetCount: number;
  readonly proposalCountMismatchAssetCount: number;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
}

interface ProposalGenerationVariantSummary extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly detectorPolicyId: DetectorPolicyId;
  readonly cache: StudySummaryInput<ProposalGenerationVariantConfig, VariantAssetResult>['cache'];
  readonly variants: readonly VariantSummary[];
  readonly comparisons: readonly VariantComparison[];
  readonly recommendation: readonly string[];
}

const DEFAULT_VARIANTS = VARIANTS;

const detectorPolicy = (id: DetectorPolicyId): FinderEvidenceDetectionPolicy => {
  if (id === 'full-current') return { enabledFamilies: ['row-scan', 'flood', 'matcher'] };
  if (id === 'row-only') return { enabledFamilies: ['row-scan'] };
  if (id === 'matcher-only') return { enabledFamilies: ['matcher'] };
  return { enabledFamilies: ['row-scan', 'matcher'] };
};

const parseConfig = ({
  flags,
}: {
  readonly flags: Readonly<Record<string, string | number | boolean>>;
}): ProposalGenerationVariantConfig => {
  const variantFlag = typeof flags.variants === 'string' ? flags.variants.trim() : '';
  const variants =
    variantFlag.length === 0
      ? DEFAULT_VARIANTS
      : variantFlag.split(',').map((id) => id.trim() as ProposalAssemblyVariant);
  const knownVariants = new Set<ProposalAssemblyVariant>(VARIANTS);
  for (const variant of variants)
    if (!knownVariants.has(variant)) throw new Error(`unknown proposal variant: ${variant}`);
  if (!variants.includes('sort-all')) {
    throw new Error('proposal-generation-variants requires sort-all as the control variant');
  }

  const detectorPolicyId =
    typeof flags['detector-policy'] === 'string'
      ? (flags['detector-policy'].trim() as DetectorPolicyId)
      : 'no-flood';
  if (!['full-current', 'no-flood', 'row-only', 'matcher-only'].includes(detectorPolicyId)) {
    throw new Error(`unknown detector policy: ${detectorPolicyId}`);
  }

  return {
    variants,
    detectorPolicyId,
    maxProposals: numericFlag(flags['max-proposals'], 24, 'max-proposals'),
    maxViews: numericFlag(flags['max-views'], listDefaultBinaryViewIds().length, 'max-views'),
  };
};

export const proposalGenerationVariantsStudyPlugin: StudyPlugin<
  ProposalGenerationVariantSummary,
  ProposalGenerationVariantConfig,
  VariantAssetResult
> = {
  id: 'proposal-generation-variants',
  title: 'IronQR proposal generation variant study',
  description: 'Compares proposal triple-assembly implementations after detector policy selection.',
  version: STUDY_VERSION,
  flags: [
    { name: 'max-assets', type: 'number', description: 'Limit approved corpus assets.' },
    {
      name: 'variants',
      type: 'string',
      description: `Comma-separated variants. Defaults to ${DEFAULT_VARIANTS.join(',')}.`,
    },
    {
      name: 'detector-policy',
      type: 'string',
      description: 'Detector policy feeding proposal assembly. Defaults to no-flood.',
    },
    { name: 'max-proposals', type: 'number', description: 'Maximum proposals per view.' },
    { name: 'max-views', type: 'number', description: 'Maximum binary views per asset.' },
  ],
  parseConfig,
  cacheKey: (config) =>
    JSON.stringify({
      config,
      engine: describeAccuracyEngine(getAccuracyEngineById('ironqr')),
    }),
  estimateUnits: (config, assets) =>
    assets.length * config.variants.length * TIMING_ROWS_PER_VARIANT,
  runAsset: async ({ asset, config, signal, log }) => {
    const image = await asset.loadImage();
    const variants: VariantResult[] = [];
    for (const variant of config.variants) {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      const result = runVariant(image, config, variant);
      variants.push(result);
      logVariantMetrics(log, result);
      log(
        `${asset.id}: ${variant} proposals=${result.proposalCount} triples=${result.tripleCount}`,
      );
    }
    return { assetId: asset.id, label: asset.label, variants };
  },
  summarize: (input) => summarize(input),
  renderReport: ({ config, results, summary }) => ({ config, summary, sampledAssets: results }),
};

const runVariant = (
  image: Parameters<typeof createNormalizedImage>[0],
  config: ProposalGenerationVariantConfig,
  variant: ProposalAssemblyVariant,
): VariantResult => {
  const startedAt = performance.now();
  const normalized = createNormalizedImage(image);
  const viewBank = createViewBank(normalized);
  const batches = listDefaultBinaryViewIds()
    .slice(0, config.maxViews)
    .map((binaryViewId) =>
      generateProposalBatchForView(viewBank, binaryViewId, {
        maxProposalsPerView: config.maxProposals,
        detectorPolicy: detectorPolicy(config.detectorPolicyId),
        assemblyVariant: variant,
      }),
    );
  const scanDurationMs = round(performance.now() - startedAt);
  const summaries = batches.map((batch) => batch.summary);
  const proposals = batches.flatMap((batch) => batch.proposals);
  const timings = summaries.reduce(
    (total, summary) =>
      addTimings(total, {
        proposalViewMs: summary.durationMs,
        rowScanMs: summary.finderEvidence.rowScanDurationMs,
        floodMs: summary.finderEvidence.floodDurationMs,
        matcherMs: summary.finderEvidence.matcherDurationMs,
        dedupeMs: summary.finderEvidence.dedupeDurationMs,
        tripleAssemblyMs: summary.tripleAssemblyDurationMs,
        proposalConstructionMs: summary.proposalConstructionDurationMs,
      }),
    emptyTimings(),
  );
  return {
    variantId: variant,
    proposalCount: proposals.length,
    proposalSignatures: proposals.map(proposalSignature).sort(),
    rowScanFinderCount: sum(summaries, (summary) => summary.finderEvidence.rowScanCount),
    floodFinderCount: sum(summaries, (summary) => summary.finderEvidence.floodCount),
    matcherFinderCount: sum(summaries, (summary) => summary.finderEvidence.matcherCount),
    dedupedFinderCount: sum(summaries, (summary) => summary.finderEvidence.dedupedCount),
    tripleCount: sum(summaries, (summary) => summary.tripleCount),
    expensiveDetectorViewCount: summaries.filter(
      (summary) => summary.finderEvidence.expensiveDetectorsRan,
    ).length,
    scanDurationMs,
    timings,
  };
};

const summarize = ({
  config,
  results,
  cache,
}: StudySummaryInput<
  ProposalGenerationVariantConfig,
  VariantAssetResult
>): ProposalGenerationVariantSummary => {
  const control = summarizeVariant('sort-all', results, results);
  const variants = config.variants.map((variant) => summarizeVariant(variant, results, results));
  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    detectorPolicyId: config.detectorPolicyId,
    cache,
    variants,
    comparisons: variants
      .filter((variant) => variant.variantId !== 'sort-all')
      .map((variant) => compareVariant(variant, control)),
    recommendation: [
      'Promote only exact-output variants. This study intentionally excludes early exits, evidence caps, and proposal-budget changes.',
      'Use tripleAssemblyMs for the isolated assembly optimization; scanDurationMs includes detector and view materialization costs.',
    ],
  };
};

const summarizeVariant = (
  variantId: ProposalAssemblyVariant,
  results: readonly VariantAssetResult[],
  controlResults: readonly VariantAssetResult[],
): VariantSummary => {
  const rows = results
    .map((result) => ({
      asset: result,
      row: result.variants.find((variant) => variant.variantId === variantId),
    }))
    .filter(
      (entry): entry is { asset: VariantAssetResult; row: VariantResult } =>
        entry.row !== undefined,
    );
  const controlByAsset = new Map(
    controlResults.map((result) => [
      result.assetId,
      result.variants.find((variant) => variant.variantId === 'sort-all'),
    ]),
  );
  const mismatchAssets = rows.filter(({ asset, row }) => {
    const control = controlByAsset.get(asset.assetId);
    return (
      control !== undefined && !sameStrings(row.proposalSignatures, control.proposalSignatures)
    );
  });
  const countMismatchAssets = rows.filter(({ asset, row }) => {
    const control = controlByAsset.get(asset.assetId);
    return control !== undefined && row.proposalCount !== control.proposalCount;
  });
  const controlPositiveAssets = new Set(
    controlResults
      .filter((result) => result.label === 'qr-pos')
      .filter((result) => (controlByAsset.get(result.assetId)?.proposalCount ?? 0) > 0)
      .map((result) => result.assetId),
  );
  const positiveAssets = new Set(
    rows
      .filter(({ asset, row }) => asset.label === 'qr-pos' && row.proposalCount > 0)
      .map(({ asset }) => asset.assetId),
  );
  const timings = rows.reduce((total, { row }) => addTimings(total, row.timings), emptyTimings());
  return {
    variantId,
    assetCount: rows.length,
    proposalAssetCount: rows.filter(({ row }) => row.proposalCount > 0).length,
    positiveProposalAssetCount: rows.filter(
      ({ asset, row }) => asset.label === 'qr-pos' && row.proposalCount > 0,
    ).length,
    negativeProposalAssetCount: rows.filter(
      ({ asset, row }) => asset.label === 'qr-neg' && row.proposalCount > 0,
    ).length,
    proposalCount: sum(rows, ({ row }) => row.proposalCount),
    rowScanFinderCount: sum(rows, ({ row }) => row.rowScanFinderCount),
    floodFinderCount: sum(rows, ({ row }) => row.floodFinderCount),
    matcherFinderCount: sum(rows, ({ row }) => row.matcherFinderCount),
    dedupedFinderCount: sum(rows, ({ row }) => row.dedupedFinderCount),
    tripleCount: sum(rows, ({ row }) => row.tripleCount),
    expensiveDetectorViewCount: sum(rows, ({ row }) => row.expensiveDetectorViewCount),
    scanDurationMs: round(sum(rows, ({ row }) => row.scanDurationMs)),
    avgScanDurationMs: average(rows.map(({ row }) => row.scanDurationMs)),
    mismatchAssetCount: mismatchAssets.length,
    proposalCountMismatchAssetCount: countMismatchAssets.length,
    lostPositiveAssetIds: [...controlPositiveAssets].filter(
      (assetId) => !positiveAssets.has(assetId),
    ),
    gainedPositiveAssetIds: [...positiveAssets].filter(
      (assetId) => !controlPositiveAssets.has(assetId),
    ),
    ...timings,
  };
};

const compareVariant = (variant: VariantSummary, control: VariantSummary): VariantComparison => ({
  variantId: variant.variantId,
  comparedTo: control.variantId,
  proposalAssetDelta: variant.proposalAssetCount - control.proposalAssetCount,
  positiveProposalAssetDelta:
    variant.positiveProposalAssetCount - control.positiveProposalAssetCount,
  negativeProposalAssetDelta:
    variant.negativeProposalAssetCount - control.negativeProposalAssetCount,
  proposalDelta: variant.proposalCount - control.proposalCount,
  scanDurationDeltaMs: round(variant.scanDurationMs - control.scanDurationMs),
  tripleAssemblyDeltaMs: round(variant.tripleAssemblyMs - control.tripleAssemblyMs),
  mismatchAssetCount: variant.mismatchAssetCount,
  proposalCountMismatchAssetCount: variant.proposalCountMismatchAssetCount,
  lostPositiveAssetIds: variant.lostPositiveAssetIds,
  gainedPositiveAssetIds: variant.gainedPositiveAssetIds,
});

const proposalSignature = (proposal: ScanProposal): string => {
  if (proposal.kind === 'quad')
    return `q:${proposal.binaryViewId}:${proposal.estimatedVersions.join('.')}`;
  return `t:${proposal.binaryViewId}:${proposal.finders.map(finderSignature).sort().join('|')}:${proposal.estimatedVersions.join('.')}`;
};

const finderSignature = (finder: {
  readonly centerX: number;
  readonly centerY: number;
  readonly moduleSize: number;
  readonly source: string;
}): string =>
  `${finder.source}:${round1(finder.centerX)},${round1(finder.centerY)},${round1(finder.moduleSize)}`;

const logVariantMetrics = (log: (message: string) => void, result: VariantResult): void => {
  logStudyTiming(
    log,
    `${result.variantId}:scan`,
    result.scanDurationMs,
    'view',
    result.proposalCount,
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
    `${result.variantId}:triples`,
    result.timings.tripleAssemblyMs,
    'view',
    result.tripleCount,
  );
  logStudyTiming(
    log,
    `${result.variantId}:row-scan`,
    result.timings.rowScanMs,
    'detector',
    result.rowScanFinderCount,
  );
  logStudyTiming(
    log,
    `${result.variantId}:matcher`,
    result.timings.matcherMs,
    'detector',
    result.matcherFinderCount,
  );
  logStudyTiming(
    log,
    `${result.variantId}:dedupe`,
    result.timings.dedupeMs,
    'detector',
    result.dedupedFinderCount,
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
  left: VariantTimingSummary,
  right: VariantTimingSummary,
): VariantTimingSummary => ({
  proposalViewMs: round(left.proposalViewMs + right.proposalViewMs),
  rowScanMs: round(left.rowScanMs + right.rowScanMs),
  floodMs: round(left.floodMs + right.floodMs),
  matcherMs: round(left.matcherMs + right.matcherMs),
  dedupeMs: round(left.dedupeMs + right.dedupeMs),
  tripleAssemblyMs: round(left.tripleAssemblyMs + right.tripleAssemblyMs),
  proposalConstructionMs: round(left.proposalConstructionMs + right.proposalConstructionMs),
});

const emptyTimings = (): VariantTimingSummary => ({
  proposalViewMs: 0,
  rowScanMs: 0,
  floodMs: 0,
  matcherMs: 0,
  dedupeMs: 0,
  tripleAssemblyMs: 0,
  proposalConstructionMs: 0,
});

const numericFlag = (
  value: string | number | boolean | undefined,
  fallback: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`proposal-generation-variants --${name} must be a positive integer`);
  }
  return value;
};

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sum = <T>(items: readonly T[], value: (item: T) => number): number =>
  items.reduce((total, item) => total + value(item), 0);

const average = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : round(values.reduce((total, value) => total + value, 0) / values.length);

const round = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;
