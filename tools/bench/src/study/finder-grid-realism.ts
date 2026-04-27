import { listDefaultBinaryViewIds } from '../../../../packages/ironqr/src/index.js';
import type { GeometryCandidate } from '../../../../packages/ironqr/src/pipeline/geometry.js';
import type { ScanProposal } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import {
  type BinaryView,
  createViewBank,
  readBinaryPixel,
} from '../../../../packages/ironqr/src/pipeline/views.js';
import {
  type DecodeOutcomeArtifacts,
  getOrComputeClusterFrontierArtifacts,
  getOrComputeDecodeOutcomeArtifacts,
} from './scanner-artifacts.js';
import { parseVariantList, positiveIntegerFlag, round, sumBy } from './summary-helpers.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_VERSION = 'study-v1';
const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const CORONATEST_ASSET_ID = 'asset-0944aec7c73146f9';

type GridRealismVariant =
  | 'baseline'
  | 'grid-realism-ranking'
  | 'grid-realism-ranking-no-timing'
  | 'grid-realism-ranking-no-module';

const DEFAULT_VARIANTS = [
  'baseline',
  'grid-realism-ranking',
] as const satisfies readonly GridRealismVariant[];

const ALL_VARIANTS = [
  ...DEFAULT_VARIANTS,
  'grid-realism-ranking-no-timing',
  'grid-realism-ranking-no-module',
] as const satisfies readonly GridRealismVariant[];

interface Config extends Record<string, unknown> {
  readonly variants: readonly GridRealismVariant[];
  readonly noDecode: boolean;
  readonly maxViews: number;
  readonly maxProposals: number;
  readonly maxProposalsPerView: number;
  readonly maxClusterRepresentatives: number;
  readonly maxDecodeAttempts?: number;
}

interface AssetResult {
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly expectedTexts: readonly string[];
  readonly variants: readonly VariantAssetResult[];
  readonly decode?: DecodeAssetResult;
}

interface VariantAssetResult {
  readonly variantId: GridRealismVariant;
  readonly proposalCount: number;
  readonly clusterCount: number;
  readonly representativeCount: number;
  readonly covered: boolean;
  /** Representative signatures in the order this variant would process them. */
  readonly proposalSignatures: readonly string[];
  /** Variant policy scores in processing order: baseline uses proposal score; realism variants use policy score. */
  readonly scores: readonly number[];
  readonly score: ScoreDistribution;
  readonly componentScores: ComponentScores;
  readonly components: ComponentDistributions;
  readonly firstChangedRank: number | null;
  readonly signalMs: number;
}

interface ComponentScores {
  readonly projective: readonly number[];
  readonly module: readonly number[];
  readonly bounds: readonly number[];
  readonly timing: readonly number[];
  readonly combined: readonly number[];
}

interface ComponentDistributions {
  readonly projective: ScoreDistribution;
  readonly module: ScoreDistribution;
  readonly bounds: ScoreDistribution;
  readonly timing: ScoreDistribution;
  readonly combined: ScoreDistribution;
}

interface DecodeAssetResult {
  readonly decodedTexts: readonly string[];
  readonly attemptCount: number;
  readonly successCount: number;
}

interface ScoreDistribution {
  readonly count: number;
  readonly min: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface Summary extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly noDecode: boolean;
  readonly cache: StudySummaryInput<Config, AssetResult>['cache'];
  readonly artifactCache: StudySummaryInput<Config, AssetResult>['artifactCache'];
  readonly variants: readonly VariantSummary[];
  readonly coronatest: {
    readonly coveredByVariant: Record<string, boolean>;
    readonly decoded?: boolean;
  };
  readonly recommendation: readonly string[];
}

interface VariantSummary extends ScoreDistribution {
  readonly variantId: GridRealismVariant;
  readonly positiveCoveredAssetCount: number;
  readonly negativeCoveredAssetCount: number;
  readonly proposalCount: number;
  readonly clusterCount: number;
  readonly representativeCount: number;
  readonly signalMs: number;
  readonly lostPositiveAssetIds: readonly string[];
  readonly gainedPositiveAssetIds: readonly string[];
  readonly changedAssetCount: number;
  readonly firstChangedRank: ScoreDistribution;
  readonly positiveScores: ScoreDistribution;
  readonly negativeScores: ScoreDistribution;
  readonly components: ComponentDistributions;
}

