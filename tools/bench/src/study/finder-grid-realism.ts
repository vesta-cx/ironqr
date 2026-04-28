import { Effect } from 'effect';
import { listDefaultBinaryViewIds } from '../../../../packages/ironqr/src/index.js';
import { runDecodeCascade } from '../../../../packages/ironqr/src/pipeline/decode-cascade.js';
import type { GeometryCandidate } from '../../../../packages/ironqr/src/pipeline/geometry.js';
import type { ScanProposal } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import {
  type BinaryView,
  createViewBank,
  readBinaryPixel,
} from '../../../../packages/ironqr/src/pipeline/views.js';
import { fractionalBar } from '../accuracy/dashboard/components.js';
import { getOrComputeClusterFrontierArtifacts } from './scanner-artifacts.js';
import { parseVariantList, positiveIntegerFlag, round, sumBy } from './summary-helpers.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

const STUDY_VERSION = 'study-v1';
const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const CORONATEST_ASSET_ID = 'asset-0944aec7c73146f9';

/**
 * Finder-grid-realism derived-stage cache/semantic versions.
 *
 * These are separate from scanner artifact L1-L8 versions because this study
 * consumes cached scanner frontiers and then derives policy-specific ordering,
 * diagnostics, and optional decode comparisons. Bump only the affected stage:
 * - `rankingPolicy`: grid-realism component formulas, weights, tie-breaks, or ordering semantics.
 * - `decodeComparison`: per-variant decode traversal, budgets, match/false-positive accounting.
 * - `visualization`: chart rows, units, or rendered bar semantics.
 */
const FINDER_GRID_REALISM_STAGE_VERSIONS = {
  rankingPolicy: 4,
  decodeComparison: 3,
  visualization: 2,
} as const;

type GridRealismVariant =
  | 'baseline'
  | 'grid-realism-ranking'
  | 'realism-phase-locked'
  | 'realism-module-heavy'
  | 'realism-timing-heavy'
  | 'realism-decode-likelihood'
  | 'realism-low-risk'
  | 'realism-geomean'
  | 'realism-lexicographic'
  | 'realism-penalty-only'
  | 'grid-realism-ranking-no-timing'
  | 'grid-realism-ranking-no-module';

const DEFAULT_VARIANTS = [
  'baseline',
  'grid-realism-ranking',
  'realism-phase-locked',
  'realism-module-heavy',
  'realism-decode-likelihood',
  'realism-low-risk',
  'realism-geomean',
  'realism-lexicographic',
] as const satisfies readonly GridRealismVariant[];

const ALL_VARIANTS = [
  ...DEFAULT_VARIANTS,
  'realism-timing-heavy',
  'realism-penalty-only',
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
  readonly stageVersions: typeof FINDER_GRID_REALISM_STAGE_VERSIONS;
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
  readonly frontier: readonly RepresentativeFrontierRow[];
  readonly score: ScoreDistribution;
  readonly componentScores: ComponentScores;
  readonly components: ComponentDistributions;
  readonly firstChangedRank: number | null;
  readonly signalMs: number;
  readonly decode?: VariantDecodeResult;
}

interface RepresentativeFrontierRow {
  readonly signature: string;
  readonly proposalId: string;
  readonly binaryViewId: string;
  readonly baselineRank: number;
  readonly variantRank: number;
  readonly clusterRank: number;
  readonly representativeRank: number;
  readonly score: number;
  readonly proposalScore: number;
  readonly components: ReturnType<typeof scoreProposalGridRealism>;
}

interface ComponentScores {
  readonly projective: readonly number[];
  readonly module: readonly number[];
  readonly bounds: readonly number[];
  readonly finder: readonly number[];
  readonly quiet: readonly number[];
  readonly timing: readonly number[];
  readonly combined: readonly number[];
}

interface ComponentDistributions {
  readonly projective: ScoreDistribution;
  readonly module: ScoreDistribution;
  readonly bounds: ScoreDistribution;
  readonly finder: ScoreDistribution;
  readonly quiet: ScoreDistribution;
  readonly timing: ScoreDistribution;
  readonly combined: ScoreDistribution;
}

interface DecodeAssetResult {
  readonly decodedTexts: readonly string[];
  readonly attemptCount: number;
  readonly successCount: number;
}

interface VariantDecodeResult extends DecodeAssetResult {
  readonly matchedExpectedTexts: readonly string[];
  readonly successRank: number | null;
  readonly falsePositive: boolean;
  readonly attempts: readonly DecodeRepresentativeAttempt[];
}

interface DecodeRepresentativeAttempt {
  readonly signature: string;
  readonly rank: number;
  readonly score: number;
  readonly attemptCount: number;
  readonly successCount: number;
  readonly decodedText: string | null;
  readonly matchedExpected: boolean;
  readonly falsePositive: boolean;
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
    readonly decodedByVariant?: Record<string, boolean>;
  };
  readonly thresholdSweeps?: readonly VariantThresholdSweep[];
  readonly visualizations: readonly StudyBarChart[];
  readonly recommendations: readonly string[];
}

