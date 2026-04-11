import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Effect } from 'effect';
import sharp from 'sharp';
import { ensureCorpusLayout, getCorpusAssetsRoot } from '../manifest.js';
import type {
  AssetReview,
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

export const hashSha256 = (buffer: Uint8Array): string => {
  return createHash('sha256').update(buffer).digest('hex');
};

const buildAssetId = (sha256: string): string => {
  return `asset-${sha256.slice(0, 16)}`;
};

const normalizeMediaType = (mediaType: string): string => {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? mediaType.toLowerCase();
};

export const mediaTypeFromExtension = (extension: string): string | undefined => {
  return MEDIA_TYPES_BY_EXTENSION[extension.toLowerCase()];
};

export const extensionFromMediaType = (mediaType: string, fallbackPath: string): string => {
  const normalizedMediaType = normalizeMediaType(mediaType);
  const fromMediaType = EXTENSIONS_BY_MEDIA_TYPE[normalizedMediaType];
  if (fromMediaType) return fromMediaType;

  const fromPath = path.extname(new URL(fallbackPath).pathname || fallbackPath).toLowerCase();
  if (fromPath && mediaTypeFromExtension(fromPath)) {
    return fromPath;
  }

  throw new Error(`Unsupported image media type: ${mediaType}`);
};

export const importAssetBytes = (
  options: ImportAssetBytesOptions,
): Promise<ImportAssetBytesResult> => {
  return Effect.runPromise(importAssetBytesEffect(options));
};

export const importAssetBytesEffect = (
  options: ImportAssetBytesOptions,
): Effect.Effect<ImportAssetBytesResult, unknown> => {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() => ensureCorpusLayout(options.repoRoot));

    const normalizedBytes = yield* normalizeImportedImage(options.bytes);
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
        review: mergeReview(existing.review, {
          ...(options.reviewStatus ? { status: options.reviewStatus } : {}),
          ...(options.reviewer ? { reviewer: options.reviewer } : {}),
          ...(options.reviewNotes ? { reviewNotes: options.reviewNotes } : {}),
          ...(options.reviewedAt ? { reviewedAt: options.reviewedAt } : {}),
        }),
        groundTruth: mergeCanonicalMetadata(
          existing.groundTruth,
          options.groundTruth,
          'ground truth',
        ),
        autoScan: mergeCanonicalMetadata(existing.autoScan, options.autoScan, 'auto-scan evidence'),
        licenseReview: mergeCanonicalMetadata(
          existing.licenseReview,
          options.licenseReview,
          'license review',
        ),
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
        ...(options.reviewStatus && options.reviewStatus !== 'pending'
          ? { reviewedAt: options.reviewedAt ?? new Date().toISOString() }
          : {}),
        ...(options.reviewNotes ? { notes: options.reviewNotes } : {}),
      },
      ...(options.groundTruth ? { groundTruth: options.groundTruth } : {}),
      ...(options.autoScan ? { autoScan: options.autoScan } : {}),
      ...(options.licenseReview ? { licenseReview: options.licenseReview } : {}),
    };

    yield* Effect.tryPromise(() =>
      writeFile(
        path.join(getCorpusAssetsRoot(options.repoRoot), `${id}${fileExtension}`),
        normalizedBytes,
      ),
    );
    options.assets.push(asset);
    return { asset, deduped: false };
  });
};

const sameProvenance = (left: ProvenanceRecord, right: ProvenanceRecord): boolean => {
  if (left.kind !== right.kind) return false;

  if (left.kind === 'local' && right.kind === 'local') {
    return left.originalPath === right.originalPath;
  }

  if (left.kind === 'remote' && right.kind === 'remote') {
    return left.sourcePageUrl === right.sourcePageUrl && left.imageUrl === right.imageUrl;
  }

  return false;
};

const mergeProvenanceRecord = (
  existing: ProvenanceRecord,
  incoming: ProvenanceRecord,
): ProvenanceRecord => {
  if (existing.kind === 'local' && incoming.kind === 'local') {
    const attribution = incoming.attribution ?? existing.attribution;
    const license = incoming.license ?? existing.license;
    const notes = incoming.notes ?? existing.notes;

    return {
      kind: 'local',
      originalPath: existing.originalPath,
      importedAt: existing.importedAt,
      ...(attribution ? { attribution } : {}),
      ...(license ? { license } : {}),
      ...(notes ? { notes } : {}),
    };
  }

  if (existing.kind === 'remote' && incoming.kind === 'remote') {
    const pageTitle = incoming.pageTitle ?? existing.pageTitle;
    const attribution = incoming.attribution ?? existing.attribution;
    const license = incoming.license ?? existing.license;
    const notes = incoming.notes ?? existing.notes;

    return {
      kind: 'remote',
      sourcePageUrl: existing.sourcePageUrl,
      imageUrl: existing.imageUrl,
      fetchedAt: existing.fetchedAt,
      ...(pageTitle ? { pageTitle } : {}),
      ...(attribution ? { attribution } : {}),
      ...(license ? { license } : {}),
      ...(notes ? { notes } : {}),
    };
  }

  throw new Error('Cannot merge provenance records of different kinds');
};

