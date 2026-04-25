import crypto from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { AccuracyEngineDescriptor, EngineAssetResult } from '../accuracy/types.js';
import type { CorpusAssetLabel } from '../core/corpus.js';
import { type BenchCorpusAsset, loadBenchCorpusAssets } from '../core/corpus.js';
import {
  type BenchmarkVerdict,
  type BenchReportEnvelope,
  buildReportCorpus,
  passedVerdict,
  REPORT_SCHEMA_VERSION,
  readRepoMetadata,
  writeJsonReport,
  writeReportWithSnapshot,
} from '../core/reports.js';
import { mapConcurrentPartial } from '../core/runner.js';
import { createBenchProgressReporter } from '../ui/progress.js';
import { openStudyCache } from './cache.js';
import {
  binaryBitHotPathStudyPlugin,
  binaryPrefilterSignalsStudyPlugin,
  finderRunMapStudyPlugin,
  moduleSamplingHotPathStudyPlugin,
  scalarMaterializationFusionStudyPlugin,
  sharedBinaryDetectorArtifactsStudyPlugin,
  thresholdStatsCacheStudyPlugin,
} from './image-processing.js';
import { createStudyPluginRegistry } from './registry.js';
import type {
  StudyCacheHandle,
  StudyPlugin,
  StudyPluginContext,
  StudyPluginResult,
} from './types.js';
import { viewOrderStudyPlugin, viewProposalsStudyPlugin } from './view-order.js';
import { applyStudyCacheWrites, createStudyWorkerPool } from './worker-pool.js';

const REPORTS_DIRECTORY = path.join('tools', 'bench', 'reports');
const FULL_REPORTS_DIRECTORY = path.join(REPORTS_DIRECTORY, 'full');
const STUDY_REPORTS_DIRECTORY = path.join(FULL_REPORTS_DIRECTORY, 'study');
const PROCESSED_STUDY_REPORTS_DIRECTORY = path.join(REPORTS_DIRECTORY, 'study');
const STUDY_CACHE_DIRECTORY = path.join('tools', 'bench', '.cache', 'studies');
const STUDY_TIMING_PREFIX = '__bench_study_timing__';

type StudyReport = BenchReportEnvelope<'study-report', Record<string, unknown>, StudyReportDetails>;

interface StudyReportDetails {
  readonly plugin: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly version: string;
  };
  readonly config: Record<string, unknown>;
  readonly cache: ReturnType<StudyCacheHandle['summary']>;
  readonly result: StudyPluginResult;
}

interface StudyOptions {
  readonly assetIds?: readonly string[];
  readonly labels?: readonly CorpusAssetLabel[];
  readonly maxAssets?: number;
  readonly seed?: string;
  readonly cacheFile?: string;
  readonly reportFile?: string;
  readonly processedReportFile?: string;
  readonly progressEnabled?: boolean;
  readonly cacheEnabled?: boolean;
  readonly refreshCache?: boolean;
  readonly workers?: number;
  readonly studyFlags?: Readonly<Record<string, string | number | boolean>>;
  readonly signal?: AbortSignal;
  readonly requestStop?: () => void;
}

export interface StudyBenchmarkResult {
  readonly reportFile: string;
  readonly processedReportFile: string;
  readonly report: StudyReport;
}

export const createDefaultStudyRegistry = () =>
  createStudyPluginRegistry([
    { plugin: binaryBitHotPathStudyPlugin },
    { plugin: binaryPrefilterSignalsStudyPlugin },
    { plugin: finderRunMapStudyPlugin },
    { plugin: moduleSamplingHotPathStudyPlugin },
    { plugin: scalarMaterializationFusionStudyPlugin },
    { plugin: sharedBinaryDetectorArtifactsStudyPlugin },
    { plugin: thresholdStatsCacheStudyPlugin },
    { plugin: viewProposalsStudyPlugin },
    { plugin: viewOrderStudyPlugin },
  ]);

export const getDefaultStudyReportPath = (repoRoot: string, studyId: string): string =>
  path.join(repoRoot, STUDY_REPORTS_DIRECTORY, `study-${studyId}.json`);