interface VariantThresholdSweep {
  readonly variantId: GridRealismVariant;
  readonly thresholds: readonly ThresholdSummary[];
}

interface ThresholdSummary {
  readonly threshold: number;
  readonly representativesKept: number;
  readonly representativesDropped: number;
  readonly representativeReductionPct: number;
  readonly decodeAttemptsKept: number;
  readonly decodeAttemptsAvoided: number;
  readonly decodeAttemptReductionPct: number;
  readonly positiveDecodedAssetsKept: number;
  readonly positiveDecodedAssetsLost: number;
  readonly falsePositiveAssetsKept: number;
  readonly falsePositiveAssetsRemoved: number;
  readonly decodedAssetIdsLost: readonly string[];
  readonly falsePositiveAssetIdsRemoved: readonly string[];
}

interface StudyBarChart {
  readonly title: string;
  readonly unit: string;
  readonly rows: readonly StudyBarChartRow[];
}

interface StudyBarChartRow {
  readonly label: string;
  readonly value: number;
  readonly bar: string;
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
  readonly positiveDecodedAssetCount?: number;
  readonly falsePositiveAssetCount?: number;
  readonly decodeAttemptCount?: number;
  readonly decodeSuccessCount?: number;
  readonly lostDecodedPositiveAssetIds?: readonly string[];
  readonly gainedDecodedPositiveAssetIds?: readonly string[];
  readonly successRank?: ScoreDistribution;
  readonly decodedProvenance?: DecodeProvenanceSummary;
}

interface DecodeProvenanceSummary {
  readonly matchedPositives: FrontierProvenanceSummary;
  readonly falsePositives: FrontierProvenanceSummary;
}

interface FrontierProvenanceSummary {
  readonly assetCount: number;
  readonly uniqueViewCount: number;
  readonly viewCounts: Record<string, number>;
  readonly variantRank: ScoreDistribution;
  readonly baselineRank: ScoreDistribution;
  readonly clusterRank: ScoreDistribution;
  readonly representativeRank: ScoreDistribution;
  readonly score: ScoreDistribution;
  readonly componentAverages: {
    readonly finder: number;
    readonly timing: number;
    readonly module: number;
    readonly quiet: number;
    readonly combined: number;
  };
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
    stageVersions: FINDER_GRID_REALISM_STAGE_VERSIONS,
  };
};

