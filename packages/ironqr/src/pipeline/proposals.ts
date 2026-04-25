import type { CornerSet, Point } from '../contracts/geometry.js';
import { validateImageDimensions } from './frame.js';
import {
  candidateVersionsFromFinders,
  createGeometryCandidates,
  type GeometryCandidate,
  type GridResolution,
} from './geometry.js';
import type { TraceSink } from './trace.js';
import { type BinaryView, type BinaryViewId, readBinaryPixel, type ViewBank } from './views.js';

const MAX_FINDER_EVIDENCE_TOTAL = 12;
const DEFAULT_MAX_PROPOSALS_PER_VIEW = 12;
const MAX_TRIPLE_COMBINATIONS = 120;
const FINDER_RATIO_TOLERANCE = 0.9;
const QUIET_ZONE_DISTANCE_MODULES = 5.25;

/**
 * Geometry seed carried by a proposal.
 */
export interface ProposalGeometrySeed {
  /** Use inferred boundary corners derived from the same finder evidence. */
  readonly kind: 'inferred-quad';
  /** Inferred QR boundary corners. */
  readonly corners: CornerSet;
}

/**
 * Proposal detector source identifiers.
 */
export type ProposalSource = 'row-scan' | 'flood' | 'matcher' | 'quad';

/**
 * Finder-like evidence emitted by cheap proposal detectors.
 */
export interface FinderEvidence {
  /** Detector family that produced this evidence. */
  readonly source: ProposalSource;
  /** Estimated finder center x coordinate. */
  readonly centerX: number;
  /** Estimated finder center y coordinate. */
  readonly centerY: number;
  /** Average module size in pixels. */
  readonly moduleSize: number;
  /** Horizontal module size estimate. */
  readonly hModuleSize: number;
  /** Vertical module size estimate. */
  readonly vModuleSize: number;
  /** Optional detector-local confidence. */
  readonly score?: number;
}

/**
 * Score breakdown used to rank proposals globally.
 */
export interface ProposalScoreBreakdown {
  /** Detector confidence and source prior. */
  readonly detectorScore: number;
  /** Geometric plausibility from finder layout and initial homography. */
  readonly geometryScore: number;
  /** Quiet-zone support around the candidate. */
  readonly quietZoneScore: number;
  /** Timing-pattern plausibility after cheap geometry. */
  readonly timingScore: number;
  /** Alignment-pattern support when the version implies one. */
  readonly alignmentScore: number;
  /** Aggregate penalties applied to the candidate. */
  readonly penalties: number;
  /** Final total score. */
  readonly total: number;
}

/**
 * Ranked finder-triple proposal.
 */
export interface FinderTripleProposal {
  /** Stable proposal id. */
  readonly id: string;
  /** Proposal kind discriminator. */
  readonly kind: 'finder-triple';
  /** Source binary view. */
  readonly binaryViewId: BinaryViewId;
  /** Finder evidence tuple. */
  readonly finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence];
  /** Geometry hypotheses derived from this finder evidence. */
  readonly geometrySeeds?: readonly ProposalGeometrySeed[];
  /** Candidate versions to try during geometry/decode. */
  readonly estimatedVersions: readonly number[];
  /** Final proposal score. */
  readonly proposalScore: number;
  /** Human-readable score breakdown. */
  readonly scoreBreakdown: ProposalScoreBreakdown;
}

/**
 * Ranked quad-style proposal.
 */
export interface QuadProposal {
  /** Stable proposal id. */
  readonly id: string;
  /** Proposal kind discriminator. */
  readonly kind: 'quad';
  /** Source binary view. */
  readonly binaryViewId: BinaryViewId;
  /** Optional explicit corners. */
  readonly corners?: {
    readonly topLeft: Point;
    readonly topRight: Point;
    readonly bottomRight: Point;
    readonly bottomLeft: Point;
  };
  /** Finder-like evidence supporting the quad. */
  readonly finderLikeEvidence: readonly FinderEvidence[];
  /** Candidate versions to try during geometry/decode. */
  readonly estimatedVersions: readonly number[];
  /** Final proposal score. */
  readonly proposalScore: number;
  /** Human-readable score breakdown. */
  readonly scoreBreakdown: ProposalScoreBreakdown;
}

/**
 * Complete proposal union.
 */
export type ScanProposal = FinderTripleProposal | QuadProposal;

/**
 * A globally ranked proposal plus reusable cheap geometry candidates produced
 * while scoring the proposal.
 */
export interface RankedProposalCandidate {
  /** Scored proposal in best-first global order. */
  readonly proposal: ScanProposal;
  /** Initial geometry candidates built during ranking and reusable by decode. */
  readonly initialGeometryCandidates: readonly GeometryCandidate[];
}

interface FinderTripleCandidate {
  readonly finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence];
  readonly seedScore: number;
}

/**
 * Counts and policy decisions from the finder-evidence detection sub-stage.
 */
export interface FinderEvidenceSummary {
  /** Finder-like evidence emitted by the row-scan detector after detector-local dedupe/capping. */
  readonly rowScanCount: number;
  /** Finder-like evidence emitted by flood-fill detection after detector-local dedupe/capping. */
  readonly floodCount: number;
  /** Finder-like evidence emitted by template matching after detector-local dedupe/capping. */
  readonly matcherCount: number;
  /** Finder-like evidence retained after cross-detector dedupe and caps. */
  readonly dedupedCount: number;
  /** Whether flood/matcher detectors were used for this view. */
  readonly expensiveDetectorsRan: boolean;
  /** Row-scan detector duration for this view. */
  readonly rowScanDurationMs: number;
  /** Flood-fill detector duration for this view. */
  readonly floodDurationMs: number;
  /** Template matcher detector duration for this view. */
  readonly matcherDurationMs: number;
  /** Cross-detector evidence dedupe/capping duration for this view. */
  readonly dedupeDurationMs: number;
}

/**
 * Proposal-generation work summary for one binary view.
 */
