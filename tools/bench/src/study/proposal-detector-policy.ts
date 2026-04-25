import { listDefaultBinaryViewIds } from '../../../../packages/ironqr/src/index.js';
import { createNormalizedImage } from '../../../../packages/ironqr/src/pipeline/frame.js';
import {
  type FinderEvidenceDetectionPolicy,
  generateProposalBatchForView,
} from '../../../../packages/ironqr/src/pipeline/proposals.js';
import { createViewBank } from '../../../../packages/ironqr/src/pipeline/views.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const STUDY_VERSION = 'study-v1';
const STUDY_TIMING_ROWS_PER_POLICY = 6;

type PolicyId =
  | 'full-current'
  | 'no-flood'
  | 'row-only'
  | 'row-plus-flood'
  | 'matcher-only'
  | 'matcher-no-row-overlap'
  | 'row-first-fallback-on-no-proposals';

interface ProposalDetectorPolicyConfig extends Record<string, unknown> {
  readonly viewSet: 'all';
  readonly policies: readonly PolicyId[];
  readonly maxProposals: number;
  readonly maxClusterRepresentatives: number;
  readonly maxDecodeAttempts: number;
  readonly maxViews: number;
}

interface PolicyDefinition {
  readonly id: PolicyId;
  readonly title: string;
  readonly detectorPolicy: FinderEvidenceDetectionPolicy;
  readonly fallback?: 'row-first-no-proposals';
}

interface ProposalDetectorPolicyAssetResult {
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly expectedTexts: readonly string[];
  readonly policies: readonly PolicyAssetResult[];
}

interface PolicyAssetResult {
  readonly policyId: PolicyId;
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly falsePositiveTexts: readonly string[];
  readonly success: boolean;
  readonly usedFallback: boolean;
  readonly scanDurationMs: number;
  readonly proposalCount: number;
  readonly boundedProposalCount: number;
  readonly rankedProposalCount: number;
  readonly clusterCount: number;
  readonly representativeCount: number;
  readonly processedRepresentativeCount: number;
  readonly killedClusterCount: number;
  readonly firstDecodedClusterRank: number | null;
  readonly decodedClusterRanks: readonly number[];
  readonly decodeAttemptCount: number;
  readonly decodeSuccessCount: number;
  readonly rowScanFinderCount: number;
  readonly floodFinderCount: number;
  readonly matcherFinderCount: number;
  readonly dedupedFinderCount: number;
  readonly expensiveDetectorViewCount: number;
  readonly timings: PolicyTimingSummary;
}

interface PolicyTimingSummary {
  readonly normalizeMs: number;
  readonly scalarViewMs: number;
  readonly binaryPlaneMs: number;
  readonly binaryViewMs: number;
  readonly proposalViewMs: number;
  readonly rowScanMs: number;
  readonly floodMs: number;
  readonly matcherMs: number;
  readonly dedupeMs: number;
  readonly tripleAssemblyMs: number;
  readonly proposalConstructionMs: number;
  readonly rankingMs: number;
  readonly clusteringMs: number;
  readonly structureMs: number;
  readonly geometryMs: number;
  readonly moduleSamplingMs: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

interface ProposalDetectorPolicySummary extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly cache: StudySummaryInput<
    ProposalDetectorPolicyConfig,
    ProposalDetectorPolicyAssetResult
  >['cache'];
  readonly policies: readonly PolicySummary[];
  readonly comparisons: readonly PolicyComparison[];
  readonly recommendation: readonly string[];
}

interface PolicySummary extends PolicyTimingSummary {
  readonly policyId: PolicyId;
  readonly title: string;
  readonly assetCount: number;
  readonly positiveDecodedAssetCount: number;
  readonly falsePositiveAssetCount: number;
  readonly successAssetCount: number;
  readonly usedFallbackAssetCount: number;
  readonly proposalCount: number;
  readonly boundedProposalCount: number;
  readonly rankedProposalCount: number;
  readonly clusterCount: number;
  readonly representativeCount: number;
  readonly processedRepresentativeCount: number;
  readonly killedClusterCount: number;
  readonly decodeAttemptCount: number;
  readonly decodeSuccessCount: number;
  readonly rowScanFinderCount: number;
  readonly floodFinderCount: number;
  readonly matcherFinderCount: number;
  readonly dedupedFinderCount: number;
  readonly expensiveDetectorViewCount: number;
  readonly scanDurationMs: number;
  readonly avgScanDurationMs: number;
  readonly avgProposalGenerationMs: number;
  readonly avgDecodeAttemptCount: number;
  readonly firstDecodedClusterRankP50: number | null;
  readonly firstDecodedClusterRankP90: number | null;
  readonly firstDecodedClusterRankP95: number | null;
  readonly firstDecodedClusterRankMax: number | null;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
  readonly falsePositiveAssetIds: readonly string[];
}

