import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { readBenchImage } from '../../tools/bench/src/shared/image.js';
import { readCorpusManifest } from '../../tools/corpus-cli/src/manifest.js';
import { clusterRankedProposals } from './src/pipeline/clusters.js';
import { runDecodeCascade } from './src/pipeline/decode-cascade.js';
import { normalizeImageInput } from './src/pipeline/frame.js';
import { assessProposalStructure } from './src/pipeline/plausibility.js';
import { generateProposals, rankProposals, type ScanProposal } from './src/pipeline/proposals.js';
import { type BinaryViewId, createViewBank } from './src/pipeline/views.js';

const DEFAULT_REPORT_FILE = path.join('tools', 'bench', 'reports', 'ironqr-view-study.json');
const DEFAULT_CACHE_FILE = path.join('tools', 'bench', '.cache', 'ironqr-view-study.json');
const CACHE_VERSION = 5;
const CHECKPOINT_INTERVAL = 1;
const LOG_INTERVAL = 8;

interface ViewAssetSummary {
  readonly assetId: string;
  readonly label: 'qr-positive' | 'non-qr-negative';
  readonly proposalCount: number;
  readonly bestProposalRank: number | null;
  readonly firstDecodeRank: number | null;
  readonly firstCorrectRank: number | null;
}

interface ViewAssetResult extends ViewAssetSummary {
  readonly viewId: BinaryViewId;
}

interface ViewAggregate {
  readonly viewId: BinaryViewId;
  readonly currentlyPrioritized: boolean;
  readonly positiveAssets: number;
  readonly negativeAssets: number;
  readonly positiveProposalAssets: number;
  readonly negativeProposalAssets: number;
  readonly positiveDecodedAssets: number;
  readonly positiveFirstWinnerAssets: number;
  readonly negativeFalsePositiveAssets: number;
  readonly averageBestProposalRank: number | null;
  readonly averageFirstCorrectRank: number | null;
  readonly averageFirstDecodeRank: number | null;
  readonly assetSummaries: readonly ViewAssetSummary[];
}

interface ProposalAttemptSummary {
  readonly rank: number;
  readonly proposal: ScanProposal;
  readonly viewId: BinaryViewId;
  readonly decodedText: string | null;
  readonly matchedExpected: boolean;
}

interface ProposalTiming {
  readonly rank: number;
  readonly viewId: BinaryViewId;
  readonly durationMs: number;
  readonly success: boolean;
  readonly matchedExpected: boolean;
}

interface ViewProgressState {
  readonly viewId: BinaryViewId;
  readonly proposalCount: number;
  readonly bestProposalRank: number | null;
  readonly firstDecodeRank: number | null;
  readonly firstCorrectRank: number | null;
}

interface MutableViewProgressState {
  viewId: BinaryViewId;
  proposalCount: number;
  bestProposalRank: number | null;
  firstDecodeRank: number | null;
  firstCorrectRank: number | null;
}

