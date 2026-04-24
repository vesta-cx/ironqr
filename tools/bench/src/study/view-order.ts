import {
  createTraceCollector,
  listDefaultBinaryViewIds,
  type ScanTimingSpan,
  scanFrame,
} from '../../../../packages/ironqr/src/index.js';
import type {
  IronqrTraceEvent,
  ProposalViewGeneratedEvent,
} from '../../../../packages/ironqr/src/pipeline/trace.js';
import { describeAccuracyEngine, getAccuracyEngineById } from '../core/engines.js';
import { normalizeDecodedText } from '../shared/text.js';
import type { StudyPlugin, StudySummaryInput } from './types.js';

interface ViewProposalsConfig extends Record<string, unknown> {
  readonly preset: 'production';
  readonly engineId: 'ironqr';
  readonly traceMode: 'full';
  readonly topK: number;
}

interface ViewProposalAssetResult {
  readonly assetId: string;
  readonly label: 'qr-pos' | 'qr-neg';
  readonly expectedTexts: readonly string[];
  readonly decodedTexts: readonly string[];
  readonly matchedTexts: readonly string[];
  readonly falsePositiveTexts: readonly string[];
  readonly scanDurationMs: number;
  readonly success: boolean;
  readonly viewRows: readonly ViewProposalAssetRow[];
  readonly scan: {
    readonly proposalCount: number;
    readonly boundedProposalCount: number;
    readonly clusterCount: number;
    readonly processedRepresentativeCount: number;
    readonly timings: ViewProposalScanTimingSummary;
  } | null;
}

interface ViewProposalScanTimingSummary {
  readonly normalizeMs: number;
  readonly scalarViewMaterializationMs: number;
  readonly binaryPlaneMaterializationMs: number;
  readonly binaryViewMaterializationMs: number;
  readonly proposalViewMs: number;
  readonly rankingMs: number;
  readonly clusteringMs: number;
  readonly structureMs: number;
  readonly geometryMs: number;
  readonly moduleSamplingMs: number;
  readonly decodeAttemptMs: number;
  readonly decodeCascadeMs: number;
}

interface ViewProposalAssetRow {
  readonly binaryViewId: string;
  readonly rowScanFinderCount: number;
  readonly floodFinderCount: number;
  readonly matcherFinderCount: number;
  readonly dedupedFinderCount: number;
  readonly expensiveDetectorsRan: boolean;
  readonly tripleCount: number;
  readonly proposalCount: number;
  readonly durationMs: number;
  readonly detectorDurationMs: number;
  readonly tripleAssemblyDurationMs: number;
  readonly proposalConstructionDurationMs: number;
  readonly scalarViewMaterializationMs: number;
  readonly binaryPlaneMaterializationMs: number;
  readonly binaryViewMaterializationMs: number;
  readonly rankedProposalCount: number;
  readonly maxProposalScore: number;
  readonly averageProposalScore: number;
  readonly maxDetectorScore: number;
  readonly maxGeometryScore: number;
  readonly maxTimingScore: number;
  readonly maxAlignmentScore: number;
  readonly maxQuietZoneScore: number;
  readonly structurePassCount: number;
  readonly structureFailCount: number;
  readonly structureDurationMs: number;
  readonly maxStructureScore: number;
  readonly averageStructureScore: number;
  readonly decodeCascadeDurationMs: number;
  readonly decodeAttemptCount: number;
  readonly decodeAttemptDurationMs: number;
  readonly moduleSamplingCount: number;
  readonly moduleSamplingDurationMs: number;
  readonly sampledModuleCount: number;
  readonly clusterBestCount: number;
  readonly clusterRepresentativeCount: number;
  readonly successCount: number;
  readonly uniqueSuccessCount: number;
  readonly falsePositiveCount: number;
}

interface ViewProposalSummary extends Record<string, unknown> {
  readonly assetCount: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly decodedAssetCount: number;
  readonly falsePositiveAssetCount: number;
  readonly cache: StudySummaryInput<ViewProposalsConfig, ViewProposalAssetResult>['cache'];
  readonly recommendation: readonly string[];
  readonly topViews: readonly ViewProposalSummaryRow[];
  readonly slowestViews: readonly ViewProposalSummaryRow[];
}