export const getDefaultProcessedStudyReportPath = (repoRoot: string, studyId: string): string =>
  path.join(repoRoot, PROCESSED_STUDY_REPORTS_DIRECTORY, `study-${studyId}.summary.json`);

export const getDefaultStudyCachePath = (repoRoot: string, studyId: string): string =>
  path.join(repoRoot, STUDY_CACHE_DIRECTORY, `${studyId}.json`);

export const listStudyPlugins = (): readonly StudyPlugin[] => createDefaultStudyRegistry().list();

const availableStudyWorkerSlots = (): number => {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
  return Math.max(1, available - 1);
};

const defaultStudyWorkerCount = (): number => {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
  return Math.max(1, Math.min(availableStudyWorkerSlots(), Math.floor(available * 0.9)));
};

const resolveStudyWorkerCount = (requested?: number): number => {
  const maxWorkers = availableStudyWorkerSlots();
  if (requested === undefined) return defaultStudyWorkerCount();
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > maxWorkers) {
    throw new Error(
      `Study worker count must be an integer from 0 to ${maxWorkers}, got ${requested}`,
    );
  }
  return requested;
};

export const runStudyBenchmark = async (
  repoRoot: string,
  studyId: string,
  options: StudyOptions = {},
): Promise<StudyBenchmarkResult> => {
  const registry = createDefaultStudyRegistry();
  const plugin = registry.get(studyId);
  const reportFile = options.reportFile ?? getDefaultStudyReportPath(repoRoot, studyId);
  const processedReportFile =
    options.processedReportFile ?? getDefaultProcessedStudyReportPath(repoRoot, studyId);
  const cacheFile = options.cacheFile ?? getDefaultStudyCachePath(repoRoot, studyId);
  await mkdir(path.dirname(reportFile), { recursive: true });
  await mkdir(path.dirname(processedReportFile), { recursive: true });
  await mkdir(path.dirname(cacheFile), { recursive: true });

  const workerCount = resolveStudyWorkerCount(options.workers);
  const selection = resolveStudySelection(studyId, options);
  if (options.progressEnabled === false) {
    process.stdout.write(`studySeed: ${JSON.stringify(selection.seed)}\n`);
  }
  const assets = await loadStudyAssets(repoRoot, selection);
  const progress = createBenchProgressReporter({
    commandName: 'study',
    enabled: options.progressEnabled ?? true,
    ...(options.requestStop === undefined ? {} : { requestStop: options.requestStop }),
  });
  progress.onMessage(`study ${studyId} loaded ${assets.length} assets seed=${selection.seed}`);
  const logs: string[] = [];
  const log = (message: string): void => {
    if (!message.startsWith(STUDY_TIMING_PREFIX)) logs.push(message);
    if (options.progressEnabled === false) return;
    if (process.stderr.isTTY) {
      progress.onMessage(message);
      return;
    }
    if (message.startsWith(STUDY_TIMING_PREFIX)) return;
    process.stdout.write(`[bench study:${studyId}] ${message}\n`);
  };
  const reports = createStudyReportReaders(repoRoot);
  const cache = await openStudyCache<unknown>({
    enabled: options.cacheEnabled ?? true,
    refresh: options.refreshCache ?? false,
    file: cacheFile,
  });

  try {
    const { result, config, engines, observability, interrupted } = await runPlugin({
      repoRoot,
      plugin,
      assets,
      reportFile,
      cacheFile,
      selection,
      ...(options.studyFlags === undefined ? {} : { studyFlags: options.studyFlags }),
      reports,
      cache,
      refreshCache: options.refreshCache ?? false,
      workerCount,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      log,
      progress,
    });

    await cache.flush();

    const pass = passedVerdict(`Study ${studyId} completed.`);
    const regression: BenchmarkVerdict = {
      status: 'unavailable',
      description: 'This study has no plugin-defined cross-run regression check.',
    };
    const report: StudyReport = {
      kind: 'study-report',
      schemaVersion: REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      status: interrupted ? 'interrupted' : 'passed',
      verdicts: { pass, regression },
      benchmark: {
        name: `Study: ${plugin.id}`,
        description:
          'Records evidence for a focused scanner-policy study. This report answers the study-specific policy question described by the plugin. Start with the study-defined `summary`, then inspect `details` for the evidence rows, sampled assets, and parameter variations that produced the recommendation.',
      },
      command: { name: 'study', argv: process.argv.slice(2) },
      repo: await readRepoMetadata(repoRoot),
      corpus: await buildReportCorpus({ repoRoot, assets }),
      selection: { seed: selection.seed, filters: selection.filters },
      engines: engines.map((engine) => ({
        id: engine.id,
        adapterVersion: engine.adapterVersion,
        packageName: engine.packageName,
        ...(engine.packageVersion === null ? {} : { packageVersion: engine.packageVersion }),
        runtimeVersion: engine.runtimeVersion,
      })),
      options: {
        cacheFile,
        progressEnabled: options.progressEnabled ?? true,
        cacheEnabled: options.cacheEnabled ?? true,
        refreshCache: options.refreshCache ?? false,
        workers: workerCount,
        config,
        observability,
      },
      summary: result.summary,
      details: {
        plugin: pluginDescriptor(plugin),
        config,
        cache: cache.summary(),
        result: { ...result, report: { logs, evidence: result.report } },
      },
    };

    await writeReportWithSnapshot(reportFile, report);
    await writeProcessedStudyReport(processedReportFile, report);
    return { reportFile, processedReportFile, report };
  } finally {
    await cache.flush();
    progress.stop();
  }
};

