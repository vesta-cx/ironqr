import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as S from 'effect/Schema';
import { isEnoentError } from './fs-error.js';
import {
  type CorpusManifest,
  CorpusManifestSchema,
  type CorpusRejectionEntry,
  type CorpusRejectionsLog,
  CorpusRejectionsLogSchema,
  type ScrapeProgress,
  ScrapeProgressSchema,
} from './schema.js';
import { normalizeUrlForDedup } from './url.js';
import { assertCompatibleVersion, MAJOR_VERSION } from './version.js';

const readVersionedJsonFile = async <T extends { version: number }>(
  filePath: string,
  decode: (input: unknown) => T,
  fallback: T,
): Promise<T> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    const data = decode(JSON.parse(raw));
    assertCompatibleVersion(data.version, filePath);
    return data;
  } catch (error) {
    if (isEnoentError(error)) return fallback;
    throw error;
  }
};

const writeJsonFile = async (filePath: string, data: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const provenanceSortKey = (
  record: CorpusManifest['assets'][number]['provenance'][number],
): string => {
  return record.kind === 'local'
    ? `local:${record.originalPath}`
    : `remote:${record.sourcePageUrl}:${record.imageUrl}`;
};

/** Return the absolute path to the `corpus/data` directory. */
export const getCorpusDataRoot = (repoRoot: string): string => {
  return path.join(repoRoot, 'corpus', 'data');
};

/** Return the absolute path to the `corpus/data/assets` directory. */
export const getCorpusAssetsRoot = (repoRoot: string): string => {
  return path.join(getCorpusDataRoot(repoRoot), 'assets');
};

/** Return the absolute path to `corpus/data/manifest.json`. */
export const getCorpusManifestPath = (repoRoot: string): string => {
  return path.join(getCorpusDataRoot(repoRoot), 'manifest.json');
};

/** Return the absolute path to `corpus/data/benchmark-real-world.json`. */
export const getBenchmarkExportPath = (repoRoot: string): string => {
  return path.join(getCorpusDataRoot(repoRoot), 'benchmark-real-world.json');
};

/** Return the absolute path to the perfbench real-world fixture directory. */
export const getPerfbenchFixtureRoot = (repoRoot: string): string => {
  return path.join(repoRoot, 'tools', 'perfbench', 'fixtures', 'real-world');
};

/** Return the absolute path to the assets sub-directory inside the perfbench fixture. */
export const getPerfbenchFixtureAssetsRoot = (repoRoot: string): string => {
  return path.join(getPerfbenchFixtureRoot(repoRoot), 'assets');
};

/** Return the absolute path to the perfbench fixture `manifest.json`. */
export const getPerfbenchFixtureManifestPath = (repoRoot: string): string => {
  return path.join(getPerfbenchFixtureRoot(repoRoot), 'manifest.json');
};

/** Create the corpus assets directory if it does not already exist. */
export const ensureCorpusLayout = async (repoRoot: string): Promise<void> => {
  await mkdir(getCorpusAssetsRoot(repoRoot), { recursive: true });
};

/** Read and validate the corpus manifest; returns an empty manifest when the file is absent. */
export const readCorpusManifest = (repoRoot: string): Promise<CorpusManifest> =>
  readVersionedJsonFile(
    getCorpusManifestPath(repoRoot),
    S.decodeUnknownSync(CorpusManifestSchema) as (input: unknown) => CorpusManifest,
    { version: MAJOR_VERSION, assets: [] },
  );

/** Write the corpus manifest to disk, sorting assets and provenance entries. */
export const writeCorpusManifest = async (
  repoRoot: string,
  manifest: CorpusManifest,
): Promise<void> => {
  await ensureCorpusLayout(repoRoot);

  const sorted: CorpusManifest = {
    version: MAJOR_VERSION,
    assets: [...manifest.assets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => ({
        ...asset,
        provenance: [...asset.provenance].sort((left, right) =>
          provenanceSortKey(left).localeCompare(provenanceSortKey(right)),
        ),
      })),
  };

  await writeJsonFile(getCorpusManifestPath(repoRoot), sorted);
};

/** Return the absolute path to `corpus/data/rejections.json`. */
export const getCorpusRejectionsPath = (repoRoot: string): string => {
  return path.join(getCorpusDataRoot(repoRoot), 'rejections.json');
};

/** Read the rejections log; returns an empty log when the file is absent. */
export const readCorpusRejections = (repoRoot: string): Promise<CorpusRejectionsLog> =>
  readVersionedJsonFile(
    getCorpusRejectionsPath(repoRoot),
    S.decodeUnknownSync(CorpusRejectionsLogSchema) as (input: unknown) => CorpusRejectionsLog,
    { version: MAJOR_VERSION, rejections: [] },
  );

/** Append a rejection entry to the log, skipping duplicates by `sourceSha256`. */
export const appendCorpusRejection = async (
  repoRoot: string,
  entry: CorpusRejectionEntry,
): Promise<void> => {
  await ensureCorpusLayout(repoRoot);
  const log = await readCorpusRejections(repoRoot);
  if (log.rejections.some((r) => r.sourceSha256 === entry.sourceSha256)) {
    return;
  }
  const updated: CorpusRejectionsLog = {
    version: MAJOR_VERSION,
    rejections: [...log.rejections, entry],
  };
  await writeJsonFile(getCorpusRejectionsPath(repoRoot), updated);
};

/** Return the absolute path to `corpus/data/scrape-progress.json`. */
export const getCorpusScrapeProgressPath = (repoRoot: string): string =>
  path.join(getCorpusDataRoot(repoRoot), 'scrape-progress.json');

const normalizeScrapeProgress = (progress: ScrapeProgress): ScrapeProgress => ({
  version: MAJOR_VERSION,
  visitedSourcePageUrls: [...new Set(progress.visitedSourcePageUrls.map(normalizeUrlForDedup))],
});

/** Read the scrape-progress file; returns an empty normalized record when the file is absent. */
export const readScrapeProgress = async (repoRoot: string): Promise<ScrapeProgress> =>
  normalizeScrapeProgress(
    await readVersionedJsonFile(
      getCorpusScrapeProgressPath(repoRoot),
      S.decodeUnknownSync(ScrapeProgressSchema) as (input: unknown) => ScrapeProgress,
      { version: MAJOR_VERSION, visitedSourcePageUrls: [] },
    ),
  );

/** Record a visited source-page URL in the progress file, skipping if already present. */
export const appendVisitedSourcePage = async (repoRoot: string, url: string): Promise<void> => {
  await ensureCorpusLayout(repoRoot);
  const progress = await readScrapeProgress(repoRoot);
  const normalizedUrl = normalizeUrlForDedup(url);
  const existingNormalized = new Set(progress.visitedSourcePageUrls.map(normalizeUrlForDedup));
  if (existingNormalized.has(normalizedUrl)) return;
  const updated: ScrapeProgress = {
    version: MAJOR_VERSION,
    visitedSourcePageUrls: [...progress.visitedSourcePageUrls, normalizedUrl],
  };
  await writeJsonFile(getCorpusScrapeProgressPath(repoRoot), updated);
};

/** Convert an absolute `targetPath` to a forward-slash repo-relative path. */
export const toRepoRelativePath = (repoRoot: string, targetPath: string): string => {
  return path.relative(repoRoot, targetPath).split(path.sep).join('/');
};
