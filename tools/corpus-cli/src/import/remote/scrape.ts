import { Effect } from 'effect';
import sharp from 'sharp';
import { appendVisitedSourcePage, readScrapeProgress } from '../../manifest.js';
import { MAJOR_VERSION } from '../../version.js';
import { AsyncQueue } from '../queue.js';
import { hashSha256 } from '../store.js';
import type {
  ImportRemoteAssetOptions,
  ScrapeRemoteAssetsResult,
  ScrapeRemoteAssetsSession,
  StagedRemoteAsset,
} from './contracts.js';
import { tryPromise } from './effect.js';
import {
  type FetchLike,
  fetchCommonsFileMeta,
  fetchImage,
  fetchText,
  isCommonsSearchUrl,
  resolveCommonsSearchPages,
} from './fetch.js';
import {
  detectBestEffortLicense,
  extractCommonsAttribution,
  extractImageCandidates,
} from './html.js';
import type { SourcePage } from './page.js';
import { assertAllowedSeed, isAllowedImageHost, normalizeHost } from './policy.js';
import { resolveSourcePages } from './resolve.js';
import {
  collectExistingStagedSourceHashesEffect,
  ensureStageDir,
  readStagedRemoteAssets,
  writeStagedRemoteAssetEffect,
} from './stage-store.js';

const NORMALIZED_STAGED_MEDIA_TYPE = 'image/webp';
const NORMALIZED_STAGED_FILENAME = 'image.webp';
const STAGED_IMAGE_MAX_DIMENSION = 1000;
const STAGED_IMAGE_QUALITY = 80;
const STAGED_ID_SHA256_LENGTH = 16;
const STAGED_ID_URL_HASH_LENGTH = 8;
const DEFAULT_STAGE_LIMIT = 100;

const normalizeScrapedImage = (bytes: Uint8Array) => {
  return tryPromise(async () => {
    const pipeline = sharp(bytes)
      .rotate()
      .resize({
        width: STAGED_IMAGE_MAX_DIMENSION,
        height: STAGED_IMAGE_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: STAGED_IMAGE_QUALITY });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      width: info.width,
      height: info.height,
    };
  });
};

interface CreateStagedAssetOptions {
  readonly page: SourcePage;
  readonly seedUrl: string;
  readonly host: string;
  readonly imageUrl: string;
  readonly sourceMediaType: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly normalized: {
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
  };
  readonly suggestedLabel: StagedRemoteAsset['suggestedLabel'];
  readonly licenseHint: {
    readonly bestEffortLicense?: string;
    readonly licenseEvidenceText?: string;
  };
  readonly attributionText?: string | undefined;
}

const createStagedRemoteAsset = (opts: CreateStagedAssetOptions): StagedRemoteAsset => {
  const sha256 = hashSha256(opts.normalized.bytes);
  const imageUrlHash = hashSha256(new TextEncoder().encode(opts.imageUrl));

  return {
    version: MAJOR_VERSION,
    id: `stage-${opts.sourceSha256.slice(0, STAGED_ID_SHA256_LENGTH)}-${imageUrlHash.slice(0, STAGED_ID_URL_HASH_LENGTH)}`,
    suggestedLabel: opts.suggestedLabel,
    imageFileName: NORMALIZED_STAGED_FILENAME,
    sourcePageUrl: opts.page.url,
    imageUrl: opts.imageUrl,
    seedUrl: opts.seedUrl,
    sourceHost: opts.host,
    fetchedAt: new Date().toISOString(),
    mediaType: NORMALIZED_STAGED_MEDIA_TYPE,
    byteLength: opts.normalized.bytes.byteLength,
    sha256,
    sourceSha256: opts.sourceSha256,
    sourceMediaType: opts.sourceMediaType,
    sourceByteLength: opts.sourceByteLength,
    width: opts.normalized.width,
    height: opts.normalized.height,
    ...(opts.page.title ? { pageTitle: opts.page.title } : {}),
    ...(opts.attributionText ? { attributionText: opts.attributionText } : {}),
    ...opts.licenseHint,
    review: {
      status: 'pending',
    },
  };
};