const writeProcessedStudyReport = async (
  processedPath: string,
  report: StudyReport,
): Promise<void> => {
  await writeJsonReport(processedPath, buildProcessedStudyReport(report));
};

const buildProcessedStudyReport = (report: StudyReport): Record<string, unknown> => {
  const summary = report.summary as Record<string, unknown>;
  const detectorBreakdown = buildDetectorBreakdown(summary);
  const matcherMatrix = buildMatcherVariantMatrix(report.details.plugin.id, summary);
  const floodMatrix = buildFloodVariantMatrix(report.details.plugin.id, summary);
  return {
    kind: 'processed-study-report',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      generatedAt: report.generatedAt,
      pluginId: report.details.plugin.id,
      pluginVersion: report.details.plugin.version,
      command: report.command,
      repo: report.repo,
      corpus: report.corpus,
      cache: report.details.cache,
      config: report.details.config,
    },
    headline: buildStudyHeadline(report.details.plugin.id, summary, detectorBreakdown),
    variants: summary.variants ?? [],
    recommendations: summary.recommendations ?? [],
    topViews: Array.isArray(summary.perView) ? summary.perView.slice(0, 20) : [],
    topScalars: Array.isArray(summary.perScalar) ? summary.perScalar.slice(0, 20) : [],
    totals: summary.totals ?? null,
    detectorBreakdown,
    detectorLatency: summary.detectorLatency ?? [],
    detectorUnits: summary.detectorUnits ?? [],
    matcherMatrix,
    floodMatrix,
    exploredAvenues: buildExploredAvenues(report.details.plugin.id, summary),
    conclusions: buildStudyConclusions(report.details.plugin.id, summary),
    questionCoverage: buildQuestionCoverage(report.details.plugin.id, summary),
  };
};

const buildStudyHeadline = (
  studyId: string,
  summary: Record<string, unknown>,
  detectorBreakdown: Record<string, number>,
): string => {
  if (studyId !== 'binary-prefilter-signals')
    return 'See variants, recommendations, and summary fields.';
  const totals = (summary.totals ?? {}) as Record<string, unknown>;
  const detectorMs = numberField(totals, 'detectorMs');
  const floodMs = detectorBreakdown.floodMs ?? 0;
  const floodControlMs = numberField(totals, 'floodControlMs');
  if (floodControlMs > 0) {
    return `Detector=${formatMs(detectorMs)}; dense-stats lead=${formatMs(floodControlMs)}; activeFloodCandidates=dense-index,dense-squared,dense-index-squared,scanline-stats,scanline-index,scanline-squared,scanline-index-squared.`;
  }
  const matcherMs = numberField(totals, 'matcherControlMs');
  const legacyMs = numberField(totals, 'matcherLegacyControlMs');
  const legacyEqual = Boolean(totals.matcherLegacyControlOutputsEqual);
  const mismatchCount = numberField(totals, 'matcherLegacyControlMismatchCount');
  return `Detector=${formatMs(detectorMs)}; flood=${formatMs(floodMs)}; run-map matcher=${formatMs(matcherMs)}; legacy matcher=${formatMs(legacyMs)}; legacyEqual=${legacyEqual}; mismatchedViews=${mismatchCount}.`;
};

