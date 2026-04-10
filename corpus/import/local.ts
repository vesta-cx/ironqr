import { createHash } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ensureCorpusLayout,
  getCorpusAssetsRoot,
  readCorpusManifest,
  writeCorpusManifest,
} from '../manifest.js';
import type {
  CorpusAsset,
  ImportLocalAssetOptions,
  ImportLocalAssetResult,
  LocalSource,
} from '../schema.js';

const MEDIA_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function hashSha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function buildAssetId(sha256: string): string {
  return `asset-${sha256.slice(0, 16)}`;
}

function buildSourceRecord(sourcePath: string, options: ImportLocalAssetOptions): LocalSource {
  return {
    kind: 'local',
    originalPath: sourcePath,
    importedAt: new Date().toISOString(),
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(options.license ? { license: options.license } : {}),
    ...(options.provenanceNotes ? { notes: options.provenanceNotes } : {}),
  };
}

function mergeProvenance(
  existing: readonly LocalSource[],
  next: LocalSource,
): readonly LocalSource[] {
  if (
    existing.some(
      (source) => source.kind === next.kind && source.originalPath === next.originalPath,
    )
  ) {
    return existing;
  }

  return [...existing, next];
}

export async function importLocalAssets(
  options: ImportLocalAssetOptions,
): Promise<ImportLocalAssetResult> {
  await ensureCorpusLayout(options.repoRoot);

  const manifest = await readCorpusManifest(options.repoRoot);
  const assets = [...manifest.assets];
  const imported: CorpusAsset[] = [];
  const deduped: CorpusAsset[] = [];

  for (const inputPath of options.paths) {
    const absolutePath = path.resolve(inputPath);
    const extension = path.extname(absolutePath).toLowerCase();
    const mediaType = MEDIA_TYPES[extension];

    if (!mediaType) {
      throw new Error(`Unsupported image extension: ${extension || '<none>'}`);
    }

    const bytes = await readFile(absolutePath);
    const sha256 = hashSha256(bytes);
    const id = buildAssetId(sha256);
    const relativePath = `assets/${id}${extension}`;
    const existingIndex = assets.findIndex((asset) => asset.id === id);
    const source = buildSourceRecord(absolutePath, options);

    if (existingIndex >= 0) {
      const existing = assets[existingIndex];
      if (!existing) continue;

      if (existing.label !== options.label) {
        throw new Error(`Asset ${id} already exists with label ${existing.label}`);
      }

      const nextAsset: CorpusAsset = {
        ...existing,
        provenance: mergeProvenance(existing.provenance, source),
      };
      assets[existingIndex] = nextAsset;
      deduped.push(nextAsset);
      continue;
    }

    const asset: CorpusAsset = {
      id,
      label: options.label,
      mediaType,
      fileExtension: extension,
      relativePath,
      sha256,
      byteLength: bytes.byteLength,
      provenance: [source],
      review: {
        status: options.reviewStatus ?? 'pending',
        ...(options.reviewer ? { reviewer: options.reviewer } : {}),
        ...(options.reviewStatus ? { reviewedAt: new Date().toISOString() } : {}),
        ...(options.reviewNotes ? { notes: options.reviewNotes } : {}),
      },
    };

    await copyFile(
      absolutePath,
      path.join(getCorpusAssetsRoot(options.repoRoot), `${id}${extension}`),
    );
    assets.push(asset);
    imported.push(asset);
  }

  const nextManifest = { version: 1 as const, assets };
  await writeCorpusManifest(options.repoRoot, nextManifest);

  return {
    imported,
    deduped,
    manifest: nextManifest,
  };
}