export interface ProposalViewGenerationSummary {
  /** Source binary view. */
  readonly binaryViewId: BinaryViewId;
  /** Finder-evidence detector summary. */
  readonly finderEvidence: FinderEvidenceSummary;
  /** Finder triples assembled before proposal construction. */
  readonly tripleCount: number;
  /** Proposals emitted for this view after per-view caps. */
  readonly proposalCount: number;
  /** End-to-end proposal-generation time for this view. */
  readonly durationMs: number;
  /** Finder-evidence detector time for this view. */
  readonly detectorDurationMs: number;
  /** Finder-triple assembly time for this view. */
  readonly tripleAssemblyDurationMs: number;
  /** Proposal object construction time for this view. */
  readonly proposalConstructionDurationMs: number;
}

/**
 * Proposal-generation work summary for one scan.
 */
export interface ProposalGenerationSummary {
  /** Number of binary views searched for proposals. */
  readonly viewCount: number;
  /** Total generated proposals across searched views. */
  readonly proposalCount: number;
  /** Per-view proposal-generation summaries in search order. */
  readonly views: readonly ProposalViewGenerationSummary[];
}

/**
 * Proposal-generation output for one binary view.
 */
export interface ProposalViewBatch {
  /** Source binary view. */
  readonly binaryViewId: BinaryViewId;
  /** Proposals emitted for this binary view. */
  readonly proposals: readonly ScanProposal[];
  /** Per-view generation summary. */
  readonly summary: ProposalViewGenerationSummary;
}

interface FinderEvidenceDetection {
  readonly evidence: readonly FinderEvidence[];
  readonly summary: FinderEvidenceSummary;
}

/**
 * Per-view proposal-generation options.
 */
export interface ProposalViewGenerationOptions {
  /** Maximum proposals retained for this binary view. */
  readonly maxProposalsPerView?: number;
  /** Optional trace sink. */
  readonly traceSink?: TraceSink;
}

/**
 * Proposal-stage configuration.
 */
export interface ProposalGenerationOptions extends ProposalViewGenerationOptions {
  /** Explicit binary views to scan for proposals. Defaults to the prioritized subset. */
  readonly viewIds?: readonly BinaryViewId[];
  /** Optional callback receiving one summary per generated proposal view. */
  readonly onViewGenerated?: (summary: ProposalViewGenerationSummary) => void;
  /** Optional callback receiving one full proposal batch per generated view. */
  readonly onBatchGenerated?: (batch: ProposalViewBatch) => void;
}

/**
 * Generates raw proposals across every default binary view.
 *
 * @param viewBank - Lazy scalar/binary view cache.
 * @param options - Proposal-generation options.
 * @returns Unranked proposals with zeroed score breakdowns.
 */
export const generateProposals = (
  viewBank: ViewBank,
  options: ProposalGenerationOptions = {},
): readonly ScanProposal[] => {
  const proposals: ScanProposal[] = [];

  for (const binaryViewId of options.viewIds ?? viewBank.listProposalViewIds()) {
    const batch = generateProposalBatchForView(viewBank, binaryViewId, options);
    options.onViewGenerated?.(batch.summary);
    options.onBatchGenerated?.(batch);
    proposals.push(...batch.proposals);
  }

  return proposals;
};

/**
 * Generates proposals for exactly one binary view.
 *
 * @param viewBank - Lazy scalar/binary view cache.
 * @param binaryViewId - Binary view to search.
 * @param options - Per-view proposal-generation options.
 * @returns One proposal batch suitable for streaming frontier scans.
 */
export const generateProposalBatchForView = (
  viewBank: ViewBank,
  binaryViewId: BinaryViewId,
  options: ProposalViewGenerationOptions = {},
): ProposalViewBatch => {
  const maxPerView = options.maxProposalsPerView ?? DEFAULT_MAX_PROPOSALS_PER_VIEW;
  const binaryView = viewBank.getBinaryView(binaryViewId);
  const batch = generateProposalsForView(binaryView, maxPerView);
  emitProposalViewGenerated(batch.summary, options.traceSink);
  for (const proposal of batch.proposals) {
    emitProposalGenerated(proposal, options.traceSink);
  }
  return batch;
};

/**
 * Builds a scan-level summary from proposal-view batches.
 *
 * @param batches - Proposal batches in generation order.
 * @returns Aggregate proposal-generation summary.
 */
export const summarizeProposalBatches = (
  batches: readonly ProposalViewBatch[],
): ProposalGenerationSummary => {
  return {
    viewCount: batches.length,
    proposalCount: batches.reduce((sum, batch) => sum + batch.proposals.length, 0),
    views: batches.map((batch) => batch.summary),
  } satisfies ProposalGenerationSummary;
};

/**
 * Ranks proposals globally by QR-specific evidence and keeps scoring-time
 * geometry candidates for downstream decode reuse.
 *
 * @param viewBank - Lazy scalar/binary view cache.
 * @param proposals - Proposals to rank.
 * @param options - Optional trace configuration.
 * @returns Best-first ranked proposal candidates.
 */
export const rankProposalCandidates = (
  viewBank: ViewBank,
  proposals: readonly ScanProposal[],
  options: ProposalGenerationOptions = {},
): readonly RankedProposalCandidate[] => {
  const ranked = dedupeRankedProposalCandidates(
    proposals
      .map((proposal) => scoreProposal(viewBank.getBinaryView(proposal.binaryViewId), proposal))
      .sort((left, right) => right.proposal.proposalScore - left.proposal.proposalScore),
  ).map((candidate, index) => {
    options.traceSink?.emit({
      type: 'proposal-ranked',
      proposalId: candidate.proposal.id,
      proposalKind: candidate.proposal.kind,
      binaryViewId: candidate.proposal.binaryViewId,
      rank: index + 1,
      scoreBreakdown: candidate.proposal.scoreBreakdown,
    });
    return candidate;
  });

  return ranked;
};

/**
 * Ranks proposals globally by QR-specific evidence.
 *
 * @param viewBank - Lazy scalar/binary view cache.
 * @param proposals - Proposals to rank.
 * @param options - Optional trace configuration.
 * @returns Best-first ranked proposals.
 */
export const rankProposals = (
  viewBank: ViewBank,
  proposals: readonly ScanProposal[],
  options: ProposalGenerationOptions = {},
): readonly ScanProposal[] => {
  return rankProposalCandidates(viewBank, proposals, options).map(
    (candidate) => candidate.proposal,
  );
};

/**
 * Detects finder-like evidence for one proposal-generation binary view.
 *
 * This is the named detection sub-stage used by `generateProposals()` before
 * finder triples are assembled into proposal candidates.
 *
 * @param binaryView - Source binary view.
 * @returns Deduplicated finder-like evidence in detector score order.
 */