export const finderGridRealismStudyPlugin: StudyPlugin<Summary, Config, AssetResult> = {
  id: 'finder-grid-realism',
  title: 'IronQR finder grid realism study',
  description: 'Scores finder triples for QR-grid realism before decode.',
  version: STUDY_VERSION,
  cacheKey: (config) => JSON.stringify(config),
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
  runAsset: async ({ asset, config, cache, artifactCache, log }) => {
    const options = artifactOptions(config);
    const artifacts = await getOrComputeClusterFrontierArtifacts(asset, artifactCache, options);
    const viewBank = createViewBank(artifacts.image);
    const geometryByProposalId = new Map(
      artifacts.rankedCandidates.map((candidate) => [
        candidate.proposal.id,
        candidate.initialGeometryCandidates,
      ]),
    );
    const baseRepresentatives = artifacts.clusters.flatMap((cluster) => cluster.representatives);
    const representativeRanks = new Map<
      string,
      { readonly clusterRank: number; readonly representativeRank: number }
    >();
    for (const [clusterIndex, cluster] of artifacts.clusters.entries()) {
      for (const [representativeIndex, proposal] of cluster.representatives.entries()) {
        representativeRanks.set(proposal.id, {
          clusterRank: clusterIndex + 1,
          representativeRank: representativeIndex + 1,
        });
      }
    }
    const scoredRepresentatives = baseRepresentatives.map((proposal, index) => ({
      proposal,
      baselineRank: index,
      gridRealism: scoreProposalGridRealism(
        proposal,
        geometryByProposalId.get(proposal.id) ?? [],
        viewBank.getBinaryView(proposal.binaryViewId),
      ),
      ranks: representativeRanks.get(proposal.id) ?? {
        clusterRank: index + 1,
        representativeRank: 1,
      },
    }));
    const baselineSignatures = baseRepresentatives.map(proposalSignature);
    const variants: VariantAssetResult[] = [];
    for (const variantId of config.variants) {
      const variantCacheKey = gridRealismVariantCacheKey(config, variantId);
      const cachedVariant = await cache.read(asset, variantCacheKey);
      if (isVariantAssetResult(cachedVariant)) {
        variants.push(cachedVariant);
        logStudyTiming(
          log,
          `${variantId}:grid-realism`,
          cachedVariant.signalMs,
          cachedVariant.representativeCount,
          true,
        );
        continue;
      }
      const startedAt = performance.now();
      const ordered = orderRepresentatives(scoredRepresentatives, variantId);
      const scores = ordered.map((row) => policyScore(row, variantId));
      const frontier = ordered.map((row, index) =>
        representativeFrontierRow(row, variantId, index),
      );
      const componentScores = componentScoreRows(ordered.map((row) => row.gridRealism));
      const signatures = ordered.map((row) => proposalSignature(row.proposal));
      const decode = config.noDecode
        ? undefined
        : await decodeOrderedRepresentatives({
            rows: ordered,
            variantId,
            geometryByProposalId,
            viewBank,
            expectedTexts: asset.expectedTexts,
            label: asset.label,
            ...(config.maxDecodeAttempts === undefined
              ? {}
              : { maxDecodeAttempts: config.maxDecodeAttempts }),
          });
      const signalMs = round(performance.now() - startedAt);
      logStudyTiming(log, `${variantId}:grid-realism`, signalMs, ordered.length);
      const result = {
        variantId,
        proposalCount: artifacts.batches.reduce((sum, batch) => sum + batch.proposals.length, 0),
        clusterCount: artifacts.clusters.length,
        representativeCount: ordered.length,
        covered: ordered.length > 0,
        proposalSignatures: signatures,
        scores,
        frontier,
        score: distribution(scores),
        componentScores,
        components: componentDistributions(componentScores),
        firstChangedRank: firstChangedRank(baselineSignatures, signatures),
        signalMs,
        ...(decode === undefined ? {} : { decode }),
      } satisfies VariantAssetResult;
      await cache.write(asset, variantCacheKey, result);
      variants.push(result);
    }
    log(
      `${asset.id}: grid-realism reps=${baseRepresentatives.length} decode=${sumBy(variants, (variant) => variant.decode?.attemptCount ?? 0)}`,
    );
    return {
      assetId: asset.id,
      label: asset.label,
      expectedTexts: asset.expectedTexts,
      variants,
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
): {
  projective: number;
  module: number;
  bounds: number;
  finder: number;
  quiet: number;
  timing: number;
  combined: number;
} => {
  const geometry = geometryCandidates[0] ?? null;
  const projective = scoreProjective(geometry, binaryView);
  const module = scoreModuleConsistency(proposal, geometry);
  const bounds = scoreBounds(geometry, binaryView);
  const finder = scoreFinderPatterns(geometry, binaryView);
  const quiet = scoreGridQuietZone(geometry, binaryView);
  const timing = scoreGridTiming(geometry, binaryView);
  const combined = round(
    finder * 0.35 + timing * 0.3 + module * 0.15 + quiet * 0.1 + Math.min(projective, bounds) * 0.1,
  );
  return { projective, module, bounds, finder, quiet, timing, combined };
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

const scoreFinderPatterns = (geometry: GeometryCandidate | null, view: BinaryView): number => {
  if (geometry === null) return 0;
  const starts = [
    [0, 0],
    [0, geometry.size - 7],
    [geometry.size - 7, 0],
  ] as const;
  const scores = starts.map(([rowStart, colStart]) =>
    scoreFinderTemplate(geometry, view, rowStart, colStart),
  );
  return round(average(scores));
};

const scoreFinderTemplate = (
  geometry: GeometryCandidate,
  view: BinaryView,
  rowStart: number,
  colStart: number,
): number => {
  const templateScores: number[] = [];
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      templateScores.push(
        bestModuleMatch(
          geometry,
          view,
          rowStart + row,
          colStart + col,
          expectedFinderDark(row, col),
        ).match,
      );
    }
  }
  templateScores.push(...separatorScores(geometry, view, rowStart, colStart));
  return round(average(templateScores));
};

const expectedFinderDark = (row: number, col: number): boolean => {
  if (row === 0 || row === 6 || col === 0 || col === 6) return true;
  if (row >= 2 && row <= 4 && col >= 2 && col <= 4) return true;
  return false;
};

const separatorScores = (
  geometry: GeometryCandidate,
  view: BinaryView,
  rowStart: number,
  colStart: number,
): readonly number[] => {
  const scores: number[] = [];
  for (let offset = -1; offset <= 7; offset += 1) {
    scores.push(bestModuleMatch(geometry, view, rowStart - 1, colStart + offset, false).match);
    scores.push(bestModuleMatch(geometry, view, rowStart + 7, colStart + offset, false).match);
    scores.push(bestModuleMatch(geometry, view, rowStart + offset, colStart - 1, false).match);
    scores.push(bestModuleMatch(geometry, view, rowStart + offset, colStart + 7, false).match);
  }
  return scores;
};

const scoreGridQuietZone = (geometry: GeometryCandidate | null, view: BinaryView): number => {
  if (geometry === null) return 0;
  const scores: number[] = [];
  for (let index = 0; index < geometry.size; index += 2) {
    for (const distance of [1, 2, 3, 4]) {
      scores.push(bestModuleMatch(geometry, view, -distance, index, false).match);
      scores.push(
        bestModuleMatch(geometry, view, geometry.size - 1 + distance, index, false).match,
      );
      scores.push(bestModuleMatch(geometry, view, index, -distance, false).match);
      scores.push(
        bestModuleMatch(geometry, view, index, geometry.size - 1 + distance, false).match,
      );
    }
  }
  return round(average(scores));
};

const scoreGridTiming = (geometry: GeometryCandidate | null, view: BinaryView): number => {
  if (geometry === null || geometry.size < 21) return 0;
  const row = timingAxisScore(geometry, view, 'row');
  const col = timingAxisScore(geometry, view, 'col');
  const phaseScore = average([row.match, col.match]);
  const runScore = average([row.run, col.run]);
  const axisAgreement = 1 - Math.abs(row.match - col.match);
  const jitterScore = 1 - average([row.jitter, col.jitter]);
  return round(phaseScore * 0.45 + runScore * 0.3 + axisAgreement * 0.15 + jitterScore * 0.1);
};

const timingAxisScore = (
  geometry: GeometryCandidate,
  view: BinaryView,
  axis: 'row' | 'col',
): { readonly match: number; readonly run: number; readonly jitter: number } => {
  const matches: number[] = [];
  const jitters: number[] = [];
  for (let index = 8; index <= geometry.size - 9; index += 1) {
    const expectedDark = index % 2 === 0;
    const sample =
      axis === 'row'
        ? bestModuleMatch(geometry, view, 6, index, expectedDark)
        : bestModuleMatch(geometry, view, index, 6, expectedDark);
    matches.push(sample.match);
    jitters.push(sample.offset);
  }
  return {
    match: round(average(matches)),
    run: round(longestRun(matches) / Math.max(1, matches.length)),
    jitter: round(average(jitters)),
  };
};

const bestModuleMatch = (
  geometry: GeometryCandidate,
  view: BinaryView,
  row: number,
  col: number,
  expectedDark: boolean,
): { readonly match: number; readonly offset: number } => {
  const offsets = [
    [0, 0],
    [-0.18, 0],
    [0.18, 0],
    [0, -0.18],
    [0, 0.18],
  ] as const;
  for (const [rowOffset, colOffset] of offsets) {
    const dark = sampleGridDark(geometry, view, row + rowOffset, col + colOffset);
    if (dark === null) continue;
    if (dark === expectedDark) return { match: 1, offset: Math.hypot(rowOffset, colOffset) / 0.18 };
  }
  return { match: 0, offset: 1 };
};

const sampleGridDark = (
  geometry: GeometryCandidate,
  view: BinaryView,
  row: number,
  col: number,
): boolean | null => {
  const point = geometry.samplePoint(row, col);
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) return null;
  return readBinaryPixel(view, y * view.width + x) === 0;
};