interface ViewProposalSummaryRow {
  readonly binaryViewId: string;
  readonly assetCount: number;
  readonly proposalCount: number;
  readonly totalDurationMs: number;
  readonly averageDurationMs: number;
  readonly detectorDurationMs: number;
  readonly scalarViewMaterializationMs: number;
  readonly binaryPlaneMaterializationMs: number;
  readonly binaryViewMaterializationMs: number;
  readonly rankedProposalCount: number;
  readonly maxProposalScore: number;
  readonly averageProposalScore: number;
  readonly maxDetectorScore: number;
  readonly maxGeometryScore: number;
  readonly maxTimingScore: number;
  readonly maxAlignmentScore: number;
  readonly maxQuietZoneScore: number;
  readonly structurePassCount: number;
  readonly structureFailCount: number;
  readonly structureDurationMs: number;
  readonly maxStructureScore: number;
  readonly averageStructureScore: number;
  readonly decodeCascadeDurationMs: number;
  readonly decodeAttemptCount: number;
  readonly decodeAttemptDurationMs: number;
  readonly moduleSamplingCount: number;
  readonly moduleSamplingDurationMs: number;
  readonly sampledModuleCount: number;
  readonly clusterBestCount: number;
  readonly clusterRepresentativeCount: number;
  readonly successCount: number;
  readonly uniqueSuccessCount: number;
  readonly falsePositiveCount: number;
  readonly expensiveDetectorAssetCount: number;
}

const ironqrDescriptor = () => describeAccuracyEngine(getAccuracyEngineById('ironqr'));

const parseConfig = ({
  flags,
}: {
  readonly flags: Readonly<Record<string, string | number | boolean>>;
}): ViewProposalsConfig => {
  const preset = flags.preset ?? 'production';
  if (preset !== 'production')
    throw new Error(`view-proposals only supports --preset production, got ${String(preset)}`);
  const topK = typeof flags['top-k'] === 'number' ? flags['top-k'] : 18;
  if (!Number.isSafeInteger(topK) || topK < 1) {
    throw new Error(
      `view-proposals --top-k must be a positive integer, got ${String(flags['top-k'])}`,
    );
  }
  return { preset, engineId: 'ironqr', traceMode: 'full', topK };
};

export const viewProposalsStudyPlugin: StudyPlugin<
  ViewProposalSummary,
  ViewProposalsConfig,
  ViewProposalAssetResult
> = {
  id: 'view-proposals',
  title: 'IronQR proposal-view study',
  description:
    'Aggregates per-view proposal cost, structure, decode, success, and false-positive evidence from public ironqr trace events.',
  version: 'study-v1',
  flags: [
    {
      name: 'max-assets',
      type: 'number',
      description: 'Limit approved corpus assets processed by the study.',
    },
    {
      name: 'preset',
      type: 'string',
      description: 'Study preset. Currently only production is supported.',
      default: 'production',
    },
    {
      name: 'top-k',
      type: 'number',
      description: 'Number of recommended proposal views to emit.',
      default: 18,
    },
  ],
  parseConfig,
  cacheKey: (config) => JSON.stringify(config),
  engines: () => [ironqrDescriptor()],
  observability: (config) => ({ traceMode: config.traceMode, traceEvents: 'full' }),
  runAsset: async ({ asset, signal, log }) => {
    if (signal?.aborted) throw signal.reason ?? new Error('Study interrupted.');
    const image = await asset.loadImage();
    const trace = createTraceCollector();
    const timingSpans: ScanTimingSpan[] = [];
    const metricsSink = {
      record(span: ScanTimingSpan) {
        timingSpans.push(span);
      },
    };
    let generatedViewCount = 0;
    let generatedProposalCount = 0;
    const traceSink = {
      get events() {
        return trace.events;
      },
      emit(event: IronqrTraceEvent) {
        trace.emit(event);
        if (event.type !== 'proposal-view-generated') return;
        generatedViewCount += 1;
        generatedProposalCount += event.proposalCount;
        log(
          `${asset.id}: view ${generatedViewCount} ${event.binaryViewId} proposals=${event.proposalCount} total=${generatedProposalCount}`,
        );
      },
    };
    const startedAt = performance.now();
    log(`${asset.id}: loading image ${image.width}x${image.height}`);
    const results = await scanFrame(image, {
      allowMultiple: true,
      proposalViewIds: listDefaultBinaryViewIds(),
      traceSink,
      metricsSink,
    });
    const scanDurationMs = round(performance.now() - startedAt);
    const decodedTexts = uniqueTexts(
      results.map((result) => normalizeDecodedText(result.payload.text)).filter(Boolean),
    );
    const expected = uniqueTexts(asset.expectedTexts.map(normalizeDecodedText).filter(Boolean));
    const matchedTexts = decodedTexts.filter((text) => expected.includes(text));
    const falsePositiveTexts = asset.label === 'qr-neg' ? decodedTexts : [];
    return {
      assetId: asset.id,
      label: asset.label,
      expectedTexts: expected,
      decodedTexts,
      matchedTexts,
      falsePositiveTexts,
      scanDurationMs,
      success: asset.label === 'qr-neg' ? decodedTexts.length === 0 : matchedTexts.length > 0,
      viewRows: buildViewRows(trace.events, timingSpans, expected, asset.label),
      scan: scanSummary(trace.events, timingSpans),
    };
  },
  summarize: (input) => summarizeViewProposalResults(input),
  renderReport: ({ config, results, summary }) => ({
    config,
    sampledAssets: results.map((result) => ({
      assetId: result.assetId,
      label: result.label,
      expectedTextCount: result.expectedTexts.length,
      decodedTexts: result.decodedTexts,
      matchedTexts: result.matchedTexts,
      falsePositiveTexts: result.falsePositiveTexts,
      scanDurationMs: result.scanDurationMs,
      success: result.success,
      scan: result.scan,
    })),
    perView: summary.topViews,
    slowestViews: summary.slowestViews,
    rows: results.flatMap((result) =>
      result.viewRows.map((row) => ({ assetId: result.assetId, label: result.label, ...row })),
    ),
  }),
};