export const detectFinderEvidence = (binaryView: BinaryView): readonly FinderEvidence[] => {
  return detectFinderEvidenceWithSummary(binaryView).evidence;
};

/**
 * Detects the strongest three finder evidences in raw binary pixels.
 *
 * This helper is for focused diagnostics/tests. Proposal generation uses
 * `detectFinderEvidence()` plus triple assembly instead.
 *
 * @param binary - Binary pixels.
 * @param width - Image width.
 * @param height - Image height.
 * @returns Up to three best finder evidences.
 */
export const detectBestFinderEvidence = (
  binary: Uint8Array,
  width: number,
  height: number,
): FinderEvidence[] => {
  validateBinaryPlane(binary, width, height, 'detectBestFinderEvidence');
  const matcher = detectMatcherFinders(binary, width, height);
  const matcherTriple = assembleFinderTriples(matcher, 1)[0];
  if (matcherTriple) return [...matcherTriple.finders];

  const evidence = dedupeFinderEvidence([
    ...detectRowScanFinders(binary, width, height),
    ...detectFloodFinders(binary, width, height),
    ...matcher,
  ]);
  const bestTriple = assembleFinderTriples(evidence, 1)[0];
  return bestTriple ? [...bestTriple.finders] : evidence.slice(0, 3);
};

const generateProposalsForView = (
  binaryView: BinaryView,
  maxPerView: number,
): ProposalViewBatch => {
  const startedAt = nowMs();

  const detectorStartedAt = nowMs();
  const detection = detectFinderEvidenceWithSummary(binaryView);
  const detectorDurationMs = nowMs() - detectorStartedAt;

  const tripleAssemblyStartedAt = nowMs();
  const triples =
    detection.evidence.length < 3
      ? []
      : assembleFinderTriples(detection.evidence, MAX_TRIPLE_COMBINATIONS);
  const tripleAssemblyDurationMs = nowMs() - tripleAssemblyStartedAt;

  const proposalConstructionStartedAt = nowMs();
  const proposals = proposalsFromFinderTriples(binaryView, triples, maxPerView);
  const proposalConstructionDurationMs = nowMs() - proposalConstructionStartedAt;

  return {
    binaryViewId: binaryView.id,
    proposals,
    summary: {
      binaryViewId: binaryView.id,
      finderEvidence: detection.summary,
      tripleCount: triples.length,
      proposalCount: proposals.length,
      durationMs: nowMs() - startedAt,
      detectorDurationMs,
      tripleAssemblyDurationMs,
      proposalConstructionDurationMs,
    },
  } satisfies ProposalViewBatch;
};

const emitProposalGenerated = (proposal: ScanProposal, traceSink?: TraceSink): void => {
  traceSink?.emit({
    type: 'proposal-generated',
    proposalId: proposal.id,
    proposalKind: proposal.kind,
    binaryViewId: proposal.binaryViewId,
    sources: listProposalSources(proposal),
    estimatedVersions: proposal.estimatedVersions,
  });
};

const emitProposalViewGenerated = (
  summary: ProposalViewGenerationSummary,
  traceSink?: TraceSink,
): void => {
  traceSink?.emit({
    type: 'proposal-view-generated',
    binaryViewId: summary.binaryViewId,
    rowScanFinderCount: summary.finderEvidence.rowScanCount,
    floodFinderCount: summary.finderEvidence.floodCount,
    matcherFinderCount: summary.finderEvidence.matcherCount,
    dedupedFinderCount: summary.finderEvidence.dedupedCount,
    expensiveDetectorsRan: summary.finderEvidence.expensiveDetectorsRan,
    rowScanDurationMs: summary.finderEvidence.rowScanDurationMs,
    floodDurationMs: summary.finderEvidence.floodDurationMs,
    matcherDurationMs: summary.finderEvidence.matcherDurationMs,
    dedupeDurationMs: summary.finderEvidence.dedupeDurationMs,
    tripleCount: summary.tripleCount,
    proposalCount: summary.proposalCount,
    durationMs: summary.durationMs,
    detectorDurationMs: summary.detectorDurationMs,
    tripleAssemblyDurationMs: summary.tripleAssemblyDurationMs,
    proposalConstructionDurationMs: summary.proposalConstructionDurationMs,
  });
};

const detectFinderEvidenceWithSummary = (binaryView: BinaryView): FinderEvidenceDetection => {
  const rowScanStartedAt = nowMs();
  const rowScan = detectRowScanFinders(binaryView, binaryView.width, binaryView.height);
  const rowScanDurationMs = nowMs() - rowScanStartedAt;
  const expensiveDetectorsRan = shouldRunExpensiveDetectors(binaryView, rowScan);
  const floodStartedAt = nowMs();
  const flood = expensiveDetectorsRan
    ? detectFloodFinders(binaryView, binaryView.width, binaryView.height)
    : [];
  const floodDurationMs = nowMs() - floodStartedAt;
  const matcherStartedAt = nowMs();
  const matcher = expensiveDetectorsRan
    ? detectMatcherFinders(binaryView, binaryView.width, binaryView.height)
    : [];
  const matcherDurationMs = nowMs() - matcherStartedAt;
  const dedupeStartedAt = nowMs();
  const evidence = dedupeFinderEvidence([...rowScan, ...flood, ...matcher]).slice(
    0,
    MAX_FINDER_EVIDENCE_TOTAL,
  );
  const dedupeDurationMs = nowMs() - dedupeStartedAt;
  return {
    evidence,
    summary: {
      rowScanCount: rowScan.length,
      floodCount: flood.length,
      matcherCount: matcher.length,
      dedupedCount: evidence.length,
      expensiveDetectorsRan,
      rowScanDurationMs,
      floodDurationMs,
      matcherDurationMs,
      dedupeDurationMs,
    },
  } satisfies FinderEvidenceDetection;
};

const assembleFinderTriples = (
  evidence: readonly FinderEvidence[],
  maxTriples: number,
): readonly FinderTripleCandidate[] => {
  return buildFinderTriples(evidence, maxTriples);
};