interface CachedAssetStudyBase {
  readonly assetId: string;
  readonly sha256: string;
  readonly label: 'qr-positive' | 'non-qr-negative';
  readonly relativePath: string;
  readonly firstGlobalCorrectViewId: BinaryViewId | null;
  readonly firstGlobalFalsePositiveViewId: BinaryViewId | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

interface CachedPartialAssetStudyResult extends CachedAssetStudyBase {
  readonly status: 'partial';
  readonly proposalCursor: number;
  readonly proposalCount: number;
  readonly elapsedMs: number;
  readonly proposalTimings: readonly ProposalTiming[];
  readonly viewProgress: readonly ViewProgressState[];
}

interface CachedCompleteAssetStudyResult extends CachedAssetStudyBase {
  readonly status: 'complete';
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly proposalTimings: readonly ProposalTiming[];
  readonly viewResults: readonly ViewAssetResult[];
}

type CachedAssetStudyResult = CachedPartialAssetStudyResult | CachedCompleteAssetStudyResult;

interface ViewStudyCacheFile {
  readonly version: number;
  readonly updatedAt: string;
  readonly viewIds: readonly BinaryViewId[];
  readonly prioritizedViewIds: readonly BinaryViewId[];
  readonly assets: Record<string, CachedAssetStudyResult>;
}

interface ViewStudyOptions {
  readonly reportFile: string;
  readonly cacheFile: string;
  readonly assetLimit?: number;
  readonly refreshCache: boolean;
  readonly verbose: boolean;
}

interface AssetTimingSummary {
  readonly assetId: string;
  readonly label: 'qr-positive' | 'non-qr-negative';
  readonly proposalCount: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

interface StudyAsset {
  readonly id: string;
  readonly sha256: string;
  readonly label: 'qr-positive' | 'non-qr-negative';
  readonly relativePath: string;
  readonly groundTruth?:
    | { readonly codes: readonly { readonly text: string }[] }
    | null
    | undefined;
}

interface ClusterProgressState {
  readonly id: string;
  readonly rank: number;
  readonly proposalCount: number;
  readonly representativeCount: number;
  processedRepresentatives: number;
  structuralFailures: number;
  outcome: 'pending' | 'decoded' | 'killed' | 'exhausted';
  observedViable: boolean;
}

interface ProposalClusterMeta {
  readonly clusterId: string;
  readonly clusterRank: number;
}

interface RepresentativeClusterMeta extends ProposalClusterMeta {
  readonly representativeIndex: number;
}

const STUDY_CLUSTER_MAX_REPRESENTATIVES = 3;
const STUDY_CLUSTER_STRUCTURAL_FAILURES = 3;

const parseArgs = (argv: readonly string[]): ViewStudyOptions => {
  let reportFile = DEFAULT_REPORT_FILE;
  let cacheFile = DEFAULT_CACHE_FILE;
  let assetLimit: number | undefined;
  let refreshCache = false;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--report-file') {
      reportFile = argv[index + 1] ?? reportFile;
      index += 1;
      continue;
    }
    if (value === '--cache-file') {
      cacheFile = argv[index + 1] ?? cacheFile;
      index += 1;
      continue;
    }
    if (value === '--limit') {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) assetLimit = Math.trunc(parsed);
      index += 1;
      continue;
    }
    if (value === '--refresh-cache') {
      refreshCache = true;
      continue;
    }
    if (value === '--verbose') {
      verbose = true;
    }
  }

  return {
    reportFile,
    cacheFile,
    ...(assetLimit === undefined ? {} : { assetLimit }),
    refreshCache,
    verbose,
  };
};

const mean = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
};

const resolveRepoRoot = (): string => {
  const override = process.env.IRONQR_REPO_ROOT;
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
};

const emptyCache = (): ViewStudyCacheFile => ({
  version: CACHE_VERSION,
  updatedAt: new Date(0).toISOString(),
  viewIds: [],
  prioritizedViewIds: [],
  assets: {},
});

const isValidCache = (value: unknown): value is ViewStudyCacheFile => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ViewStudyCacheFile>;
  return candidate.version === CACHE_VERSION && !!candidate.assets;
};

const loadCache = async (file: string, refreshCache: boolean): Promise<ViewStudyCacheFile> => {
  if (refreshCache) return emptyCache();
  try {
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isValidCache(parsed) ? parsed : emptyCache();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyCache();
    }
    throw error;
  }
};

const saveCache = async (file: string, cache: ViewStudyCacheFile): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
};

const createAggregateState = (
  viewIds: readonly BinaryViewId[],
  prioritizedViewIds: readonly BinaryViewId[],
) => {
  const prioritized = new Set(prioritizedViewIds);
  return new Map<
    BinaryViewId,
    {
      currentlyPrioritized: boolean;
      positiveAssets: number;
      negativeAssets: number;
      positiveProposalAssets: number;
      negativeProposalAssets: number;
      positiveDecodedAssets: number;
      positiveFirstWinnerAssets: number;
      negativeFalsePositiveAssets: number;
      bestProposalRanks: number[];
      firstCorrectRanks: number[];
      firstDecodeRanks: number[];
      assetSummaries: ViewAssetSummary[];
    }
  >(
    viewIds.map((viewId) => [
      viewId,
      {
        currentlyPrioritized: prioritized.has(viewId),
        positiveAssets: 0,
        negativeAssets: 0,
        positiveProposalAssets: 0,
        negativeProposalAssets: 0,
        positiveDecodedAssets: 0,
        positiveFirstWinnerAssets: 0,
        negativeFalsePositiveAssets: 0,
        bestProposalRanks: [],
        firstCorrectRanks: [],
        firstDecodeRanks: [],
        assetSummaries: [],
      },
    ]),
  );
};