const buildDetectorBreakdown = (summary: Record<string, unknown>): Record<string, number> => {
  const rows = Array.isArray(summary.perView) ? summary.perView : [];
  return rows.reduce(
    (totals, row) => {
      if (!isRecord(row)) return totals;
      totals.rowScanMs += numberField(row, 'rowScanMs');
      totals.floodMs += numberField(row, 'floodMs');
      totals.matcherMs += numberField(row, 'matcherMs');
      totals.dedupeMs += numberField(row, 'dedupeMs');
      return totals;
    },
    { rowScanMs: 0, floodMs: 0, matcherMs: 0, dedupeMs: 0 },
  );
};

const buildMatcherVariantMatrix = (
  studyId: string,
  summary: Record<string, unknown>,
): Record<string, unknown> | null => {
  if (studyId !== 'binary-prefilter-signals') return null;
  const totals = (summary.totals ?? {}) as Record<string, unknown>;
  if (numberField(totals, 'matcherControlMs') === 0) return null;
  return {
    controlComparison: {
      runMapMs: numberField(totals, 'matcherControlMs'),
      legacyMs: numberField(totals, 'matcherLegacyControlMs'),
      legacyVsRunMapOutputsEqual: Boolean(totals.matcherLegacyControlOutputsEqual),
      legacyVsRunMapMismatchCount: numberField(totals, 'matcherLegacyControlMismatchCount'),
      runMapSavedMs: roundReportNumber(
        numberField(totals, 'matcherLegacyControlMs') - numberField(totals, 'matcherControlMs'),
      ),
      runMapImprovementPct: percentReportNumber(
        numberField(totals, 'matcherLegacyControlMs') - numberField(totals, 'matcherControlMs'),
        numberField(totals, 'matcherLegacyControlMs'),
      ),
    },
    variants: detectorCandidates(summary).filter(
      (candidate) => candidate.area === 'matcher' || candidate.area === 'flood+matcher',
    ),
  };
};

const buildFloodVariantMatrix = (
  studyId: string,
  summary: Record<string, unknown>,
): Record<string, unknown> | null => {
  if (studyId !== 'binary-prefilter-signals') return null;
  const totals = (summary.totals ?? {}) as Record<string, unknown>;
  const controlMs = numberField(totals, 'floodControlMs');
  if (controlMs === 0) return null;
  return {
    control: { denseStatsMs: controlMs },
    variants: detectorCandidates(summary).filter(
      (candidate) => candidate.area === 'flood' || candidate.area === 'flood+matcher',
    ),
  };
};

const detectorCandidates = (
  summary: Record<string, unknown>,
): readonly Record<string, unknown>[] =>
  Array.isArray(summary.detectorCandidates)
    ? summary.detectorCandidates.filter(
        (candidate): candidate is Record<string, unknown> =>
          typeof candidate === 'object' && candidate !== null,
      )
    : [];

