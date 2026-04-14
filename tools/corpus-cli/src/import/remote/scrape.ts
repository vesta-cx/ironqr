import { Effect } from 'effect';
import sharp from 'sharp';
import { appendVisitedSourcePage, readScrapeProgress } from '../../manifest.js';
import type { ImportRemoteAssetOptions } from '../../schema.js';
import { AsyncQueue } from '../queue.js';
import { hashSha256 } from '../store.js';
import type {
  ScrapeRemoteAssetsResult,
  ScrapeRemoteAssetsSession,
  StagedRemoteAsset,
} from './contracts.js';
import { tryPromise } from './effect.js';
import { type FetchLike, fetchImage, fetchText } from './fetch.js';
import {
  detectBestEffortLicense,
  extractCommonsAttribution,
  extractImageCandidates,
} from './html.js';
import type { SourcePage } from './page.js';
import { assertAllowedSeed, isAllowedImageHost, normalizeHost } from './policy.js';
import { resolveSourcePagesEffect } from './resolve.js';
import {
  collectExistingStagedSourceHashesEffect,
  ensureStageDir,
  readStagedRemoteAssets,
  writeStagedRemoteAssetEffect,
} from './stage-store.js';

const NORMALIZED_STAGED_MEDIA_TYPE = 'image/webp';
const NORMALIZED_STAGED_FILENAME = 'image.webp';

const normalizeScrapedImage = (bytes: Uint8Array) => {
  return tryPromise(async () => {
    const pipeline = sharp(bytes)
      .rotate()
      .resize({
        width: 1000,
        height: 1000,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      width: info.width,
      height: info.height,
    };
  });
};

const createStagedRemoteAsset = (
  page: SourcePage,
  seedUrl: string,
  host: string,
  imageUrl: string,
  sourceMediaType: string,
  sourceSha256: string,
  sourceByteLength: number,
  normalized: { readonly bytes: Uint8Array; readonly width: number; readonly height: number },
  suggestedLabel: StagedRemoteAsset['suggestedLabel'],
  licenseHint: { readonly bestEffortLicense?: string; readonly licenseEvidenceText?: string },
  attributionText?: string,
): StagedRemoteAsset => {
  const sha256 = hashSha256(normalized.bytes);
  const imageUrlHash = hashSha256(new TextEncoder().encode(imageUrl));

  return {
    version: 1,
    id: `stage-${sourceSha256.slice(0, 16)}-${imageUrlHash.slice(0, 8)}`,
    suggestedLabel,
    imageFileName: NORMALIZED_STAGED_FILENAME,
    sourcePageUrl: page.url,
    imageUrl,
    seedUrl,
    sourceHost: host,
    fetchedAt: new Date().toISOString(),
    mediaType: NORMALIZED_STAGED_MEDIA_TYPE,
    byteLength: normalized.bytes.byteLength,
    sha256,
    sourceSha256,
    sourceMediaType,
    sourceByteLength,
    width: normalized.width,
    height: normalized.height,
    ...(page.title ? { pageTitle: page.title } : {}),
    ...(attributionText ? { attributionText } : {}),
    ...licenseHint,
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
  return tryPromise(async () => {
    const assets: StagedRemoteAsset[] = [];
    const seenImageUrls = new Set<string>();
    const limit = options.limit ?? 100;
    const log = options.log ?? (() => {});
    const fetchDelayMs = options.fetchDelayMs ?? 0;
    const seenSourceSha256 = await Effect.runPromise(
      collectExistingStagedSourceHashesEffect(options.repoRoot),
    );

    if (seenSourceSha256.size > 0) {
      log(`Cross-run dedup: ${seenSourceSha256.size} previously staged image(s) will be skipped`);
    }

    const scrapeProgress = await readScrapeProgress(options.repoRoot);
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
      const seedPage = await Effect.runPromise(fetchText(seed.toString(), fetchImpl, false));
      let resolvedSourcePages = 0;
      const state = {
        seenPages: new Set<string>(),
        yieldedLeaves: new Set<string>(),
        visitedSourcePageUrls: seenSourcePageUrls,
      };

      for await (const page of resolveSourcePagesEffect(
        seedPage,
        { fetchImpl, log, fetchDelayMs },
        state,
      )) {
        resolvedSourcePages += 1;
        if (assets.length >= limit) {
          break;
        }

        const imageCandidates = extractImageCandidates(page.url, page.html, page.isDetail);
        const host = normalizeHost(new URL(page.url).hostname);
        const licenseHint = detectBestEffortLicense(host, page.html);
        const attributionText =
          host === 'commons.wikimedia.org' ? extractCommonsAttribution(page.html) : null;

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
          await new Promise((r) => setTimeout(r, fetchDelayMs));

          let asset: StagedRemoteAsset | null;
          try {
            const { bytes: rawBytes, mediaType: sourceMediaType } = await Effect.runPromise(
              fetchImage(imageUrl, fetchImpl),
            );
            const sourceSha256 = hashSha256(rawBytes);

            if (seenSourceSha256.has(sourceSha256)) {
              log(`Skipped ${imageUrl}: sourceSha256 already staged in an earlier run`);
              continue;
            }

            const normalized = await Effect.runPromise(normalizeScrapedImage(rawBytes));
            asset = createStagedRemoteAsset(
              page,
              seedUrl,
              host,
              imageUrl,
              sourceMediaType,
              sourceSha256,
              rawBytes.byteLength,
              normalized,
              options.label,
              licenseHint,
              attributionText ?? undefined,
            );

            await Effect.runPromise(
              writeStagedRemoteAssetEffect(stageDir, asset, normalized.bytes),
            );
          } catch (error) {
            log(`Skipped ${imageUrl}: ${error instanceof Error ? error.message : String(error)}`);
            asset = null;
          }

          if (asset === null) {
            continue;
          }

          log(`Staged ${asset.id} from ${imageUrl}`);
          assets.push(asset);
          seenImageUrls.add(imageUrl);
          seenSourceSha256.add(asset.sourceSha256);
          onStagedAsset(asset);
        }

        // Mark the source page as visited so the next scrape session skips
        // fetching it entirely rather than re-deduping all its images.
        seenSourcePageUrls.add(page.url);
        await appendVisitedSourcePage(options.repoRoot, page.url);
      }

      log(`Resolved ${resolvedSourcePages} source page(s) for ${seed.toString()}`);
    }

    log(`Scrape complete: staged ${assets.length} image(s) in ${stageDir}`);
    return assets as readonly StagedRemoteAsset[];
  });
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

export const scrapeRemoteAssets = (
  options: ImportRemoteAssetOptions,
  fetchImpl: FetchLike = fetch,
): Promise<ScrapeRemoteAssetsResult> => {
  return Effect.runPromise(scrapeRemoteAssetsEffect(options, fetchImpl));
};

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

export const streamStagedRemoteAssets = async function* (
  stageDir: string,
): AsyncGenerator<StagedRemoteAsset> {
  const assets = await readStagedRemoteAssets(stageDir);
  for (const asset of assets) {
    yield asset;
  }
};
