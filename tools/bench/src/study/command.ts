import crypto from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CorpusAssetLabel, CorpusBenchAsset } from '../accuracy/types.js';
import {
  type BenchmarkVerdict,
  type BenchReportEnvelope,
  buildReportCorpus,
  passedVerdict,
  REPORT_SCHEMA_VERSION,
  readRepoMetadata,
  writeReportWithSnapshot,
} from '../core/reports.js';
import { readBenchImage } from '../shared/image.js';
import { createStudyPluginRegistry } from './registry.js';
import type { StudyPlugin, StudyPluginResult } from './types.js';
import { viewOrderStudyPlugin } from './view-order.js';

const REPORTS_DIRECTORY = path.join('tools', 'bench', 'reports');
const STUDY_CACHE_DIRECTORY = path.join('tools', 'bench', '.cache', 'studies');
const CORPUS_MANIFEST_VERSION = 1;

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
}

interface CorpusManifestAsset {
  readonly id: string;
  readonly label: CorpusAssetLabel;
  readonly sha256: string;
  readonly relativePath: string;
  readonly review: { readonly status: string };
  readonly groundTruth?: { readonly codes: readonly { readonly text: string }[] };
}

interface CorpusManifest {
  readonly version: number;
  readonly assets: readonly CorpusManifestAsset[];
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
  const logs: string[] = [];
  const result = await plugin.run({
    repoRoot,
    assets,
    output: { reportFile, cacheFile },
    flags: {
      ...(selection.maxAssets === null ? {} : { 'max-assets': selection.maxAssets }),
      seed: selection.seed,
    },
    log: (message) => {
      logs.push(message);
      if (options.progressEnabled === false) return;
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
      assets: assets.map((asset) => ({ assetId: asset.id, label: asset.label })),
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
): Promise<readonly CorpusBenchAsset[]> => {
  const manifest = await readCorpusManifest(repoRoot);
  const approved = manifest.assets.filter((asset) => asset.review.status === 'approved');
  let selected = approved;
  if (selection.assetIds.length > 0) {
    const requested = new Set(selection.assetIds);
    selected = selected.filter((asset) => requested.has(asset.id));
  }
  if (selection.labels.length > 0) {
    const labels = new Set(selection.labels);
    selected = selected.filter((asset) => labels.has(asset.label));
  }
  if (selection.maxAssets !== null && selected.length > selection.maxAssets) {
    const random = seededRandom(selection.seed);
    selected = selected
      .map((asset) => ({ asset, sort: random() }))
      .sort((left, right) => left.sort - right.sort)
      .slice(0, selection.maxAssets)
      .map((entry) => entry.asset);
  }
  return selected.map((asset) => ({
    id: asset.id,
    label: asset.label,
    sha256: asset.sha256,
    relativePath: asset.relativePath,
    imagePath: path.join(repoRoot, 'corpus', 'data', asset.relativePath),
    expectedTexts: asset.groundTruth?.codes.map((code) => code.text) ?? [],
    loadImage: () => readBenchImage(path.join(repoRoot, 'corpus', 'data', asset.relativePath)),
  }));
};

const readCorpusManifest = async (repoRoot: string): Promise<CorpusManifest> => {
  const filePath = path.join(repoRoot, 'corpus', 'data', 'manifest.json');
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isCorpusManifest(parsed)) throw new Error(`Invalid corpus manifest: ${filePath}`);
  if (parsed.version > CORPUS_MANIFEST_VERSION) {
    throw new Error(
      `Incompatible corpus manifest version: ${parsed.version}; bench supports ${CORPUS_MANIFEST_VERSION}.`,
    );
  }
  return parsed;
};

const isCorpusManifest = (value: unknown): value is CorpusManifest => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CorpusManifest>;
  return typeof candidate.version === 'number' && Array.isArray(candidate.assets);
};

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const seededRandom = (seed: string): (() => number) => {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};