const longestRun = (values: readonly number[]): number => {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (value >= 1) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
};

interface ScoredRepresentative {
  readonly proposal: ScanProposal;
  readonly baselineRank: number;
  readonly gridRealism: ReturnType<typeof scoreProposalGridRealism>;
  readonly ranks: {
    readonly clusterRank: number;
    readonly representativeRank: number;
  };
}

const representativeFrontierRow = (
  row: ScoredRepresentative,
  variantId: GridRealismVariant,
  index: number,
): RepresentativeFrontierRow => ({
  signature: proposalSignature(row.proposal),
  proposalId: row.proposal.id,
  binaryViewId: row.proposal.binaryViewId,
  baselineRank: row.baselineRank + 1,
  variantRank: index + 1,
  clusterRank: row.ranks.clusterRank,
  representativeRank: row.ranks.representativeRank,
  score: policyScore(row, variantId),
  proposalScore: row.proposal.proposalScore,
  components: row.gridRealism,
});

const gridRealismVariantCacheKey = (config: Config, variantId: GridRealismVariant): string =>
  JSON.stringify({
    study: 'finder-grid-realism',
    stage: 'variant-result',
    variantId,
    noDecode: config.noDecode,
    maxViews: config.maxViews,
    maxProposals: config.maxProposals,
    maxProposalsPerView: config.maxProposalsPerView,
    maxClusterRepresentatives: config.maxClusterRepresentatives,
    maxDecodeAttempts: config.maxDecodeAttempts ?? null,
    stageVersions: config.stageVersions,
  });

const isVariantAssetResult = (value: unknown): value is VariantAssetResult =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { variantId?: unknown }).variantId === 'string' &&
  typeof (value as { representativeCount?: unknown }).representativeCount === 'number' &&
  Array.isArray((value as { proposalSignatures?: unknown }).proposalSignatures) &&
  Array.isArray((value as { scores?: unknown }).scores) &&
  Array.isArray((value as { frontier?: unknown }).frontier);