export const viewOrderStudyPlugin: StudyPlugin<
  ViewProposalSummary,
  ViewProposalsConfig,
  ViewProposalAssetResult
> = {
  ...viewProposalsStudyPlugin,
  id: 'view-order',
  title: 'IronQR view-order study',
  description: 'Compatibility alias for the proposal-view study; use view-proposals for new runs.',
};

const buildViewRows = (
  events: readonly IronqrTraceEvent[],
  timingSpans: readonly ScanTimingSpan[],
  expectedTexts: readonly string[],
  label: 'qr-pos' | 'qr-neg',
): readonly ViewProposalAssetRow[] => {
  const proposals = new Map<string, string>();
  const rows = new Map<string, MutableViewProposalAssetRow>();
  const successByView = new Map<string, Set<string>>();
  const falsePositiveByView = new Map<string, number>();

  for (const event of events) {
    if (event.type === 'proposal-view-generated') rows.set(event.binaryViewId, rowFromEvent(event));
    if (event.type === 'proposal-generated') proposals.set(event.proposalId, event.binaryViewId);
    if (event.type === 'proposal-ranked') {
      proposals.set(event.proposalId, event.binaryViewId);
      const row = ensureRow(rows, event.binaryViewId);
      row.rankedProposalCount += 1;
      row.proposalScoreTotal += event.scoreBreakdown.total;
      row.maxProposalScore = Math.max(row.maxProposalScore, event.scoreBreakdown.total);
      row.maxDetectorScore = Math.max(row.maxDetectorScore, event.scoreBreakdown.detectorScore);
      row.maxGeometryScore = Math.max(row.maxGeometryScore, event.scoreBreakdown.geometryScore);
      row.maxTimingScore = Math.max(row.maxTimingScore, event.scoreBreakdown.timingScore);
      row.maxAlignmentScore = Math.max(row.maxAlignmentScore, event.scoreBreakdown.alignmentScore);
      row.maxQuietZoneScore = Math.max(row.maxQuietZoneScore, event.scoreBreakdown.quietZoneScore);
    }
    if (event.type === 'cluster-started') {
      rowForProposal(rows, proposals, event.bestProposalId).clusterBestCount += 1;
    }
    if (event.type === 'cluster-representative-started') {
      ensureRow(rows, event.binaryViewId).clusterRepresentativeCount += 1;
    }
    if (event.type === 'proposal-structure-assessed') {
      const row = rowForProposal(rows, proposals, event.proposalId);
      if (event.passed) row.structurePassCount += 1;
      else row.structureFailCount += 1;
      row.structureScoreTotal += event.score;
      row.maxStructureScore = Math.max(row.maxStructureScore, event.score);
    }
    if (event.type === 'decode-attempt-started') {
      rowForProposal(rows, proposals, event.proposalId).decodeAttemptCount += 1;
    }
    if (event.type === 'decode-attempt-succeeded') {
      const proposalViewId = proposals.get(event.proposalId);
      if (!proposalViewId) continue;
      const row = ensureRow(rows, proposalViewId);
      row.successCount += 1;
      const text = normalizeDecodedText(event.payloadText);
      if (label === 'qr-neg' && text.length > 0) {
        falsePositiveByView.set(proposalViewId, (falsePositiveByView.get(proposalViewId) ?? 0) + 1);
      }
      if (expectedTexts.includes(text)) {
        let texts = successByView.get(proposalViewId);
        if (!texts) {
          texts = new Set();
          successByView.set(proposalViewId, texts);
        }
        texts.add(text);
      }
    }
  }

  applyTimingSpans(rows, proposals, timingSpans);

  return [...rows.values()].map((row) =>
    finalizeAssetRow(
      row,
      successByView.get(row.binaryViewId)?.size ?? 0,
      falsePositiveByView.get(row.binaryViewId) ?? 0,
    ),
  );
};