const parseConfig = ({
  flags,
}: {
  readonly flags: Readonly<Record<string, string | number | boolean>>;
}): Config => {
  const variants = parseVariantList({
    value: flags.variants,
    defaultValues: flags.variants === undefined ? DEFAULT_VARIANTS : ALL_VARIANTS,
    controlValue: 'baseline',
    unknownLabel: 'finder grid realism variant',
    studyId: 'finder-grid-realism',
  });
  const noDecode = flags['no-decode'] === true;
  return {
    variants,
    noDecode,
    maxViews: positiveIntegerFlag(
      flags['max-views'],
      listDefaultBinaryViewIds().length,
      'max-views',
      'finder-grid-realism',
    ),
    maxProposals: positiveIntegerFlag(
      flags['max-proposals'],
      24,
      'max-proposals',
      'finder-grid-realism',
    ),
    maxProposalsPerView: positiveIntegerFlag(
      flags['max-proposals-per-view'],
      12,
      'max-proposals-per-view',
      'finder-grid-realism',
    ),
    maxClusterRepresentatives: positiveIntegerFlag(
      flags['max-cluster-representatives'],
      1,
      'max-cluster-representatives',
      'finder-grid-realism',
    ),
    ...(flags['max-decode-attempts'] === undefined
      ? {}
      : {
          maxDecodeAttempts: positiveIntegerFlag(
            flags['max-decode-attempts'],
            1,
            'max-decode-attempts',
            'finder-grid-realism',
          ),
        }),
  };
};

export const finderGridRealismStudyPlugin: StudyPlugin<Summary, Config, AssetResult> = {
  id: 'finder-grid-realism',
  title: 'IronQR finder grid realism study',
  description: 'Scores finder triples for QR-grid realism before decode.',
  version: STUDY_VERSION,
  usesInternalCache: true,
  flags: [
    { name: 'max-assets', type: 'number', description: 'Limit approved corpus assets.' },
    {
      name: 'variants',
      type: 'string',
      description: `Comma-separated variants. Defaults to ${DEFAULT_VARIANTS.join(',')}.`,
    },
    {
      name: 'no-decode',
      type: 'boolean',
      description: 'Skip L8 decode and report frontier-only metrics.',
    },
    { name: 'max-views', type: 'number', description: 'Maximum proposal binary views per asset.' },
    {
      name: 'max-proposals',
      type: 'number',
      description: 'Maximum clusters/proposals retained for decode frontier.',
    },
    {
      name: 'max-proposals-per-view',
      type: 'number',
      description: 'Maximum proposals emitted per view.',
    },
    {
      name: 'max-cluster-representatives',
      type: 'number',
      description: 'Representatives retained per cluster.',
    },
    {
      name: 'max-decode-attempts',
      type: 'number',
      description: 'Optional decode-attempt cap for decode mode.',
    },
  ],
  parseConfig,
  estimateUnits: (config, assets) => assets.length * config.variants.length,
  runAsset: async ({ asset, config, artifactCache, log }) => {
    const options = artifactOptions(config);
    const artifacts = config.noDecode
      ? await getOrComputeClusterFrontierArtifacts(asset, artifactCache, options)
      : await getOrComputeDecodeOutcomeArtifacts(asset, artifactCache, options);
    const viewBank = createViewBank(artifacts.image);
    const geometryByProposalId = new Map(
      artifacts.rankedCandidates.map((candidate) => [
        candidate.proposal.id,
        candidate.initialGeometryCandidates,
      ]),
    );
    const baseRepresentatives = artifacts.clusters.flatMap((cluster) => cluster.representatives);
    const scoredRepresentatives = baseRepresentatives.map((proposal, index) => ({
      proposal,
      baselineRank: index,
      gridRealism: scoreProposalGridRealism(
        proposal,
        geometryByProposalId.get(proposal.id) ?? [],
        viewBank.getBinaryView(proposal.binaryViewId),
      ),
    }));
    const baselineSignatures = baseRepresentatives.map(proposalSignature);
    const variants = config.variants.map((variantId) => {
      const startedAt = performance.now();
      const ordered = orderRepresentatives(scoredRepresentatives, variantId);
      const scores = ordered.map((row) => policyScore(row, variantId));
      const componentScores = componentScoreRows(ordered.map((row) => row.gridRealism));
      const signatures = ordered.map((row) => proposalSignature(row.proposal));
      const signalMs = round(performance.now() - startedAt);
      logStudyTiming(log, `${variantId}:grid-realism`, signalMs, ordered.length);
      return {
        variantId,
        proposalCount: artifacts.batches.reduce((sum, batch) => sum + batch.proposals.length, 0),
        clusterCount: artifacts.clusters.length,
        representativeCount: ordered.length,
        covered: ordered.length > 0,
        proposalSignatures: signatures,
        scores,
        score: distribution(scores),
        componentScores,
        components: componentDistributions(componentScores),
        firstChangedRank: firstChangedRank(baselineSignatures, signatures),
        signalMs,
      } satisfies VariantAssetResult;
    });
    const decode = config.noDecode ? undefined : decodeResult(artifacts as DecodeOutcomeArtifacts);
    log(
      `${asset.id}: grid-realism reps=${baseRepresentatives.length} decode=${decode?.attemptCount ?? 0}`,
    );
    return {
      assetId: asset.id,
      label: asset.label,
      expectedTexts: asset.expectedTexts,
      variants,
      ...(decode === undefined ? {} : { decode }),
    };
  },
  summarize: (input) => summarize(input),
  renderReport: ({ config, results, summary }) => ({ config, summary, sampledAssets: results }),
};