const decodeOrderedRepresentatives = async (input: {
  readonly rows: readonly ScoredRepresentative[];
  readonly variantId: GridRealismVariant;
  readonly geometryByProposalId: ReadonlyMap<string, readonly GeometryCandidate[]>;
  readonly viewBank: ReturnType<typeof createViewBank>;
  readonly expectedTexts: readonly string[];
  readonly label: 'qr-pos' | 'qr-neg';
  readonly maxDecodeAttempts?: number;
}): Promise<VariantDecodeResult> => {
  const decodedTexts = new Set<string>();
  const matchedExpectedTexts = new Set<string>();
  const attempts: DecodeRepresentativeAttempt[] = [];
  let attemptCount = 0;
  let successCount = 0;
  let successRank: number | null = null;
  const shouldAttemptDecode = (): boolean => {
    if (input.maxDecodeAttempts === undefined) return true;
    if (attemptCount >= input.maxDecodeAttempts) return false;
    return true;
  };
  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index];
    if (row === undefined) continue;
    let representativeAttemptCount = 0;
    let representativeSuccessCount = 0;
    const success = await Effect.runPromise(
      runDecodeCascade(row.proposal, input.viewBank, {
        proposalRank: index + 1,
        topProposalScore: input.rows[0]?.proposal.proposalScore ?? 0,
        initialGeometryCandidates: input.geometryByProposalId.get(row.proposal.id) ?? [],
        shouldAttemptDecode,
        onAttemptMeasured: (attempt) => {
          attemptCount += 1;
          representativeAttemptCount += 1;
          if (attempt.outcome === 'success') {
            successCount += 1;
            representativeSuccessCount += 1;
          }
        },
      }),
    );
    const decodedText = success?.result.payload.text ?? null;
    const matchedExpected =
      decodedText === null ? false : input.expectedTexts.includes(decodedText);
    attempts.push({
      signature: proposalSignature(row.proposal),
      rank: index + 1,
      score: policyScore(row, input.variantId),
      attemptCount: representativeAttemptCount,
      successCount: representativeSuccessCount,
      decodedText,
      matchedExpected,
      falsePositive: input.label === 'qr-neg' && decodedText !== null,
    });
    if (success === null) continue;
    successRank = index + 1;
    decodedTexts.add(decodedText ?? '');
    if (matchedExpected && decodedText !== null) matchedExpectedTexts.add(decodedText);
    break;
  }
  return {
    decodedTexts: [...decodedTexts],
    matchedExpectedTexts: [...matchedExpectedTexts],
    attemptCount,
    successCount,
    successRank,
    falsePositive: input.label === 'qr-neg' && decodedTexts.size > 0,
    attempts,
  };
};

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
  const score = row.gridRealism;
  if (variant === 'baseline') return row.proposal.proposalScore;
  if (variant === 'grid-realism-ranking' || variant === 'realism-phase-locked')
    return score.combined;
  if (variant === 'realism-module-heavy')
    return round(
      score.module * 0.45 + score.finder * 0.25 + score.timing * 0.2 + score.quiet * 0.1,
    );
  if (variant === 'realism-timing-heavy')
    return round(
      score.timing * 0.45 + score.finder * 0.3 + score.module * 0.15 + score.quiet * 0.1,
    );
  if (variant === 'realism-decode-likelihood')
    return round(
      score.finder * 0.35 + score.timing * 0.3 + score.module * 0.25 + score.quiet * 0.1,
    );
  if (variant === 'realism-low-risk') return lowRiskScore(score);
  if (variant === 'realism-geomean') return geomeanScore(score);
  if (variant === 'realism-lexicographic') return lexicographicScore(score);
  if (variant === 'realism-penalty-only') return penaltyOnlyScore(score);
  if (variant === 'grid-realism-ranking-no-timing')
    return round(
      score.finder * 0.45 +
        score.module * 0.3 +
        score.quiet * 0.15 +
        Math.min(score.projective, score.bounds) * 0.1,
    );
  if (variant === 'grid-realism-ranking-no-module')
    return round(
      score.finder * 0.4 +
        score.timing * 0.35 +
        score.quiet * 0.15 +
        Math.min(score.projective, score.bounds) * 0.1,
    );
  return score.combined;
};

const lowRiskScore = (score: ReturnType<typeof scoreProposalGridRealism>): number => {
  const severePenalty =
    (score.finder < 0.72 ? 0.3 : 0) +
    (score.timing < 0.58 ? 0.2 : 0) +
    (score.quiet < 0.55 ? 0.15 : 0);
  return round(
    score.finder * 0.35 +
      score.module * 0.3 +
      score.timing * 0.25 +
      score.quiet * 0.1 -
      severePenalty,
  );
};

const geomeanScore = (score: ReturnType<typeof scoreProposalGridRealism>): number =>
  round(
    Math.max(0.01, score.finder) ** 0.35 *
      Math.max(0.01, score.timing) ** 0.3 *
      Math.max(0.01, score.module) ** 0.2 *
      Math.max(0.01, score.quiet) ** 0.1 *
      Math.max(0.01, Math.min(score.projective, score.bounds)) ** 0.05,
  );

