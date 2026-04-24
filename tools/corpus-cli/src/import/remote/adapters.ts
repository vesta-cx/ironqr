import { Effect } from 'effect';
import type { FetchError } from '../../errors.js';
import { normalizeUrlForDedup } from '../../url.js';
import {
  type FetchLike,
  fetchPixabaySearchBatch,
  fetchText,
  isCommonsSearchUrl,
  isPixabayApiSearchUrl,
  type PixabaySearchBatch,
  resolveCommonsSearchPages,
} from './fetch.js';
import type { SourcePage } from './page.js';
import { readRequestCache, writeRequestCache } from './request-cache.js';
import { resolveSourcePages } from './resolve.js';

interface LicenseHint {
  readonly bestEffortLicense?: string;
  readonly licenseEvidenceText?: string;
}

/** A source page plus any adapter-provided metadata that avoids HTML scraping. */
export interface ResolvedRemotePage extends SourcePage {
  readonly imageCandidates?: readonly string[];
  readonly attributionText?: string;
  readonly licenseHint?: LicenseHint;
}

export interface ResolveSeedPagesOptions<E> {
  readonly repoRoot: string;
  readonly seedUrl: string;
  readonly fetchImpl: FetchLike;
  readonly fetchDelayMs: number;
  readonly remainingStageSlots: number;
  readonly log: (line: string) => void;
  readonly visitedSourcePageUrls: ReadonlySet<string>;
  readonly onPage: (page: ResolvedRemotePage) => Effect.Effect<void, E>;
}

interface RemoteSourceAdapter {
  readonly id: string;
  readonly supports: (seedUrl: string) => boolean;
  readonly resolvePages: <E>(
    options: ResolveSeedPagesOptions<E>,
  ) => Effect.Effect<number, E | FetchError | Error>;
}

const PIXABAY_API_KEY_ENV = 'PIXABAY_API_KEY';
const PIXABAY_API_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const PIXABAY_API_PAGE_SIZE = 200;
const PIXABAY_API_BURST_STAGE_LIMIT = 100;
const PIXABAY_API_REQUEST_DELAY_MS = 750;
const PIXABAY_LICENSE_HINT: LicenseHint = {
  bestEffortLicense: 'Pixabay License',
  licenseEvidenceText:
    'Pixabay API docs: content is provided under the Pixabay Content License; show the source when displaying search results.',
};

const PIXABAY_API_SEARCH_CACHE_NAMESPACE = 'pixabay-api-search';

const sleepEffect = (ms: number) => Effect.sleep(ms);

const resolvePixabayBatchSize = (remainingStageSlots: number): number => {
  return Math.max(3, Math.min(PIXABAY_API_PAGE_SIZE, remainingStageSlots));
};

/** Return the adapter-specific inter-request delay for a seed URL. */
export const resolveSeedFetchDelayMs = (
  seedUrl: string,
  remainingStageSlots: number,
  defaultFetchDelayMs: number,
): number => {
  if (!isPixabayApiSearchUrl(seedUrl)) {
    return defaultFetchDelayMs;
  }

  if (remainingStageSlots < PIXABAY_API_BURST_STAGE_LIMIT) {
    return 0;
  }

  return Math.min(defaultFetchDelayMs, PIXABAY_API_REQUEST_DELAY_MS);
};

const getPixabayApiKey = (): string => {
  const apiKey = process.env[PIXABAY_API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new Error(
      `Pixabay API seed requires ${PIXABAY_API_KEY_ENV}. Add it to your local .env before running corpus scrape.`,
    );
  }
  return apiKey;
};

