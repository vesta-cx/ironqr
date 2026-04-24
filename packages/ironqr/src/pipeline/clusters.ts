import type { Point } from '../contracts/geometry.js';
import type { FinderEvidence, ProposalScoreBreakdown, ScanProposal } from './proposals.js';
import type { BinaryViewId } from './views.js';

const DEFAULT_MAX_CLUSTER_REPRESENTATIVES = 3;
const PROPOSAL_CLUSTER_QUANTIZATION = 24;

/**
 * One grouped QR candidate spanning multiple near-duplicate proposals.
 */
export interface ProposalCluster {
  /** Stable cluster id derived from proposal geometry. */
  readonly id: string;
  /** Best-first ranked proposals that collapsed into the cluster. */
  readonly proposals: readonly ScanProposal[];
  /** Canonical cluster-level proposal to probe before any proposal-level fallback. */
  readonly representatives: readonly ScanProposal[];
  /** Score of the strongest proposal in the cluster. */
  readonly bestProposalScore: number;
  /** Aggregate cluster confidence combining score, support, and view diversity. */
  readonly clusterScore: number;
  /** Number of proposals supporting this cluster. */
  readonly supportCount: number;
  /** Number of distinct binary views supporting this cluster. */
  readonly viewDiversity: number;
}

/**
 * Cluster-construction options.
 */
export interface ProposalClusterOptions {
  /** Maximum representative proposals retained per cluster. */
  readonly maxRepresentatives?: number;
}

/**
 * Groups ranked proposals into coarse QR-candidate clusters and selects a small
 * diverse representative set for each cluster.
 *
 * @param proposals - Best-first ranked proposals.
 * @param options - Representative budgeting options.
 * @returns Best-first candidate clusters.
 */
export const clusterRankedProposals = (
  proposals: readonly ScanProposal[],
  options: ProposalClusterOptions = {},
): readonly ProposalCluster[] => {
  const representativeBudget = Math.min(
    2,
    normalizeRepresentativeBudget(options.maxRepresentatives),
  );
  const grouped = new Map<string, ScanProposal[]>();

  for (const proposal of proposals) {
    const clusterId = proposalClusterKey(proposal);
    const existing = grouped.get(clusterId);
    if (existing) {
      existing.push(proposal);
      continue;
    }
    grouped.set(clusterId, [proposal]);
  }

  return [...grouped.entries()]
    .map(([id, clusterProposals]) => {
      const orderedProposals = [...clusterProposals].sort(
        (left, right) => right.proposalScore - left.proposalScore,
      );
      const clusterScore = scoreCluster(orderedProposals);
      const representatives = createClusterRepresentatives(
        id,
        orderedProposals,
        clusterScore,
        representativeBudget,
      );
      return {
        id,
        proposals: orderedProposals,
        representatives,
        bestProposalScore: orderedProposals[0]?.proposalScore ?? 0,
        clusterScore,
        supportCount: orderedProposals.length,
        viewDiversity: new Set(orderedProposals.map((proposal) => proposal.binaryViewId)).size,
      };
    })
    .sort((left, right) => right.clusterScore - left.clusterScore);
};

const scoreCluster = (proposals: readonly ScanProposal[]): number => {
  const bestScore = proposals[0]?.proposalScore ?? 0;
  const supportBonus = Math.log1p(proposals.length) * 0.75;
  const viewDiversity = new Set(proposals.map((proposal) => proposal.binaryViewId)).size;
  const familyDiversity = new Set(proposals.map((proposal) => viewFamilyKey(proposal.binaryViewId)))
    .size;
  const diversityBonus = Math.log1p(viewDiversity) * 0.4 + Math.log1p(familyDiversity) * 0.25;
  const spreadPenalty = clusterSpreadPenalty(proposals);
  return bestScore + supportBonus + diversityBonus - spreadPenalty;
};