const buildExploredAvenues = (
  studyId: string,
  summary: Record<string, unknown>,
): readonly Record<string, unknown>[] => {
  if (studyId !== 'binary-prefilter-signals') return [];
  const totals = (summary.totals ?? {}) as Record<string, unknown>;
  const denseStatsMs =
    numberField(totals, 'floodControlMs') || numberField(totals, 'floodInlineStatsMs');
  const avenues: Record<string, unknown>[] = [
    {
      id: 'run-map-matcher',
      area: 'matcher',
      status: 'canonized-control',
      finding:
        'Run-map cross-check matcher preserved legacy matcher finder evidence across the full corpus and is now canonical.',
    },
    {
      id: 'inline-component-stats-flood',
      area: 'flood',
      status: 'retired-reference',
      finding:
        'Combined connected-component labeling and stats collection into one pass, but a targeted gray:h:i legacy check showed dense-stats preserved the extra legacy finders that inline omitted.',
    },
    {
      id: 'dense-stats',
      area: 'flood',
      status: 'canonized-control',
      finding:
        'Use dense typed arrays for component stats; fastest flood candidate from the prior batch and canonical control for hybrid variants.',
      candidateMs: denseStatsMs,
    },
    {
      id: 'dense-index-family',
      area: 'flood',
      status: 'active-candidate-family',
      finding:
        'Measure dense-stats permutations with min-x indexed containment lookup and squared-distance geometry tests.',
    },
    {
      id: 'scanline-family',
      area: 'flood',
      status: 'active-candidate-family',
      finding:
        'Measure scanline component-labeling permutations with linear/indexed containment lookup and hypot/squared-distance geometry tests.',
    },
    {
      id: 'spatial-bin',
      area: 'flood',
      status: 'disabled-reference',
      finding:
        'Historical spatial-index candidate retained in cache; superseded by lighter dense-index permutations for the current phase.',
    },
    {
      id: 'run-length-ccl',
      area: 'flood',
      status: 'disabled-reference',
      finding:
        'Historical run-length CCL candidate retained in cache; superseded by scanline labeling permutations for the current phase.',
    },
    {
      id: 'run-pattern',
      area: 'matcher',
      status: 'disabled-candidate',
      finding:
        'Enumerate matcher centers from 1:1:3:1:1 run patterns, then verify with run-map cross-checks instead of sampling arbitrary grid centers; retained for later measurement.',
    },
    {
      id: 'axis-intersect',
      area: 'matcher',
      status: 'disabled-candidate',
      finding:
        'Intersect plausible horizontal and vertical run-pattern centers to reduce matcher probes without the retired hard center-signal gate; retained for later measurement.',
    },
    {
      id: 'coarse-grid-fallback-matcher',
      area: 'matcher',
      status: 'binned',
      finding:
        'Priority-first coarse probing with control fallback preserved safety but made several views average above 400ms; fallback cost overwhelms any easy-view benefit.',
    },
    {
      id: 'shared-runs',
      area: 'flood+matcher',
      status: 'disabled-candidate',
      finding:
        'Use run-length artifacts for both flood connected-components and matcher center enumeration so one threshold-plane pass can feed multiple detectors; retained for later measurement.',
    },
  ];
  return avenues;
};

const buildStudyConclusions = (
  studyId: string,
  summary: Record<string, unknown>,
): readonly string[] => {
  if (studyId !== 'binary-prefilter-signals') return [];
  const totals = (summary.totals ?? {}) as Record<string, unknown>;
  const denseStatsMs =
    numberField(totals, 'floodControlMs') || numberField(totals, 'floodInlineStatsMs');
  const conclusions: string[] = [];
  if (denseStatsMs > 0) {
    conclusions.push(
      `Dense-stats flood is the current canonical flood control at ${formatMs(denseStatsMs)} in this run.`,
    );
  }
  conclusions.push(
    'No exhausted legacy flood, filtered flood, or center-signal matcher variants are active in this study phase.',
  );
  conclusions.push(
    'Current run phase measures hybrid flood variants against the dense-stats control; matcher candidates are retained in the ledger and cache but disabled by default.',
  );
  conclusions.push(
    'Decode success and false-positive impact remain out of scope for this detector-evidence report.',
  );
  return conclusions;
};