const applyAssetResultToAggregates = (
  aggregates: ReturnType<typeof createAggregateState>,
  result: CachedCompleteAssetStudyResult,
): void => {
  for (const viewResult of result.viewResults) {
    const aggregate = aggregates.get(viewResult.viewId);
    if (!aggregate) continue;

    if (result.label === 'qr-positive') {
      aggregate.positiveAssets += 1;
      if (viewResult.proposalCount > 0) aggregate.positiveProposalAssets += 1;
      if (viewResult.firstCorrectRank !== null) aggregate.positiveDecodedAssets += 1;
      if (result.firstGlobalCorrectViewId === viewResult.viewId)
        aggregate.positiveFirstWinnerAssets += 1;
    } else {
      aggregate.negativeAssets += 1;
      if (viewResult.proposalCount > 0) aggregate.negativeProposalAssets += 1;
      if (result.firstGlobalFalsePositiveViewId === viewResult.viewId)
        aggregate.negativeFalsePositiveAssets += 1;
    }

    if (viewResult.bestProposalRank !== null)
      aggregate.bestProposalRanks.push(viewResult.bestProposalRank);
    if (viewResult.firstDecodeRank !== null)
      aggregate.firstDecodeRanks.push(viewResult.firstDecodeRank);
    if (viewResult.firstCorrectRank !== null)
      aggregate.firstCorrectRanks.push(viewResult.firstCorrectRank);
    aggregate.assetSummaries.push({
      assetId: viewResult.assetId,
      label: viewResult.label,
      proposalCount: viewResult.proposalCount,
      bestProposalRank: viewResult.bestProposalRank,
      firstDecodeRank: viewResult.firstDecodeRank,
      firstCorrectRank: viewResult.firstCorrectRank,
    });
  }
};

const buildViewReport = (
  aggregates: ReturnType<typeof createAggregateState>,
): readonly ViewAggregate[] => {
  return [...aggregates.entries()]
    .map(([viewId, aggregate]) => ({
      viewId,
      currentlyPrioritized: aggregate.currentlyPrioritized,
      positiveAssets: aggregate.positiveAssets,
      negativeAssets: aggregate.negativeAssets,
      positiveProposalAssets: aggregate.positiveProposalAssets,
      negativeProposalAssets: aggregate.negativeProposalAssets,
      positiveDecodedAssets: aggregate.positiveDecodedAssets,
      positiveFirstWinnerAssets: aggregate.positiveFirstWinnerAssets,
      negativeFalsePositiveAssets: aggregate.negativeFalsePositiveAssets,
      averageBestProposalRank: mean(aggregate.bestProposalRanks),
      averageFirstCorrectRank: mean(aggregate.firstCorrectRanks),
      averageFirstDecodeRank: mean(aggregate.firstDecodeRanks),
      assetSummaries: aggregate.assetSummaries,
    }))
    .sort((left, right) => {
      if (left.positiveDecodedAssets !== right.positiveDecodedAssets) {
        return right.positiveDecodedAssets - left.positiveDecodedAssets;
      }
      if (left.positiveFirstWinnerAssets !== right.positiveFirstWinnerAssets) {
        return right.positiveFirstWinnerAssets - left.positiveFirstWinnerAssets;
      }
      if (left.negativeFalsePositiveAssets !== right.negativeFalsePositiveAssets) {
        return left.negativeFalsePositiveAssets - right.negativeFalsePositiveAssets;
      }
      return (
        (left.averageFirstCorrectRank ?? Number.POSITIVE_INFINITY) -
        (right.averageFirstCorrectRank ?? Number.POSITIVE_INFINITY)
      );
    });
};

const resolveViewIds = async (
  repoRoot: string,
  approvedAssets: readonly { relativePath: string }[],
  cache: ViewStudyCacheFile,
): Promise<{
  readonly viewIds: readonly BinaryViewId[];
  readonly prioritizedViewIds: readonly BinaryViewId[];
}> => {
  if (cache.viewIds.length > 0) {
    return {
      viewIds: cache.viewIds,
      prioritizedViewIds: cache.prioritizedViewIds,
    };
  }

  const firstAsset = approvedAssets[0];
  if (!firstAsset) {
    return {
      viewIds: [],
      prioritizedViewIds: [],
    };
  }

  const imagePath = path.resolve(repoRoot, 'corpus', 'data', firstAsset.relativePath);
  const image = await readBenchImage(imagePath);
  const imageData = await Effect.runPromise(normalizeImageInput(image as never));
  const viewBank = createViewBank(imageData);
  return {
    viewIds: viewBank.listBinaryViewIds(),
    prioritizedViewIds: viewBank.listProposalViewIds(),
  };
};

