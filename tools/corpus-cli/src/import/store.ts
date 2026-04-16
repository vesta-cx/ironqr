import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Effect } from 'effect';
import sharp from 'sharp';
import {
  CorpusIntegrityError,
  FilesystemError,
  ImageProcessingError,
  UnsupportedMediaError,
} from '../errors.js';
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
const ASSET_ID_HASH_LENGTH = 16;
const NORMALIZED_IMAGE_MAX_DIMENSION = 1000;
const NORMALIZED_IMAGE_QUALITY = 80;

/** Compute the hex-encoded SHA-256 hash of a byte buffer. */
export const hashSha256 = (buffer: Uint8Array): string => {
  return createHash('sha256').update(buffer).digest('hex');
};

const buildAssetId = (sha256: string): string => {
  return `asset-${sha256.slice(0, ASSET_ID_HASH_LENGTH)}`;
};

const normalizeMediaType = (mediaType: string): string => {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? mediaType.toLowerCase();
};

/** Map a lowercase file extension (e.g. `.jpg`) to its MIME type, or `undefined` if unsupported. */
export const mediaTypeFromExtension = (extension: string): string | undefined => {
  return MEDIA_TYPES_BY_EXTENSION[extension.toLowerCase()];
};

/** Derive a file extension from a MIME type, falling back to the extension in `fallbackPath`. */
export const extensionFromMediaType = (mediaType: string, fallbackPath: string): string => {
  const normalizedMediaType = normalizeMediaType(mediaType);
  const fromMediaType = EXTENSIONS_BY_MEDIA_TYPE[normalizedMediaType];
  if (fromMediaType) return fromMediaType;

  let fromPath: string;
  try {
    fromPath = path.extname(new URL(fallbackPath).pathname).toLowerCase();
  } catch {
    fromPath = path.extname(fallbackPath).toLowerCase();
  }
  if (fromPath && mediaTypeFromExtension(fromPath)) {
    return fromPath;
  }

  throw new UnsupportedMediaError(`Unsupported image media type: ${mediaType}`);
};

/** Effect-based version of `importAssetBytes`, for composition in larger Effect pipelines. */
export const importAssetBytesEffect = (
  options: ImportAssetBytesOptions,
): Effect.Effect<
  ImportAssetBytesResult,
  FilesystemError | UnsupportedMediaError | ImageProcessingError | CorpusIntegrityError
> => {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => ensureCorpusLayout(options.repoRoot),
      catch: (e) => new FilesystemError('Failed to ensure corpus layout', e),
    });

    const sourceSha256 = options.sourceSha256 ?? hashSha256(options.bytes);
    const normalizedBytes = yield* normalizeImportedImage(options.bytes);
    const mediaType = NORMALIZED_IMAGE_MEDIA_TYPE;
    const sha256 = hashSha256(normalizedBytes);
    const id = buildAssetId(sourceSha256);
    const fileExtension = yield* Effect.try({
      try: () => extensionFromMediaType(mediaType, options.sourcePathForExtension),
      catch: (e) => (e instanceof UnsupportedMediaError ? e : new UnsupportedMediaError(String(e))),
    });
    const relativePath = `assets/${id}${fileExtension}`;
    const existingIndex = options.assets.findIndex((asset) => asset.id === id);

    if (existingIndex >= 0) {
      const existing = options.assets[existingIndex]!;

      if (existing.label !== options.label) {
        return yield* Effect.fail(
          new CorpusIntegrityError(`Asset ${id} already exists with label ${existing.label}`),
        );
      }

      const asset = yield* Effect.try({
        try: (): CorpusAsset => ({
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
          autoScan: mergeCanonicalMetadata(
            existing.autoScan,
            options.autoScan,
            'auto-scan evidence',
          ),
          licenseReview: mergeCanonicalMetadata(
            existing.licenseReview,
            options.licenseReview,
            'license review',
          ),
        }),
        catch: (e) => new CorpusIntegrityError(e instanceof Error ? e.message : String(e)),
      });
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
      sourceSha256,
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

    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          path.join(getCorpusAssetsRoot(options.repoRoot), `${id}${fileExtension}`),
          normalizedBytes,
        ),
      catch: (e) => new FilesystemError('Failed to write asset file', e),
    });
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
  merged[index] = mergeProvenanceRecord(merged[index]!, next);
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
  readonly sourcePathForExtension: string;
  readonly label: CorpusAssetLabel;
  readonly provenance: ProvenanceRecord;
  /**
   * sha256 of the original fetched/input bytes before normalization. When
   * provided, used as the stable asset identity + dedup key. Defaults to
   * hashing `bytes` if omitted, which is correct for local file imports.
   */
  readonly sourceSha256?: string;
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
  return Effect.tryPromise({
    try: async () => {
      const normalized = await sharp(bytes)
        .rotate()
        .resize({
          width: NORMALIZED_IMAGE_MAX_DIMENSION,
          height: NORMALIZED_IMAGE_MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: NORMALIZED_IMAGE_QUALITY })
        .toBuffer();

      return new Uint8Array(normalized);
    },
    catch: (e) => new ImageProcessingError('Failed to normalize image', e),
  });
};