interface MutableViewProposalAssetRow {
  binaryViewId: string;
  rowScanFinderCount: number;
  floodFinderCount: number;
  matcherFinderCount: number;
  dedupedFinderCount: number;
  expensiveDetectorsRan: boolean;
  tripleCount: number;
  proposalCount: number;
  durationMs: number;
  detectorDurationMs: number;
  tripleAssemblyDurationMs: number;
  proposalConstructionDurationMs: number;
  scalarViewMaterializationMs: number;
  binaryPlaneMaterializationMs: number;
  binaryViewMaterializationMs: number;
  rankedProposalCount: number;
  proposalScoreTotal: number;
  maxProposalScore: number;
  averageProposalScore?: number;
  maxDetectorScore: number;
  maxGeometryScore: number;
  maxTimingScore: number;
  maxAlignmentScore: number;
  maxQuietZoneScore: number;
  structurePassCount: number;
  structureFailCount: number;
  structureDurationMs: number;
  structureScoreTotal: number;
  maxStructureScore: number;
  averageStructureScore?: number;
  decodeCascadeDurationMs: number;
  decodeAttemptCount: number;
  decodeAttemptDurationMs: number;
  moduleSamplingCount: number;
  moduleSamplingDurationMs: number;
  sampledModuleCount: number;
  clusterBestCount: number;
  clusterRepresentativeCount: number;
  successCount: number;
  uniqueSuccessCount?: number;
  falsePositiveCount?: number;
}

const finalizeAssetRow = (
  row: MutableViewProposalAssetRow,
  uniqueSuccessCount: number,
  falsePositiveCount: number,
): ViewProposalAssetRow => ({
  binaryViewId: row.binaryViewId,
  rowScanFinderCount: row.rowScanFinderCount,
  floodFinderCount: row.floodFinderCount,
  matcherFinderCount: row.matcherFinderCount,
  dedupedFinderCount: row.dedupedFinderCount,
  expensiveDetectorsRan: row.expensiveDetectorsRan,
  tripleCount: row.tripleCount,
  proposalCount: row.proposalCount,
  durationMs: row.durationMs,
  detectorDurationMs: row.detectorDurationMs,
  tripleAssemblyDurationMs: row.tripleAssemblyDurationMs,
  proposalConstructionDurationMs: row.proposalConstructionDurationMs,
  scalarViewMaterializationMs: row.scalarViewMaterializationMs,
  binaryPlaneMaterializationMs: row.binaryPlaneMaterializationMs,
  binaryViewMaterializationMs: row.binaryViewMaterializationMs,
  rankedProposalCount: row.rankedProposalCount,
  maxProposalScore: row.maxProposalScore,
  averageProposalScore:
    row.rankedProposalCount === 0 ? 0 : round(row.proposalScoreTotal / row.rankedProposalCount),
  maxDetectorScore: row.maxDetectorScore,
  maxGeometryScore: row.maxGeometryScore,
  maxTimingScore: row.maxTimingScore,
  maxAlignmentScore: row.maxAlignmentScore,
  maxQuietZoneScore: row.maxQuietZoneScore,
  structurePassCount: row.structurePassCount,
  structureFailCount: row.structureFailCount,
  structureDurationMs: row.structureDurationMs,
  maxStructureScore: row.maxStructureScore,
  averageStructureScore:
    row.structurePassCount + row.structureFailCount === 0
      ? 0
      : round(row.structureScoreTotal / (row.structurePassCount + row.structureFailCount)),
  decodeCascadeDurationMs: row.decodeCascadeDurationMs,
  decodeAttemptCount: row.decodeAttemptCount,
  decodeAttemptDurationMs: row.decodeAttemptDurationMs,
  moduleSamplingCount: row.moduleSamplingCount,
  moduleSamplingDurationMs: row.moduleSamplingDurationMs,
  sampledModuleCount: row.sampledModuleCount,
  clusterBestCount: row.clusterBestCount,
  clusterRepresentativeCount: row.clusterRepresentativeCount,
  successCount: row.successCount,
  uniqueSuccessCount,
  falsePositiveCount,
});