interface PolicyComparison {
  readonly policyId: PolicyId;
  readonly comparedTo: PolicyId;
  readonly positiveDelta: number;
  readonly falsePositiveDelta: number;
  readonly proposalDelta: number;
  readonly decodeAttemptDelta: number;
  readonly scanDurationDeltaMs: number;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
}

const POLICY_DEFINITIONS: readonly PolicyDefinition[] = [
  {
    id: 'full-current',
    title: 'row-scan + flood + matcher + dedupe control',
    detectorPolicy: { enabledFamilies: ['row-scan', 'flood', 'matcher'] },
  },
  {
    id: 'no-flood',
    title: 'row-scan + matcher without flood',
    detectorPolicy: { enabledFamilies: ['row-scan', 'matcher'] },
  },
  {
    id: 'row-only',
    title: 'row-scan only',
    detectorPolicy: { enabledFamilies: ['row-scan'] },
  },
  {
    id: 'row-plus-flood',
    title: 'row-scan + flood without matcher',
    detectorPolicy: { enabledFamilies: ['row-scan', 'flood'] },
  },
  {
    id: 'matcher-only',
    title: 'matcher only',
    detectorPolicy: { enabledFamilies: ['matcher'] },
  },
  {
    id: 'matcher-no-row-overlap',
    title: 'row-scan + matcher with row-overlap matcher suppression',
    detectorPolicy: {
      enabledFamilies: ['row-scan', 'matcher'],
      suppressMatcherOverlappingRowScan: true,
    },
  },
  {
    id: 'row-first-fallback-on-no-proposals',
    title: 'row-scan first, run no-flood rescue only when row-scan emits no proposals',
    detectorPolicy: { enabledFamilies: ['row-scan'] },
    fallback: 'row-first-no-proposals',
  },
];

const DEFAULT_POLICY_IDS: readonly PolicyId[] = [
  'no-flood',
  'row-only',
  'matcher-only',
  'matcher-no-row-overlap',
  'row-first-fallback-on-no-proposals',
];
const ALL_POLICY_IDS = POLICY_DEFINITIONS.map((policy) => policy.id);