const artifactOptions = (config: Config) => ({
  viewIds: listDefaultBinaryViewIds().slice(0, config.maxViews),
  maxProposalsPerView: config.maxProposalsPerView,
  detectorPolicy: { enabledFamilies: ['row-scan', 'matcher'] as const },
  rankingVariant: 'timing-heavy' as const,
  maxProposals: config.maxProposals,
  maxClusterRepresentatives: config.maxClusterRepresentatives,
  representativeVariant: 'proposal-score' as const,
  ...(config.maxDecodeAttempts === undefined
    ? {}
    : { maxDecodeAttempts: config.maxDecodeAttempts }),
});

const scoreProposalGridRealism = (
  proposal: ScanProposal,
  geometryCandidates: readonly GeometryCandidate[],
  binaryView: BinaryView,
): { projective: number; module: number; bounds: number; timing: number; combined: number } => {
  const geometry = geometryCandidates[0] ?? null;
  const projective = scoreProjective(geometry, binaryView);
  const module = scoreModuleConsistency(proposal, geometry);
  const bounds = scoreBounds(geometry, binaryView);
  const timing = scoreGridTiming(geometry, binaryView);
  const combined = round(projective * 0.25 + module * 0.25 + bounds * 0.2 + timing * 0.3);
  return { projective, module, bounds, timing, combined };
};

const scoreProjective = (geometry: GeometryCandidate | null, view: BinaryView): number => {
  if (geometry === null) return 0;
  const area = polygonArea([
    geometry.corners.topLeft,
    geometry.corners.topRight,
    geometry.corners.bottomRight,
    geometry.corners.bottomLeft,
  ]);
  const imageArea = Math.max(1, view.width * view.height);
  const areaScore = clamp01(area / imageArea / 0.02);
  const convexScore = area > 1 ? 1 : 0;
  return round(clamp01((geometry.geometryScore / 3) * 0.5 + areaScore * 0.3 + convexScore * 0.2));
};

const scoreBounds = (geometry: GeometryCandidate | null, view: BinaryView): number => {
  if (geometry === null) return 0;
  const tolerance = Math.max(view.width, view.height) * 0.08;
  const corners = [
    geometry.corners.topLeft,
    geometry.corners.topRight,
    geometry.corners.bottomRight,
    geometry.corners.bottomLeft,
  ];
  const inside =
    corners.filter(
      (point) =>
        point.x >= -tolerance &&
        point.y >= -tolerance &&
        point.x <= view.width + tolerance &&
        point.y <= view.height + tolerance,
    ).length / corners.length;
  const pitch = averageModulePitch(geometry);
  const pitchScore = pitch <= 0 ? 0 : clamp01(Math.min(pitch / 1.5, 12 / pitch));
  return round(inside * 0.7 + pitchScore * 0.3);
};

const scoreModuleConsistency = (
  proposal: ScanProposal,
  geometry: GeometryCandidate | null,
): number => {
  if (geometry === null || proposal.kind !== 'finder-triple') return geometry === null ? 0 : 0.5;
  const predicted = averageModulePitch(geometry);
  if (predicted <= 0) return 0;
  const ratios = proposal.finders.map(
    (finder) => Math.min(finder.moduleSize, predicted) / Math.max(finder.moduleSize, predicted),
  );
  const axisRatios = proposal.finders.map(
    (finder) =>
      Math.min(finder.hModuleSize, finder.vModuleSize) /
      Math.max(finder.hModuleSize, finder.vModuleSize),
  );
  return round(clamp01(average(ratios) * 0.7 + average(axisRatios) * 0.3));
};

