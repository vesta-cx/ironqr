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

const REPORTS_DIRECTORY = path.join('tools', 'bench', 'reports');
const STUDY_CACHE_DIRECTORY = path.join('tools', 'bench', '.cache', 'studies');
const MAX_STUDY_WORKERS = 8;

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
  path.join(repoRoot, REPORTS_DIRECTORY, `study-${studyId}.json`);

export const getDefaultStudyCachePath = (repoRoot: string, studyId: string): string =>
  path.join(repoRoot, STUDY_CACHE_DIRECTORY, `${studyId}.json`);

export const listStudyPlugins = (): readonly StudyPlugin[] => createDefaultStudyRegistry().list();

const defaultStudyWorkerCount = (): number => {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
  return Math.max(1, Math.min(MAX_STUDY_WORKERS, Math.floor(available / 2)));
};

const resolveStudyWorkerCount = (requested?: number): number => {
  if (requested === undefined) return defaultStudyWorkerCount();
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_STUDY_WORKERS) {
    throw new Error(
      `Study worker count must be an integer from 1 to ${MAX_STUDY_WORKERS}, got ${requested}`,
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
  const cacheFile = options.cacheFile ?? getDefaultStudyCachePath(repoRoot, studyId);
  await mkdir(path.dirname(reportFile), { recursive: true });
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
    logs.push(message);
    if (options.progressEnabled === false) return;
    if (process.stderr.isTTY) {
      progress.onMessage(message);
      return;
    }
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
      workerCount,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      log,
      progress,
    });

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
    return { reportFile, report };
  } finally {
    progress.stop();
  }
};

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

    const run = await mapConcurrentPartial(
      input.assets,
      input.workerCount,
      async (asset, index) => {
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
        const cached = await input.cache.read(asset, cacheKey);
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
        const result = await runAsset({
          repoRoot: input.repoRoot,
          asset,
          config,
          reports: input.reports,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          log: input.log,
        });
        await input.cache.write(asset, cacheKey, result);
        input.progress.onScanFinished({
          engineId: input.plugin.id,
          assetId: asset.id,
          relativePath: asset.relativePath,
          result: studyUnitResult(input.plugin.id, asset, result, false),
          wroteToCache: input.cache.summary().enabled,
        });
        input.progress.onMessage(`study asset finished ${asset.id}`);
        return result;
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (run.error !== null) throw run.error;
    const interrupted = run.interrupted;
    if (interrupted) input.log('study interrupted; writing partial report from completed assets');
    const assetResults = run.completed;

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