const lexicographicScore = (score: ReturnType<typeof scoreProposalGridRealism>): number => {
  const semanticBucket = score.finder >= 0.72 && score.timing >= 0.58 ? 1 : 0;
  return round(
    semanticBucket * 0.45 + score.finder * 0.25 + score.module * 0.2 + score.timing * 0.1,
  );
};

const penaltyOnlyScore = (score: ReturnType<typeof scoreProposalGridRealism>): number => {
  const badness =
    Math.max(0, 0.75 - score.finder) * 0.35 +
    Math.max(0, 0.65 - score.timing) * 0.3 +
    Math.max(0, 0.65 - score.module) * 0.2 +
    Math.max(0, 0.6 - score.quiet) * 0.15;
  return round(1 - badness);
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
  finder: scores.map((score) => score.finder),
  quiet: scores.map((score) => score.quiet),
  timing: scores.map((score) => score.timing),
  combined: scores.map((score) => score.combined),
});

const componentDistributions = (scores: ComponentScores): ComponentDistributions => ({
  projective: distribution(scores.projective),
  module: distribution(scores.module),
  bounds: distribution(scores.bounds),
  finder: distribution(scores.finder),
  quiet: distribution(scores.quiet),
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
  const baselineDecoded = new Set(
    results
      .filter(
        (result) =>
          result.label === 'qr-pos' &&
          (result.variants.find((variant) => variant.variantId === 'baseline')?.decode
            ?.matchedExpectedTexts.length ?? 0) > 0,
      )
      .map((result) => result.assetId),
  );
  const variants = config.variants.map((variantId) =>
    summarizeVariant(variantId, results, baselineCovered, baselineDecoded),
  );
  const thresholdSweeps = config.noDecode
    ? undefined
    : buildThresholdSweeps(config.variants, results);
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
            decodedByVariant: Object.fromEntries(
              config.variants.map((variant) => [
                variant,
                (results
                  .find((result) => result.assetId === CORONATEST_ASSET_ID)
                  ?.variants.find((row) => row.variantId === variant)?.decode?.decodedTexts
                  .length ?? 0) > 0,
              ]),
            ),
          }),
    },
    ...(thresholdSweeps === undefined ? {} : { thresholdSweeps }),
    visualizations: buildVisualizations(variants, thresholdSweeps),
    recommendations: [
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
  baselineDecoded: ReadonlySet<string>,
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
  const decodedPositiveIds = new Set(
    results
      .filter(
        (result) =>
          result.label === 'qr-pos' &&
          (result.variants.find((variant) => variant.variantId === variantId)?.decode
            ?.matchedExpectedTexts.length ?? 0) > 0,
      )
      .map((result) => result.assetId),
  );
  const decodedRows = rows.map((row) => row.decode).filter(isDefined);
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
    ...(decodedRows.length === 0
      ? {}
      : {
          positiveDecodedAssetCount: decodedPositiveIds.size,
          falsePositiveAssetCount: results.filter(
            (result) =>
              result.label === 'qr-neg' &&
              (result.variants.find((variant) => variant.variantId === variantId)?.decode
                ?.falsePositive ??
                false),
          ).length,
          decodeAttemptCount: sumBy(decodedRows, (row) => row.attemptCount),
          decodeSuccessCount: sumBy(decodedRows, (row) => row.successCount),
          lostDecodedPositiveAssetIds: [...baselineDecoded]
            .filter((assetId) => !decodedPositiveIds.has(assetId))
            .sort(),
          gainedDecodedPositiveAssetIds: [...decodedPositiveIds]
            .filter((assetId) => !baselineDecoded.has(assetId))
            .sort(),
          successRank: distribution(decodedRows.flatMap((row) => row.successRank ?? [])),
          decodedProvenance: summarizeDecodeProvenance(variantId, results),
        }),
    ...score,
  };
};

const summarizeDecodeProvenance = (
  variantId: GridRealismVariant,
  results: readonly AssetResult[],
): DecodeProvenanceSummary => {
  const matchedRows: RepresentativeFrontierRow[] = [];
  const falsePositiveRows: RepresentativeFrontierRow[] = [];
  for (const result of results) {
    const variant = result.variants.find((row) => row.variantId === variantId);
    if (variant?.decode === undefined) continue;
    const matchedAttempt = variant.decode.attempts.find((attempt) => attempt.matchedExpected);
    if (matchedAttempt !== undefined) {
      const frontierRow = variant.frontier.find(
        (row) => row.signature === matchedAttempt.signature,
      );
      if (frontierRow !== undefined) matchedRows.push(frontierRow);
    }
    const falsePositiveAttempt = variant.decode.attempts.find((attempt) => attempt.falsePositive);
    if (falsePositiveAttempt !== undefined) {
      const frontierRow = variant.frontier.find(
        (row) => row.signature === falsePositiveAttempt.signature,
      );
      if (frontierRow !== undefined) falsePositiveRows.push(frontierRow);
    }
  }
  return {
    matchedPositives: summarizeFrontierProvenance(matchedRows),
    falsePositives: summarizeFrontierProvenance(falsePositiveRows),
  };
};