const clusterSpreadPenalty = (proposals: readonly ScanProposal[]): number => {
  const centroids = proposals
    .map((proposal) => centroid(proposalClusterPoints(proposal)))
    .filter((point): point is Point => point !== null);
  if (centroids.length < 2) return 0;
  const center = centroid(centroids);
  if (!center) return 0;
  const averageDistance =
    centroids.reduce((sum, point) => sum + Math.hypot(point.x - center.x, point.y - center.y), 0) /
    centroids.length;
  return Math.min(3, averageDistance / PROPOSAL_CLUSTER_QUANTIZATION);
};

const createClusterRepresentatives = (
  clusterId: string,
  proposals: readonly ScanProposal[],
  clusterScore: number,
  representativeBudget: number,
): readonly ScanProposal[] => {
  const best = proposals[0];
  if (!best || representativeBudget < 1) return [];
  const finderProposals = proposals.filter((proposal) => proposal.kind === 'finder-triple');
  const primary =
    finderProposals.length === proposals.length && finderProposals.length > 0
      ? createFinderTripleClusterRepresentative(clusterId, finderProposals, clusterScore)
      : { ...best, id: `cluster:${clusterId}:best`, proposalScore: clusterScore };
  if (representativeBudget < 2 || primary.id === best.id) return [primary];
  return [primary, best];
};

const createFinderTripleClusterRepresentative = (
  clusterId: string,
  proposals: readonly Extract<ScanProposal, { readonly kind: 'finder-triple' }>[],
  clusterScore: number,
): ScanProposal => {
  const best = proposals[0];
  if (!best) throw new RangeError('Cannot average an empty proposal cluster.');
  const oriented = proposals.map((proposal) => ({
    proposal,
    finders: orientFinders(proposal.finders),
  }));
  const weights = oriented.map(({ proposal }) => Math.max(1, proposal.proposalScore));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const averageAt = (index: 0 | 1 | 2): FinderEvidence => {
    const values = oriented.map(({ finders }) => finders[index]);
    const weighted = <
      K extends keyof Pick<
        FinderEvidence,
        'centerX' | 'centerY' | 'moduleSize' | 'hModuleSize' | 'vModuleSize' | 'score'
      >,
    >(
      key: K,
    ): number =>
      values.reduce(
        (sum, finder, valueIndex) => sum + (finder[key] ?? 0) * (weights[valueIndex] ?? 1),
        0,
      ) / totalWeight;
    return {
      source: values[0]?.source ?? 'row-scan',
      centerX: weighted('centerX'),
      centerY: weighted('centerY'),
      moduleSize: weighted('moduleSize'),
      hModuleSize: weighted('hModuleSize'),
      vModuleSize: weighted('vModuleSize'),
      score: weighted('score'),
    };
  };

  return {
    id: `cluster:${clusterId}:average`,
    kind: 'finder-triple',
    binaryViewId: best.binaryViewId,
    finders: [averageAt(0), averageAt(1), averageAt(2)],
    estimatedVersions: mostLikelyVersions(proposals),
    proposalScore: clusterScore,
    scoreBreakdown: aggregateScoreBreakdown(proposals, clusterScore),
  };
};

const orientFinders = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
): readonly [FinderEvidence, FinderEvidence, FinderEvidence] => {
  const lengths = [
    {
      left: finders[0],
      right: finders[1],
      opposite: finders[2],
      length: finderDistance(finders[0], finders[1]),
    },
    {
      left: finders[0],
      right: finders[2],
      opposite: finders[1],
      length: finderDistance(finders[0], finders[2]),
    },
    {
      left: finders[1],
      right: finders[2],
      opposite: finders[0],
      length: finderDistance(finders[1], finders[2]),
    },
  ].sort((left, right) => right.length - left.length);
  const hyp = lengths[0];
  if (!hyp) throw new RangeError('Cannot orient an empty finder triple.');
  const topLeft = hyp.opposite;
  let topRight = hyp.left;
  let bottomLeft = hyp.right;
  const cross =
    (topRight.centerX - topLeft.centerX) * (bottomLeft.centerY - topLeft.centerY) -
    (topRight.centerY - topLeft.centerY) * (bottomLeft.centerX - topLeft.centerX);
  if (cross < 0) [topRight, bottomLeft] = [bottomLeft, topRight];
  return [topLeft, topRight, bottomLeft];
};