const buildQuestionCoverage = (
  studyId: string,
  summary: Record<string, unknown>,
): readonly Record<string, string>[] => {
  if (studyId !== 'binary-prefilter-signals') return [];
  const totals = (summary.totals ?? {}) as Record<string, unknown>;
  const floodControlMs = numberField(totals, 'floodControlMs');
  if (floodControlMs > 0) {
    return [
      {
        question: 'What is the current detector control baseline?',
        status: 'answered-for-control-with-active-candidates',
        evidence: `denseStats=${formatMs(floodControlMs)} activeFloodCandidates=dense-index,dense-squared,dense-index-squared,scanline-stats,scanline-index,scanline-squared,scanline-index-squared`,
      },
      {
        question: 'Do flood variants prove decode success or false positives?',
        status: 'unanswered',
        evidence: 'decode=false in this study run',
      },
    ];
  }
  return [
    {
      question: 'Do cheap signals identify detector hotspots?',
      status: 'answered-for-sample',
      evidence: `detector=${formatMs(numberField(totals, 'detectorMs'))}; runMapMatcher=${formatMs(numberField(totals, 'matcherControlMs'))}`,
    },
    {
      question: 'Did run-map cross-check promotion preserve matcher finder evidence?',
      status: 'answered-for-candidates',
      evidence: `legacyEqual=${String(totals.matcherLegacyControlOutputsEqual)} legacyMismatchViews=${String(totals.matcherLegacyControlMismatchCount)}`,
    },
    {
      question: 'Do signals predict decode success or false positives?',
      status: 'unanswered',
      evidence: 'decode=false in this study run',
    },
  ];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberField = (value: Record<string, unknown>, key: string): number => {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : 0;
};

const roundReportNumber = (value: number): number => Math.round(value * 100) / 100;

const percentReportNumber = (part: number, whole: number): number =>
  whole === 0 ? 0 : roundReportNumber((part / whole) * 100);

const formatMs = (value: number): string => `${value.toFixed(2)}ms`;

const runPlugin = async (input: {
  readonly repoRoot: string;
  readonly plugin: StudyPlugin;
  readonly assets: readonly BenchCorpusAsset[];
  readonly reportFile: string;
  readonly cacheFile: string;
  readonly selection: ReturnType<typeof resolveStudySelection>;
  readonly studyFlags?: Readonly<Record<string, string | number | boolean>>;
  readonly reports: ReturnType<typeof createStudyReportReaders>;
  readonly cache: StudyCacheHandle<unknown>;
  readonly refreshCache: boolean;
  readonly workerCount: number;
  readonly signal?: AbortSignal;
  readonly log: (message: string) => void;
  readonly progress: ReturnType<typeof createBenchProgressReporter>;
}): Promise<{
  readonly result: StudyPluginResult;
  readonly config: Record<string, unknown>;
  readonly engines: readonly AccuracyEngineDescriptor[];
  readonly observability: Record<string, unknown>;
  readonly interrupted: boolean;
}> => {
  const flags = {
    ...(input.selection.maxAssets === null ? {} : { 'max-assets': input.selection.maxAssets }),
    seed: input.selection.seed,
    ...(input.studyFlags ?? {}),
  };
  if (isGenericStudyPlugin(input.plugin)) {
    const runAsset = input.plugin.runAsset;
    const summarize = input.plugin.summarize;
    const renderReport = input.plugin.renderReport;
    const config = input.plugin.parseConfig?.({ flags, assets: input.assets }) ?? {};
    const baseCacheKey = input.plugin.cacheKey?.(config) ?? JSON.stringify(config);
    const engines = input.plugin.engines?.(config) ?? [];
    const observability = input.plugin.observability?.(config) ?? {};
    input.progress.onBenchmarkStarted(input.assets.length, [input.plugin.id], input.workerCount);
    const estimatedUnits = input.plugin.estimateUnits?.(config, input.assets) ?? null;
    if (estimatedUnits !== null) input.progress.onStudyUnitsPlanned(estimatedUnits);

    const preloadedResults: unknown[] = [];
    const assetsToRun: (typeof input.assets)[number][] = [];
    const readCachedAsset = input.plugin.readCachedAsset;
    if (readCachedAsset) {
      input.progress.onMessage(`study cache preload starting for ${input.assets.length} assets`);
      for (const [index, asset] of input.assets.entries()) {
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('Study interrupted.');
        await yieldToProgressRenderer();
        input.progress.onAssetPrepared(asset.id, index + 1, input.assets.length);
        const cached = await readCachedAsset({
          repoRoot: input.repoRoot,
          asset,
          config,
          reports: input.reports,
          cache: input.cache,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          log: input.log,
        });
        if (cached === null) {
          assetsToRun.push(asset);
          continue;
        }
        input.progress.onScanStarted({
          engineId: input.plugin.id,
          assetId: asset.id,
          relativePath: asset.relativePath,
          label: asset.label,
          cached: true,
          cacheable: true,
        });
        input.progress.onScanFinished({
          engineId: input.plugin.id,
          assetId: asset.id,
          relativePath: asset.relativePath,
          result: studyUnitResult(input.plugin.id, asset, cached, true),
          wroteToCache: false,
        });
        input.progress.onMessage(`study cache hit ${asset.id}`);
        preloadedResults.push(cached);
      }
      input.progress.onMessage(
        `study cache preload complete: replayed ${preloadedResults.length} assets, queued ${assetsToRun.length}/${input.assets.length}`,
      );
    } else {
      assetsToRun.push(...input.assets);
    }

    const useWorkerPool = input.workerCount > 0;
    const studyWorkerPool = useWorkerPool
      ? createStudyWorkerPool(input.workerCount, {
          log: input.log,
          cache: input.cache,
        })
      : null;
    const assetsById = new Map(input.assets.map((asset) => [asset.id, asset] as const));
    const abortStudyWorkers = (): void => {
      void studyWorkerPool?.close();
    };
    input.signal?.addEventListener('abort', abortStudyWorkers, { once: true });
    if (studyWorkerPool) {
      input.progress.onMessage(`study workers starting: ${input.workerCount}`);
      await yieldToProgressRenderer();
      await studyWorkerPool.ready();
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Study interrupted.');
      input.progress.onMessage(`study workers ready: ${input.workerCount}`);
    } else {
      input.progress.onMessage('study workers disabled: running assets on main thread');
    }
    try {
      const run = await mapConcurrentPartial(
        assetsToRun,
        Math.max(1, input.workerCount),
        async (asset, index) => {
          if (!readCachedAsset)
            input.progress.onAssetPrepared(asset.id, index + 1, input.assets.length);
          const cacheKey = JSON.stringify({
            studyId: input.plugin.id,
            studyVersion: input.plugin.version,
            configKey: baseCacheKey,
            assetId: asset.id,
            assetSha256: asset.sha256,
            engines: engines.map((engine) => ({ id: engine.id, version: engine.adapterVersion })),
            observability,
          });
          const cached = input.plugin.usesInternalCache
            ? null
            : await input.cache.read(asset, cacheKey);
          if (cached !== null) {
            input.progress.onScanStarted({
              engineId: input.plugin.id,
              assetId: asset.id,
              relativePath: asset.relativePath,
              label: asset.label,
              cached: true,
              cacheable: true,
            });
            input.progress.onScanFinished({
              engineId: input.plugin.id,
              assetId: asset.id,
              relativePath: asset.relativePath,
              result: studyUnitResult(input.plugin.id, asset, cached, true),
              wroteToCache: false,
            });
            input.progress.onMessage(`study cache hit ${asset.id}`);
            return cached;
          }
          input.progress.onScanStarted({
            engineId: input.plugin.id,
            assetId: asset.id,
            relativePath: asset.relativePath,
            label: asset.label,
            cached: false,
            cacheable: input.cache.summary().enabled,
          });
          input.progress.onMessage(`study asset started ${asset.id}`);
          await yieldToProgressRenderer();
          const result = studyWorkerPool
            ? await (async () => {
                const execution = await studyWorkerPool.run({
                  repoRoot: input.repoRoot,
                  plugin: input.plugin,
                  config,
                  asset,
                  cacheFile: input.cacheFile,
                  cacheEnabled: input.cache.summary().enabled,
                  refreshCache: input.refreshCache,
                });
                await applyStudyCacheWrites(input.cache, assetsById, execution.cacheWrites);
                return execution.result;
              })()
            : await runAsset({
                repoRoot: input.repoRoot,
                asset,
                config,
                reports: input.reports,
                cache: input.cache,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                log: input.log,
              });
          if (!input.plugin.usesInternalCache) await input.cache.write(asset, cacheKey, result);
          const resultWasCached =
            result !== null &&
            typeof result === 'object' &&
            (result as { cacheHit?: unknown }).cacheHit === true;
          input.progress.onScanFinished({
            engineId: input.plugin.id,
            assetId: asset.id,
            relativePath: asset.relativePath,
            result: studyUnitResult(input.plugin.id, asset, result, resultWasCached),
            wroteToCache: !resultWasCached && input.cache.summary().enabled,
          });
          input.progress.onMessage(`study asset finished ${asset.id}`);
          return result;
        },
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (run.error !== null) throw run.error;
      const interrupted = run.interrupted;
      if (interrupted) input.log('study interrupted; writing partial report from completed assets');
      const assetResults = [...preloadedResults, ...run.completed];

      const summaryInput = {
        config,
        assets: input.assets,
        results: assetResults,
        cache: input.cache.summary(),
      };
      const summary = summarize(summaryInput);
      const report = renderReport({ ...summaryInput, summary });
      return {
        result: {
          pluginId: input.plugin.id,
          assetCount: input.assets.length,
          summary,
          report,
        },
        config,
        engines,
        observability,
        interrupted,
      };
    } finally {
      input.signal?.removeEventListener('abort', abortStudyWorkers);
      await studyWorkerPool?.close();
    }
  }

  if (!input.plugin.run) throw new Error(`Study plugin ${input.plugin.id} has no runner hooks.`);
  const context: StudyPluginContext = {
    repoRoot: input.repoRoot,
    assets: input.assets,
    output: { reportFile: input.reportFile, cacheFile: input.cacheFile },
    flags,
    reports: input.reports,
    cache: input.cache,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    log: input.log,
  };
  const result = await input.plugin.run(context);
  return { result, config: {}, engines: [], observability: {}, interrupted: false };
};

const yieldToProgressRenderer = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const studyUnitResult = (
  engineId: string,
  asset: BenchCorpusAsset,
  value: unknown,
  cached: boolean,
): EngineAssetResult => {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const success = typeof record.success === 'boolean' ? record.success : true;
  const decodedTexts = stringArray(record.decodedTexts);
  const matchedTexts = stringArray(record.matchedTexts);
  const durationMs = typeof record.scanDurationMs === 'number' ? record.scanDurationMs : 0;
  return {
    engineId,
    label: asset.label,
    outcome:
      asset.label === 'qr-pos'
        ? success
          ? 'pass'
          : 'fail-no-decode'
        : success
          ? 'pass'
          : 'false-positive',
    decodedTexts,
    matchedTexts,
    failureReason: success ? null : asset.label === 'qr-pos' ? 'no_decode' : 'false_positive',
    error: null,
    durationMs,
    imageLoadDurationMs: null,
    totalJobDurationMs: durationMs,
    cached,
  };
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const isGenericStudyPlugin = (
  plugin: StudyPlugin,
): plugin is Required<Pick<StudyPlugin, 'runAsset' | 'summarize' | 'renderReport'>> & StudyPlugin =>
  plugin.runAsset !== undefined &&
  plugin.summarize !== undefined &&
  plugin.renderReport !== undefined;

const createStudyReportReaders = (repoRoot: string) => ({
  accuracy: () => readJsonOrNull(path.join(repoRoot, REPORTS_DIRECTORY, 'accuracy.json')),
  performance: () => readJsonOrNull(path.join(repoRoot, REPORTS_DIRECTORY, 'performance.json')),
});

const readJsonOrNull = async (filePath: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const pluginDescriptor = (plugin: StudyPlugin) => ({
  id: plugin.id,
  title: plugin.title,
  description: plugin.description,
  version: plugin.version,
});

const resolveStudySelection = (studyId: string, options: StudyOptions) => {
  const filters = {
    assetIds: options.assetIds ?? [],
    labels: options.labels ?? [],
    maxAssets: options.maxAssets ?? null,
  };
  return {
    seed: options.seed ?? stableStudySeed(studyId, filters),
    assetIds: options.assetIds ?? [],
    labels: options.labels ?? [],
    maxAssets: options.maxAssets ?? null,
    filters,
  };
};

const stableStudySeed = (studyId: string, filters: Record<string, unknown>): string => {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ studyId, filters }))
    .digest('hex')
    .slice(0, 16);
  return `${studyId}-${hash}`;
};

const loadStudyAssets = async (
  repoRoot: string,
  selection: ReturnType<typeof resolveStudySelection>,
): Promise<readonly BenchCorpusAsset[]> => {
  const corpus = await loadBenchCorpusAssets(repoRoot, {
    assetIds: selection.assetIds,
    labels: selection.labels,
    maxAssets: selection.maxAssets,
    seed: selection.seed,
    generateSeedWhenSampling: false,
  });
  return corpus.assets;
};