const loadPixabaySearchBatch = (
  repoRoot: string,
  seedUrl: string,
  fetchImpl: FetchLike,
  page: number,
  log: (line: string) => void,
  perPage: number,
) => {
  return Effect.tryPromise({
    try: async () => {
      const cacheKey = `${seedUrl}\npage=${page}\nperPage=${perPage}`;
      const cached = await readRequestCache<PixabaySearchBatch>({
        repoRoot,
        namespace: PIXABAY_API_SEARCH_CACHE_NAMESPACE,
        cacheKey,
        ttlMs: PIXABAY_API_CACHE_TTL_MS,
      });
      if (cached) {
        log(`Using cached Pixabay API page ${page} for ${seedUrl}`);
        return cached;
      }

      const apiKey = getPixabayApiKey();
      const batch = await Effect.runPromise(
        fetchPixabaySearchBatch(seedUrl, apiKey, fetchImpl, page, perPage),
      );
      await writeRequestCache(
        {
          repoRoot,
          namespace: PIXABAY_API_SEARCH_CACHE_NAMESPACE,
          cacheKey,
          ttlMs: PIXABAY_API_CACHE_TTL_MS,
        },
        batch,
      );
      return batch;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
};

const buildPixabayResolvedPage = (hit: {
  readonly pageUrl: string;
  readonly imageUrl: string;
  readonly tags?: string;
  readonly user?: string;
  readonly id?: number;
}): ResolvedRemotePage => {
  const idText = typeof hit.id === 'number' ? `#${hit.id}` : 'image';
  const tags = hit.tags?.trim();
  const byline = hit.user?.trim() ? `Image by ${hit.user.trim()} on Pixabay` : 'Image from Pixabay';

  return {
    url: hit.pageUrl,
    title: tags ? `Pixabay ${idText}: ${tags}` : `Pixabay ${idText}`,
    html: '',
    isDetail: true,
    imageCandidates: [hit.imageUrl],
    attributionText: byline,
    licenseHint: PIXABAY_LICENSE_HINT,
  };
};

const genericHtmlAdapter: RemoteSourceAdapter = {
  id: 'generic-html',
  supports: () => true,
  resolvePages: <E>(options: ResolveSeedPagesOptions<E>) =>
    Effect.gen(function* () {
      const seedPage = yield* fetchText(options.seedUrl, options.fetchImpl, false);
      const state = {
        seenPages: new Set<string>(),
        yieldedLeaves: new Set<string>(),
        visitedSourcePageUrls: options.visitedSourcePageUrls,
      };

      let resolved = 0;
      yield* resolveSourcePages(
        seedPage,
        { fetchImpl: options.fetchImpl, log: options.log, fetchDelayMs: options.fetchDelayMs },
        state,
        (page) =>
          Effect.gen(function* () {
            yield* options.onPage(page);
            resolved += 1;
          }),
      );

      return resolved;
    }),
};

const commonsSearchAdapter: RemoteSourceAdapter = {
  id: 'commons-search-api',
  supports: isCommonsSearchUrl,
  resolvePages: <E>(options: ResolveSeedPagesOptions<E>) =>
    resolveCommonsSearchPages(
      options.seedUrl,
      options.fetchImpl,
      options.fetchDelayMs,
      options.log,
      options.visitedSourcePageUrls,
      options.onPage,
    ),
};

const pixabayApiAdapter: RemoteSourceAdapter = {
  id: 'pixabay-api',
  supports: isPixabayApiSearchUrl,
  resolvePages: <E>(options: ResolveSeedPagesOptions<E>) =>
    Effect.gen(function* () {
      let page = 1;
      let resolved = 0;
      const batchSize = resolvePixabayBatchSize(options.remainingStageSlots);

      for (;;) {
        const batch = yield* loadPixabaySearchBatch(
          options.repoRoot,
          options.seedUrl,
          options.fetchImpl,
          page,
          options.log,
          batchSize,
        );

        if (batch.results.length === 0) break;

        for (const hit of batch.results) {
          if (options.visitedSourcePageUrls.has(normalizeUrlForDedup(hit.pageUrl))) {
            options.log(`Skipped ${hit.pageUrl}: visited in a previous scrape`);
            continue;
          }

          yield* options.onPage(buildPixabayResolvedPage(hit));
          resolved += 1;
        }

        if (batch.nextPage === null) break;
        page = batch.nextPage;
        yield* sleepEffect(options.fetchDelayMs);
      }

      return resolved;
    }),
};

const REMOTE_SOURCE_ADAPTERS: readonly RemoteSourceAdapter[] = [
  commonsSearchAdapter,
  pixabayApiAdapter,
  genericHtmlAdapter,
];

const selectRemoteSourceAdapter = (seedUrl: string): RemoteSourceAdapter => {
  return REMOTE_SOURCE_ADAPTERS.find((adapter) => adapter.supports(seedUrl)) ?? genericHtmlAdapter;
};

/** Resolve detail/source pages through the adapter that matches `seedUrl`. */
export const resolveSeedSourcePages = <E>(
  options: ResolveSeedPagesOptions<E>,
): Effect.Effect<number, E | FetchError | Error> => {
  const adapter = selectRemoteSourceAdapter(options.seedUrl);
  options.log(`Using source adapter ${adapter.id} for ${options.seedUrl}`);
  return adapter.resolvePages(options);
};