const summarizeFrontierProvenance = (
  rows: readonly RepresentativeFrontierRow[],
): FrontierProvenanceSummary => ({
  assetCount: rows.length,
  uniqueViewCount: new Set(rows.map((row) => row.binaryViewId)).size,
  viewCounts: countBy(rows.map((row) => row.binaryViewId)),
  variantRank: distribution(rows.map((row) => row.variantRank)),
  baselineRank: distribution(rows.map((row) => row.baselineRank)),
  clusterRank: distribution(rows.map((row) => row.clusterRank)),
  representativeRank: distribution(rows.map((row) => row.representativeRank)),
  score: distribution(rows.map((row) => row.score)),
  componentAverages: {
    finder: averageOrZero(rows.map((row) => row.components.finder)),
    timing: averageOrZero(rows.map((row) => row.components.timing)),
    module: averageOrZero(rows.map((row) => row.components.module)),
    quiet: averageOrZero(rows.map((row) => row.components.quiet)),
    combined: averageOrZero(rows.map((row) => row.components.combined)),
  },
});

const averageOrZero = (values: readonly number[]): number =>
  values.length === 0 ? 0 : round(average(values));

const countBy = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1]));
};

const SWEEP_THRESHOLDS = [0, 0.25, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9] as const;

const buildThresholdSweeps = (
  variants: readonly GridRealismVariant[],
  results: readonly AssetResult[],
): readonly VariantThresholdSweep[] =>
  variants
    .filter((variantId) => variantId !== 'baseline')
    .map((variantId) => ({
      variantId,
      thresholds: SWEEP_THRESHOLDS.map((threshold) =>
        thresholdSummary(variantId, results, threshold),
      ),
    }));

const thresholdSummary = (
  variantId: GridRealismVariant,
  results: readonly AssetResult[],
  threshold: number,
): ThresholdSummary => {
  let representativesKept = 0;
  let representativesDropped = 0;
  let decodeAttemptsKept = 0;
  let decodeAttemptsAvoided = 0;
  const decodedAssetIdsLost: string[] = [];
  const falsePositiveAssetIdsRemoved: string[] = [];
  let positiveDecodedAssetsKept = 0;
  let falsePositiveAssetsKept = 0;

  for (const result of results) {
    const variant = result.variants.find((row) => row.variantId === variantId);
    if (variant === undefined) continue;
    for (const row of variant.frontier) {
      if (row.score >= threshold) representativesKept += 1;
      else representativesDropped += 1;
    }

    const decode = variant.decode;
    if (decode === undefined) continue;
    const keptAttempts = decode.attempts.filter((attempt) => attempt.score >= threshold);
    const droppedAttempts = decode.attempts.filter((attempt) => attempt.score < threshold);
    decodeAttemptsKept += sumBy(keptAttempts, (attempt) => attempt.attemptCount);
    decodeAttemptsAvoided += sumBy(droppedAttempts, (attempt) => attempt.attemptCount);

    const matchedAttempt = decode.attempts.find((attempt) => attempt.matchedExpected);
    if (result.label === 'qr-pos' && matchedAttempt !== undefined) {
      if (matchedAttempt.score >= threshold) positiveDecodedAssetsKept += 1;
      else decodedAssetIdsLost.push(result.assetId);
    }

    const falsePositiveAttempt = decode.attempts.find((attempt) => attempt.falsePositive);
    if (falsePositiveAttempt !== undefined) {
      if (falsePositiveAttempt.score >= threshold) falsePositiveAssetsKept += 1;
      else falsePositiveAssetIdsRemoved.push(result.assetId);
    }
  }

  const representativeTotal = representativesKept + representativesDropped;
  const decodeAttemptTotal = decodeAttemptsKept + decodeAttemptsAvoided;
  return {
    threshold,
    representativesKept,
    representativesDropped,
    representativeReductionPct: percent(representativesDropped, representativeTotal),
    decodeAttemptsKept,
    decodeAttemptsAvoided,
    decodeAttemptReductionPct: percent(decodeAttemptsAvoided, decodeAttemptTotal),
    positiveDecodedAssetsKept,
    positiveDecodedAssetsLost: decodedAssetIdsLost.length,
    falsePositiveAssetsKept,
    falsePositiveAssetsRemoved: falsePositiveAssetIdsRemoved.length,
    decodedAssetIdsLost: decodedAssetIdsLost.sort(),
    falsePositiveAssetIdsRemoved: falsePositiveAssetIdsRemoved.sort(),
  };
};

const percent = (numerator: number, denominator: number): number =>
  denominator <= 0 ? 0 : round((numerator / denominator) * 100);

const summarizeComponents = (rows: readonly VariantAssetResult[]): ComponentDistributions =>
  componentDistributions({
    projective: rows.flatMap((row) => row.componentScores.projective),
    module: rows.flatMap((row) => row.componentScores.module),
    bounds: rows.flatMap((row) => row.componentScores.bounds),
    finder: rows.flatMap((row) => row.componentScores.finder),
    quiet: rows.flatMap((row) => row.componentScores.quiet),
    timing: rows.flatMap((row) => row.componentScores.timing),
    combined: rows.flatMap((row) => row.componentScores.combined),
  });