const scrapeRemoteAssetsLoopEffect = (
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike,
  stageDir: string,
  onStagedAsset: (asset: StagedRemoteAsset) => void,
) => {
  return Effect.gen(function* () {
    const assets: StagedRemoteAsset[] = [];
    const seenImageUrls = new Set<string>();
    const limit = options.limit ?? DEFAULT_STAGE_LIMIT;
    const log = options.log ?? (() => {});
    const fetchDelayMs = options.fetchDelayMs ?? 0;
    const seenSourceSha256 = yield* collectExistingStagedSourceHashesEffect(options.repoRoot);

    if (seenSourceSha256.size > 0) {
      log(`Cross-run dedup: ${seenSourceSha256.size} previously staged image(s) will be skipped`);
    }

    const scrapeProgress = yield* tryPromise(() => readScrapeProgress(options.repoRoot));
    const seenSourcePageUrls = new Set<string>(scrapeProgress.visitedSourcePageUrls);

    if (seenSourcePageUrls.size > 0) {
      log(
        `Page-level dedup: ${seenSourcePageUrls.size} previously visited page(s) will be skipped`,
      );
    }

    for (const seedUrl of options.seedUrls) {
      if (assets.length >= limit) break;

      const seed = assertAllowedSeed(seedUrl);
      log(`Fetching seed ${seed.toString()}`);
      let resolvedSourcePages = 0;

      const onPageCallback = (page: SourcePage) =>
        Effect.gen(function* () {
          resolvedSourcePages += 1;
          if (assets.length >= limit) {
            return yield* Effect.fail({ _tag: 'LimitReached' } as const);
          }

          yield* processSourcePage(
            page,
            seedUrl,
            fetchImpl,
            fetchDelayMs,
            log,
            limit,
            options.label,
            seenImageUrls,
            seenSourceSha256,
            assets,
            stageDir,
            onStagedAsset,
          );

          // Mark the source page as visited so the next scrape session skips
          // fetching it entirely rather than re-deduping all its images.
          seenSourcePageUrls.add(page.url);
          yield* tryPromise(() => appendVisitedSourcePage(options.repoRoot, page.url));
        });

      const catchLimit = Effect.catchIf(
        (e: unknown): e is { readonly _tag: 'LimitReached' } =>
          typeof e === 'object' && e !== null && '_tag' in e && e._tag === 'LimitReached',
        () => Effect.void,
      );

      if (isCommonsSearchUrl(seed.toString())) {
        // Use the Wikimedia Commons search API for paginated results
        // instead of scraping the infiniscroll HTML page.
        yield* resolveCommonsSearchPages(
          seed.toString(),
          fetchImpl,
          limit - assets.length,
          fetchDelayMs,
          log,
          seenSourcePageUrls,
          onPageCallback,
        ).pipe(catchLimit);
      } else {
        const seedPage = yield* fetchText(seed.toString(), fetchImpl, false);
        const state = {
          seenPages: new Set<string>(),
          yieldedLeaves: new Set<string>(),
          visitedSourcePageUrls: seenSourcePageUrls,
        };

        yield* resolveSourcePages(
          seedPage,
          { fetchImpl, log, fetchDelayMs },
          state,
          onPageCallback,
        ).pipe(catchLimit);
      }

      log(`Resolved ${resolvedSourcePages} source page(s) for ${seed.toString()}`);
    }

    log(`Scrape complete: staged ${assets.length} image(s) in ${stageDir}`);
    return assets as readonly StagedRemoteAsset[];
  });
};

const processSourcePage = (
  page: SourcePage,
  seedUrl: string,
  fetchImpl: FetchLike,
  fetchDelayMs: number,
  log: (line: string) => void,
  limit: number,
  label: StagedRemoteAsset['suggestedLabel'],
  seenImageUrls: Set<string>,
  seenSourceSha256: Set<string>,
  assets: StagedRemoteAsset[],
  stageDir: string,
  onStagedAsset: (asset: StagedRemoteAsset) => void,
) => {
  return Effect.gen(function* () {
    const imageCandidates = extractImageCandidates(page.url, page.html, page.isDetail);
    const host = normalizeHost(new URL(page.url).hostname);
    let licenseHint = detectBestEffortLicense(host, page.html);
    let attributionText =
      host === 'commons.wikimedia.org' ? extractCommonsAttribution(page.html) : null;

    // For Commons detail pages prefer the structured API over HTML parsing —
    // the HTML can have multiple licensetpl_short spans at different versions.
    if (host === 'commons.wikimedia.org' && page.isDetail) {
      yield* Effect.sleep(fetchDelayMs);
      const apiMeta = yield* fetchCommonsFileMeta(page.url, fetchImpl);
      if (apiMeta?.license) {
        licenseHint = {
          bestEffortLicense: apiMeta.license,
          licenseEvidenceText: `Wikimedia API: ${apiMeta.license}`,
        };
      }
      if (apiMeta?.attribution) {
        attributionText = apiMeta.attribution;
      }
    }

    log(`Considering ${imageCandidates.length} image(s) from ${page.url}`);

    for (const imageUrl of imageCandidates) {
      if (assets.length >= limit) break;
      if (seenImageUrls.has(imageUrl)) {
        log(`Skipped ${imageUrl}: already staged this run`);
        continue;
      }

      if (!isAllowedImageHost(host, imageUrl)) {
        log(`Skipped ${imageUrl}: host not in CDN allowlist for ${host}`);
        continue;
      }

      log(`Fetching image ${imageUrl}`);
      yield* Effect.sleep(fetchDelayMs);

      const asset = yield* stageImage(
        page,
        seedUrl,
        host,
        imageUrl,
        fetchImpl,
        label,
        licenseHint,
        attributionText ?? undefined,
        seenSourceSha256,
        stageDir,
        log,
      );

      if (asset === null) continue;

      log(`Staged ${asset.id} from ${imageUrl}`);
      assets.push(asset);
      seenImageUrls.add(imageUrl);
      seenSourceSha256.add(asset.sourceSha256);
      onStagedAsset(asset);
    }
  });
};