const rowFromEvent = (event: ProposalViewGeneratedEvent): MutableViewProposalAssetRow => ({
  ...emptyRow(event.binaryViewId),
  rowScanFinderCount: event.rowScanFinderCount,
  floodFinderCount: event.floodFinderCount,
  matcherFinderCount: event.matcherFinderCount,
  dedupedFinderCount: event.dedupedFinderCount,
  expensiveDetectorsRan: event.expensiveDetectorsRan,
  tripleCount: event.tripleCount,
  proposalCount: event.proposalCount,
  durationMs: round(event.durationMs),
  detectorDurationMs: round(event.detectorDurationMs),
  tripleAssemblyDurationMs: round(event.tripleAssemblyDurationMs),
  proposalConstructionDurationMs: round(event.proposalConstructionDurationMs),
});

const rowForProposal = (
  rows: Map<string, MutableViewProposalAssetRow>,
  proposals: Map<string, string>,
  proposalId: string,
): MutableViewProposalAssetRow => ensureRow(rows, proposals.get(proposalId) ?? 'unknown');

const ensureRow = (
  rows: Map<string, MutableViewProposalAssetRow>,
  binaryViewId: string,
): MutableViewProposalAssetRow => {
  const existing = rows.get(binaryViewId);
  if (existing) return existing;
  const row = emptyRow(binaryViewId);
  rows.set(binaryViewId, row);
  return row;
};

const emptyRow = (binaryViewId: string): MutableViewProposalAssetRow => ({
  binaryViewId,
  rowScanFinderCount: 0,
  floodFinderCount: 0,
  matcherFinderCount: 0,
  dedupedFinderCount: 0,
  expensiveDetectorsRan: false,
  tripleCount: 0,
  proposalCount: 0,
  durationMs: 0,
  detectorDurationMs: 0,
  tripleAssemblyDurationMs: 0,
  proposalConstructionDurationMs: 0,
  scalarViewMaterializationMs: 0,
  binaryPlaneMaterializationMs: 0,
  binaryViewMaterializationMs: 0,
  rankedProposalCount: 0,
  proposalScoreTotal: 0,
  maxProposalScore: 0,
  maxDetectorScore: 0,
  maxGeometryScore: 0,
  maxTimingScore: 0,
  maxAlignmentScore: 0,
  maxQuietZoneScore: 0,
  structurePassCount: 0,
  structureFailCount: 0,
  structureDurationMs: 0,
  structureScoreTotal: 0,
  maxStructureScore: 0,
  decodeCascadeDurationMs: 0,
  decodeAttemptCount: 0,
  decodeAttemptDurationMs: 0,
  moduleSamplingCount: 0,
  moduleSamplingDurationMs: 0,
  sampledModuleCount: 0,
  clusterBestCount: 0,
  clusterRepresentativeCount: 0,
  successCount: 0,
});

const applyTimingSpans = (
  rows: Map<string, MutableViewProposalAssetRow>,
  proposals: Map<string, string>,
  timingSpans: readonly ScanTimingSpan[],
): void => {
  for (const span of timingSpans) {
    const metadata = span.metadata ?? {};
    if (span.name === 'scalar-view') {
      addToRowsMatchingScalar(
        rows,
        metadata.scalarViewId,
        'scalarViewMaterializationMs',
        span.durationMs,
      );
      continue;
    }
    if (span.name === 'binary-plane') {
      addToRowsMatchingPlane(
        rows,
        metadata.scalarViewId,
        metadata.threshold,
        'binaryPlaneMaterializationMs',
        span.durationMs,
      );
      continue;
    }
    if (span.name === 'binary-view' || span.name === 'proposal-view') {
      const row = rowForBinaryView(rows, metadata.binaryViewId);
      if (!row) continue;
      if (span.name === 'binary-view') row.binaryViewMaterializationMs += span.durationMs;
      continue;
    }
    if (span.name === 'structure') {
      rowForTimedProposal(rows, proposals, metadata.proposalId).structureDurationMs +=
        span.durationMs;
      continue;
    }
    if (span.name === 'decode-cascade') {
      rowForTimedProposal(rows, proposals, metadata.proposalId).decodeCascadeDurationMs +=
        span.durationMs;
      continue;
    }
    if (span.name === 'decode-attempt') {
      rowForTimedProposal(rows, proposals, metadata.proposalId).decodeAttemptDurationMs +=
        span.durationMs;
      continue;
    }
    if (span.name === 'module-sampling') {
      const row = rowForBinaryView(rows, metadata.decodeBinaryViewId);
      if (!row) continue;
      row.moduleSamplingCount += 1;
      row.moduleSamplingDurationMs += span.durationMs;
      row.sampledModuleCount += numberMetadata(metadata.moduleCount);
    }
  }

  for (const row of rows.values()) {
    row.scalarViewMaterializationMs = round(row.scalarViewMaterializationMs);
    row.binaryPlaneMaterializationMs = round(row.binaryPlaneMaterializationMs);
    row.binaryViewMaterializationMs = round(row.binaryViewMaterializationMs);
    row.structureDurationMs = round(row.structureDurationMs);
    row.decodeCascadeDurationMs = round(row.decodeCascadeDurationMs);
    row.decodeAttemptDurationMs = round(row.decodeAttemptDurationMs);
    row.moduleSamplingDurationMs = round(row.moduleSamplingDurationMs);
  }
};