const buildVisualizations = (
  variants: readonly VariantSummary[],
  thresholdSweeps: readonly VariantThresholdSweep[] | undefined,
): readonly StudyBarChart[] => {
  const rankingVariants = variants.filter((variant) => variant.variantId !== 'baseline');
  const scoreValues = rankingVariants.flatMap((variant) => [
    variant.positiveScores.avg,
    variant.negativeScores.avg,
  ]);
  const scoreMax = Math.max(1, ...scoreValues);
  const changedMax = Math.max(1, ...variants.map((row) => row.changedAssetCount));
  const charts: StudyBarChart[] = [
    {
      title: 'Grid-realism ranking score average by label',
      unit: 'score',
      rows: rankingVariants.flatMap((variant) => [
        barRow(`${variant.variantId} positive`, variant.positiveScores.avg, scoreMax),
        barRow(`${variant.variantId} negative`, variant.negativeScores.avg, scoreMax),
      ]),
    },
    {
      title: 'Assets whose representative order changed',
      unit: 'assets',
      rows: variants.map((variant) =>
        barRow(variant.variantId, variant.changedAssetCount, changedMax),
      ),
    },
    {
      title: 'Grid-realism component averages',
      unit: 'score',
      rows: componentBarRows(
        variants.find((variant) => variant.variantId === 'grid-realism-ranking') ?? variants[0],
      ),
    },
  ];
  const thresholdSweep = thresholdSweeps?.find(
    (sweep) =>
      sweep.variantId === 'grid-realism-ranking' || sweep.variantId === 'realism-phase-locked',
  );
  if (thresholdSweep !== undefined) {
    charts.push(
      {
        title: `${thresholdSweep.variantId} threshold decode-attempt reduction`,
        unit: '%',
        rows: thresholdSweep.thresholds.map((row) =>
          barRow(`>=${row.threshold.toFixed(2)}`, row.decodeAttemptReductionPct, 100),
        ),
      },
      {
        title: `${thresholdSweep.variantId} threshold lost positives`,
        unit: 'assets',
        rows: thresholdSweep.thresholds.map((row) =>
          barRow(
            `>=${row.threshold.toFixed(2)}`,
            row.positiveDecodedAssetsLost,
            Math.max(
              1,
              ...thresholdSweep.thresholds.map((entry) => entry.positiveDecodedAssetsLost),
            ),
          ),
        ),
      },
    );
  }
  const decodeVariants = variants.filter((variant) => variant.decodeAttemptCount !== undefined);
  if (decodeVariants.length === 0) return charts;
  charts.push(
    {
      title: 'Decode-confirmation positives',
      unit: 'assets',
      rows: decodeVariants.map((variant) =>
        barRow(
          variant.variantId,
          variant.positiveDecodedAssetCount ?? 0,
          Math.max(1, ...decodeVariants.map((row) => row.positiveDecodedAssetCount ?? 0)),
        ),
      ),
    },
    {
      title: 'Decode-confirmation false positives',
      unit: 'assets',
      rows: decodeVariants.map((variant) =>
        barRow(
          variant.variantId,
          variant.falsePositiveAssetCount ?? 0,
          Math.max(1, ...decodeVariants.map((row) => row.falsePositiveAssetCount ?? 0)),
        ),
      ),
    },
    {
      title: 'Decode attempts',
      unit: 'attempts',
      rows: decodeVariants.map((variant) =>
        barRow(
          variant.variantId,
          variant.decodeAttemptCount ?? 0,
          Math.max(1, ...decodeVariants.map((row) => row.decodeAttemptCount ?? 0)),
        ),
      ),
    },
  );
  return charts;
};

const componentBarRows = (variant: VariantSummary | undefined): readonly StudyBarChartRow[] => {
  if (variant === undefined) return [];
  return [
    barRow('projective', variant.components.projective.avg, 1),
    barRow('module', variant.components.module.avg, 1),
    barRow('bounds', variant.components.bounds.avg, 1),
    barRow('finder', variant.components.finder.avg, 1),
    barRow('quiet', variant.components.quiet.avg, 1),
    barRow('timing-phase-locked', variant.components.timing.avg, 1),
    barRow('combined', variant.components.combined.avg, 1),
  ];
};

const barRow = (label: string, value: number, max: number): StudyBarChartRow => ({
  label,
  value,
  bar: bar(value, max),
});

const bar = (value: number, max: number): string =>
  fractionalBar(Math.max(0, value) / Math.max(1, max), 24, { minVisible: value > 0 });

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
  cached = false,
): void => {
  log(
    `${STUDY_TIMING_PREFIX}${JSON.stringify({
      id: label,
      durationMs,
      outputCount: samples,
      cached,
    })}`,
  );
};
