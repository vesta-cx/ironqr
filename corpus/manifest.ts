import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as S from 'effect/Schema';
import { type CorpusManifest, CorpusManifestSchema } from './schema.js';

const decodeManifest = S.decodeUnknownSync(CorpusManifestSchema);

export function getCorpusDataRoot(repoRoot: string): string {
  return path.join(repoRoot, 'corpus', 'data');
}

export function getCorpusAssetsRoot(repoRoot: string): string {
  return path.join(getCorpusDataRoot(repoRoot), 'assets');
}

export function getCorpusManifestPath(repoRoot: string): string {
  return path.join(getCorpusDataRoot(repoRoot), 'manifest.json');
}

export function getBenchmarkExportPath(repoRoot: string): string {
  return path.join(getCorpusDataRoot(repoRoot), 'benchmark-real-world.json');
}

export async function ensureCorpusLayout(repoRoot: string): Promise<void> {
  await mkdir(getCorpusAssetsRoot(repoRoot), { recursive: true });
}

export async function readCorpusManifest(repoRoot: string): Promise<CorpusManifest> {
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
}

export async function writeCorpusManifest(
  repoRoot: string,
  manifest: CorpusManifest,
): Promise<void> {
  await ensureCorpusLayout(repoRoot);

  const sorted: CorpusManifest = {
    version: 1,
    assets: [...manifest.assets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => ({
        ...asset,
        provenance: [...asset.provenance].sort((left, right) =>
          left.originalPath.localeCompare(right.originalPath),
        ),
      })),
  };

  await writeFile(getCorpusManifestPath(repoRoot), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

export function toRepoRelativePath(repoRoot: string, targetPath: string): string {
  return path.relative(repoRoot, targetPath).split(path.sep).join('/');
}