const stageImage = (
  page: SourcePage,
  seedUrl: string,
  host: string,
  imageUrl: string,
  fetchImpl: FetchLike,
  label: StagedRemoteAsset['suggestedLabel'],
  licenseHint: { readonly bestEffortLicense?: string; readonly licenseEvidenceText?: string },
  attributionText: string | undefined,
  seenSourceSha256: Set<string>,
  stageDir: string,
  log: (line: string) => void,
): Effect.Effect<StagedRemoteAsset | null, unknown> => {
  return Effect.gen(function* () {
    const { bytes: rawBytes, mediaType: sourceMediaType } = yield* fetchImage(imageUrl, fetchImpl);
    const sourceSha256 = hashSha256(rawBytes);

    if (seenSourceSha256.has(sourceSha256)) {
      log(`Skipped ${imageUrl}: sourceSha256 already staged in an earlier run`);
      return null;
    }

    const normalized = yield* normalizeScrapedImage(rawBytes);
    const asset = createStagedRemoteAsset({
      page,
      seedUrl,
      host,
      imageUrl,
      sourceMediaType,
      sourceSha256,
      sourceByteLength: rawBytes.byteLength,
      normalized,
      suggestedLabel: label,
      licenseHint,
      attributionText,
    });

    yield* writeStagedRemoteAssetEffect(stageDir, asset, normalized.bytes);
    return asset;
  }).pipe(
    Effect.catch((error: unknown) => {
      log(`Skipped ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`);
      return Effect.succeed(null);
    }),
  );
};

const scrapeRemoteAssetsEffect = (
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike = fetch,
) => {
  return Effect.gen(function* () {
    const stageDir = yield* ensureStageDir(options.repoRoot);
    const assets = yield* scrapeRemoteAssetsLoopEffect(options, fetchImpl, stageDir, () => {});
    return { stageDir, assets } satisfies ScrapeRemoteAssetsResult;
  });
};

/**
 * Scrapes images from `options.seedUrls` and writes them to the staging area.
 * Returns the stage directory path and the full list of staged assets.
 */
export const scrapeRemoteAssets = (
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike = fetch,
): Promise<ScrapeRemoteAssetsResult> => {
  return Effect.runPromise(scrapeRemoteAssetsEffect(options, fetchImpl));
};

/**
 * Starts a non-blocking scrape session and returns a `ScrapeRemoteAssetsSession`.
 * Assets stream out via `session.assets`; `session.done` resolves with the complete list.
 */
export const startScrapeRemoteAssets = async (
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike = fetch,
): Promise<ScrapeRemoteAssetsSession> => {
  const stageDir = await Effect.runPromise(ensureStageDir(options.repoRoot));
  const queue = new AsyncQueue<StagedRemoteAsset>();

  const done = Effect.runPromise(
    scrapeRemoteAssetsLoopEffect(options, fetchImpl, stageDir, (asset) => queue.push(asset)),
  )
    .then((assets) => {
      queue.close();
      return assets;
    })
    .catch((error: unknown) => {
      queue.close();
      throw error;
    });

  return { stageDir, assets: queue, done };
};

/** Async-generator that yields every staged asset from an existing `stageDir`. */
export const streamStagedRemoteAssets = async function* (
  stageDir: string,
): AsyncGenerator<StagedRemoteAsset> {
  const assets = await readStagedRemoteAssets(stageDir);
  for (const asset of assets) {
    yield asset;
  }
};