const parseConfig = ({
  flags,
}: {
  readonly flags: Readonly<Record<string, string | number | boolean>>;
}): ProposalDetectorPolicyConfig => {
  const viewSet = flags['view-set'] ?? 'all';
  if (viewSet !== 'all')
    throw new Error(
      `proposal-detector-policy only supports --view-set all, got ${String(viewSet)}`,
    );
  const policyFlag = typeof flags.policies === 'string' ? flags.policies.trim() : '';
  const policies =
    policyFlag.length === 0
      ? DEFAULT_POLICY_IDS
      : policyFlag.split(',').map((id) => id.trim() as PolicyId);
  const known = new Set(ALL_POLICY_IDS);
  for (const policy of policies)
    if (!known.has(policy)) throw new Error(`unknown proposal detector policy: ${policy}`);
  return {
    viewSet: 'all',
    policies,
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

export const proposalDetectorPolicyStudyPlugin: StudyPlugin<
  ProposalDetectorPolicySummary,
  ProposalDetectorPolicyConfig,
  ProposalDetectorPolicyAssetResult
> = {
  id: 'proposal-detector-policy',
  title: 'IronQR proposal detector policy study',
  description: 'Compares detector-family and staged fallback policies by proposal output and cost.',
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
      description: 'Binary view set. Only all is supported.',
      default: 'all',
    },
    {
      name: 'policies',
      type: 'string',
      description: 'Comma-separated policy ids. Defaults to all policy variants.',
    },
    {
      name: 'max-proposals',
      type: 'number',
      description: 'Maximum global proposals/clusters retained. Defaults to production-like 24.',
      default: 24,
    },
    {
      name: 'max-cluster-representatives',
      type: 'number',
      description: 'Maximum representatives tried per cluster. Defaults to production-like 1.',
      default: 1,
    },
    {
      name: 'max-decode-attempts',
      type: 'number',
      description: 'Reserved for the later decode phase; proposal-only runs ignore this flag.',
      default: 200,
    },
    {
      name: 'max-views',
      type: 'number',
      description: 'Maximum binary views to scan. Defaults to all views; intended for smoke tests.',
      default: listDefaultBinaryViewIds().length,
    },
  ],
  parseConfig,
  cacheKey: (config) => JSON.stringify({ version: STUDY_VERSION, ...config }),
  engines: () => [describeAccuracyEngine(getAccuracyEngineById('ironqr'))],
  observability: (config) => ({
    viewSet: config.viewSet,
    policies: config.policies,
    metrics: 'proposal,detector-policy',
  }),
  estimateUnits: (config, assets) =>
    assets.length * config.policies.length * STUDY_TIMING_ROWS_PER_POLICY,
  replayCachedAsset: ({ result, log }) => {
    for (const policy of result.policies) logPolicyMetrics(log, policy.policyId, policy);
  },
  runAsset: async ({ asset, config, signal, log }) => {
    if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
    const image = await asset.loadImage();
    const expectedTexts = uniqueTexts(
      asset.expectedTexts.map(normalizeDecodedText).filter(Boolean),
    );
    const definitions = config.policies.map(policyDefinition);
    const policies: PolicyAssetResult[] = [];
    const rowOnlyDefinition = policyDefinition('row-only');
    const noFloodDefinition = policyDefinition('no-flood');

    for (const definition of definitions) {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      const result =
        definition.fallback === 'row-first-no-proposals'
          ? await runFallbackPolicy(
              image,
              asset.label,
              expectedTexts,
              rowOnlyDefinition,
              noFloodDefinition,
              config,
            )
          : await runSinglePolicy(image, asset.label, expectedTexts, definition, config);
      policies.push(result);
      logPolicyMetrics(log, definition.id, result);
      log(
        `${asset.id}: ${definition.id} success=${result.success} proposals=${result.proposalCount}`,
      );
    }

    return { assetId: asset.id, label: asset.label, expectedTexts, policies };
  },
  summarize: (input) => summarizePolicyResults(input),
  renderReport: ({ config, results, summary }) => ({
    config,
    policies: POLICY_DEFINITIONS.filter((definition) => config.policies.includes(definition.id)),
    summary,
    sampledAssets: results.map((result) => ({
      assetId: result.assetId,
      label: result.label,
      expectedTexts: result.expectedTexts,
      policies: result.policies,
    })),
  }),
};

const numericFlag = (
  value: string | number | boolean | undefined,
  fallback: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`proposal-detector-policy --${name} must be a positive integer`);
  }
  return value;
};

const policyDefinition = (id: PolicyId): PolicyDefinition => {
  const definition = POLICY_DEFINITIONS.find((policy) => policy.id === id);
  if (!definition) throw new Error(`unknown proposal detector policy: ${id}`);
  return definition;
};

const runFallbackPolicy = async (
  image: Parameters<typeof createNormalizedImage>[0],
  label: 'qr-pos' | 'qr-neg',
  expectedTexts: readonly string[],
  rowOnly: PolicyDefinition,
  fallback: PolicyDefinition,
  config: ProposalDetectorPolicyConfig,
): Promise<PolicyAssetResult> => {
  const row = await runSinglePolicy(image, label, expectedTexts, rowOnly, config);
  if (row.proposalCount > 0)
    return { ...row, policyId: 'row-first-fallback-on-no-proposals', usedFallback: false };
  const rescue = await runSinglePolicy(image, label, expectedTexts, fallback, config);
  return combineFallbackResult(row, rescue);
};

