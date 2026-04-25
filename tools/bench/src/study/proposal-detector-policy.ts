import {
  createTraceCollector,
  listDefaultBinaryViewIds,
  type ScanTimingSpan,
  scanFrame,
} from '../../../../packages/ironqr/src/index.js';
import type { FinderEvidenceDetectionPolicy } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import type { IronqrTraceEvent } from '../../../../packages/ironqr/src/pipeline/trace.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const STUDY_VERSION = 'study-v1';

type PolicyId =
  | 'full-current'
  | 'no-flood'
  | 'row-only'
  | 'row-plus-flood'
  | 'matcher-only'
  | 'matcher-no-row-overlap'
  | 'row-first-fallback-on-no-decode';

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
  readonly fallback?: 'row-first-no-decode';
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
    id: 'row-first-fallback-on-no-decode',
    title: 'row-scan first, run no-flood rescue only when row-scan does not decode',
    detectorPolicy: { enabledFamilies: ['row-scan'] },
    fallback: 'row-first-no-decode',
  },
];

const DEFAULT_POLICY_IDS = POLICY_DEFINITIONS.map((policy) => policy.id);

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
  const known = new Set(DEFAULT_POLICY_IDS);
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
  description:
    'Compares detector-family and staged fallback policies by proposal/decode outcomes and cost.',
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
      description:
        'Maximum decode attempts per policy scan. Defaults to 200 for bounded policy comparisons.',
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
    metrics: 'proposal,cluster,decode,detector-policy',
  }),
  estimateUnits: (config, assets) => assets.length * config.policies.length,
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
        definition.fallback === 'row-first-no-decode'
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
        `${asset.id}: ${definition.id} success=${result.success} proposals=${result.proposalCount} clusters=${result.clusterCount} attempts=${result.decodeAttemptCount}`,
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
  image: Parameters<typeof scanFrame>[0],
  label: 'qr-pos' | 'qr-neg',
  expectedTexts: readonly string[],
  rowOnly: PolicyDefinition,
  fallback: PolicyDefinition,
  config: ProposalDetectorPolicyConfig,
): Promise<PolicyAssetResult> => {
  const row = await runSinglePolicy(image, label, expectedTexts, rowOnly, config);
  if (row.success)
    return { ...row, policyId: 'row-first-fallback-on-no-decode', usedFallback: false };
  const rescue = await runSinglePolicy(image, label, expectedTexts, fallback, config);
  return combineFallbackResult(row, rescue);
};

const runSinglePolicy = async (
  image: Parameters<typeof scanFrame>[0],
  label: 'qr-pos' | 'qr-neg',
  expectedTexts: readonly string[],
  definition: PolicyDefinition,
  config: ProposalDetectorPolicyConfig,
): Promise<PolicyAssetResult> => {
  const trace = createTraceCollector();
  const timingSpans: ScanTimingSpan[] = [];
  const startedAt = performance.now();
  const results = await scanFrame(image, {
    allowMultiple: false,
    maxProposals: config.maxProposals,
    maxClusterRepresentatives: config.maxClusterRepresentatives,
    maxDecodeAttempts: config.maxDecodeAttempts,
    maxClusterStructuralFailures: 10_000,
    continueAfterDecode: false,
    proposalViewIds: listDefaultBinaryViewIds().slice(0, config.maxViews),
    proposalDetectorPolicy: definition.detectorPolicy,
    traceSink: trace,
    metricsSink: { record: (span) => timingSpans.push(span) },
  });
  const scanDurationMs = round(performance.now() - startedAt);
  const decodedTexts = uniqueTexts(
    results.map((result) => normalizeDecodedText(result.payload.text)).filter(Boolean),
  );
  const matchedTexts = decodedTexts.filter((text) => expectedTexts.includes(text));
  const falsePositiveTexts = label === 'qr-neg' ? decodedTexts : [];
  const traceSummary = summarizeTrace(trace.events, timingSpans);
  return {
    policyId: definition.id,
    decodedTexts,
    matchedTexts,
    falsePositiveTexts,
    success: label === 'qr-neg' ? decodedTexts.length === 0 : matchedTexts.length > 0,
    usedFallback: false,
    scanDurationMs,
    ...traceSummary,
  };
};

