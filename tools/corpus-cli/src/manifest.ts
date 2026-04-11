import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as S from 'effect/Schema';
import { type CorpusManifest, CorpusManifestSchema } from './schema.js';

const decodeManifest = (value: unknown): CorpusManifest => {
  return S.decodeUnknownSync(CorpusManifestSchema)(value);
};

const provenanceSortKey = (
  record: CorpusManifest['assets'][number]['provenance'][number],
): string => {
  return record.kind === 'local'
    ? `local:${record.originalPath}`
    : `remote:${record.sourcePageUrl}:${record.imageUrl}`;
};

export const getCorpusDataRoot = (repoRoot: string): string => {
  return path.join(repoRoot, 'corpus', 'data');
};

export const getCorpusAssetsRoot = (repoRoot: string): string => {
  return path.join(getCorpusDataRoot(repoRoot), 'assets');
};

export const getCorpusManifestPath = (repoRoot: string): string => {
  return path.join(getCorpusDataRoot(repoRoot), 'manifest.json');
};

export const getBenchmarkExportPath = (repoRoot: string): string => {
  return path.join(getCorpusDataRoot(repoRoot), 'benchmark-real-world.json');
};

export const ensureCorpusLayout = async (repoRoot: string): Promise<void> => {
  await mkdir(getCorpusAssetsRoot(repoRoot), { recursive: true });
};

export const readCorpusManifest = async (repoRoot: string): Promise<CorpusManifest> => {
  const manifestPath = getCorpusManifestPath(repoRoot);

  try {
    const raw = await readFile(manifestPath, 'utf8');
    return decodeManifest(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, assets: [] };
    }

    throw error;
  }
};

export const writeCorpusManifest = async (
  repoRoot: string,
  manifest: CorpusManifest,
): Promise<void> => {
  await ensureCorpusLayout(repoRoot);

  const sorted: CorpusManifest = {
    version: 1,
    assets: [...manifest.assets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => ({
        ...asset,
        provenance: [...asset.provenance].sort((left, right) =>
          provenanceSortKey(left).localeCompare(provenanceSortKey(right)),
        ),
      })),
  };

  await writeFile(getCorpusManifestPath(repoRoot), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
};

export const toRepoRelativePath = (repoRoot: string, targetPath: string): string => {
  return path.relative(repoRoot, targetPath).split(path.sep).join('/');
};