const createEmptyViewProgress = (viewIds: readonly BinaryViewId[]): ViewProgressState[] => {
  return viewIds.map((viewId) => ({
    viewId,
    proposalCount: 0,
    bestProposalRank: null,
    firstDecodeRank: null,
    firstCorrectRank: null,
  }));
};

const createViewProgressMap = (
  viewProgress: readonly ViewProgressState[],
): Map<BinaryViewId, MutableViewProgressState> => {
  return new Map(viewProgress.map((entry) => [entry.viewId, { ...entry }]));
};

const materializeViewProgress = (
  viewIds: readonly BinaryViewId[],
  progressMap: Map<BinaryViewId, MutableViewProgressState>,
): readonly ViewProgressState[] => {
  return viewIds.map((viewId) => ({
    ...(progressMap.get(viewId) ?? {
      viewId,
      proposalCount: 0,
      bestProposalRank: null,
      firstDecodeRank: null,
      firstCorrectRank: null,
    }),
  }));
};

const toViewResults = (
  asset: Pick<StudyAsset, 'id' | 'label'>,
  viewIds: readonly BinaryViewId[],
  progressMap: Map<BinaryViewId, MutableViewProgressState>,
): readonly ViewAssetResult[] => {
  return viewIds.map((viewId) => {
    const progress = progressMap.get(viewId);
    return {
      viewId,
      assetId: asset.id,
      label: asset.label,
      proposalCount: progress?.proposalCount ?? 0,
      bestProposalRank: progress?.bestProposalRank ?? null,
      firstDecodeRank: progress?.firstDecodeRank ?? null,
      firstCorrectRank: progress?.firstCorrectRank ?? null,
    } satisfies ViewAssetResult;
  });
};

const isCompleteAssetResult = (
  value: CachedAssetStudyResult | undefined,
): value is CachedCompleteAssetStudyResult => {
  return value?.status === 'complete';
};

const isPartialAssetResult = (
  value: CachedAssetStudyResult | undefined,
): value is CachedPartialAssetStudyResult => {
  return value?.status === 'partial';
};

const assetCacheMatches = (
  cached: CachedAssetStudyResult | undefined,
  asset: Pick<StudyAsset, 'id' | 'sha256' | 'label' | 'relativePath'>,
  viewIds: readonly BinaryViewId[],
): boolean => {
  if (!cached) return false;
  if (
    cached.assetId !== asset.id ||
    cached.sha256 !== asset.sha256 ||
    cached.label !== asset.label ||
    cached.relativePath !== asset.relativePath
  ) {
    return false;
  }
  if (isCompleteAssetResult(cached)) {
    return cached.viewResults.length === viewIds.length;
  }
  return cached.viewProgress.length === viewIds.length;
};

const buildPartialResult = (
  asset: Pick<StudyAsset, 'id' | 'sha256' | 'label' | 'relativePath'>,
  startedAt: string,
  proposalCursor: number,
  proposalCount: number,
  proposalTimings: readonly ProposalTiming[],
  firstGlobalCorrectViewId: BinaryViewId | null,
  firstGlobalFalsePositiveViewId: BinaryViewId | null,
  viewIds: readonly BinaryViewId[],
  progressMap: Map<BinaryViewId, MutableViewProgressState>,
): CachedPartialAssetStudyResult => {
  const updatedAt = new Date().toISOString();
  return {
    status: 'partial',
    assetId: asset.id,
    sha256: asset.sha256,
    label: asset.label,
    relativePath: asset.relativePath,
    proposalCursor,
    proposalCount,
    elapsedMs: Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)),
    proposalTimings,
    firstGlobalCorrectViewId,
    firstGlobalFalsePositiveViewId,
    startedAt,
    viewProgress: materializeViewProgress(viewIds, progressMap),
    updatedAt,
  };
};

const buildCompleteResult = (
  asset: Pick<StudyAsset, 'id' | 'sha256' | 'label' | 'relativePath'>,
  startedAt: string,
  proposalTimings: readonly ProposalTiming[],
  firstGlobalCorrectViewId: BinaryViewId | null,
  firstGlobalFalsePositiveViewId: BinaryViewId | null,
  viewIds: readonly BinaryViewId[],
  progressMap: Map<BinaryViewId, MutableViewProgressState>,
): CachedCompleteAssetStudyResult => {
  const finishedAt = new Date().toISOString();
  return {
    status: 'complete',
    assetId: asset.id,
    sha256: asset.sha256,
    label: asset.label,
    relativePath: asset.relativePath,
    firstGlobalCorrectViewId,
    firstGlobalFalsePositiveViewId,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    proposalTimings,
    viewResults: toViewResults(asset, viewIds, progressMap),
    updatedAt: finishedAt,
  };
};