const mostLikelyVersions = (proposals: readonly ScanProposal[]): readonly number[] => {
  const counts = new Map<number, number>();
  for (const proposal of proposals) {
    for (const version of proposal.estimatedVersions)
      counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([version]) => version);
  return ranked.length > 0 ? ranked.slice(0, 3) : (proposals[0]?.estimatedVersions ?? [1]);
};

const aggregateScoreBreakdown = (
  proposals: readonly ScanProposal[],
  total: number,
): ProposalScoreBreakdown => {
  const average = (field: keyof Omit<ProposalScoreBreakdown, 'total'>): number =>
    proposals.reduce((sum, proposal) => sum + proposal.scoreBreakdown[field], 0) /
    Math.max(1, proposals.length);
  return {
    detectorScore: average('detectorScore'),
    geometryScore: average('geometryScore'),
    quietZoneScore: average('quietZoneScore'),
    timingScore: average('timingScore'),
    alignmentScore: average('alignmentScore'),
    penalties: average('penalties'),
    total,
  };
};

const proposalClusterKey = (proposal: ScanProposal): string => {
  const points = proposalClusterPoints(proposal);
  if (points.length === 0) return `${proposal.id}:empty`;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const centroidX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const centroidY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return [
    proposal.estimatedVersions[0] ?? 0,
    Math.round(centroidX / PROPOSAL_CLUSTER_QUANTIZATION),
    Math.round(centroidY / PROPOSAL_CLUSTER_QUANTIZATION),
    Math.round(width / PROPOSAL_CLUSTER_QUANTIZATION),
    Math.round(height / PROPOSAL_CLUSTER_QUANTIZATION),
  ].join(':');
};

const viewFamilyKey = (binaryViewId: BinaryViewId): string => {
  const { scalarViewId } = parseBinaryViewId(binaryViewId);
  if (scalarViewId === 'gray') return 'gray';
  if (scalarViewId === 'oklab-l') return 'oklab-l';
  if (scalarViewId.startsWith('oklab')) return 'oklab-chroma';
  return 'rgb';
};

const proposalClusterPoints = (proposal: ScanProposal): readonly Point[] => {
  if (proposal.kind === 'finder-triple') {
    return proposal.finders.map((finder) => ({ x: finder.centerX, y: finder.centerY }));
  }
  if (proposal.corners) {
    return [
      proposal.corners.topLeft,
      proposal.corners.topRight,
      proposal.corners.bottomRight,
      proposal.corners.bottomLeft,
    ];
  }
  return proposal.finderLikeEvidence.map((finder) => ({ x: finder.centerX, y: finder.centerY }));
};

const centroid = (points: readonly Point[]): Point | null => {
  if (points.length === 0) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
};

const finderDistance = (left: FinderEvidence, right: FinderEvidence): number =>
  Math.hypot(right.centerX - left.centerX, right.centerY - left.centerY);

const normalizeRepresentativeBudget = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CLUSTER_REPRESENTATIVES;
  return Math.max(1, Math.trunc(value));
};

const parseBinaryViewId = (
  binaryViewId: BinaryViewId,
): { readonly scalarViewId: string; readonly threshold: string; readonly polarity: string } => {
  const [scalarViewId, threshold, polarity, extra] = binaryViewId.split(':');
  if (
    extra !== undefined ||
    scalarViewId === undefined ||
    threshold === undefined ||
    polarity === undefined
  ) {
    throw new RangeError(`Invalid binary view id: ${binaryViewId}.`);
  }
  return { scalarViewId, threshold, polarity };
};