const proposalsFromFinderTriples = (
  binaryView: BinaryView,
  triples: readonly FinderTripleCandidate[],
  maxPerView: number,
): readonly ScanProposal[] => {
  const proposals: ScanProposal[] = [];
  for (let index = 0; index < triples.length && proposals.length < maxPerView; index += 1) {
    const triple = triples[index]!;
    const estimatedVersions = candidateVersionsFromFinders(triple.finders, 2);
    if (estimatedVersions.length === 0) continue;
    const inferredCorners = inferQuadCorners(triple.finders, estimatedVersions[0]!);
    proposals.push({
      id: `${binaryView.id}:triple:${index}`,
      kind: 'finder-triple',
      binaryViewId: binaryView.id,
      finders: triple.finders,
      geometrySeeds: inferredCorners ? [{ kind: 'inferred-quad', corners: inferredCorners }] : [],
      estimatedVersions,
      proposalScore: 0,
      scoreBreakdown: emptyScoreBreakdown(),
    });
  }

  return proposals;
};

const scoreProposal = (binaryView: BinaryView, proposal: ScanProposal): RankedProposalCandidate => {
  const detectorScore = computeDetectorScore(proposal);
  const initialGeometryCandidates = createGeometryCandidates(proposal);
  const initialGeometry = initialGeometryCandidates[0] ?? null;
  const geometryScore = computeProposalGeometryScore(proposal, initialGeometry);
  const quietZoneScore = computeQuietZoneScore(binaryView, proposal, initialGeometry);
  const timingScore = computeTimingScore(binaryView, initialGeometry);
  const alignmentScore = computeAlignmentScore(binaryView, initialGeometry);
  const penalties = computePenalties(binaryView, initialGeometry);
  const total =
    detectorScore + geometryScore + quietZoneScore + timingScore + alignmentScore - penalties;
  const scoreBreakdown = {
    detectorScore,
    geometryScore,
    quietZoneScore,
    timingScore,
    alignmentScore,
    penalties,
    total,
  } satisfies ProposalScoreBreakdown;

  const scoredProposal =
    proposal.kind === 'finder-triple'
      ? ({
          ...proposal,
          proposalScore: total,
          scoreBreakdown,
        } satisfies FinderTripleProposal)
      : ({
          ...proposal,
          proposalScore: total,
          scoreBreakdown,
        } satisfies QuadProposal);

  return {
    proposal: scoredProposal,
    initialGeometryCandidates,
  } satisfies RankedProposalCandidate;
};

const computeDetectorScore = (proposal: ScanProposal): number => {
  const evidence =
    proposal.kind === 'finder-triple' ? proposal.finders : proposal.finderLikeEvidence;
  if (evidence.length === 0) return 0;
  const sourcePrior =
    evidence.reduce((sum, entry) => sum + sourceBonus(entry.source), 0) / evidence.length;
  const evidenceScore =
    evidence.reduce((sum, entry) => sum + Math.log2(1 + (entry.score ?? 0)), 0) / evidence.length;
  return sourcePrior + evidenceScore;
};

const computeProposalGeometryScore = (
  proposal: ScanProposal,
  geometry: GridResolution | null,
): number => {
  if (proposal.kind === 'quad') return (geometry?.geometryScore ?? 0) + 0.1;
  const [a, b, c] = proposal.finders;
  const sizeRatio =
    Math.max(a.moduleSize, b.moduleSize, c.moduleSize) /
    Math.max(1e-6, Math.min(a.moduleSize, b.moduleSize, c.moduleSize));
  const average = (a.moduleSize + b.moduleSize + c.moduleSize) / 3;
  const lengths = [distance(a, b), distance(a, c), distance(b, c)].sort(
    (left, right) => right - left,
  );
  const hypotenuse = lengths[0] ?? 0;
  const legA = lengths[1] ?? 0;
  const legB = lengths[2] ?? 0;
  const asymmetry = Math.abs(legA - legB) / Math.max(1, (legA + legB) / 2);
  const pythagorean = Math.abs(hypotenuse - Math.hypot(legA, legB)) / Math.max(1, hypotenuse);
  const version = proposal.estimatedVersions[0] ?? 1;
  const expectedLeg = average * (version * 4 + 10);
  const versionError = Math.abs((legA + legB) / 2 - expectedLeg) / Math.max(1, expectedLeg);
  return (
    (geometry?.geometryScore ?? 0) +
    (1 - asymmetry) +
    (1 - pythagorean) +
    (1 - (sizeRatio - 1)) +
    (1 - versionError)
  );
};

const computeQuietZoneScore = (
  binaryView: BinaryView,
  proposal: ScanProposal,
  geometry: GridResolution | null,
): number => {
  if (proposal.kind === 'finder-triple') {
    const oriented = orientTriple(proposal.finders);
    if (oriented === null) return 0;
    const right = normalise(
      oriented.topRight.centerX - oriented.topLeft.centerX,
      oriented.topRight.centerY - oriented.topLeft.centerY,
    );
    const down = normalise(
      oriented.bottomLeft.centerX - oriented.topLeft.centerX,
      oriented.bottomLeft.centerY - oriented.topLeft.centerY,
    );
    if (right === null || down === null) return 0;
    const scores = [
      sampleQuietZone(
        binaryView,
        oriented.topLeft,
        { x: -right.x, y: -right.y },
        { x: -down.x, y: -down.y },
      ),
      sampleQuietZone(binaryView, oriented.topRight, right, { x: -down.x, y: -down.y }),
      sampleQuietZone(binaryView, oriented.bottomLeft, { x: -right.x, y: -right.y }, down),
    ];
    return scores.reduce((sum, value) => sum + value, 0) / scores.length;
  }

  if (geometry === null) return 0;
  const outer = [
    geometry.corners.topLeft,
    geometry.corners.topRight,
    geometry.corners.bottomRight,
    geometry.corners.bottomLeft,
  ];
  const center = centroid(outer);
  let light = 0;
  let total = 0;
  for (const corner of outer) {
    const direction = normalise(corner.x - center.x, corner.y - center.y);
    if (direction === null) continue;
    const sample = sampleBinary(binaryView, corner.x + direction.x * 4, corner.y + direction.y * 4);
    if (sample === 255) light += 1;
    total += 1;
  }
  return total === 0 ? 0 : light / total;
};

const computeTimingScore = (binaryView: BinaryView, geometry: GridResolution | null): number => {
  if (geometry === null || geometry.size < 21) return 0;
  const rowScore = sampleTimingLine(binaryView, geometry, 6, 'row');
  const colScore = sampleTimingLine(binaryView, geometry, 6, 'col');
  return (rowScore + colScore) / 2;
};

