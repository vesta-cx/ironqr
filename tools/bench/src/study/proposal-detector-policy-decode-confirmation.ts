import type { ScanTimingSpan } from '../../../../packages/ironqr/src/contracts/scan.js';
import {
  createTraceCollector,
  listDefaultBinaryViewIds,
  scanFrame,
} from '../../../../packages/ironqr/src/index.js';
import type { FinderEvidenceDetectionPolicy } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import type { IronqrTraceEvent } from '../../../../packages/ironqr/src/pipeline/trace.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const STUDY_VERSION = 'study-v1';
const TIMING_ROWS_PER_POLICY = 6;

type PolicyId = 'full-current' | 'no-flood';

const POLICIES = ['full-current', 'no-flood'] as const satisfies readonly PolicyId[];

interface Config extends Record<string, unknown> {
  readonly policies: readonly PolicyId[];
  readonly maxProposals: number;
  readonly maxClusterRepresentatives: number;
  readonly maxDecodeAttempts?: number;
  readonly maxViews: number;
}

interface AssetResult {
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly expectedTexts: readonly string[];
  readonly policies: readonly PolicyResult[];
}

interface PolicyResult {
  readonly policyId: PolicyId;
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

interface PolicySummary extends TimingSummary {
  readonly policyId: PolicyId;
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

interface Summary extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly cache: StudySummaryInput<Config, AssetResult>['cache'];
  readonly policies: readonly PolicySummary[];
  readonly comparisons: readonly Comparison[];
  readonly recommendation: readonly string[];
}

const parseConfig = ({
  flags,
}: {
  readonly flags: Readonly<Record<string, string | number | boolean>>;
}): Config => {
  const policyFlag = typeof flags.policies === 'string' ? flags.policies.trim() : '';
  const policies =
    policyFlag.length === 0 ? POLICIES : policyFlag.split(',').map((id) => id.trim() as PolicyId);
  const known = new Set<PolicyId>(POLICIES);
  for (const policy of policies)
    if (!known.has(policy)) throw new Error(`unknown proposal detector policy: ${policy}`);
  if (!policies.includes('full-current'))
    throw new Error('proposal-detector-policy-decode-confirmation requires full-current');
  return {
    policies,
    maxProposals: numericFlag(flags['max-proposals'], 24, 'max-proposals'),
    maxClusterRepresentatives: numericFlag(
      flags['max-cluster-representatives'],
      1,
      'max-cluster-representatives',
    ),
    ...(flags['max-decode-attempts'] === undefined
      ? {}
      : { maxDecodeAttempts: numericFlag(flags['max-decode-attempts'], 1, 'max-decode-attempts') }),
    maxViews: numericFlag(flags['max-views'], listDefaultBinaryViewIds().length, 'max-views'),
  };
};

export const proposalDetectorPolicyDecodeConfirmationStudyPlugin: StudyPlugin<
  Summary,
  Config,
  AssetResult
> = {
  id: 'proposal-detector-policy-decode-confirmation',
  title: 'IronQR proposal detector policy decode confirmation study',
  description: 'Compares proposal detector-family policies against decode outcomes and costs.',
  version: STUDY_VERSION,
  flags: [
    { name: 'max-assets', type: 'number', description: 'Limit approved corpus assets.' },
    {
      name: 'policies',
      type: 'string',
      description: `Comma-separated policies. Defaults to ${POLICIES.join(',')}.`,
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
  parseConfig,
  cacheKey: (config) =>
    JSON.stringify({ config, engine: describeAccuracyEngine(getAccuracyEngineById('ironqr')) }),
  estimateUnits: (config, assets) =>
    assets.length * config.policies.length * TIMING_ROWS_PER_POLICY,
  replayCachedAsset: ({ result, log }) => {
    for (const policy of result.policies) logPolicyMetrics(log, policy);
  },
  runAsset: async ({ asset, config, signal, log }) => {
    const image = await asset.loadImage();
    const expectedTexts = uniqueTexts(
      asset.expectedTexts.map(normalizeDecodedText).filter(Boolean),
    );
    const policies: PolicyResult[] = [];
    for (const policy of config.policies) {
      if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
      const result = await runPolicy(image, asset.label, expectedTexts, policy, config);
      policies.push(result);
      logPolicyMetrics(log, result);
      log(
        `${asset.id}: ${policy} success=${result.success} proposals=${result.proposalCount} attempts=${result.decodeAttemptCount}`,
      );
    }
    return { assetId: asset.id, label: asset.label, expectedTexts, policies };
  },
  summarize: (input) => summarize(input),
  renderReport: ({ config, results, summary }) => ({ config, summary, sampledAssets: results }),
};

const detectorPolicyForId = (policy: PolicyId): FinderEvidenceDetectionPolicy | undefined => {
  if (policy === 'no-flood') return { enabledFamilies: ['row-scan', 'matcher'] };
  return undefined;
};

const runPolicy = async (
  image: Parameters<typeof scanFrame>[0],
  label: 'qr-pos' | 'qr-neg',
  expectedTexts: readonly string[],
  policy: PolicyId,
  config: Config,
): Promise<PolicyResult> => {
  const trace = createTraceCollector();
  const spans: ScanTimingSpan[] = [];
  const startedAt = performance.now();
  const detectorPolicy = detectorPolicyForId(policy);
  const results = await scanFrame(image, {
    allowMultiple: false,
    maxProposals: config.maxProposals,
    maxClusterRepresentatives: config.maxClusterRepresentatives,
    ...(config.maxDecodeAttempts === undefined
      ? {}
      : { maxDecodeAttempts: config.maxDecodeAttempts }),
    maxClusterStructuralFailures: 10_000,
    continueAfterDecode: false,
    proposalViewIds: listDefaultBinaryViewIds().slice(0, config.maxViews),
    ...(detectorPolicy === undefined ? {} : { proposalDetectorPolicy: detectorPolicy }),
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
    policyId: policy,
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
  PolicyResult,
  'policyId' | 'decodedTexts' | 'matchedTexts' | 'falsePositiveTexts' | 'success' | 'scanDurationMs'
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
  const controlSuccessAssetIds = successfulPositiveAssetIds('full-current', results);
  const control = summarizePolicy('full-current', results, controlSuccessAssetIds);
  const policies = config.policies.map((policy) =>
    summarizePolicy(policy, results, controlSuccessAssetIds),
  );
  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    cache,
    policies,
    comparisons: policies
      .filter((policy) => policy.policyId !== 'full-current')
      .map((policy) => comparePolicy(policy, control)),
    recommendation: [
      'Promote detector policies only with zero positive decode loss and no false-positive increase relative to full-current.',
      'Use proposal, detector, decode attempt, cluster, and timing deltas to decide whether removing flood reduces downstream work.',
    ],
  };
};

const summarizePolicy = (
  policyId: PolicyId,
  results: readonly AssetResult[],
  controlSuccessAssetIds: ReadonlySet<string>,
): PolicySummary => {
  const rows = results
    .map((result) => ({
      asset: result,
      row: result.policies.find((policy) => policy.policyId === policyId),
    }))
    .filter((entry): entry is { asset: AssetResult; row: PolicyResult } => entry.row !== undefined);
  const positiveRows = rows.filter(({ asset }) => asset.label === 'qr-pos');
  const successAssetIds = new Set(
    positiveRows.filter(({ row }) => row.matchedTexts.length > 0).map(({ asset }) => asset.assetId),
  );
  const falsePositiveAssetIds = rows
    .filter(({ asset, row }) => asset.label === 'qr-neg' && row.falsePositiveTexts.length > 0)
    .map(({ asset }) => asset.assetId);
  const timings = rows.reduce((total, { row }) => addTimings(total, row.timings), emptyTimings());
  return {
    policyId,
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
  policyId: PolicyId,
  results: readonly AssetResult[],
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

const comparePolicy = (policy: PolicySummary, control: PolicySummary): Comparison => ({
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

const logPolicyMetrics = (log: (message: string) => void, result: PolicyResult): void => {
  logStudyTiming(
    log,
    `${result.policyId}:scan`,
    result.scanDurationMs,
    'view',
    result.success ? 1 : 0,
  );
  logStudyTiming(
    log,
    `${result.policyId}:proposals`,
    result.timings.proposalViewMs,
    'view',
    result.proposalCount,
  );
  logStudyTiming(
    log,
    `${result.policyId}:decode-attempts`,
    result.timings.decodeAttemptMs,
    'view',
    result.decodeAttemptCount,
  );
  logStudyTiming(
    log,
    `${result.policyId}:geometry`,
    result.timings.geometryMs,
    'view',
    result.decodeAttemptCount,
  );
  logStudyTiming(
    log,
    `${result.policyId}:module-sampling`,
    result.timings.moduleSamplingMs,
    'view',
    result.decodeAttemptCount,
  );
  logStudyTiming(
    log,
    `${result.policyId}:structure`,
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
    throw new Error(
      `proposal-detector-policy-decode-confirmation --${name} must be a positive integer`,
    );
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