const checkpointNeeded = (proposalCursor: number, proposalCount: number): boolean => {
  return proposalCursor >= proposalCount || proposalCursor % CHECKPOINT_INTERVAL === 0;
};

const progressLogNeeded = (proposalCursor: number, proposalCount: number): boolean => {
  return proposalCursor >= proposalCount || proposalCursor % LOG_INTERVAL === 0;
};

const createClusterProgress = (proposals: readonly ScanProposal[]) => {
  const clusters = clusterRankedProposals(proposals, {
    maxRepresentatives: STUDY_CLUSTER_MAX_REPRESENTATIVES,
  });
  const states = new Map<string, ClusterProgressState>(
    clusters.map((cluster, index) => [
      cluster.id,
      {
        id: cluster.id,
        rank: index + 1,
        proposalCount: cluster.proposals.length,
        representativeCount: cluster.representatives.length,
        processedRepresentatives: 0,
        structuralFailures: 0,
        outcome: 'pending',
        observedViable: false,
      },
    ]),
  );
  const proposalMeta = new Map<string, ProposalClusterMeta>();
  const representativeMeta = new Map<string, RepresentativeClusterMeta>();
  for (const [clusterIndex, cluster] of clusters.entries()) {
    const clusterRank = clusterIndex + 1;
    for (const proposal of cluster.proposals) {
      proposalMeta.set(proposal.id, {
        clusterId: cluster.id,
        clusterRank,
      });
    }
    for (const [representativeIndex, proposal] of cluster.representatives.entries()) {
      representativeMeta.set(proposal.id, {
        clusterId: cluster.id,
        clusterRank,
        representativeIndex: representativeIndex + 1,
      });
    }
  }
  return {
    clusters,
    states,
    proposalMeta,
    representativeMeta,
    representativeCount: clusters.reduce((sum, cluster) => sum + cluster.representatives.length, 0),
  };
};

const summarizeClusterProgress = (states: Iterable<ClusterProgressState>) => {
  const summary = {
    viable: 0,
    pending: 0,
    decoded: 0,
    killed: 0,
    exhausted: 0,
  };
  for (const state of states) {
    if (state.observedViable) summary.viable += 1;
    summary[state.outcome] += 1;
  }
  return summary;
};

const applyRepresentativeObservation = (
  state: ClusterProgressState,
  structurePassed: boolean,
  success: boolean,
): 'decoded' | 'killed' | 'exhausted' | null => {
  if (state.outcome !== 'pending') return null;
  state.processedRepresentatives += 1;
  if (!structurePassed) {
    state.structuralFailures += 1;
    if (state.structuralFailures >= STUDY_CLUSTER_STRUCTURAL_FAILURES) {
      state.outcome = 'killed';
      return 'killed';
    }
    if (state.processedRepresentatives >= state.representativeCount) {
      state.outcome = 'exhausted';
      return 'exhausted';
    }
    return null;
  }
  if (success) {
    state.outcome = 'decoded';
    return 'decoded';
  }
  if (state.processedRepresentatives >= state.representativeCount) {
    state.outcome = 'exhausted';
    return 'exhausted';
  }
  return null;
};

const finalizeClusterProgress = (states: Iterable<ClusterProgressState>) => {
  const materialized = [...states];
  for (const state of materialized) {
    if (state.outcome === 'pending') {
      state.outcome = 'exhausted';
    }
  }
  return summarizeClusterProgress(materialized);
};

const formatSimulatedClusterOutcome = (
  outcome: Exclude<ClusterProgressState['outcome'], 'pending'>,
): string => {
  switch (outcome) {
    case 'decoded':
      return 'would-decode';
    case 'killed':
      return 'would-kill';
    case 'exhausted':
      return 'would-exhaust';
  }
};

const formatLogTimestamp = (): string => {
  return new Date().toISOString();
};

const logStudyMessage = (message: string): void => {
  console.error(`[${formatLogTimestamp()}] ${message}`);
};

