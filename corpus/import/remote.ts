import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
import { extensionFromMediaType, hashSha256, importAssetBytes } from './store.js';

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

interface ParsedPage {
  readonly url: string;
  readonly title: string | null;
  readonly html: string;
}

const decodeStagedAsset = S.decodeUnknownSync(StagedRemoteAssetSchema);

const SAFE_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertSafeSlug(value: string, label: string): void {
  if (!SAFE_SLUG_PATTERN.test(value) || value.includes('..')) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function assertHttpUrl(value: string, label: string): void {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Expected http(s) URL for ${label}, got ${url.protocol}`);
  }
}

function validateStagedAsset(asset: StagedRemoteAsset): void {
  assertSafeSlug(asset.id, 'asset id');
  assertSafeSlug(asset.imageFileName, 'image filename');
  assertHttpUrl(asset.sourcePageUrl, 'source page URL');
  assertHttpUrl(asset.imageUrl, 'image URL');
}

function normalizeHost(value: string): string {
  return value.replace(/^www\./, '').toLowerCase();
}

function assertAllowedSeed(seedUrl: string): URL {
  const url = new URL(seedUrl);
  const host = normalizeHost(url.hostname);

  if (!ALLOWED_SOURCE_HOSTS.has(host)) {
    throw new Error(`Seed host is not in the allowlist: ${host}`);
  }

  return url;
}

function absolutize(baseUrl: string, value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseSrcset(value: string, baseUrl: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().split(/\s+/, 1)[0] ?? '')
    .map((candidate) => absolutize(baseUrl, candidate))
    .filter((candidate): candidate is string => candidate !== null);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function matchAllGroups(pattern: RegExp, value: string, groupIndex = 1): string[] {
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
}

function getStagingRoot(repoRoot: string): string {
  return path.join(repoRoot, 'corpus', 'staging');
}

async function ensureStageDir(repoRoot: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stageDir = path.join(getStagingRoot(repoRoot), timestamp);
  await mkdir(stageDir, { recursive: true });
  return stageDir;
}

function getAssetDir(stageDir: string, assetId: string): string {
  return path.join(stageDir, assetId);
}

function getAssetManifestPath(stageDir: string, assetId: string): string {
  return path.join(getAssetDir(stageDir, assetId), 'manifest.json');
}

function getAssetImagePath(stageDir: string, asset: StagedRemoteAsset): string {
  return path.join(getAssetDir(stageDir, asset.id), asset.imageFileName);
}

function detectBestEffortLicense(
  host: string,
  html: string,
): { bestEffortLicense?: string; licenseEvidenceText?: string } {
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
}

async function fetchText(url: string, fetchImpl: FetchLike): Promise<ParsedPage> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch page ${url}: ${response.status}`);
  }

  const html = await response.text();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  return {
    url,
    title,
    html,
  };
}

function extractPageLinks(pageUrl: string, html: string): readonly string[] {
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
}

function isAllowedImageHost(sourceHost: string, imageUrl: string): boolean {
  try {
    const imageHost = normalizeHost(new URL(imageUrl).hostname);
    const allowed = ALLOWED_IMAGE_HOSTS[sourceHost];
    if (!allowed) return imageHost === sourceHost;
    return allowed.some((host) => normalizeHost(host) === imageHost);
  } catch {
    return false;
  }
}

function extractImageCandidates(pageUrl: string, html: string): readonly string[] {
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
}