const scoreGridTiming = (geometry: GeometryCandidate | null, view: BinaryView): number => {
  if (geometry === null || geometry.size < 21) return 0;
  const values: number[] = [];
  for (let col = 8; col <= geometry.size - 9; col += 1)
    values.push(sampleTiming(geometry, view, 6, col, col));
  for (let row = 8; row <= geometry.size - 9; row += 1)
    values.push(sampleTiming(geometry, view, row, 6, row));
  if (values.length === 0) return 0.5;
  const direct = average(values);
  return round(Math.max(direct, 1 - direct));
};

const sampleTiming = (
  geometry: GeometryCandidate,
  view: BinaryView,
  row: number,
  col: number,
  phaseIndex: number,
): number => {
  const point = geometry.samplePoint(row, col);
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) return 0;
  const dark = readBinaryPixel(view, y * view.width + x) === 0;
  const expectedDark = phaseIndex % 2 === 0;
  return dark === expectedDark ? 1 : 0;
};

interface ScoredRepresentative {
  readonly proposal: ScanProposal;
  readonly baselineRank: number;
  readonly gridRealism: ReturnType<typeof scoreProposalGridRealism>;
}

const orderRepresentatives = (
  rows: readonly ScoredRepresentative[],
  variant: GridRealismVariant,
): readonly ScoredRepresentative[] => {
  if (variant === 'baseline') return rows;
  return [...rows].sort(
    (left, right) =>
      byDescending(policyScore(left, variant), policyScore(right, variant)) ||
      byDescending(left.proposal.proposalScore, right.proposal.proposalScore) ||
      left.baselineRank - right.baselineRank,
  );
};

const policyScore = (row: ScoredRepresentative, variant: GridRealismVariant): number => {
  if (variant === 'baseline') return row.proposal.proposalScore;
  if (variant === 'grid-realism-ranking-no-timing')
    return round(
      row.gridRealism.projective * 0.35 +
        row.gridRealism.module * 0.4 +
        row.gridRealism.bounds * 0.25,
    );
  if (variant === 'grid-realism-ranking-no-module')
    return round(
      row.gridRealism.projective * 0.35 +
        row.gridRealism.bounds * 0.25 +
        row.gridRealism.timing * 0.4,
    );
  return row.gridRealism.combined;
};

const byDescending = (left: number, right: number): number => right - left;

const firstChangedRank = (
  baseline: readonly string[],
  candidate: readonly string[],
): number | null => {
  const length = Math.max(baseline.length, candidate.length);
  for (let index = 0; index < length; index += 1) {
    if (baseline[index] !== candidate[index]) return index + 1;
  }
  return null;
};

const componentScoreRows = (
  scores: readonly ReturnType<typeof scoreProposalGridRealism>[],
): ComponentScores => ({
  projective: scores.map((score) => score.projective),
  module: scores.map((score) => score.module),
  bounds: scores.map((score) => score.bounds),
  timing: scores.map((score) => score.timing),
  combined: scores.map((score) => score.combined),
});

const componentDistributions = (scores: ComponentScores): ComponentDistributions => ({
  projective: distribution(scores.projective),
  module: distribution(scores.module),
  bounds: distribution(scores.bounds),
  timing: distribution(scores.timing),
  combined: distribution(scores.combined),
});

const summarize = ({
  config,
  results,
  cache,
  artifactCache,
}: StudySummaryInput<Config, AssetResult>): Summary => {
  const baselineCovered = new Set(
    results
      .filter(
        (result) =>
          result.label === 'qr-pos' &&
          result.variants.find((variant) => variant.variantId === 'baseline')?.covered,
      )
      .map((result) => result.assetId),
  );
  const variants = config.variants.map((variantId) =>
    summarizeVariant(variantId, results, baselineCovered),
  );
  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    noDecode: config.noDecode,
    cache,
    artifactCache,
    variants,
    coronatest: {
      coveredByVariant: Object.fromEntries(
        config.variants.map((variant) => [
          variant,
          results
            .find((result) => result.assetId === CORONATEST_ASSET_ID)
            ?.variants.find((row) => row.variantId === variant)?.covered ?? false,
        ]),
      ),
      ...(config.noDecode
        ? {}
        : {
            decoded:
              (results.find((result) => result.assetId === CORONATEST_ASSET_ID)?.decode
                ?.decodedTexts.length ?? 0) > 0,
          }),
    },
    recommendation: [
      'Treat grid-realism as one dependent hypothesis pipeline, not independent component policies.',
      'Use baseline vs grid-realism-ranking to evaluate frontier order changes before decode confirmation.',
      'Inspect component distributions as diagnostics only; do not canonize projective/module/bounds/timing in isolation.',
      'Coronatest must remain covered before any realism ranking or hard-rejection candidate advances.',
    ],
  };
};

