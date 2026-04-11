import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import * as S from 'effect/Schema';
import sharp from 'sharp';
import { readCorpusManifest, writeCorpusManifest } from '../manifest.js';
import type {
  AutoScan,
  CorpusAsset,
  CorpusAssetLabel,
  GroundTruth,
  ImportRemoteAssetOptions,
  ImportRemoteAssetResult,
  LicenseReview,
  RemoteSource,
  ReviewStatus,
} from '../schema.js';
import { assertHttpUrl } from '../url.js';
import { extensionFromMediaType, hashSha256, importAssetBytesEffect } from './store.js';

const ALLOWED_SOURCE_HOSTS = new Set([
  'pixabay.com',
  'commons.wikimedia.org',
  'publicdomainpictures.net',
  'pexels.com',
  'pdimagearchive.org',
  'unsplash.com',
]);

const PAGE_LINK_PATTERNS: Record<string, readonly RegExp[]> = {
  'pixabay.com': [/^\/(photos|illustrations|vectors)\//],
  'commons.wikimedia.org': [/^\/wiki\/File:/],
  'publicdomainpictures.net': [/^\/view-image\.php/, /^\/picture\//],
  'pexels.com': [/^\/photo\//],
  'pdimagearchive.org': [],
  'unsplash.com': [/^\/photos\//],
};

/**
 * Per-source allowlist of hosts that may serve image bytes. Secondary image
 * fetches are restricted to these hosts to prevent a compromised or hostile
 * allowlisted page from pivoting the scraper into arbitrary http(s) targets
 * (for example internal/localhost services reachable from the reviewer).
 */
const ALLOWED_IMAGE_HOSTS: Record<string, readonly string[]> = {
  'pixabay.com': ['pixabay.com', 'cdn.pixabay.com'],
  'commons.wikimedia.org': ['commons.wikimedia.org', 'upload.wikimedia.org'],
  'publicdomainpictures.net': ['publicdomainpictures.net'],
  'pexels.com': ['pexels.com', 'images.pexels.com'],
  'pdimagearchive.org': ['pdimagearchive.org'],
  'unsplash.com': ['unsplash.com', 'images.unsplash.com'],
};

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const StageReviewStatusSchema = S.Literals(['pending', 'approved', 'rejected', 'skipped']);
export type StageReviewStatus = S.Schema.Type<typeof StageReviewStatusSchema>;

const StageReviewSchema = S.Struct({
  status: StageReviewStatusSchema,
  reviewer: S.optional(S.String),
  reviewedAt: S.optional(S.String),
  notes: S.optional(S.String),
});
export type StageReview = S.Schema.Type<typeof StageReviewSchema>;

export const StagedRemoteAssetSchema = S.Struct({
  version: S.Literal(1),
  id: S.String,
  suggestedLabel: S.Literals(['qr-positive', 'non-qr-negative']),
  imageFileName: S.String,
  sourcePageUrl: S.String,
  imageUrl: S.String,
  seedUrl: S.String,
  sourceHost: S.String,
  fetchedAt: S.String,
  mediaType: S.String,
  byteLength: S.Number,
  sha256: S.String,
  width: S.Number,
  height: S.Number,
  pageTitle: S.optional(S.String),
  altText: S.optional(S.String),
  bestEffortLicense: S.optional(S.String),
  licenseEvidenceText: S.optional(S.String),
  review: StageReviewSchema,
  confirmedLicense: S.optional(S.String),
  groundTruth: S.optional(
    S.Struct({
      qrCount: S.Number,
      codes: S.Array(
        S.Struct({
          text: S.String,
          kind: S.optional(S.String),
          verifiedWith: S.optional(S.String),
          notes: S.optional(S.String),
        }),
      ),
    }),
  ),
  autoScan: S.optional(
    S.Struct({
      attempted: S.Boolean,
      succeeded: S.Boolean,
      results: S.Array(
        S.Struct({
          text: S.String,
          kind: S.optional(S.String),
        }),
      ),
      acceptedAsTruth: S.optional(S.Boolean),
    }),
  ),
  importedAssetId: S.optional(S.String),
});
export type StagedRemoteAsset = S.Schema.Type<typeof StagedRemoteAssetSchema>;

export interface ScrapeRemoteAssetsResult {
  readonly stageDir: string;
  readonly assets: readonly StagedRemoteAsset[];
}

export interface ImportStagedRemoteAssetsOptions {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly reviewStatus?: ReviewStatus;
  readonly reviewer?: string;
  readonly reviewNotes?: string;
  readonly overrideLabel?: CorpusAssetLabel;
  readonly attribution?: string;
  readonly license?: string;
  readonly provenanceNotes?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const tryPromise = <A>(evaluate: () => Promise<A>) => {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
};

const decodeStagedAsset = S.decodeUnknownSync(StagedRemoteAssetSchema);

const SAFE_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const assertSafeSlug = (value: string, label: string): void => {
  if (!SAFE_SLUG_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
};

const validateStagedAsset = (asset: StagedRemoteAsset): void => {
  assertSafeSlug(asset.id, 'asset id');
  assertSafeSlug(asset.imageFileName, 'image filename');
  assertHttpUrl(asset.sourcePageUrl, 'source page URL');
  assertHttpUrl(asset.imageUrl, 'image URL');
};

const normalizeHost = (value: string): string => {
  return value.replace(/^www\./, '').toLowerCase();
};

const assertAllowedSeed = (seedUrl: string): URL => {
  const url = new URL(seedUrl);
  const host = normalizeHost(url.hostname);

  if (!ALLOWED_SOURCE_HOSTS.has(host)) {
    throw new Error(`Seed host is not in the allowlist: ${host}`);
  }

  return url;
};

const absolutize = (baseUrl: string, value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

const parseSrcset = (value: string, baseUrl: string): readonly string[] => {
  return value
    .split(',')
    .map((entry) => entry.trim().split(/\s+/, 1)[0] ?? '')
    .map((candidate) => absolutize(baseUrl, candidate))
    .filter((candidate): candidate is string => candidate !== null);
};

const dedupe = (values: readonly string[]): string[] => {
  return [...new Set(values)];
};

const matchAllGroups = (pattern: RegExp, value: string, groupIndex = 1): string[] => {
  if (!pattern.global) {
    throw new Error('matchAllGroups requires a global regular expression');
  }

  const matches: string[] = [];
  let match = pattern.exec(value);

  while (match !== null) {
    const candidate = match[groupIndex];
    if (candidate) {
      matches.push(candidate);
    }
    match = pattern.exec(value);
  }

  return matches;
};

const getStagingRoot = (repoRoot: string): string => {
  return path.join(repoRoot, 'corpus', 'staging');
};

const ensureStageDir = (repoRoot: string) => {
  return tryPromise(async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stageDir = path.join(getStagingRoot(repoRoot), timestamp);
    await mkdir(stageDir, { recursive: true });
    return stageDir;
  });
};

const getAssetDir = (stageDir: string, assetId: string): string => {
  return path.join(stageDir, assetId);
};

const getAssetManifestPath = (stageDir: string, assetId: string): string => {
  return path.join(getAssetDir(stageDir, assetId), 'manifest.json');
};

const getAssetImagePath = (stageDir: string, asset: StagedRemoteAsset): string => {
  return path.join(getAssetDir(stageDir, asset.id), asset.imageFileName);
};

/**
 * Resolve `<stageDir>/<assetId>/<fileName>` and assert that the final
 * absolute path is contained within `<stageDir>`. This is a defense-in-depth
 * prefix check on top of `assertSafeSlug`, and gives a meaningful guarantee
 * even if the upstream validators are ever weakened or bypassed.
 */
export const resolveStagedAssetPath = (
  stageDir: string,
  assetId: string,
  fileName: string,
): string => {
  assertSafeSlug(assetId, 'asset id');
  assertSafeSlug(fileName, 'image filename');

  const absoluteStage = path.resolve(stageDir);
  const absoluteTarget = path.resolve(absoluteStage, assetId, fileName);
  const stageWithSep = absoluteStage.endsWith(path.sep)
    ? absoluteStage
    : `${absoluteStage}${path.sep}`;

  if (absoluteTarget !== absoluteStage && !absoluteTarget.startsWith(stageWithSep)) {
    throw new Error(`Staged path escapes stage directory: ${absoluteTarget}`);
  }

  return absoluteTarget;
};

const detectBestEffortLicense = (
  host: string,
  html: string,
): { bestEffortLicense?: string; licenseEvidenceText?: string } => {
  const lowerHtml = html.toLowerCase();
  const evidenceMatch =
    /(public domain|cc0|pixabay license|pexels license|royalty free|free download|unsplash license)/i.exec(
      html,
    )?.[0];

  if (host === 'commons.wikimedia.org' || host === 'pdimagearchive.org') {
    return {
      bestEffortLicense: 'Public domain (host allowlisted; verify page)',
      ...(evidenceMatch ? { licenseEvidenceText: evidenceMatch } : {}),
    };
  }
  if (lowerHtml.includes('pixabay license')) {
    return {
      bestEffortLicense: 'Pixabay License',
      ...(evidenceMatch ? { licenseEvidenceText: evidenceMatch } : {}),
    };
  }
  if (lowerHtml.includes('pexels license')) {
    return {
      bestEffortLicense: 'Pexels License',
      ...(evidenceMatch ? { licenseEvidenceText: evidenceMatch } : {}),
    };
  }
  if (lowerHtml.includes('royalty free') || lowerHtml.includes('free download')) {
    return {
      bestEffortLicense: 'Royalty free / free download (verify page)',
      ...(evidenceMatch ? { licenseEvidenceText: evidenceMatch } : {}),
    };
  }
  if (host === 'unsplash.com') {
    return {
      bestEffortLicense: 'Unsplash / free to use (verify page)',
      ...(evidenceMatch ? { licenseEvidenceText: evidenceMatch } : {}),
    };
  }
  if (evidenceMatch) {
    return { licenseEvidenceText: evidenceMatch };
  }
  return {};
};

const readLimitedBody = (response: Response, maxBytes: number, label: string) => {
  return tryPromise(async () => {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Response for ${label} exceeds ${maxBytes} bytes`);
    }

    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        throw new Error(`Response for ${label} exceeds ${maxBytes} bytes`);
      }
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new Error(`Response for ${label} exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  });
};

const fetchText = (url: string, fetchImpl: FetchLike) => {
  return Effect.gen(function* () {
    const response = yield* tryPromise(() =>
      fetchImpl(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'manual',
      }),
    );
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Unexpected redirect while fetching page ${url}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch page ${url}: ${response.status}`);
    }

    const htmlBytes = yield* readLimitedBody(response, MAX_HTML_BYTES, `page ${url}`);
    const html = new TextDecoder().decode(htmlBytes);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
    return {
      url,
      title,
      html,
    };
  });
};

const extractPageLinks = (pageUrl: string, html: string): readonly string[] => {
  const baseUrl = new URL(pageUrl);
  const host = normalizeHost(baseUrl.hostname);
  const patterns = PAGE_LINK_PATTERNS[host] ?? [];
  if (patterns.length === 0) return [];

  const matches = matchAllGroups(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi, html)
    .map((href) => absolutize(pageUrl, href))
    .filter((href): href is string => href !== null)
    .filter((href) => normalizeHost(new URL(href).hostname) === host)
    .filter((href) => patterns.some((pattern) => pattern.test(new URL(href).pathname)));

  return dedupe(matches);
};

const isAllowedImageHost = (sourceHost: string, imageUrl: string): boolean => {
  try {
    const imageHost = normalizeHost(new URL(imageUrl).hostname);
    const allowed = ALLOWED_IMAGE_HOSTS[sourceHost];
    if (!allowed) return imageHost === sourceHost;
    return allowed.some((host) => normalizeHost(host) === imageHost);
  } catch {
    return false;
  }
};

const extractImageCandidates = (pageUrl: string, html: string): readonly string[] => {
  const metaCandidates = [
    ...matchAllGroups(
      /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi,
      html,
    ),
    ...matchAllGroups(/<link\b[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["'][^>]*>/gi, html),
  ]
    .map((value) => absolutize(pageUrl, value))
    .filter((candidate): candidate is string => candidate !== null);

  const imageCandidates = [
    ...matchAllGroups(/<(?:img|source)\b[^>]*src=["']([^"']+)["'][^>]*>/gi, html),
    ...matchAllGroups(/<(?:img|source)\b[^>]*srcset=["']([^"']+)["'][^>]*>/gi, html).flatMap(
      (srcset) => parseSrcset(srcset, pageUrl),
    ),
  ]
    .map((value) => absolutize(pageUrl, value))
    .filter((candidate): candidate is string => candidate !== null);

  return dedupe([...metaCandidates, ...imageCandidates]);
};

const fetchImage = (url: string, fetchImpl: FetchLike) => {
  return Effect.gen(function* () {
    const response = yield* tryPromise(() =>
      fetchImpl(url, {
        headers: {
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
        },
        redirect: 'manual',
      }),
    );
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Unexpected redirect while fetching image ${url}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch image ${url}: ${response.status}`);
    }

    const bytes = yield* readLimitedBody(response, MAX_IMAGE_BYTES, `image ${url}`);
    return {
      bytes,
      mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  });
};

const writeStagedRemoteAssetEffect = (
  stageDir: string,
  asset: StagedRemoteAsset,
  bytes: Uint8Array,
): Effect.Effect<void, unknown> => {
  return tryPromise(async () => {
    validateStagedAsset(asset);
    const assetDir = getAssetDir(stageDir, asset.id);
    await mkdir(assetDir, { recursive: true });
    await writeFile(path.join(assetDir, asset.imageFileName), bytes);
    await writeFile(
      getAssetManifestPath(stageDir, asset.id),
      `${JSON.stringify(asset, null, 2)}\n`,
      'utf8',
    );
  });
};

export const writeStagedRemoteAsset = (
  stageDir: string,
  asset: StagedRemoteAsset,
  bytes: Uint8Array,
): Promise<void> => {
  return Effect.runPromise(writeStagedRemoteAssetEffect(stageDir, asset, bytes));
};

const updateStagedRemoteAssetEffect = (
  stageDir: string,
  asset: StagedRemoteAsset,
): Effect.Effect<void, unknown> => {
  return tryPromise(async () => {
    validateStagedAsset(asset);
    await writeFile(
      getAssetManifestPath(stageDir, asset.id),
      `${JSON.stringify(asset, null, 2)}\n`,
      'utf8',
    );
  });
};

export const updateStagedRemoteAsset = (
  stageDir: string,
  asset: StagedRemoteAsset,
): Promise<void> => {
  return Effect.runPromise(updateStagedRemoteAssetEffect(stageDir, asset));
};

const readStagedRemoteAssetEffect = (
  stageDir: string,
  assetId: string,
): Effect.Effect<StagedRemoteAsset, unknown> => {
  return Effect.gen(function* () {
    assertSafeSlug(assetId, 'asset id');
    const raw = yield* tryPromise(() => readFile(getAssetManifestPath(stageDir, assetId), 'utf8'));
    const asset = decodeStagedAsset(JSON.parse(raw));
    validateStagedAsset(asset);
    return asset;
  });
};

export const readStagedRemoteAsset = (
  stageDir: string,
  assetId: string,
): Promise<StagedRemoteAsset> => {
  return Effect.runPromise(readStagedRemoteAssetEffect(stageDir, assetId));
};

const readStagedRemoteAssetsEffect = (
  stageDir: string,
): Effect.Effect<readonly StagedRemoteAsset[], unknown> => {
  return Effect.gen(function* () {
    const entries = yield* tryPromise(() => readdir(stageDir, { withFileTypes: true }));
    const assets: StagedRemoteAsset[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      assets.push(yield* readStagedRemoteAssetEffect(stageDir, entry.name));
    }

    return assets.sort((left, right) => left.id.localeCompare(right.id));
  });
};

export const readStagedRemoteAssets = (stageDir: string): Promise<readonly StagedRemoteAsset[]> => {
  return Effect.runPromise(readStagedRemoteAssetsEffect(stageDir));
};

const buildRemoteSource = (
  asset: StagedRemoteAsset,
  options: ImportStagedRemoteAssetsOptions,
): RemoteSource => {
  const license = asset.confirmedLicense ?? options.license;
  return {
    kind: 'remote',
    sourcePageUrl: asset.sourcePageUrl,
    imageUrl: asset.imageUrl,
    fetchedAt: asset.fetchedAt,
    ...(asset.pageTitle ? { pageTitle: asset.pageTitle } : {}),
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(license ? { license } : {}),
    ...(options.provenanceNotes ? { notes: options.provenanceNotes } : {}),
  };
};

const buildLicenseReview = (
  asset: StagedRemoteAsset,
  reviewer?: string,
): LicenseReview | undefined => {
  if (!asset.bestEffortLicense && !asset.licenseEvidenceText && !asset.confirmedLicense) {
    return undefined;
  }

  return {
    ...(asset.bestEffortLicense ? { bestEffortLicense: asset.bestEffortLicense } : {}),
    ...(asset.licenseEvidenceText ? { licenseEvidenceText: asset.licenseEvidenceText } : {}),
    ...(asset.confirmedLicense ? { confirmedLicense: asset.confirmedLicense } : {}),
    ...(reviewer ? { licenseVerifiedBy: reviewer } : {}),
    ...(asset.review.reviewedAt ? { licenseVerifiedAt: asset.review.reviewedAt } : {}),
  };
};

const scrapeRemoteAssetsEffect = (
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike = fetch,
) => {
  return Effect.gen(function* () {
    const stageDir = yield* ensureStageDir(options.repoRoot);
    const assets: StagedRemoteAsset[] = [];
    const seenImageUrls = new Set<string>();
    const limit = options.limit ?? 100;

    for (const seedUrl of options.seedUrls) {
      if (assets.length >= limit) break;

      const seed = assertAllowedSeed(seedUrl);
      const seedPage = yield* fetchText(seed.toString(), fetchImpl);
      const pageUrls = extractPageLinks(seedPage.url, seedPage.html);
      const candidatePages = pageUrls.length > 0 ? pageUrls : [seedPage.url];

      for (const pageUrl of candidatePages) {
        if (assets.length >= limit) break;

        let page = seedPage;
        if (pageUrl !== seedPage.url) {
          page = yield* fetchText(pageUrl, fetchImpl);
        }
        const imageCandidates = extractImageCandidates(page.url, page.html);
        const host = normalizeHost(new URL(page.url).hostname);
        const licenseHint = detectBestEffortLicense(host, page.html);

        for (const imageUrl of imageCandidates) {
          if (assets.length >= limit) break;
          if (seenImageUrls.has(imageUrl)) continue;

          if (!isAllowedImageHost(host, imageUrl)) {
            options.log?.(`Skipped ${imageUrl}: host not in CDN allowlist for ${host}`);
            continue;
          }

          const asset = yield* Effect.gen(function* () {
            const { bytes, mediaType } = yield* fetchImage(imageUrl, fetchImpl);
            const extension = extensionFromMediaType(mediaType, imageUrl);
            const metadata = yield* tryPromise(() => sharp(bytes).metadata());
            const sha256 = hashSha256(bytes);
            const imageUrlHash = hashSha256(new TextEncoder().encode(imageUrl));
            const stagedAsset: StagedRemoteAsset = {
              version: 1,
              id: `stage-${sha256.slice(0, 16)}-${imageUrlHash.slice(0, 8)}`,
              suggestedLabel: options.label,
              imageFileName: `image${extension}`,
              sourcePageUrl: page.url,
              imageUrl,
              seedUrl,
              sourceHost: host,
              fetchedAt: new Date().toISOString(),
              mediaType,
              byteLength: bytes.byteLength,
              sha256,
              width: metadata.width ?? 0,
              height: metadata.height ?? 0,
              ...(page.title ? { pageTitle: page.title } : {}),
              ...licenseHint,
              review: {
                status: 'pending',
              },
            };

            yield* writeStagedRemoteAssetEffect(stageDir, stagedAsset, bytes);
            return stagedAsset;
          }).pipe(
            Effect.catch((error: unknown) =>
              Effect.sync(() => {
                options.log?.(
                  `Skipped ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`,
                );
                return null;
              }),
            ),
          );

          if (asset === null) {
            continue;
          }

          assets.push(asset);
          seenImageUrls.add(imageUrl);
        }
      }
    }

    return { stageDir, assets };
  });
};

export const scrapeRemoteAssets = (
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike = fetch,
): Promise<ScrapeRemoteAssetsResult> => {
  return Effect.runPromise(scrapeRemoteAssetsEffect(options, fetchImpl));
};

const importStagedRemoteAssetsEffect = (options: ImportStagedRemoteAssetsOptions) => {
  return Effect.gen(function* () {
    const stagedAssets = yield* readStagedRemoteAssetsEffect(options.stageDir);
    const manifest = yield* tryPromise(() => readCorpusManifest(options.repoRoot));
    const assets = [...manifest.assets];
    const imported: CorpusAsset[] = [];
    const deduped: CorpusAsset[] = [];

    for (const stagedAsset of stagedAssets) {
      const effectiveReviewStatus =
        stagedAsset.review.status === 'pending'
          ? (options.reviewStatus ?? 'pending')
          : stagedAsset.review.status;

      if (effectiveReviewStatus !== 'approved') {
        continue;
      }

      const reviewer = stagedAsset.review.reviewer ?? options.reviewer;
      const reviewNotes = stagedAsset.review.notes ?? options.reviewNotes;
      const reviewedAt = stagedAsset.review.reviewedAt ?? new Date().toISOString();
      const approvedAsset: StagedRemoteAsset = {
        ...stagedAsset,
        review: {
          status: 'approved',
          ...(reviewer ? { reviewer } : {}),
          reviewedAt,
          ...(reviewNotes ? { notes: reviewNotes } : {}),
        },
      };

      const sourcePath = getAssetImagePath(options.stageDir, approvedAsset);
      const bytes = yield* tryPromise(() => readFile(sourcePath));
      const licenseReview = buildLicenseReview(approvedAsset, reviewer);
      const result = yield* importAssetBytesEffect({
        repoRoot: options.repoRoot,
        assets,
        bytes: new Uint8Array(bytes),
        mediaType: approvedAsset.mediaType,
        sourcePathForExtension: approvedAsset.imageUrl,
        label: options.overrideLabel ?? approvedAsset.suggestedLabel,
        provenance: buildRemoteSource(approvedAsset, options),
        reviewStatus: 'approved',
        ...(reviewer ? { reviewer } : {}),
        ...(reviewNotes ? { reviewNotes } : {}),
        ...(approvedAsset.review.reviewedAt ? { reviewedAt: approvedAsset.review.reviewedAt } : {}),
        ...(approvedAsset.groundTruth
          ? { groundTruth: approvedAsset.groundTruth as GroundTruth }
          : {}),
        ...(approvedAsset.autoScan ? { autoScan: approvedAsset.autoScan as AutoScan } : {}),
        ...(licenseReview ? { licenseReview } : {}),
      });

      if (result.deduped) {
        deduped.push(result.asset);
      } else {
        imported.push(result.asset);
      }

      yield* updateStagedRemoteAssetEffect(options.stageDir, {
        ...approvedAsset,
        importedAssetId: result.asset.id,
      });
    }

    const nextManifest = { version: 1 as const, assets };
    yield* tryPromise(() => writeCorpusManifest(options.repoRoot, nextManifest));

    return {
      imported,
      deduped,
      manifest: nextManifest,
    };
  });
};

export const importStagedRemoteAssets = (
  options: ImportStagedRemoteAssetsOptions,
): Promise<ImportRemoteAssetResult> => {
  return Effect.runPromise(importStagedRemoteAssetsEffect(options));
};