const computeAlignmentScore = (binaryView: BinaryView, geometry: GridResolution | null): number => {
  if (geometry === null || geometry.version < 2) return 0;
  const alignmentModule = geometry.size - 7;
  const center = geometry.samplePoint(alignmentModule, alignmentModule);
  const dark = sampleBinary(binaryView, center.x, center.y) === 0 ? 1 : 0;
  const ringSamples = [
    geometry.samplePoint(alignmentModule - 1, alignmentModule),
    geometry.samplePoint(alignmentModule + 1, alignmentModule),
    geometry.samplePoint(alignmentModule, alignmentModule - 1),
    geometry.samplePoint(alignmentModule, alignmentModule + 1),
  ];
  const light = ringSamples.reduce(
    (sum, point) => sum + (sampleBinary(binaryView, point.x, point.y) === 255 ? 1 : 0),
    0,
  );
  return dark * 0.5 + light / Math.max(1, ringSamples.length);
};

const computePenalties = (binaryView: BinaryView, geometry: GridResolution | null): number => {
  if (geometry === null) return 5;
  let penalty = 0;
  if (geometry.bounds.width < 12 || geometry.bounds.height < 12) penalty += 2;
  if (geometry.bounds.x < -geometry.bounds.width * 0.1) penalty += 1;
  if (geometry.bounds.y < -geometry.bounds.height * 0.1) penalty += 1;
  if (geometry.bounds.x + geometry.bounds.width > binaryView.width + geometry.bounds.width * 0.1)
    penalty += 1;
  if (geometry.bounds.y + geometry.bounds.height > binaryView.height + geometry.bounds.height * 0.1)
    penalty += 1;
  return penalty;
};

const buildFinderTriples = (
  evidence: readonly FinderEvidence[],
  maxCombinations: number,
): readonly FinderTripleCandidate[] => {
  const scored: FinderTripleCandidate[] = [];
  for (let i = 0; i < evidence.length - 2; i += 1) {
    for (let j = i + 1; j < evidence.length - 1; j += 1) {
      for (let k = j + 1; k < evidence.length; k += 1) {
        const a = evidence[i]!;
        const b = evidence[j]!;
        const c = evidence[k]!;
        const score = scoreTripleGeometry(a, b, c);
        if (score === null) continue;
        const detectorBias =
          ((a.score ?? 0) + (b.score ?? 0) + (c.score ?? 0)) / 3 +
          (sourceBonus(a.source) + sourceBonus(b.source) + sourceBonus(c.source)) / 3;
        scored.push({ finders: [a, b, c], seedScore: score + detectorBias });
      }
    }
  }

  return scored.sort((left, right) => right.seedScore - left.seedScore).slice(0, maxCombinations);
};

const scoreTripleGeometry = (
  a: FinderEvidence,
  b: FinderEvidence,
  c: FinderEvidence,
): number | null => {
  const lengths = [
    { pair: [a, b] as const, length: distance(a, b), opposite: c },
    { pair: [a, c] as const, length: distance(a, c), opposite: b },
    { pair: [b, c] as const, length: distance(b, c), opposite: a },
  ].sort((left, right) => right.length - left.length);
  const hyp = lengths[0]!;
  const leg1 = lengths[1]!;
  const leg2 = lengths[2]!;
  const topLeft = hyp.opposite;
  const armA = leg1.pair[0] === topLeft || leg1.pair[1] === topLeft ? leg1 : leg2;
  const armB = armA === leg1 ? leg2 : leg1;
  const sizeRatio =
    Math.max(a.moduleSize, b.moduleSize, c.moduleSize) /
    Math.max(1e-6, Math.min(a.moduleSize, b.moduleSize, c.moduleSize));
  if (sizeRatio > 1.8) return null;
  const averageModule = (a.moduleSize + b.moduleSize + c.moduleSize) / 3;
  const averageLeg = (armA.length + armB.length) / 2;
  if (averageLeg < averageModule * 7) return null;
  const asymmetry = 1 - Math.abs(armA.length - armB.length) / Math.max(1, averageLeg);
  const pythagorean =
    1 - Math.abs(hyp.length - Math.hypot(armA.length, armB.length)) / Math.max(1, hyp.length);
  const version = Math.max(1, Math.min(40, Math.round((averageLeg / averageModule - 10) / 4)));
  const expectedLeg = averageModule * (version * 4 + 10);
  const versionPlausibility = 1 - Math.abs(averageLeg - expectedLeg) / Math.max(1, expectedLeg);
  return asymmetry + pythagorean + versionPlausibility + (2 - sizeRatio);
};

const detectRowScanFinders = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): FinderEvidence[] => {
  const evidence: FinderEvidence[] = [];
  for (let row = 0; row < height; row += 1) {
    const runs: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let phase = 0;
    let current = 255;
    let start = 0;
    let col = 0;
    while (col < width && pixel(binary, width, col, row) === 255) col += 1;
    if (col >= width) continue;
    current = 0;
    start = col;

    for (; col <= width; col += 1) {
      const value = col < width ? pixel(binary, width, col, row) : current ^ 255;
      if (value === current) continue;
      runs[phase] = col - start;
      if (phase === 4) {
        const candidate = createRowScanEvidence(binary, width, height, runs, col, row);
        if (candidate) evidence.push(candidate);
        runs[0] = runs[2];
        runs[1] = runs[3];
        runs[2] = runs[4];
        runs[3] = 0;
        runs[4] = 0;
        phase = 3;
      } else {
        phase += 1;
      }
      current = value;
      start = col;
    }
  }

  return clusterFinderEvidence(evidence)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, MAX_FINDER_EVIDENCE_TOTAL);
};

const createRowScanEvidence = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
  runs: readonly [number, number, number, number, number],
  col: number,
  row: number,
): FinderEvidence | null => {
  const ratioScore = finderRatioScore(runs);
  if (ratioScore <= 0) return null;
  const centerX = col - runs[4] - runs[3] - runs[2] / 2;
  const vertical = crossCheck(binary, width, height, centerX, row, 0, 1);
  if (!vertical) return null;
  const horizontal = crossCheck(binary, width, height, centerX, vertical.centerY, 1, 0);
  if (!horizontal) return null;
  const moduleSize = (vertical.moduleSize + horizontal.moduleSize) / 2;
  return {
    source: 'row-scan',
    centerX: horizontal.centerX,
    centerY: vertical.centerY,
    moduleSize,
    hModuleSize: horizontal.moduleSize,
    vModuleSize: vertical.moduleSize,
    score: ratioScore + vertical.score + horizontal.score,
  };
};