const summarizeVariant = (
  variantId: GridRealismVariant,
  results: readonly AssetResult[],
  baselineCovered: ReadonlySet<string>,
): VariantSummary => {
  const rows = results
    .map((result) => result.variants.find((variant) => variant.variantId === variantId))
    .filter(isDefined);
  const coveredPositiveIds = new Set(
    results
      .filter(
        (result) =>
          result.label === 'qr-pos' &&
          result.variants.find((variant) => variant.variantId === variantId)?.covered,
      )
      .map((result) => result.assetId),
  );
  const lostPositiveAssetIds = [...baselineCovered]
    .filter((assetId) => !coveredPositiveIds.has(assetId))
    .sort();
  const gainedPositiveAssetIds = [...coveredPositiveIds]
    .filter((assetId) => !baselineCovered.has(assetId))
    .sort();
  const score = distribution(rows.flatMap((row) => row.scores));
  const changedAssetCount = rows.filter((row) => row.firstChangedRank !== null).length;
  const changedRanks = rows.flatMap((row) =>
    row.firstChangedRank === null ? [] : [row.firstChangedRank],
  );
  const positiveScores = distribution(
    results
      .filter((result) => result.label === 'qr-pos')
      .flatMap(
        (result) =>
          result.variants.find((variant) => variant.variantId === variantId)?.scores ?? [],
      ),
  );
  const negativeScores = distribution(
    results
      .filter((result) => result.label === 'qr-neg')
      .flatMap(
        (result) =>
          result.variants.find((variant) => variant.variantId === variantId)?.scores ?? [],
      ),
  );
  return {
    variantId,
    positiveCoveredAssetCount: coveredPositiveIds.size,
    negativeCoveredAssetCount: results.filter(
      (result) =>
        result.label === 'qr-neg' &&
        result.variants.find((variant) => variant.variantId === variantId)?.covered,
    ).length,
    proposalCount: sumBy(rows, (row) => row.proposalCount),
    clusterCount: sumBy(rows, (row) => row.clusterCount),
    representativeCount: sumBy(rows, (row) => row.representativeCount),
    signalMs: round(sumBy(rows, (row) => row.signalMs)),
    lostPositiveAssetIds,
    gainedPositiveAssetIds,
    changedAssetCount,
    firstChangedRank: distribution(changedRanks),
    positiveScores,
    negativeScores,
    components: summarizeComponents(rows),
    ...score,
  };
};

const summarizeComponents = (rows: readonly VariantAssetResult[]): ComponentDistributions =>
  componentDistributions({
    projective: rows.flatMap((row) => row.componentScores.projective),
    module: rows.flatMap((row) => row.componentScores.module),
    bounds: rows.flatMap((row) => row.componentScores.bounds),
    timing: rows.flatMap((row) => row.componentScores.timing),
    combined: rows.flatMap((row) => row.componentScores.combined),
  });

const decodeResult = (artifacts: DecodeOutcomeArtifacts): DecodeAssetResult => ({
  decodedTexts: artifacts.decodedTexts,
  attemptCount: artifacts.attemptCount,
  successCount: artifacts.successCount,
});

const distribution = (values: readonly number[]): ScoreDistribution => {
  if (values.length === 0) return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    min: round(sorted[0] ?? 0),
    avg: round(average(values)),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: round(sorted.at(-1) ?? 0),
  };
};

const percentile = (sorted: readonly number[], quantile: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return round(sorted[index] ?? 0);
};

const proposalSignature = (proposal: ScanProposal): string =>
  `${proposal.binaryViewId}:${proposal.id}`;

const averageModulePitch = (geometry: GeometryCandidate): number => {
  const center = geometry.samplePoint(6, 6);
  const right = geometry.samplePoint(6, 7);
  const down = geometry.samplePoint(7, 6);
  return average([distance(center, right), distance(center, down)]);
};

const polygonArea = (points: readonly { readonly x: number; readonly y: number }[]): number => {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) continue;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
};

const distance = (
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
): number => Math.hypot(a.x - b.x, a.y - b.y);

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const logStudyTiming = (
  log: (message: string) => void,
  label: string,
  durationMs: number,
  samples: number,
): void => {
  log(
    `${STUDY_TIMING_PREFIX}${JSON.stringify({
      label,
      durationMs,
      samples,
    })}`,
  );
};