const computeAssetResult = async (
  repoRoot: string,
  asset: StudyAsset,
  viewIds: readonly BinaryViewId[],
  resume: CachedPartialAssetStudyResult | null,
  persistPartial: (result: CachedPartialAssetStudyResult) => Promise<void>,
  logPrefix: string,
  verbose: boolean,
): Promise<CachedCompleteAssetStudyResult> => {
  const imagePath = path.resolve(repoRoot, 'corpus', 'data', asset.relativePath);
  const image = await readBenchImage(imagePath);
  const imageData = await Effect.runPromise(normalizeImageInput(image as never));
  const viewBank = createViewBank(imageData);
  const expectedTexts = new Set(asset.groundTruth?.codes.map((code) => code.text) ?? []);
  const proposals = rankProposals(
    viewBank,
    generateProposals(viewBank, {
      viewIds,
    }),
  );
  const proposalCount = proposals.length;
  const topProposalScore = proposals[0]?.proposalScore ?? 0;
  const clusterProgress = createClusterProgress(proposals);
  const canResume = resume !== null && resume.proposalCount === proposalCount;
  const progressMap = createViewProgressMap(
    canResume ? resume.viewProgress : createEmptyViewProgress(viewIds),
  );
  const proposalTimings: ProposalTiming[] = canResume ? [...resume.proposalTimings] : [];
  let firstGlobalCorrectViewId = canResume ? resume.firstGlobalCorrectViewId : null;
  let firstGlobalFalsePositiveViewId = canResume ? resume.firstGlobalFalsePositiveViewId : null;
  let proposalCursor = canResume ? resume.proposalCursor : 0;
  const startedAt = canResume ? resume.startedAt : new Date().toISOString();

  if (canResume && proposalCursor > 0) {
    logStudyMessage(
      `${logPrefix} resume ${proposalCursor}/${proposalCount} elapsed ${resume.elapsedMs}ms clusters ${clusterProgress.clusters.length} reps ${clusterProgress.representativeCount}`,
    );
  } else {
    logStudyMessage(
      `${logPrefix} proposals ${proposalCount} clusters ${clusterProgress.clusters.length} reps ${clusterProgress.representativeCount}`,
    );
  }

  const proposalTimingByRank = new Map(proposalTimings.map((timing) => [timing.rank, timing]));
  for (let proposalIndex = 0; proposalIndex < proposalCursor; proposalIndex += 1) {
    const proposal = proposals[proposalIndex];
    if (!proposal) continue;
    const priorTiming = proposalTimingByRank.get(proposalIndex + 1);
    const proposalMeta = clusterProgress.proposalMeta.get(proposal.id);
    if (proposalMeta && priorTiming?.success === true) {
      const state = clusterProgress.states.get(proposalMeta.clusterId);
      if (state) state.observedViable = true;
    }
    const meta = clusterProgress.representativeMeta.get(proposal.id);
    if (!meta) continue;
    const structure = assessProposalStructure(proposal, viewBank);
    const state = clusterProgress.states.get(meta.clusterId);
    if (!state) continue;
    applyRepresentativeObservation(state, structure.passed, priorTiming?.success === true);
  }

  for (let proposalIndex = proposalCursor; proposalIndex < proposalCount; proposalIndex += 1) {
    const proposal = proposals[proposalIndex];
    if (!proposal) continue;
    const rank = proposalIndex + 1;
    const attemptStartedAt = Date.now();
    const success = await Effect.runPromise(
      runDecodeCascade(proposal, viewBank, {
        proposalRank: rank,
        topProposalScore,
      }),
    );
    const decodedText = success?.result.payload.text ?? null;
    const matchedExpected = decodedText !== null && expectedTexts.has(decodedText);
    const attempt = {
      rank,
      proposal,
      viewId: proposal.binaryViewId,
      decodedText,
      matchedExpected,
    } satisfies ProposalAttemptSummary;
    const proposalMeta = clusterProgress.proposalMeta.get(proposal.id);
    if (proposalMeta && success !== null) {
      const clusterState = clusterProgress.states.get(proposalMeta.clusterId);
      if (clusterState && !clusterState.observedViable) {
        clusterState.observedViable = true;
        if (verbose) {
          logStudyMessage(
            `${logPrefix} cluster ${proposalMeta.clusterRank}/${clusterProgress.clusters.length} observed-viable at proposal ${rank}/${proposalCount}`,
          );
        }
      }
    }
    const representativeMeta = clusterProgress.representativeMeta.get(proposal.id);
    if (representativeMeta) {
      const structure = assessProposalStructure(proposal, viewBank);
      const clusterState = clusterProgress.states.get(representativeMeta.clusterId);
      if (clusterState) {
        const outcome = applyRepresentativeObservation(
          clusterState,
          structure.passed,
          success !== null,
        );
        if (verbose && outcome !== null) {
          logStudyMessage(
            `${logPrefix} cluster ${representativeMeta.clusterRank}/${clusterProgress.clusters.length} ${formatSimulatedClusterOutcome(outcome)} at proposal ${rank}/${proposalCount} rep ${representativeMeta.representativeIndex}/${clusterState.representativeCount}`,
          );
        }
      }
    }
    proposalTimings.push({
      rank,
      viewId: proposal.binaryViewId,
      durationMs: Date.now() - attemptStartedAt,
      success: success !== null,
      matchedExpected,
    });
    const progress = progressMap.get(attempt.viewId);
    if (!progress) continue;

    progress.proposalCount += 1;
    if (progress.bestProposalRank === null) progress.bestProposalRank = rank;
    if (attempt.decodedText !== null && progress.firstDecodeRank === null) {
      progress.firstDecodeRank = rank;
    }
    if (attempt.matchedExpected && progress.firstCorrectRank === null) {
      progress.firstCorrectRank = rank;
    }
    if (
      asset.label === 'qr-positive' &&
      attempt.matchedExpected &&
      firstGlobalCorrectViewId === null
    ) {
      firstGlobalCorrectViewId = attempt.viewId;
    }
    if (
      asset.label === 'non-qr-negative' &&
      attempt.decodedText !== null &&
      firstGlobalFalsePositiveViewId === null
    ) {
      firstGlobalFalsePositiveViewId = attempt.viewId;
    }

    proposalCursor = rank;
    if (checkpointNeeded(proposalCursor, proposalCount)) {
      await persistPartial(
        buildPartialResult(
          asset,
          startedAt,
          proposalCursor,
          proposalCount,
          proposalTimings,
          firstGlobalCorrectViewId,
          firstGlobalFalsePositiveViewId,
          viewIds,
          progressMap,
        ),
      );
      if (progressLogNeeded(proposalCursor, proposalCount)) {
        const clusterSummary = summarizeClusterProgress(clusterProgress.states.values());
        logStudyMessage(
          `${logPrefix} proposal ${proposalCursor}/${proposalCount} clusters viable ${clusterSummary.viable} would-decode ${clusterSummary.decoded} would-kill ${clusterSummary.killed} would-exhaust ${clusterSummary.exhausted} pending ${clusterSummary.pending}`,
        );
      }
    }
  }

  const finalClusterSummary = finalizeClusterProgress(clusterProgress.states.values());
  logStudyMessage(
    `${logPrefix} cluster-summary viable ${finalClusterSummary.viable} would-decode ${finalClusterSummary.decoded} would-kill ${finalClusterSummary.killed} would-exhaust ${finalClusterSummary.exhausted}`,
  );

  return buildCompleteResult(
    asset,
    startedAt,
    proposalTimings,
    firstGlobalCorrectViewId,
    firstGlobalFalsePositiveViewId,
    viewIds,
    progressMap,
  );
};