const rowForTimedProposal = (
  rows: Map<string, MutableViewProposalAssetRow>,
  proposals: Map<string, string>,
  proposalId: unknown,
): MutableViewProposalAssetRow =>
  ensureRow(
    rows,
    typeof proposalId === 'string' ? (proposals.get(proposalId) ?? 'unknown') : 'unknown',
  );

const rowForBinaryView = (
  rows: Map<string, MutableViewProposalAssetRow>,
  binaryViewId: unknown,
): MutableViewProposalAssetRow | null =>
  typeof binaryViewId === 'string' ? ensureRow(rows, binaryViewId) : null;

const addToRowsMatchingScalar = (
  rows: Map<string, MutableViewProposalAssetRow>,
  scalarViewId: unknown,
  field: 'scalarViewMaterializationMs',
  durationMs: number,
): void => {
  if (typeof scalarViewId !== 'string') return;
  for (const row of rows.values()) {
    if (parseBinaryViewId(row.binaryViewId).scalarViewId === scalarViewId) row[field] += durationMs;
  }
};

const addToRowsMatchingPlane = (
  rows: Map<string, MutableViewProposalAssetRow>,
  scalarViewId: unknown,
  threshold: unknown,
  field: 'binaryPlaneMaterializationMs',
  durationMs: number,
): void => {
  if (typeof scalarViewId !== 'string' || typeof threshold !== 'string') return;
  for (const row of rows.values()) {
    const parsed = parseBinaryViewId(row.binaryViewId);
    if (parsed.scalarViewId === scalarViewId && parsed.threshold === threshold)
      row[field] += durationMs;
  }
};

const scanSummary = (
  events: readonly IronqrTraceEvent[],
  timingSpans: readonly ScanTimingSpan[],
) => {
  const finished = events.find((event) => event.type === 'scan-finished');
  if (!finished || finished.type !== 'scan-finished') return null;
  return {
    proposalCount: finished.proposalCount,
    boundedProposalCount: finished.boundedProposalCount,
    clusterCount: finished.clusterCount,
    processedRepresentativeCount: finished.processedRepresentativeCount,
    timings: summarizeTimingSpans(timingSpans),
  };
};

const summarizeTimingSpans = (
  timingSpans: readonly ScanTimingSpan[],
): ViewProposalScanTimingSummary => {
  const sum = (name: ScanTimingSpan['name']): number =>
    round(
      timingSpans
        .filter((span) => span.name === name)
        .reduce((total, span) => total + span.durationMs, 0),
    );
  return {
    normalizeMs: sum('normalize'),
    scalarViewMaterializationMs: sum('scalar-view'),
    binaryPlaneMaterializationMs: sum('binary-plane'),
    binaryViewMaterializationMs: sum('binary-view'),
    proposalViewMs: sum('proposal-view'),
    rankingMs: sum('ranking'),
    clusteringMs: sum('clustering'),
    structureMs: sum('structure'),
    geometryMs: sum('geometry'),
    moduleSamplingMs: sum('module-sampling'),
    decodeAttemptMs: sum('decode-attempt'),
    decodeCascadeMs: sum('decode-cascade'),
  };
};

const parseBinaryViewId = (binaryViewId: string): { scalarViewId: string; threshold: string } => {
  const [scalarViewId = '', threshold = ''] = binaryViewId.split(':');
  return { scalarViewId, threshold };
};