const runSinglePolicy = async (
  image: Parameters<typeof createNormalizedImage>[0],
  label: 'qr-pos' | 'qr-neg',
  _expectedTexts: readonly string[],
  definition: PolicyDefinition,
  config: ProposalDetectorPolicyConfig,
): Promise<PolicyAssetResult> => {
  const startedAt = performance.now();
  const normalized = createNormalizedImage(image);
  const viewBank = createViewBank(normalized);
  const batches = listDefaultBinaryViewIds()
    .slice(0, config.maxViews)
    .map((binaryViewId) =>
      generateProposalBatchForView(viewBank, binaryViewId, {
        maxProposalsPerView: config.maxProposals,
        detectorPolicy: definition.detectorPolicy,
      }),
    );
  const scanDurationMs = round(performance.now() - startedAt);
  const summaries = batches.map((batch) => batch.summary);
  const proposalCount = sum(batches, (batch) => batch.proposals.length);
  const timings = summaries.reduce(
    (total, summary) =>
      addTimings(total, {
        ...emptyTimings(),
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
    policyId: definition.id,
    decodedTexts: [],
    matchedTexts: [],
    falsePositiveTexts: [],
    success: label === 'qr-neg' ? proposalCount === 0 : proposalCount > 0,
    usedFallback: false,
    scanDurationMs,
    proposalCount,
    boundedProposalCount: proposalCount,
    rankedProposalCount: proposalCount,
    clusterCount: 0,
    representativeCount: 0,
    processedRepresentativeCount: 0,
    killedClusterCount: 0,
    firstDecodedClusterRank: null,
    decodedClusterRanks: [],
    decodeAttemptCount: 0,
    decodeSuccessCount: 0,
    rowScanFinderCount: sum(summaries, (summary) => summary.finderEvidence.rowScanCount),
    floodFinderCount: sum(summaries, (summary) => summary.finderEvidence.floodCount),
    matcherFinderCount: sum(summaries, (summary) => summary.finderEvidence.matcherCount),
    dedupedFinderCount: sum(summaries, (summary) => summary.finderEvidence.dedupedCount),
    expensiveDetectorViewCount: summaries.filter(
      (summary) => summary.finderEvidence.expensiveDetectorsRan,
    ).length,
    timings,
  };
};

const combineFallbackResult = (
  row: PolicyAssetResult,
  rescue: PolicyAssetResult,
): PolicyAssetResult => ({
  ...rescue,
  policyId: 'row-first-fallback-on-no-proposals',
  usedFallback: true,
  scanDurationMs: round(row.scanDurationMs + rescue.scanDurationMs),
  proposalCount: row.proposalCount + rescue.proposalCount,
  boundedProposalCount: row.boundedProposalCount + rescue.boundedProposalCount,
  rankedProposalCount: row.rankedProposalCount + rescue.rankedProposalCount,
  clusterCount: row.clusterCount + rescue.clusterCount,
  representativeCount: row.representativeCount + rescue.representativeCount,
  processedRepresentativeCount:
    row.processedRepresentativeCount + rescue.processedRepresentativeCount,
  killedClusterCount: row.killedClusterCount + rescue.killedClusterCount,
  decodeAttemptCount: row.decodeAttemptCount + rescue.decodeAttemptCount,
  decodeSuccessCount: row.decodeSuccessCount + rescue.decodeSuccessCount,
  rowScanFinderCount: row.rowScanFinderCount + rescue.rowScanFinderCount,
  floodFinderCount: row.floodFinderCount + rescue.floodFinderCount,
  matcherFinderCount: row.matcherFinderCount + rescue.matcherFinderCount,
  dedupedFinderCount: row.dedupedFinderCount + rescue.dedupedFinderCount,
  expensiveDetectorViewCount: row.expensiveDetectorViewCount + rescue.expensiveDetectorViewCount,
  timings: addTimings(row.timings, rescue.timings),
});

const summarizePolicyResults = ({
  config,
  results,
  cache,
}: StudySummaryInput<
  ProposalDetectorPolicyConfig,
  ProposalDetectorPolicyAssetResult
>): ProposalDetectorPolicySummary => {
  const controlPolicyId: PolicyId = config.policies.includes('full-current')
    ? 'full-current'
    : (config.policies[0] ?? 'no-flood');
  const controlSuccessAssetIds = successfulPositiveAssetIds(controlPolicyId, results);
  const control = summarizeOnePolicy(controlPolicyId, results, controlSuccessAssetIds);
  const policies = config.policies.map((policyId) =>
    summarizeOnePolicy(policyId, results, controlSuccessAssetIds),
  );
  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    cache,
    policies,
    comparisons: policies
      .filter((policy) => policy.policyId !== control.policyId)
      .map((policy) => compareToControl(policy, control)),
    recommendation: [
      'Use full-current as the proposal-generation control. Do not promote no-flood, staged fallback, or matcher overlap suppression unless positive proposal coverage and negative proposal behavior match the control.',
      'Prefer policies that preserve proposal coverage while reducing matcherMs, floodMs, proposalViewMs, and emitted proposal count.',
    ],
  };
};

const summarizeOnePolicy = (
  policyId: PolicyId,
  results: readonly ProposalDetectorPolicyAssetResult[],
  controlSuccessAssetIds: ReadonlySet<string>,
): PolicySummary => {
  const rows = results
    .map((result) => result.policies.find((policy) => policy.policyId === policyId))
    .filter((row): row is PolicyAssetResult => row !== undefined);
  const positiveRows = results
    .filter((result) => result.label === 'qr-pos')
    .map((result) => ({
      assetId: result.assetId,
      row: result.policies.find((policy) => policy.policyId === policyId),
    }))
    .filter(
      (entry): entry is { assetId: string; row: PolicyAssetResult } => entry.row !== undefined,
    );
  const falsePositiveAssetIds = results
    .filter((result) => result.label === 'qr-neg')
    .filter(
      (result) =>
        (result.policies.find((policy) => policy.policyId === policyId)?.proposalCount ?? 0) > 0,
    )
    .map((result) => result.assetId);
  const successAssetIds = new Set(
    positiveRows.filter((entry) => entry.row.proposalCount > 0).map((entry) => entry.assetId),
  );
  const decodedRanks = rows.flatMap((row) =>
    row.firstDecodedClusterRank === null ? [] : [row.firstDecodedClusterRank],
  );
  const timings = rows.reduce((acc, row) => addTimings(acc, row.timings), emptyTimings());
  return {
    policyId,
    title: policyDefinition(policyId).title,
    assetCount: rows.length,
    positiveDecodedAssetCount: successAssetIds.size,
    falsePositiveAssetCount: falsePositiveAssetIds.length,
    successAssetCount: rows.filter((row) => row.success).length,
    usedFallbackAssetCount: rows.filter((row) => row.usedFallback).length,
    proposalCount: sum(rows, (row) => row.proposalCount),
    boundedProposalCount: sum(rows, (row) => row.boundedProposalCount),
    rankedProposalCount: sum(rows, (row) => row.rankedProposalCount),
    clusterCount: sum(rows, (row) => row.clusterCount),
    representativeCount: sum(rows, (row) => row.representativeCount),
    processedRepresentativeCount: sum(rows, (row) => row.processedRepresentativeCount),
    killedClusterCount: sum(rows, (row) => row.killedClusterCount),
    decodeAttemptCount: sum(rows, (row) => row.decodeAttemptCount),
    decodeSuccessCount: sum(rows, (row) => row.decodeSuccessCount),
    rowScanFinderCount: sum(rows, (row) => row.rowScanFinderCount),
    floodFinderCount: sum(rows, (row) => row.floodFinderCount),
    matcherFinderCount: sum(rows, (row) => row.matcherFinderCount),
    dedupedFinderCount: sum(rows, (row) => row.dedupedFinderCount),
    expensiveDetectorViewCount: sum(rows, (row) => row.expensiveDetectorViewCount),
    scanDurationMs: round(sum(rows, (row) => row.scanDurationMs)),
    avgScanDurationMs: average(rows.map((row) => row.scanDurationMs)),
    avgProposalGenerationMs: average(rows.map((row) => row.timings.proposalViewMs)),
    avgDecodeAttemptCount: average(rows.map((row) => row.decodeAttemptCount)),
    firstDecodedClusterRankP50: percentile(decodedRanks, 0.5),
    firstDecodedClusterRankP90: percentile(decodedRanks, 0.9),
    firstDecodedClusterRankP95: percentile(decodedRanks, 0.95),
    firstDecodedClusterRankMax: decodedRanks.length === 0 ? null : Math.max(...decodedRanks),
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
  policyId: PolicyId,
  results: readonly ProposalDetectorPolicyAssetResult[],
): ReadonlySet<string> =>
  new Set(
    results
      .filter((result) => result.label === 'qr-pos')
      .filter(
        (result) =>
          (result.policies.find((policy) => policy.policyId === policyId)?.proposalCount ?? 0) > 0,
      )
      .map((result) => result.assetId),
  );

const compareToControl = (policy: PolicySummary, control: PolicySummary): PolicyComparison => ({
  policyId: policy.policyId,
  comparedTo: control.policyId,
  positiveDelta: policy.positiveDecodedAssetCount - control.positiveDecodedAssetCount,
  falsePositiveDelta: policy.falsePositiveAssetCount - control.falsePositiveAssetCount,
  proposalDelta: policy.proposalCount - control.proposalCount,
  decodeAttemptDelta: policy.decodeAttemptCount - control.decodeAttemptCount,
  scanDurationDeltaMs: round(policy.scanDurationMs - control.scanDurationMs),
  lostPositiveAssetIds: policy.lostPositiveAssetIds,
  gainedPositiveAssetIds: policy.gainedPositiveAssetIds,
});

const logPolicyMetrics = (
  log: (message: string) => void,
  policyId: string,
  result: PolicyAssetResult,
): void => {
  logStudyTiming(log, `${policyId}:scan`, result.scanDurationMs, 'view', result.success ? 1 : 0);
  logStudyTiming(
    log,
    `${policyId}:proposals`,
    result.timings.proposalViewMs,
    'view',
    result.proposalCount,
  );
  logStudyTiming(
    log,
    `${policyId}:row-scan`,
    result.timings.rowScanMs,
    'detector',
    result.rowScanFinderCount,
  );
  logStudyTiming(
    log,
    `${policyId}:flood`,
    result.timings.floodMs,
    'detector',
    result.floodFinderCount,
  );
  logStudyTiming(
    log,
    `${policyId}:matcher`,
    result.timings.matcherMs,
    'detector',
    result.matcherFinderCount,
  );
  logStudyTiming(
    log,
    `${policyId}:dedupe`,
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
  left: PolicyTimingSummary,
  right: PolicyTimingSummary,
): PolicyTimingSummary => ({
  normalizeMs: round(left.normalizeMs + right.normalizeMs),
  scalarViewMs: round(left.scalarViewMs + right.scalarViewMs),
  binaryPlaneMs: round(left.binaryPlaneMs + right.binaryPlaneMs),
  binaryViewMs: round(left.binaryViewMs + right.binaryViewMs),
  proposalViewMs: round(left.proposalViewMs + right.proposalViewMs),
  rowScanMs: round(left.rowScanMs + right.rowScanMs),
  floodMs: round(left.floodMs + right.floodMs),
  matcherMs: round(left.matcherMs + right.matcherMs),
  dedupeMs: round(left.dedupeMs + right.dedupeMs),
  tripleAssemblyMs: round(left.tripleAssemblyMs + right.tripleAssemblyMs),
  proposalConstructionMs: round(left.proposalConstructionMs + right.proposalConstructionMs),
  rankingMs: round(left.rankingMs + right.rankingMs),
  clusteringMs: round(left.clusteringMs + right.clusteringMs),
  structureMs: round(left.structureMs + right.structureMs),
  geometryMs: round(left.geometryMs + right.geometryMs),
  moduleSamplingMs: round(left.moduleSamplingMs + right.moduleSamplingMs),
  decodeAttemptMs: round(left.decodeAttemptMs + right.decodeAttemptMs),
  decodeCascadeMs: round(left.decodeCascadeMs + right.decodeCascadeMs),
});

const emptyTimings = (): PolicyTimingSummary => ({
  normalizeMs: 0,
  scalarViewMs: 0,
  binaryPlaneMs: 0,
  binaryViewMs: 0,
  proposalViewMs: 0,
  rowScanMs: 0,
  floodMs: 0,
  matcherMs: 0,
  dedupeMs: 0,
  tripleAssemblyMs: 0,
  proposalConstructionMs: 0,
  rankingMs: 0,
  clusteringMs: 0,
  structureMs: 0,
  geometryMs: 0,
  moduleSamplingMs: 0,
  decodeAttemptMs: 0,
  decodeCascadeMs: 0,
});

const sum = <T>(items: readonly T[], value: (item: T) => number): number =>
  items.reduce((total, item) => total + value(item), 0);

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length);

const percentile = (values: readonly number[], quantile: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? null;
};

const uniqueTexts = (values: readonly string[]): readonly string[] => Array.from(new Set(values));

const round = (value: number): number => Math.round(value * 100) / 100;