const mergeProvenance = (
  existing: readonly ProvenanceRecord[],
  next: ProvenanceRecord,
): readonly ProvenanceRecord[] => {
  const index = existing.findIndex((source) => sameProvenance(source, next));
  if (index < 0) {
    return [...existing, next];
  }

  const merged = [...existing];
  const existingRecord = merged[index];
  if (!existingRecord) {
    throw new Error(`Missing provenance at index ${index}`);
  }

  merged[index] = mergeProvenanceRecord(existingRecord, next);
  return merged;
};

const mergeCanonicalMetadata = <T extends object>(
  existing: T | undefined,
  incoming: T | undefined,
  label: string,
): T | undefined => {
  if (existing === undefined) return incoming;
  if (incoming === undefined) return existing;
  if (isDeepStrictEqual(existing, incoming)) {
    return existing;
  }

  throw new Error(`Cannot change ${label} on dedupe`);
};

/**
 * Merge an incoming review into an existing asset review, keeping the more
 * authoritative state and filling in any metadata the existing review is
 * missing.
 *
 * Rules:
 * - If incoming brings a different authoritative status (`approved` vs
 *   `rejected`) on top of an already-decided review, we refuse to silently
 *   flip it and throw. Status transitions must be explicit.
 * - If incoming upgrades `pending` → `approved`/`rejected`, incoming fully
 *   owns the review (status, reviewer, reviewedAt, notes).
 * - Otherwise the existing review's status wins, but incoming may fill in
 *   any reviewer/notes that the existing review is missing. The first
 *   recorded reviewer is kept when both sides have one.
 */
const mergeReview = (
  existing: AssetReview,
  incoming: {
    readonly status?: ReviewStatus;
    readonly reviewer?: string;
    readonly reviewNotes?: string;
    readonly reviewedAt?: string;
  },
): AssetReview => {
  const incomingStatus = incoming.status;

  if (
    incomingStatus &&
    incomingStatus !== 'pending' &&
    existing.status !== 'pending' &&
    existing.status !== incomingStatus
  ) {
    throw new Error(
      `Cannot change review status from ${existing.status} to ${incomingStatus} on dedupe`,
    );
  }

  const isUpgrade =
    existing.status === 'pending' && incomingStatus !== undefined && incomingStatus !== 'pending';

  if (isUpgrade) {
    return {
      status: incomingStatus as ReviewStatus,
      ...(incoming.reviewer ? { reviewer: incoming.reviewer } : {}),
      reviewedAt: incoming.reviewedAt ?? new Date().toISOString(),
      ...(incoming.reviewNotes ? { notes: incoming.reviewNotes } : {}),
    };
  }

  const mergedReviewer = existing.reviewer ?? incoming.reviewer;
  const mergedNotes = existing.notes ?? incoming.reviewNotes;
  const mergedReviewedAt = existing.reviewedAt ?? incoming.reviewedAt;

  if (
    mergedReviewer === existing.reviewer &&
    mergedNotes === existing.notes &&
    mergedReviewedAt === existing.reviewedAt
  ) {
    return existing;
  }

  return {
    status: existing.status,
    ...(mergedReviewer ? { reviewer: mergedReviewer } : {}),
    ...(mergedReviewedAt && existing.status !== 'pending' ? { reviewedAt: mergedReviewedAt } : {}),
    ...(mergedNotes ? { notes: mergedNotes } : {}),
  };
};

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
  readonly reviewedAt?: string;
  readonly groundTruth?: GroundTruth;
  readonly autoScan?: AutoScan;
  readonly licenseReview?: LicenseReview;
}

interface ImportAssetBytesResult {
  readonly asset: CorpusAsset;
  readonly deduped: boolean;
}

const normalizeImportedImage = (bytes: Uint8Array) => {
  return Effect.tryPromise(async () => {
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
  });
};