const detectMatcherFinders = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): FinderEvidence[] => {
  const evidence: FinderEvidence[] = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 180));
  for (let y = 2; y < height - 2; y += step) {
    for (let x = 2; x < width - 2; x += step) {
      if (pixel(binary, width, x, y) !== 0) continue;
      const horizontal = crossCheck(binary, width, height, x, y, 1, 0);
      const vertical = crossCheck(binary, width, height, x, y, 0, 1);
      if (!horizontal || !vertical) continue;
      const moduleSize = (horizontal.moduleSize + vertical.moduleSize) / 2;
      if (moduleSize < 0.8) continue;
      evidence.push({
        source: 'matcher',
        centerX: horizontal.centerX,
        centerY: vertical.centerY,
        moduleSize,
        hModuleSize: horizontal.moduleSize,
        vModuleSize: vertical.moduleSize,
        score: horizontal.score + vertical.score + 0.75,
      });
    }
  }

  return clusterFinderEvidence(evidence)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, MAX_FINDER_EVIDENCE_TOTAL);
};

const detectFloodFinders = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): FinderEvidence[] => {
  const labels = labelConnectedComponents(binary, width, height);
  const components = collectComponentStats(labels, binary, width, height);
  const dark = components.filter((component) => component.color === 0);
  const light = components.filter((component) => component.color === 255);
  const evidence: FinderEvidence[] = [];

  for (const ring of dark) {
    const ringWidth = ring.maxX - ring.minX + 1;
    const ringHeight = ring.maxY - ring.minY + 1;
    const aspect = Math.max(ringWidth, ringHeight) / Math.max(1, Math.min(ringWidth, ringHeight));
    if (ring.pixelCount < 16 || aspect > 1.7) continue;

    const gap = light.find(
      (candidate) =>
        candidate.minX > ring.minX &&
        candidate.maxX < ring.maxX &&
        candidate.minY > ring.minY &&
        candidate.maxY < ring.maxY &&
        distancePoint(candidate.centroidX, candidate.centroidY, ring.centroidX, ring.centroidY) <
          Math.min(ringWidth, ringHeight) * 0.25,
    );
    if (!gap) continue;

    const stone = dark.find(
      (candidate) =>
        candidate !== ring &&
        candidate.minX > gap.minX &&
        candidate.maxX < gap.maxX &&
        candidate.minY > gap.minY &&
        candidate.maxY < gap.maxY &&
        distancePoint(candidate.centroidX, candidate.centroidY, gap.centroidX, gap.centroidY) <
          Math.min(gap.maxX - gap.minX + 1, gap.maxY - gap.minY + 1) * 0.2,
    );
    if (!stone) continue;

    const areaRatio = stone.pixelCount / Math.max(1, ring.pixelCount);
    if (areaRatio < 0.18 || areaRatio > 0.72) continue;
    const moduleSize = Math.sqrt(ring.pixelCount / 24);
    evidence.push({
      source: 'flood',
      centerX: ring.centroidX,
      centerY: ring.centroidY,
      moduleSize,
      hModuleSize: moduleSize,
      vModuleSize: moduleSize,
      score: 1.5 - Math.abs(areaRatio - 0.375),
    });
  }

  return dedupeFinderEvidence(evidence)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, MAX_FINDER_EVIDENCE_TOTAL);
};

const crossCheck = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  dx: number,
  dy: number,
): {
  readonly centerX: number;
  readonly centerY: number;
  readonly moduleSize: number;
  readonly score: number;
} | null => {
  const x = Math.round(centerX);
  const y = Math.round(centerY);
  if (pixel(binary, width, x, y) !== 0) return null;

  const counts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let cursorX = x;
  let cursorY = y;
  while (inside(cursorX, cursorY, width, height) && pixel(binary, width, cursorX, cursorY) === 0) {
    counts[2] += 1;
    cursorX -= dx;
    cursorY -= dy;
  }
  while (
    inside(cursorX, cursorY, width, height) &&
    pixel(binary, width, cursorX, cursorY) === 255
  ) {
    counts[1] += 1;
    cursorX -= dx;
    cursorY -= dy;
  }
  while (inside(cursorX, cursorY, width, height) && pixel(binary, width, cursorX, cursorY) === 0) {
    counts[0] += 1;
    cursorX -= dx;
    cursorY -= dy;
  }

  cursorX = x + dx;
  cursorY = y + dy;
  while (inside(cursorX, cursorY, width, height) && pixel(binary, width, cursorX, cursorY) === 0) {
    counts[2] += 1;
    cursorX += dx;
    cursorY += dy;
  }
  while (
    inside(cursorX, cursorY, width, height) &&
    pixel(binary, width, cursorX, cursorY) === 255
  ) {
    counts[3] += 1;
    cursorX += dx;
    cursorY += dy;
  }
  while (inside(cursorX, cursorY, width, height) && pixel(binary, width, cursorX, cursorY) === 0) {
    counts[4] += 1;
    cursorX += dx;
    cursorY += dy;
  }

  const ratioScore = finderRatioScore(counts);
  if (ratioScore <= 0) return null;
  const before = counts[0] + counts[1] + counts[2] / 2;
  const after = counts[4] + counts[3] + counts[2] / 2;
  const refinedX = centerX + dx * ((after - before) / 2);
  const refinedY = centerY + dy * ((after - before) / 2);
  return {
    centerX: refinedX,
    centerY: refinedY,
    moduleSize: (counts[0] + counts[1] + counts[2] + counts[3] + counts[4]) / 7,
    score: ratioScore,
  };
};

const finderRatioScore = (counts: readonly number[]): number => {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total < 7) return 0;
  const moduleSize = total / 7;
  const expected: readonly [number, number, number, number, number] = [1, 1, 3, 1, 1];
  let error = 0;
  for (let index = 0; index < 5; index += 1) {
    error += Math.abs((counts[index] ?? 0) - expected[index]! * moduleSize) / moduleSize;
  }
  return error > FINDER_RATIO_TOLERANCE * 5 ? 0 : Math.max(0, 2.5 - error * 0.5);
};

