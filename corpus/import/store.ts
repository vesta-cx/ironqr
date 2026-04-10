import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ensureCorpusLayout, getCorpusAssetsRoot } from '../manifest.js';
import type {
  AutoScan,
  CorpusAsset,
  CorpusAssetLabel,
  GroundTruth,
  LicenseReview,
  ProvenanceRecord,
  ReviewStatus,
} from '../schema.js';

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const EXTENSIONS_BY_MEDIA_TYPE: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const NORMALIZED_IMAGE_MEDIA_TYPE = 'image/webp';

export function hashSha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function buildAssetId(sha256: string): string {
  return `asset-${sha256.slice(0, 16)}`;
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? mediaType.toLowerCase();
}

export function mediaTypeFromExtension(extension: string): string | undefined {
  return MEDIA_TYPES_BY_EXTENSION[extension.toLowerCase()];
}

export function extensionFromMediaType(mediaType: string, fallbackPath: string): string {
  const normalizedMediaType = normalizeMediaType(mediaType);
  const fromMediaType = EXTENSIONS_BY_MEDIA_TYPE[normalizedMediaType];
  if (fromMediaType) return fromMediaType;

  const fromPath = path.extname(new URL(fallbackPath).pathname || fallbackPath).toLowerCase();
  if (fromPath && mediaTypeFromExtension(fromPath)) {
    return fromPath;
  }

  throw new Error(`Unsupported image media type: ${mediaType}`);
}

function sameProvenance(left: ProvenanceRecord, right: ProvenanceRecord): boolean {
  if (left.kind !== right.kind) return false;

  if (left.kind === 'local' && right.kind === 'local') {
    return left.originalPath === right.originalPath;
  }

  if (left.kind === 'remote' && right.kind === 'remote') {
    return left.sourcePageUrl === right.sourcePageUrl && left.imageUrl === right.imageUrl;
  }

  return false;
}

function mergeProvenance(
  existing: readonly ProvenanceRecord[],
  next: ProvenanceRecord,
): readonly ProvenanceRecord[] {
  if (existing.some((source) => sameProvenance(source, next))) {
    return existing;
  }

  return [...existing, next];
}

interface ImportAssetBytesOptions {
  readonly repoRoot: string;
  readonly assets: CorpusAsset[];
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sourcePathForExtension: string;
  readonly label: CorpusAssetLabel;
  readonly provenance: ProvenanceRecord;
  readonly reviewStatus?: ReviewStatus;
  readonly reviewer?: string;
  readonly reviewNotes?: string;
  readonly groundTruth?: GroundTruth;
  readonly autoScan?: AutoScan;
  readonly licenseReview?: LicenseReview;
}

interface ImportAssetBytesResult {
  readonly asset: CorpusAsset;
  readonly deduped: boolean;
}

async function normalizeImportedImage(bytes: Uint8Array): Promise<Uint8Array> {
  const normalized = await sharp(bytes)
    .rotate()
    .resize({
      width: 1000,
      height: 1000,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer();

  return new Uint8Array(normalized);
}

export async function importAssetBytes(
  options: ImportAssetBytesOptions,
): Promise<ImportAssetBytesResult> {
  await ensureCorpusLayout(options.repoRoot);

  const normalizedBytes = await normalizeImportedImage(options.bytes);
  const mediaType = NORMALIZED_IMAGE_MEDIA_TYPE;
  const sha256 = hashSha256(normalizedBytes);
  const id = buildAssetId(sha256);
  const fileExtension = extensionFromMediaType(mediaType, options.sourcePathForExtension);
  const relativePath = `assets/${id}${fileExtension}`;
  const existingIndex = options.assets.findIndex((asset) => asset.id === id);

  if (existingIndex >= 0) {
    const existing = options.assets[existingIndex];
    if (!existing) throw new Error(`Missing asset at index ${existingIndex}`);

    if (existing.label !== options.label) {
      throw new Error(`Asset ${id} already exists with label ${existing.label}`);
    }

    const asset: CorpusAsset = {
      ...existing,
      provenance: mergeProvenance(existing.provenance, options.provenance),
      ...(options.groundTruth ? { groundTruth: options.groundTruth } : {}),
      ...(options.autoScan ? { autoScan: options.autoScan } : {}),
      ...(options.licenseReview ? { licenseReview: options.licenseReview } : {}),
    };
    options.assets[existingIndex] = asset;
    return { asset, deduped: true };
  }

  const asset: CorpusAsset = {
    id,
    label: options.label,
    mediaType,
    fileExtension,
    relativePath,
    sha256,
    byteLength: normalizedBytes.byteLength,
    provenance: [options.provenance],
    review: {
      status: options.reviewStatus ?? 'pending',
      ...(options.reviewer ? { reviewer: options.reviewer } : {}),
      ...(options.reviewStatus ? { reviewedAt: new Date().toISOString() } : {}),
      ...(options.reviewNotes ? { notes: options.reviewNotes } : {}),
    },
    ...(options.groundTruth ? { groundTruth: options.groundTruth } : {}),
    ...(options.autoScan ? { autoScan: options.autoScan } : {}),
    ...(options.licenseReview ? { licenseReview: options.licenseReview } : {}),
  };

  await writeFile(
    path.join(getCorpusAssetsRoot(options.repoRoot), `${id}${fileExtension}`),
    normalizedBytes,
  );
  options.assets.push(asset);
  return { asset, deduped: false };
}