const numberMetadata = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const summarizeViewProposalResults = ({
  config,
  results,
  cache,
}: StudySummaryInput<ViewProposalsConfig, ViewProposalAssetResult>): ViewProposalSummary => {
  const views = new Map<string, MutableViewProposalSummaryRow>();
  for (const result of results) {
    for (const row of result.viewRows) {
      const aggregate = ensureSummaryRow(views, row.binaryViewId);
      aggregate.assetCount += 1;
      aggregate.proposalCount += row.proposalCount;
      aggregate.totalDurationMs += row.durationMs;
      aggregate.detectorDurationMs += row.detectorDurationMs;
      aggregate.scalarViewMaterializationMs += row.scalarViewMaterializationMs;
      aggregate.binaryPlaneMaterializationMs += row.binaryPlaneMaterializationMs;
      aggregate.binaryViewMaterializationMs += row.binaryViewMaterializationMs;
      aggregate.rankedProposalCount += row.rankedProposalCount;
      aggregate.proposalScoreTotal += row.averageProposalScore * row.rankedProposalCount;
      aggregate.maxProposalScore = Math.max(aggregate.maxProposalScore, row.maxProposalScore);
      aggregate.maxDetectorScore = Math.max(aggregate.maxDetectorScore, row.maxDetectorScore);
      aggregate.maxGeometryScore = Math.max(aggregate.maxGeometryScore, row.maxGeometryScore);
      aggregate.maxTimingScore = Math.max(aggregate.maxTimingScore, row.maxTimingScore);
      aggregate.maxAlignmentScore = Math.max(aggregate.maxAlignmentScore, row.maxAlignmentScore);
      aggregate.maxQuietZoneScore = Math.max(aggregate.maxQuietZoneScore, row.maxQuietZoneScore);
      aggregate.structurePassCount += row.structurePassCount;
      aggregate.structureFailCount += row.structureFailCount;
      aggregate.structureDurationMs += row.structureDurationMs;
      aggregate.structureScoreTotal +=
        row.averageStructureScore * (row.structurePassCount + row.structureFailCount);
      aggregate.maxStructureScore = Math.max(aggregate.maxStructureScore, row.maxStructureScore);
      aggregate.decodeCascadeDurationMs += row.decodeCascadeDurationMs;
      aggregate.decodeAttemptCount += row.decodeAttemptCount;
      aggregate.decodeAttemptDurationMs += row.decodeAttemptDurationMs;
      aggregate.moduleSamplingCount += row.moduleSamplingCount;
      aggregate.moduleSamplingDurationMs += row.moduleSamplingDurationMs;
      aggregate.sampledModuleCount += row.sampledModuleCount;
      aggregate.clusterBestCount += row.clusterBestCount;
      aggregate.clusterRepresentativeCount += row.clusterRepresentativeCount;
      aggregate.successCount += row.successCount;
      aggregate.uniqueSuccessCount += row.uniqueSuccessCount;
      aggregate.falsePositiveCount += row.falsePositiveCount;
      if (row.expensiveDetectorsRan) aggregate.expensiveDetectorAssetCount += 1;
    }
  }
  const rows = [...views.values()].map(finalizeSummaryRow);
  const recommendation = [...rows]
    .sort((left, right) => viewRankScore(right) - viewRankScore(left))
    .slice(0, config.topK)
    .map((row) => row.binaryViewId);
  return {
    assetCount: results.length,
    positiveCount: results.filter((result) => result.label === 'qr-pos').length,
    negativeCount: results.filter((result) => result.label === 'qr-neg').length,
    decodedAssetCount: results.filter((result) => result.decodedTexts.length > 0).length,
    falsePositiveAssetCount: results.filter((result) => result.falsePositiveTexts.length > 0)
      .length,
    cache,
    recommendation,
    topViews: [...rows].sort((left, right) => viewRankScore(right) - viewRankScore(left)),
    slowestViews: [...rows]
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
      .slice(0, 20),
  };
};

interface MutableViewProposalSummaryRow {
  binaryViewId: string;
  assetCount: number;
  proposalCount: number;
  totalDurationMs: number;
  detectorDurationMs: number;
  scalarViewMaterializationMs: number;
  binaryPlaneMaterializationMs: number;
  binaryViewMaterializationMs: number;
  rankedProposalCount: number;
  proposalScoreTotal: number;
  maxProposalScore: number;
  maxDetectorScore: number;
  maxGeometryScore: number;
  maxTimingScore: number;
  maxAlignmentScore: number;
  maxQuietZoneScore: number;
  structurePassCount: number;
  structureFailCount: number;
  structureDurationMs: number;
  structureScoreTotal: number;
  maxStructureScore: number;
  decodeCascadeDurationMs: number;
  decodeAttemptCount: number;
  decodeAttemptDurationMs: number;
  moduleSamplingCount: number;
  moduleSamplingDurationMs: number;
  sampledModuleCount: number;
  clusterBestCount: number;
  clusterRepresentativeCount: number;
  successCount: number;
  uniqueSuccessCount: number;
  falsePositiveCount: number;
  expensiveDetectorAssetCount: number;
}

