import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
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
import { createBenchProgressReporter } from '../ui/progress.js';
import { createStudyPluginRegistry } from './registry.js';
import type { StudyPlugin, StudyPluginResult } from './types.js';
import { viewOrderStudyPlugin } from './view-order.js';

const REPORTS_DIRECTORY = path.join('tools', 'bench', 'reports');
const STUDY_CACHE_DIRECTORY = path.join('tools', 'bench', '.cache', 'studies');

type StudyReport = BenchReportEnvelope<'study-report', Record<string, unknown>, StudyReportDetails>;

interface StudyReportDetails {
  readonly plugin: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly version: string;
  };
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
  readonly signal?: AbortSignal;
  readonly requestStop?: () => void;
}

export interface StudyBenchmarkResult {
  readonly reportFile: string;
  readonly report: StudyReport;
}

export const createDefaultStudyRegistry = () =>
  createStudyPluginRegistry([{ plugin: viewOrderStudyPlugin }]);

export const getDefaultStudyReportPath = (repoRoot: string, studyId: string): string =>
  path.join(repoRoot, REPORTS_DIRECTORY, `study-${studyId}.json`);

export const getDefaultStudyCachePath = (repoRoot: string, studyId: string): string =>
  path.join(repoRoot, STUDY_CACHE_DIRECTORY, `${studyId}.json`);

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

  const selection = resolveStudySelection(studyId, options);
  const assets = await loadStudyAssets(repoRoot, selection);
  const progress = createBenchProgressReporter({
    commandName: 'study',
    enabled: options.progressEnabled ?? true,
    ...(options.requestStop === undefined ? {} : { requestStop: options.requestStop }),
  });
  progress.onMessage(`study ${studyId} loaded ${assets.length} assets`);
  const logs: string[] = [];
  try {
    const result = await plugin.run({
      repoRoot,
      assets,
      output: { reportFile, cacheFile },
      flags: {
        ...(selection.maxAssets === null ? {} : { 'max-assets': selection.maxAssets }),
        seed: selection.seed,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      log: (message) => {
        logs.push(message);
        if (options.progressEnabled === false) return;
        if (process.stderr.isTTY) {
          progress.onMessage(message);
          return;
        }
        process.stdout.write(`[bench study:${studyId}] ${message}\n`);
      },
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
      status: 'passed',
      verdicts: { pass, regression },
      benchmark: {
        name: `Study: ${plugin.id}`,
        description:
          'Records evidence for a focused scanner-policy study. This report answers the study-specific policy question described by the plugin. Start with the study-defined `summary`, then inspect `details` for the evidence rows, sampled assets, and parameter variations that produced the recommendation.',
      },
      command: { name: 'study', argv: process.argv.slice(2) },
      repo: await readRepoMetadata(repoRoot),
      corpus: await buildReportCorpus({
        repoRoot,
        assets,
      }),
      selection: { seed: selection.seed, filters: selection.filters },
      engines: [],
      options: { cacheFile, progressEnabled: options.progressEnabled ?? true },
      summary: result.summary,
      details: {
        plugin: pluginDescriptor(plugin),
        result: { ...result, report: { logs, evidence: result.report } },
      },
    };

    await writeReportWithSnapshot(reportFile, report);
    return { reportFile, report };
  } finally {
    progress.stop();
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