const buildReport = (
  reportFile: string,
  approvedAssets: readonly { label: 'qr-positive' | 'non-qr-negative' }[],
  prioritizedViewIds: readonly BinaryViewId[],
  views: readonly ViewAggregate[],
  cacheFile: string,
  cacheHits: number,
  cacheMisses: number,
  cacheResumes: number,
  assetTimings: readonly AssetTimingSummary[],
) => {
  const recommendedPriorityOrder = views.map((view) => view.viewId);
  const totalDurationMs = assetTimings.reduce((sum, asset) => sum + asset.durationMs, 0);
  return {
    createdAt: new Date().toISOString(),
    reportFile,
    cacheFile,
    approvedAssetCount: approvedAssets.length,
    positiveAssetCount: approvedAssets.filter((asset) => asset.label === 'qr-positive').length,
    negativeAssetCount: approvedAssets.filter((asset) => asset.label === 'non-qr-negative').length,
    cacheHits,
    cacheMisses,
    cacheResumes,
    totalDurationMs,
    averageDurationMs:
      assetTimings.length === 0 ? 0 : Math.round(totalDurationMs / assetTimings.length),
    assetTimings,
    prioritizedViews: [...prioritizedViewIds],
    recommendedPriorityOrder,
    recommendedTop18: recommendedPriorityOrder.slice(0, 18),
    views,
  };
};