const combineFallbackResult = (
  row: PolicyAssetResult,
  rescue: PolicyAssetResult,
): PolicyAssetResult => ({
  ...rescue,
  policyId: 'row-first-fallback-on-no-decode',
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

const summarizeTrace = (
  events: readonly IronqrTraceEvent[],
  spans: readonly ScanTimingSpan[],
): Omit<
  PolicyAssetResult,
  | 'policyId'
  | 'decodedTexts'
  | 'matchedTexts'
  | 'falsePositiveTexts'
  | 'success'
  | 'usedFallback'
  | 'scanDurationMs'
> => {
  const proposalViews = events.filter((event) => event.type === 'proposal-view-generated');
  const clustering = [...events]
    .reverse()
    .find((event) => event.type === 'proposal-clusters-built');
  const scanFinished = [...events].reverse().find((event) => event.type === 'scan-finished');
  const decodedClusters = events.filter(
    (event): event is Extract<IronqrTraceEvent, { type: 'cluster-finished' }> =>
      event.type === 'cluster-finished' && event.outcome === 'decoded',
  );
  const decodedClusterRanks = decodedClusters.map((event) => event.clusterRank);
  return {
    proposalCount:
      scanFinished?.proposalCount ?? sum(proposalViews, (event) => event.proposalCount),
    boundedProposalCount:
      scanFinished?.boundedProposalCount ?? clustering?.boundedProposalCount ?? 0,
    rankedProposalCount: clustering?.rankedProposalCount ?? 0,
    clusterCount: scanFinished?.clusterCount ?? clustering?.clusterCount ?? 0,
    representativeCount: scanFinished?.representativeCount ?? clustering?.representativeCount ?? 0,
    processedRepresentativeCount: scanFinished?.processedRepresentativeCount ?? 0,
    killedClusterCount: scanFinished?.killedClusterCount ?? 0,
    firstDecodedClusterRank:
      decodedClusterRanks.length === 0 ? null : Math.min(...decodedClusterRanks),
    decodedClusterRanks,
    decodeAttemptCount: events.filter((event) => event.type === 'decode-attempt-started').length,
    decodeSuccessCount: events.filter((event) => event.type === 'decode-attempt-succeeded').length,
    rowScanFinderCount: sum(proposalViews, (event) => event.rowScanFinderCount),
    floodFinderCount: sum(proposalViews, (event) => event.floodFinderCount),
    matcherFinderCount: sum(proposalViews, (event) => event.matcherFinderCount),
    dedupedFinderCount: sum(proposalViews, (event) => event.dedupedFinderCount),
    expensiveDetectorViewCount: proposalViews.filter((event) => event.expensiveDetectorsRan).length,
    timings: {
      normalizeMs: spanSum(spans, 'normalize'),
      scalarViewMs: spanSum(spans, 'scalar-view'),
      binaryPlaneMs: spanSum(spans, 'binary-plane'),
      binaryViewMs: spanSum(spans, 'binary-view'),
      proposalViewMs: spanSum(spans, 'proposal-view'),
      rowScanMs: round(sum(proposalViews, (event) => event.rowScanDurationMs)),
      floodMs: round(sum(proposalViews, (event) => event.floodDurationMs)),
      matcherMs: round(sum(proposalViews, (event) => event.matcherDurationMs)),
      dedupeMs: round(sum(proposalViews, (event) => event.dedupeDurationMs)),
      tripleAssemblyMs: round(sum(proposalViews, (event) => event.tripleAssemblyDurationMs)),
      proposalConstructionMs: round(
        sum(proposalViews, (event) => event.proposalConstructionDurationMs),
      ),
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

const summarizePolicyResults = ({
  config,
  results,
  cache,
}: StudySummaryInput<
  ProposalDetectorPolicyConfig,
  ProposalDetectorPolicyAssetResult
>): ProposalDetectorPolicySummary => {
  const controlSuccessAssetIds = successfulPositiveAssetIds('full-current', results);
  const control = summarizeOnePolicy('full-current', results, controlSuccessAssetIds);
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
      .filter((policy) => policy.policyId !== 'full-current')
      .map((policy) => compareToControl(policy, control)),
    recommendation: [
      'Use full-current as the control. Do not promote no-flood, staged fallback, or matcher overlap suppression unless positive decodes and false positives match the control.',
      'Prefer policies that preserve decoded payloads while reducing matcherMs, proposalViewMs, processed representatives, and decode attempts.',
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
        (result.policies.find((policy) => policy.policyId === policyId)?.falsePositiveTexts
          .length ?? 0) > 0,
    )
    .map((result) => result.assetId);
  const successAssetIds = new Set(
    positiveRows.filter((entry) => entry.row.matchedTexts.length > 0).map((entry) => entry.assetId),
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
          (result.policies.find((policy) => policy.policyId === policyId)?.matchedTexts.length ??
            0) > 0,
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
  logStudyTiming(log, `${policyId}:scan`, result.scanDurationMs, result.success ? 1 : 0);
  logStudyTiming(log, `${policyId}:proposals`, result.timings.proposalViewMs, result.proposalCount);
  logStudyTiming(
    log,
    `${policyId}:decode-attempts`,
    result.timings.decodeAttemptMs,
    result.decodeAttemptCount,
  );
};

const logStudyTiming = (
  log: (message: string) => void,
  id: string,
  durationMs: number,
  outputCount: number,
): void => {
  log(`${STUDY_TIMING_PREFIX}${JSON.stringify({ id, durationMs, group: 'view', outputCount })}`);
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

const spanSum = (spans: readonly ScanTimingSpan[], name: ScanTimingSpan['name']): number =>
  round(
    sum(
      spans.filter((span) => span.name === name),
      (span) => span.durationMs,
    ),
  );

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