async function fetchImage(
  url: string,
  fetchImpl: FetchLike,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch image ${url}: ${response.status}`);
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export async function writeStagedRemoteAsset(
  stageDir: string,
  asset: StagedRemoteAsset,
  bytes: Uint8Array,
): Promise<void> {
  validateStagedAsset(asset);
  const assetDir = getAssetDir(stageDir, asset.id);
  await mkdir(assetDir, { recursive: true });
  await writeFile(path.join(assetDir, asset.imageFileName), bytes);
  await writeFile(
    getAssetManifestPath(stageDir, asset.id),
    `${JSON.stringify(asset, null, 2)}\n`,
    'utf8',
  );
}

export async function updateStagedRemoteAsset(
  stageDir: string,
  asset: StagedRemoteAsset,
): Promise<void> {
  validateStagedAsset(asset);
  await writeFile(
    getAssetManifestPath(stageDir, asset.id),
    `${JSON.stringify(asset, null, 2)}\n`,
    'utf8',
  );
}

export async function readStagedRemoteAsset(
  stageDir: string,
  assetId: string,
): Promise<StagedRemoteAsset> {
  assertSafeSlug(assetId, 'asset id');
  const raw = await readFile(getAssetManifestPath(stageDir, assetId), 'utf8');
  const asset = decodeStagedAsset(JSON.parse(raw));
  validateStagedAsset(asset);
  return asset;
}

export async function readStagedRemoteAssets(
  stageDir: string,
): Promise<readonly StagedRemoteAsset[]> {
  const entries = await readdir(stageDir, { withFileTypes: true });
  const assets: StagedRemoteAsset[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    assets.push(await readStagedRemoteAsset(stageDir, entry.name));
  }

  return assets.sort((left, right) => left.id.localeCompare(right.id));
}

function buildRemoteSource(
  asset: StagedRemoteAsset,
  options: ImportStagedRemoteAssetsOptions,
): RemoteSource {
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
}

function buildLicenseReview(
  asset: StagedRemoteAsset,
  reviewer?: string,
): LicenseReview | undefined {
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
}

export async function scrapeRemoteAssets(
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike = fetch,
): Promise<ScrapeRemoteAssetsResult> {
  const stageDir = await ensureStageDir(options.repoRoot);
  const assets: StagedRemoteAsset[] = [];
  const seenImageUrls = new Set<string>();
  const limit = options.limit ?? 100;

  for (const seedUrl of options.seedUrls) {
    if (assets.length >= limit) break;

    const seed = assertAllowedSeed(seedUrl);
    const seedPage = await fetchText(seed.toString(), fetchImpl);
    const pageUrls = extractPageLinks(seedPage.url, seedPage.html);
    const candidatePages = pageUrls.length > 0 ? pageUrls : [seedPage.url];

    for (const pageUrl of candidatePages) {
      if (assets.length >= limit) break;

      const page = pageUrl === seedPage.url ? seedPage : await fetchText(pageUrl, fetchImpl);
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

        try {
          const { bytes, mediaType } = await fetchImage(imageUrl, fetchImpl);
          const extension = extensionFromMediaType(mediaType, imageUrl);
          const metadata = await sharp(bytes).metadata();
          const id = `stage-${hashSha256(bytes).slice(0, 16)}`;
          const asset: StagedRemoteAsset = {
            version: 1,
            id,
            suggestedLabel: options.label,
            imageFileName: `image${extension}`,
            sourcePageUrl: page.url,
            imageUrl,
            seedUrl,
            sourceHost: host,
            fetchedAt: new Date().toISOString(),
            mediaType,
            byteLength: bytes.byteLength,
            sha256: hashSha256(bytes),
            width: metadata.width ?? 0,
            height: metadata.height ?? 0,
            ...(page.title ? { pageTitle: page.title } : {}),
            ...licenseHint,
            review: {
              status: 'pending',
            },
          };

          await writeStagedRemoteAsset(stageDir, asset, bytes);
          assets.push(asset);
          seenImageUrls.add(imageUrl);
          break;
        } catch (error) {
          options.log?.(
            `Skipped ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  return { stageDir, assets };
}

export async function importStagedRemoteAssets(
  options: ImportStagedRemoteAssetsOptions,
): Promise<ImportRemoteAssetResult> {
  const stagedAssets = await readStagedRemoteAssets(options.stageDir);
  const manifest = await readCorpusManifest(options.repoRoot);
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
    const bytes = await readFile(sourcePath);
    const licenseReview = buildLicenseReview(approvedAsset, reviewer);
    const result = await importAssetBytes({
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

    await updateStagedRemoteAsset(options.stageDir, {
      ...approvedAsset,
      importedAssetId: result.asset.id,
    });
  }

  const nextManifest = { version: 1 as const, assets };
  await writeCorpusManifest(options.repoRoot, nextManifest);

  return {
    imported,
    deduped,
    manifest: nextManifest,
  };
}