const main = async (): Promise<void> => {
  const repoRoot = resolveRepoRoot();
  const options = parseArgs(process.argv.slice(2));
  const reportFile = path.resolve(repoRoot, options.reportFile);
  const cacheFile = path.resolve(repoRoot, options.cacheFile);
  let cache = await loadCache(cacheFile, options.refreshCache);
  const manifest = await readCorpusManifest(repoRoot);
  const approvedAssets = manifest.assets
    .filter((asset) => asset.review.status === 'approved')
    .slice(0, options.assetLimit);
  const { viewIds, prioritizedViewIds } = await resolveViewIds(repoRoot, approvedAssets, cache);

  cache = {
    ...cache,
    updatedAt: new Date().toISOString(),
    viewIds,
    prioritizedViewIds,
  };
  await saveCache(cacheFile, cache);

  const aggregates = createAggregateState(viewIds, prioritizedViewIds);
  const assetTimings: AssetTimingSummary[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let cacheResumes = 0;

  for (const [assetIndex, asset] of approvedAssets.entries()) {
    const cached = cache.assets[asset.id];
    const logPrefix = `[view-study] ${assetIndex + 1}/${approvedAssets.length} ${asset.id}`;

    if (assetCacheMatches(cached, asset, viewIds) && isCompleteAssetResult(cached)) {
      cacheHits += 1;
      logStudyMessage(`${logPrefix} cache-hit ${cached.durationMs}ms`);
      applyAssetResultToAggregates(aggregates, cached);
      assetTimings.push({
        assetId: cached.assetId,
        label: cached.label,
        proposalCount: cached.viewResults.reduce((sum, view) => sum + view.proposalCount, 0),
        startedAt: cached.startedAt,
        finishedAt: cached.finishedAt,
        durationMs: cached.durationMs,
      });
      continue;
    }

    const resume =
      assetCacheMatches(cached, asset, viewIds) && isPartialAssetResult(cached) ? cached : null;
    if (resume) {
      cacheResumes += 1;
    } else {
      cacheMisses += 1;
      logStudyMessage(`${logPrefix} scanning`);
    }

    const persistPartial = async (result: CachedPartialAssetStudyResult): Promise<void> => {
      cache = {
        ...cache,
        updatedAt: new Date().toISOString(),
        assets: {
          ...cache.assets,
          [asset.id]: result,
        },
      };
      await saveCache(cacheFile, cache);
    };

    const result = await computeAssetResult(
      repoRoot,
      asset,
      viewIds,
      resume,
      persistPartial,
      logPrefix,
      options.verbose,
    );
    applyAssetResultToAggregates(aggregates, result);
    assetTimings.push({
      assetId: result.assetId,
      label: result.label,
      proposalCount: result.viewResults.reduce((sum, view) => sum + view.proposalCount, 0),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
    });
    cache = {
      ...cache,
      updatedAt: new Date().toISOString(),
      assets: {
        ...cache.assets,
        [asset.id]: result,
      },
    };
    await saveCache(cacheFile, cache);
    logStudyMessage(`${logPrefix} complete ${result.durationMs}ms`);
  }

  assetTimings.sort((left, right) => right.durationMs - left.durationMs);
  const views = buildViewReport(aggregates);
  const report = buildReport(
    reportFile,
    approvedAssets,
    prioritizedViewIds,
    views,
    cacheFile,
    cacheHits,
    cacheMisses,
    cacheResumes,
    assetTimings,
  );

  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`report: ${reportFile}`);
  console.log(`cacheFile: ${cacheFile}`);
  console.log(`approvedAssets: ${report.approvedAssetCount}`);
  console.log(`positives: ${report.positiveAssetCount}`);
  console.log(`negatives: ${report.negativeAssetCount}`);
  console.log(`cacheHits: ${cacheHits}`);
  console.log(`cacheMisses: ${cacheMisses}`);
  console.log(`cacheResumes: ${cacheResumes}`);
  console.log(`totalDurationMs: ${report.totalDurationMs}`);
  console.log(`averageDurationMs: ${report.averageDurationMs}`);
  console.log('slowestAssets{asset,label,proposalCount,durationMs}:');
  for (const asset of assetTimings.slice(0, 10)) {
    console.log(`  ${asset.assetId},${asset.label},${asset.proposalCount},${asset.durationMs}`);
  }
  console.log(
    'topViews{view,decoded,firstWins,falsePositives,avgBestRank,avgCorrectRank,prioritized}:',
  );
  for (const view of views.slice(0, 20)) {
    console.log(
      `  ${view.viewId},${view.positiveDecodedAssets},${view.positiveFirstWinnerAssets},${view.negativeFalsePositiveAssets},${view.averageBestProposalRank ?? '-'},${view.averageFirstCorrectRank ?? '-'},${view.currentlyPrioritized ? 'yes' : 'no'}`,
    );
  }
};

await main();