const ensureSummaryRow = (
  rows: Map<string, MutableViewProposalSummaryRow>,
  binaryViewId: string,
): MutableViewProposalSummaryRow => {
  const existing = rows.get(binaryViewId);
  if (existing) return existing;
  const row = {
    binaryViewId,
    assetCount: 0,
    proposalCount: 0,
    totalDurationMs: 0,
    detectorDurationMs: 0,
    scalarViewMaterializationMs: 0,
    binaryPlaneMaterializationMs: 0,
    binaryViewMaterializationMs: 0,
    rankedProposalCount: 0,
    proposalScoreTotal: 0,
    maxProposalScore: 0,
    maxDetectorScore: 0,
    maxGeometryScore: 0,
    maxTimingScore: 0,
    maxAlignmentScore: 0,
    maxQuietZoneScore: 0,
    structurePassCount: 0,
    structureFailCount: 0,
    structureDurationMs: 0,
    structureScoreTotal: 0,
    maxStructureScore: 0,
    decodeCascadeDurationMs: 0,
    decodeAttemptCount: 0,
    decodeAttemptDurationMs: 0,
    moduleSamplingCount: 0,
    moduleSamplingDurationMs: 0,
    sampledModuleCount: 0,
    clusterBestCount: 0,
    clusterRepresentativeCount: 0,
    successCount: 0,
    uniqueSuccessCount: 0,
    falsePositiveCount: 0,
    expensiveDetectorAssetCount: 0,
  };
  rows.set(binaryViewId, row);
  return row;
};

const finalizeSummaryRow = (row: MutableViewProposalSummaryRow): ViewProposalSummaryRow => ({
  binaryViewId: row.binaryViewId,
  assetCount: row.assetCount,
  proposalCount: row.proposalCount,
  totalDurationMs: round(row.totalDurationMs),
  averageDurationMs: row.assetCount === 0 ? 0 : round(row.totalDurationMs / row.assetCount),
  detectorDurationMs: round(row.detectorDurationMs),
  scalarViewMaterializationMs: round(row.scalarViewMaterializationMs),
  binaryPlaneMaterializationMs: round(row.binaryPlaneMaterializationMs),
  binaryViewMaterializationMs: round(row.binaryViewMaterializationMs),
  rankedProposalCount: row.rankedProposalCount,
  maxProposalScore: row.maxProposalScore,
  averageProposalScore:
    row.rankedProposalCount === 0 ? 0 : round(row.proposalScoreTotal / row.rankedProposalCount),
  maxDetectorScore: row.maxDetectorScore,
  maxGeometryScore: row.maxGeometryScore,
  maxTimingScore: row.maxTimingScore,
  maxAlignmentScore: row.maxAlignmentScore,
  maxQuietZoneScore: row.maxQuietZoneScore,
  structurePassCount: row.structurePassCount,
  structureFailCount: row.structureFailCount,
  structureDurationMs: round(row.structureDurationMs),
  maxStructureScore: row.maxStructureScore,
  averageStructureScore:
    row.structurePassCount + row.structureFailCount === 0
      ? 0
      : round(row.structureScoreTotal / (row.structurePassCount + row.structureFailCount)),
  decodeCascadeDurationMs: round(row.decodeCascadeDurationMs),
  decodeAttemptCount: row.decodeAttemptCount,
  decodeAttemptDurationMs: round(row.decodeAttemptDurationMs),
  moduleSamplingCount: row.moduleSamplingCount,
  moduleSamplingDurationMs: round(row.moduleSamplingDurationMs),
  sampledModuleCount: row.sampledModuleCount,
  clusterBestCount: row.clusterBestCount,
  clusterRepresentativeCount: row.clusterRepresentativeCount,
  successCount: row.successCount,
  uniqueSuccessCount: row.uniqueSuccessCount,
  falsePositiveCount: row.falsePositiveCount,
  expensiveDetectorAssetCount: row.expensiveDetectorAssetCount,
});

const viewRankScore = (row: ViewProposalSummaryRow): number =>
  row.uniqueSuccessCount * 1_000_000 +
  row.successCount * 100_000 +
  row.structurePassCount * 1_000 +
  row.proposalCount * 10 -
  row.falsePositiveCount * 10_000 -
  row.totalDurationMs;

const uniqueTexts = (values: readonly string[]): readonly string[] => [...new Set(values)];

const round = (value: number): number => Math.round(value * 100) / 100;