const inferQuadCorners = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
  version: number,
): {
  readonly topLeft: Point;
  readonly topRight: Point;
  readonly bottomRight: Point;
  readonly bottomLeft: Point;
} | null => {
  const geometry = createGeometryCandidates({
    id: 'tmp',
    kind: 'finder-triple',
    binaryViewId: 'gray:otsu:normal',
    finders,
    estimatedVersions: [version],
    proposalScore: 0,
    scoreBreakdown: emptyScoreBreakdown(),
  })[0];
  if (!geometry) return null;
  return geometry.corners;
};

const sampleQuietZone = (
  binaryView: BinaryView,
  finder: FinderEvidence,
  right: Point,
  down: Point,
): number => {
  const probes = [
    {
      x: finder.centerX + right.x * finder.moduleSize * QUIET_ZONE_DISTANCE_MODULES,
      y: finder.centerY + right.y * finder.moduleSize * QUIET_ZONE_DISTANCE_MODULES,
    },
    {
      x: finder.centerX + down.x * finder.moduleSize * QUIET_ZONE_DISTANCE_MODULES,
      y: finder.centerY + down.y * finder.moduleSize * QUIET_ZONE_DISTANCE_MODULES,
    },
    {
      x: finder.centerX + (right.x + down.x) * finder.moduleSize * QUIET_ZONE_DISTANCE_MODULES,
      y: finder.centerY + (right.y + down.y) * finder.moduleSize * QUIET_ZONE_DISTANCE_MODULES,
    },
  ];
  let light = 0;
  for (const probe of probes) {
    if (sampleBinary(binaryView, probe.x, probe.y) === 255) light += 1;
  }
  return light / probes.length;
};

const sampleTimingLine = (
  binaryView: BinaryView,
  geometry: GridResolution,
  fixedIndex: number,
  axis: 'row' | 'col',
): number => {
  let matches = 0;
  let total = 0;
  for (let index = 7; index <= geometry.size - 8; index += 1) {
    const point =
      axis === 'row'
        ? geometry.samplePoint(fixedIndex, index)
        : geometry.samplePoint(index, fixedIndex);
    const expectedDark = index % 2 === 0;
    const dark = sampleBinary(binaryView, point.x, point.y) === 0;
    matches += dark === expectedDark ? 1 : 0;
    total += 1;
  }
  return total === 0 ? 0 : matches / total;
};

const nowMs = (): number => performance.now();

const validateBinaryPlane = (
  binary: Uint8Array,
  width: number,
  height: number,
  caller: string,
): void => {
  validateImageDimensions(width, height);
  const expected = width * height;
  if (binary.length < expected) {
    throw new RangeError(
      `${caller}: expected at least ${expected} binary pixels, got ${binary.length}.`,
    );
  }
};

const sampleBinary = (binaryView: BinaryView, x: number, y: number): number | undefined => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= binaryView.width || py >= binaryView.height) return undefined;
  return readBinaryPixel(binaryView, py * binaryView.width + px);
};

const dedupeRankedProposalCandidates = (
  candidates: readonly RankedProposalCandidate[],
): RankedProposalCandidate[] => {
  const seen = new Set<string>();
  const deduped: RankedProposalCandidate[] = [];
  for (const candidate of candidates) {
    const signature = proposalSignature(candidate.proposal);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(candidate);
  }
  return deduped;
};

const proposalSignature = (proposal: ScanProposal): string => {
  if (proposal.kind === 'finder-triple') {
    const points = [...proposal.finders]
      .map((finder) => `${Math.round(finder.centerX / 4)}:${Math.round(finder.centerY / 4)}`)
      .sort();
    return `${proposal.kind}:${proposal.estimatedVersions[0] ?? 0}:${points.join('|')}`;
  }
  if (proposal.corners) {
    const corners = [
      proposal.corners.topLeft,
      proposal.corners.topRight,
      proposal.corners.bottomRight,
      proposal.corners.bottomLeft,
    ].map((point) => `${Math.round(point.x / 4)}:${Math.round(point.y / 4)}`);
    return `${proposal.kind}:${proposal.estimatedVersions[0] ?? 0}:${corners.join('|')}`;
  }
  const points = proposal.finderLikeEvidence
    .map((finder) => `${Math.round(finder.centerX / 4)}:${Math.round(finder.centerY / 4)}`)
    .sort();
  return `${proposal.kind}:${proposal.estimatedVersions[0] ?? 0}:${points.join('|')}`;
};

const shouldRunExpensiveDetectors = (
  binaryView: BinaryView,
  rowScan: readonly FinderEvidence[],
): boolean => {
  if (rowScan.length > 0) return true;
  if (binaryView.scalarViewId === 'gray') {
    return binaryView.threshold === 'otsu' || binaryView.threshold === 'sauvola';
  }
  return binaryView.scalarViewId === 'oklab-l' && binaryView.threshold === 'sauvola';
};

const clusterFinderEvidence = (evidence: readonly FinderEvidence[]): FinderEvidence[] => {
  const clustered: FinderEvidence[] = [];
  for (const candidate of [...evidence].sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0),
  )) {
    const existingIndex = clustered.findIndex(
      (existing) =>
        existing.source === candidate.source &&
        distance(existing, candidate) <
          Math.max(2, Math.min(existing.moduleSize, candidate.moduleSize) * 3),
    );
    if (existingIndex === -1) {
      clustered.push(candidate);
      continue;
    }

    const existing = clustered[existingIndex]!;
    const existingWeight = Math.max(1, existing.score ?? 1);
    const candidateWeight = Math.max(1, candidate.score ?? 1);
    const total = existingWeight + candidateWeight;
    clustered[existingIndex] = {
      source: existing.source,
      centerX: (existing.centerX * existingWeight + candidate.centerX * candidateWeight) / total,
      centerY: (existing.centerY * existingWeight + candidate.centerY * candidateWeight) / total,
      moduleSize:
        (existing.moduleSize * existingWeight + candidate.moduleSize * candidateWeight) / total,
      hModuleSize:
        (existing.hModuleSize * existingWeight + candidate.hModuleSize * candidateWeight) / total,
      vModuleSize:
        (existing.vModuleSize * existingWeight + candidate.vModuleSize * candidateWeight) / total,
      score: (existing.score ?? 0) + (candidate.score ?? 0),
    } satisfies FinderEvidence;
  }
  return dedupeFinderEvidence(clustered);
};

