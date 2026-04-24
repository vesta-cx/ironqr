import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as S from 'effect/Schema';
import { isEnoentError } from '../fs-error.js';
import { type CorpusManifest, CorpusManifestSchema } from '../schema.js';
import { assertCompatibleVersion, MAJOR_VERSION } from '../version.js';

const provenanceSortKey = (
  record: CorpusManifest['assets'][number]['provenance'][number],
): string => {
  return record.kind === 'local'
    ? `local:${record.originalPath}`
    : `remote:${record.sourcePageUrl}:${record.imageUrl}`;
};

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

/** Return the absolute path to the generated corpus root. */
export const getGeneratedCorpusRoot = (repoRoot: string): string => {
  return path.join(repoRoot, 'corpus', 'generated');
};

/** Return the absolute path to the generated asset directory. */
export const getGeneratedCorpusAssetsRoot = (repoRoot: string): string => {
  return path.join(getGeneratedCorpusRoot(repoRoot), 'assets');
};

/** Return the absolute path to the generated manifest file. */
export const getGeneratedCorpusManifestPath = (repoRoot: string): string => {
  return path.join(getGeneratedCorpusRoot(repoRoot), 'manifest.json');
};

/** Create the generated corpus layout if it does not already exist. */
export const ensureGeneratedCorpusLayout = async (repoRoot: string): Promise<void> => {
  await mkdir(getGeneratedCorpusAssetsRoot(repoRoot), { recursive: true });
};

/** Read the generated corpus manifest; returns an empty manifest when absent. */
export const readGeneratedCorpusManifest = (repoRoot: string): Promise<CorpusManifest> =>
  readVersionedJsonFile(
    getGeneratedCorpusManifestPath(repoRoot),
    S.decodeUnknownSync(CorpusManifestSchema) as (input: unknown) => CorpusManifest,
    { version: MAJOR_VERSION, assets: [] },
  );

/** Write the generated corpus manifest to disk, sorting assets and provenance entries. */
export const writeGeneratedCorpusManifest = async (
  repoRoot: string,
  manifest: CorpusManifest,
): Promise<void> => {
  await ensureGeneratedCorpusLayout(repoRoot);
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
  await writeJsonFile(getGeneratedCorpusManifestPath(repoRoot), sorted);
};