const listProposalSources = (proposal: ScanProposal): readonly ProposalSource[] => {
  const values = proposal.kind === 'finder-triple' ? proposal.finders : proposal.finderLikeEvidence;
  return Array.from(new Set(values.map((entry) => entry.source)));
};

const sourceBonus = (source: ProposalSource): number => {
  switch (source) {
    case 'matcher':
      return 1.2;
    case 'flood':
      return 1.05;
    case 'row-scan':
      return 1;
    case 'quad':
      return 0.95;
  }
};

const dedupeFinderEvidence = (evidence: readonly FinderEvidence[]): FinderEvidence[] => {
  const sorted = [...evidence].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const deduped: FinderEvidence[] = [];
  for (const entry of sorted) {
    const duplicate = deduped.some(
      (existing) =>
        distance(existing, entry) <
        Math.max(2, Math.min(existing.moduleSize, entry.moduleSize) * 2.2),
    );
    if (!duplicate) deduped.push(entry);
  }
  return deduped;
};

const orientTriple = (
  finders: readonly [FinderEvidence, FinderEvidence, FinderEvidence],
): {
  readonly topLeft: FinderEvidence;
  readonly topRight: FinderEvidence;
  readonly bottomLeft: FinderEvidence;
} | null => {
  const lengths = [
    {
      left: finders[0],
      right: finders[1],
      opposite: finders[2],
      length: distance(finders[0], finders[1]),
    },
    {
      left: finders[0],
      right: finders[2],
      opposite: finders[1],
      length: distance(finders[0], finders[2]),
    },
    {
      left: finders[1],
      right: finders[2],
      opposite: finders[0],
      length: distance(finders[1], finders[2]),
    },
  ].sort((a, b) => b.length - a.length);
  const topLeft = lengths[0]?.opposite;
  let topRight = lengths[0]?.left;
  let bottomLeft = lengths[0]?.right;
  if (!topLeft || !topRight || !bottomLeft) return null;
  const cross =
    (topRight.centerX - topLeft.centerX) * (bottomLeft.centerY - topLeft.centerY) -
    (topRight.centerY - topLeft.centerY) * (bottomLeft.centerX - topLeft.centerX);
  if (cross < 0) [topRight, bottomLeft] = [bottomLeft, topRight];
  return { topLeft, topRight, bottomLeft };
};

interface ComponentStats {
  readonly id: number;
  readonly color: number;
  readonly pixelCount: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly centroidX: number;
  readonly centroidY: number;
}

const labelConnectedComponents = (
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): Int32Array => {
  const labels = new Int32Array(width * height);
  let nextLabel = 1;
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (labels[index] !== 0) continue;
      const color = pixelAtIndex(binary, index);
      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;
      labels[index] = nextLabel;

      while (head < tail) {
        const cx = queueX[head] ?? 0;
        const cy = queueY[head] ?? 0;
        head += 1;
        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ] as const;
        for (const [nx, ny] of neighbors) {
          if (!inside(nx, ny, width, height)) continue;
          const neighborIndex = ny * width + nx;
          if (labels[neighborIndex] !== 0 || pixelAtIndex(binary, neighborIndex) !== color)
            continue;
          labels[neighborIndex] = nextLabel;
          queueX[tail] = nx;
          queueY[tail] = ny;
          tail += 1;
        }
      }

      nextLabel += 1;
    }
  }

  return labels;
};

const collectComponentStats = (
  labels: Int32Array,
  binary: Uint8Array | BinaryView,
  width: number,
  height: number,
): readonly ComponentStats[] => {
  const map = new Map<
    number,
    {
      color: number;
      pixelCount: number;
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      sumX: number;
      sumY: number;
    }
  >();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const id = labels[index] ?? 0;
      const existing = map.get(id);
      if (existing) {
        existing.pixelCount += 1;
        existing.minX = Math.min(existing.minX, x);
        existing.minY = Math.min(existing.minY, y);
        existing.maxX = Math.max(existing.maxX, x);
        existing.maxY = Math.max(existing.maxY, y);
        existing.sumX += x;
        existing.sumY += y;
      } else {
        map.set(id, {
          color: pixelAtIndex(binary, index),
          pixelCount: 1,
          minX: x,
          minY: y,
          maxX: x,
          maxY: y,
          sumX: x,
          sumY: y,
        });
      }
    }
  }

  return [...map.entries()].map(([id, value]) => ({
    id,
    color: value.color,
    pixelCount: value.pixelCount,
    minX: value.minX,
    minY: value.minY,
    maxX: value.maxX,
    maxY: value.maxY,
    centroidX: value.sumX / value.pixelCount,
    centroidY: value.sumY / value.pixelCount,
  }));
};

const pixel = (binary: Uint8Array | BinaryView, width: number, x: number, y: number): number => {
  return pixelAtIndex(binary, y * width + x);
};

const pixelAtIndex = (binary: Uint8Array | BinaryView, index: number): number => {
  if (isBinaryViewInput(binary)) return readBinaryPixel(binary, index);
  return binary[index] ?? 255;
};

const isBinaryViewInput = (value: Uint8Array | BinaryView): value is BinaryView =>
  !(value instanceof Uint8Array);

const inside = (x: number, y: number, width: number, height: number): boolean => {
  return x >= 0 && y >= 0 && x < width && y < height;
};

const normalise = (x: number, y: number): Point | null => {
  const length = Math.hypot(x, y);
  if (length < 1e-6) return null;
  return { x: x / length, y: y / length };
};

const distance = (left: FinderEvidence, right: FinderEvidence): number => {
  return distancePoint(left.centerX, left.centerY, right.centerX, right.centerY);
};

const distancePoint = (x0: number, y0: number, x1: number, y1: number): number => {
  return Math.hypot(x1 - x0, y1 - y0);
};

const centroid = (points: readonly Point[]): Point => {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
};

const emptyScoreBreakdown = (): ProposalScoreBreakdown => ({
  detectorScore: 0,
  geometryScore: 0,
  quietZoneScore: 0,
  timingScore: 0,
  alignmentScore: 0,
  penalties: 0,
  total: 0,
});
