import { Effect } from 'effect';
import type { FetchError } from '../../errors.js';
import { normalizeUrlForDedup } from '../../url.js';
import { tryFetch } from './effect.js';
import type { SourcePage } from './page.js';
import { normalizeHost } from './policy.js';
import { htmlToText, stripAnsi } from './text.js';

/** Minimal subset of the Fetch API required by scrape utilities; compatible with `globalThis.fetch`. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_SAME_HOST_REDIRECTS = 5;
const MAX_RETRYABLE_FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_500;

// Keep request headers minimal.
// Real browsers send a coherent fingerprint across UA, Client Hints, TLS, and cookie state.
// Pretending to be Chrome from a Bun fetch made Pixabay/Cloudflare challenge us with 403s.
// Minimal headers plus Bun's native fetch path are accepted more reliably here.
const REQUEST_HEADERS: Record<string, string> = {
  'accept-language': 'en-US,en;q=0.9',
};

const readLimitedBody = (response: Response, maxBytes: number, label: string) => {
  return tryFetch(async () => {
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
      try {
        await reader.cancel();
      } catch {
        // cancel may fail if the stream is already closed
      }
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

const assertSameHostRedirect = (from: string, to: string): void => {
  const fromUrl = new URL(from);
  const toUrl = new URL(to);
  if (normalizeHost(fromUrl.hostname) !== normalizeHost(toUrl.hostname)) {
    throw new Error(`Cross-host redirect not allowed: ${from} -> ${to}`);
  }
  if (fromUrl.protocol === 'https:' && toUrl.protocol !== 'https:') {
    throw new Error(`Protocol downgrade not allowed: ${from} -> ${to}`);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const parseRetryAfterMs = (value: string | null): number | null => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
};

const isCloudflareChallenge = (response: Response): boolean =>
  response.status === 403 && response.headers.get('cf-mitigated') === 'challenge';

const isPixabayHost = (url: string): boolean =>
  normalizeHost(new URL(url).hostname) === 'pixabay.com';

const isRetryableResponse = (url: string, response: Response): boolean => {
  if (response.status === 429) return true;
  return isPixabayHost(url) && response.status === 403 && !isCloudflareChallenge(response);
};

const retryDelayMs = (response: Response, attempt: number): number => {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  if (retryAfterMs !== null) return retryAfterMs;
  return RETRY_BACKOFF_MS * 2 ** attempt;
};

const formatChallengeError = (url: string, label: string): string => {
  if (isPixabayHost(url)) {
    return `Failed to fetch ${label} ${url}: 403 (Pixabay returned a Cloudflare challenge to this CLI fetch. Use Wikimedia Commons, a custom seed URL, or direct Pixabay detail-page/image URLs instead of the Pixabay search preset.)`;
  }
  return `Failed to fetch ${label} ${url}: 403 (Cloudflare challenge)`;
};

/**
 * Fetches `url` following same-host redirects up to `MAX_SAME_HOST_REDIRECTS`.
 * Throws on cross-host redirects, protocol downgrades, or non-2xx responses.
 */
export const fetchFollowingSameHost = (
  url: string,
  fetchImpl: FetchLike,
  accept: string,
  label: string,
) => {
  return tryFetch(async () => {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_SAME_HOST_REDIRECTS; hop += 1) {
      for (let attempt = 0; attempt < MAX_RETRYABLE_FETCH_ATTEMPTS; attempt += 1) {
        const response = await fetchImpl(currentUrl, {
          headers: { ...REQUEST_HEADERS, accept },
          redirect: 'manual',
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect without location while fetching ${label} ${currentUrl}`);
          }

          const nextUrl = new URL(location, currentUrl).toString();
          assertSameHostRedirect(currentUrl, nextUrl);
          response.body?.cancel().catch(() => {});
          currentUrl = nextUrl;
          break;
        }

        if (response.ok) {
          return { response, finalUrl: currentUrl };
        }

        if (isCloudflareChallenge(response)) {
          response.body?.cancel().catch(() => {});
          throw new Error(formatChallengeError(currentUrl, label));
        }

        if (
          isRetryableResponse(currentUrl, response) &&
          attempt + 1 < MAX_RETRYABLE_FETCH_ATTEMPTS
        ) {
          response.body?.cancel().catch(() => {});
          await sleep(retryDelayMs(response, attempt));
          continue;
        }

        response.body?.cancel().catch(() => {});
        throw new Error(`Failed to fetch ${label} ${currentUrl}: ${response.status}`);
      }
    }

    throw new Error(`Too many redirects while fetching ${label} ${url}`);
  });
};

/**
 * Fetches an HTML page at `url` and returns a `SourcePage` with its final URL, title, and raw HTML.
 * `isDetail` flags whether this is a detail page (vs. a listing/seed page).
 */
export const fetchText = (url: string, fetchImpl: FetchLike, isDetail: boolean) => {
  return Effect.gen(function* () {
    const { response, finalUrl } = yield* fetchFollowingSameHost(
      url,
      fetchImpl,
      'text/html,application/xhtml+xml',
      'page',
    );

    const htmlBytes = yield* readLimitedBody(response, MAX_HTML_BYTES, `page ${finalUrl}`);
    const html = new TextDecoder().decode(htmlBytes);
    const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
    const title = rawTitle !== null ? htmlToText(rawTitle).trim() || null : null;

    return {
      url: finalUrl,
      title,
      html,
      isDetail,
    } satisfies SourcePage;
  });
};

// ── Wikimedia Commons structured metadata ─────────────────────────────

/** Structured license and attribution metadata retrieved from the Wikimedia Commons API. */
export interface CommonsFileMeta {
  readonly license?: string;
  readonly attribution?: string;
}

const MAX_COMMONS_API_BYTES = 1 * 1024 * 1024;

interface WikimediaApiResponse {
  readonly query?: {
    readonly pages?: Record<
      string,
      {
        readonly imageinfo?: ReadonlyArray<{
          readonly extmetadata?: Record<string, { readonly value?: string }>;
        }>;
      }
    >;
  };
}

const isWikimediaApiResponse = (value: unknown): value is WikimediaApiResponse => {
  return typeof value === 'object' && value !== null && 'query' in value;
};

/**
 * Fetches structured file metadata from the Wikimedia Commons `imageinfo` API.
 * Returns null on any error so callers can gracefully fall back to HTML parsing.
 */
export const fetchCommonsFileMeta = (
  pageUrl: string,
  fetchImpl: FetchLike,
): Effect.Effect<CommonsFileMeta | null, never> => {
  return Effect.gen(function* () {
    const match = /\/wiki\/(File:[^?#]+)/i.exec(pageUrl);
    if (!match?.[1]) return null;

    const title = decodeURIComponent(match[1]);
    const apiUrl =
      `https://commons.wikimedia.org/w/api.php?action=query` +
      `&titles=${encodeURIComponent(title)}` +
      `&prop=imageinfo&iiprop=extmetadata&format=json&origin=*`;

    const response = yield* tryFetch(() =>
      fetchImpl(apiUrl, {
        headers: { ...REQUEST_HEADERS, accept: 'application/json' },
      }),
    );
    if (!response.ok) return null;

    const bodyBytes = yield* readLimitedBody(response, MAX_COMMONS_API_BYTES, 'Wikimedia API');
    const raw: unknown = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (!isWikimediaApiResponse(raw)) return null;

    const extmeta = Object.values(raw.query?.pages ?? {})[0]?.imageinfo?.[0]?.extmetadata;
    if (!extmeta) return null;

    const license = extmeta.LicenseShortName?.value?.trim() || undefined;
    const artistRaw = extmeta.Artist?.value;
    const attribution = artistRaw ? stripAnsi(htmlToText(artistRaw)) || undefined : undefined;

    return {
      ...(license ? { license } : {}),
      ...(attribution ? { attribution } : {}),
    };
  }).pipe(Effect.catchTag('FetchError', () => Effect.succeed(null)));
};

/**
 * Downloads an image from `url` and returns its raw bytes and media type.
 * Enforces the same-host redirect policy and a maximum byte limit.
 */
// ── Wikimedia Commons search API ───────────────────────────────────────

const MAX_SEARCH_API_BYTES = 2 * 1024 * 1024;
const COMMONS_SEARCH_BATCH_SIZE = 50;

interface CommonsSearchResult {
  readonly title: string;
  readonly pageUrl: string;
}

interface CommonsSearchBatch {
  readonly results: readonly CommonsSearchResult[];
  readonly sroffset: number | null;
}

/** Structured Pixabay image hit consumed by the Pixabay API adapter. */
export interface PixabaySearchResult {
  readonly id?: number;
  readonly pageUrl: string;
  readonly imageUrl: string;
  readonly tags?: string;
  readonly user?: string;
}

/** One page of Pixabay API search results plus the next page number, if any. */
export interface PixabaySearchBatch {
  readonly results: readonly PixabaySearchResult[];
  readonly nextPage: number | null;
}

interface CommonsSearchApiResponse {
  readonly continue?: { readonly sroffset?: number };
  readonly query?: { readonly search?: ReadonlyArray<{ readonly title?: string }> };
}

const isCommonsSearchApiResponse = (v: unknown): v is CommonsSearchApiResponse =>
  typeof v === 'object' && v !== null;

/** Returns true if the URL is a Wikimedia Commons MediaSearch page. */
export const isCommonsSearchUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      normalizeHost(parsed.hostname) === 'commons.wikimedia.org' &&
      parsed.searchParams.get('title') === 'Special:MediaSearch'
    );
  } catch {
    return false;
  }
};

/** Extracts the search query from a Commons MediaSearch URL. */
const extractCommonsSearchQuery = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('search');
  } catch {
    return null;
  }
};

/**
 * Fetches one batch of file page URLs from the Wikimedia Commons search API.
 * Returns results and the offset for the next batch (null if no more).
 */
export const fetchCommonsSearchBatch = (
  query: string,
  fetchImpl: FetchLike,
  offset = 0,
): Effect.Effect<CommonsSearchBatch, FetchError | Error> => {
  return Effect.gen(function* () {
    const apiUrl =
      `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}` +
      `&srnamespace=6` +
      `&srlimit=${COMMONS_SEARCH_BATCH_SIZE}` +
      `&sroffset=${offset}` +
      `&format=json&origin=*`;

    const response = yield* tryFetch(() =>
      fetchImpl(apiUrl, {
        headers: { ...REQUEST_HEADERS, accept: 'application/json' },
      }),
    );

    if (!response.ok) {
      return yield* Effect.fail(new Error(`Commons search API returned ${response.status}`));
    }

    const bodyBytes = yield* readLimitedBody(response, MAX_SEARCH_API_BYTES, 'Commons search API');
    const raw: unknown = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (!isCommonsSearchApiResponse(raw)) {
      return { results: [], sroffset: null };
    }

    const entries = raw.query?.search ?? [];
    const results: CommonsSearchResult[] = entries
      .filter((entry): entry is { title: string } => typeof entry.title === 'string')
      .map((entry) => ({
        title: entry.title,
        pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(entry.title.replace(/ /g, '_'))}`,
      }));

    return {
      results,
      sroffset: raw.continue?.sroffset ?? null,
    };
  });
};

/**
 * Resolves file page URLs from a Commons search seed URL by querying the API.
 * Calls `onPage` for each detail page. The caller controls termination via
 * the error channel (e.g. a tagged `LimitReached` fail) — this function
 * pages through results until the API is exhausted or `onPage` signals stop.
 */
export const resolveCommonsSearchPages = <E>(
  seedUrl: string,
  fetchImpl: FetchLike,
  fetchDelayMs: number,
  log: (line: string) => void,
  visitedSourcePageUrls: ReadonlySet<string>,
  onPage: (page: SourcePage) => Effect.Effect<void, E>,
): Effect.Effect<number, E | FetchError | Error> => {
  return Effect.gen(function* () {
    const query = extractCommonsSearchQuery(seedUrl);
    if (!query) {
      return yield* Effect.fail(new Error(`Cannot extract search query from ${seedUrl}`));
    }

    log(`Using Commons search API for query: ${query}`);
    let offset = 0;
    let resolved = 0;

    for (;;) {
      const batch = yield* fetchCommonsSearchBatch(query, fetchImpl, offset);
      if (batch.results.length === 0) break;

      for (const result of batch.results) {
        if (visitedSourcePageUrls.has(normalizeUrlForDedup(result.pageUrl))) {
          log(`Skipped ${result.pageUrl}: visited in a previous scrape`);
          continue;
        }

        log(`Fetching page ${result.pageUrl}`);
        yield* Effect.sleep(fetchDelayMs);

        const page = yield* fetchText(result.pageUrl, fetchImpl, true).pipe(
          Effect.catchTag('FetchError', (error) => {
            log(`Skipped page ${result.pageUrl}: ${error.message}`);
            return Effect.succeed(null);
          }),
        );

        if (page === null) continue;

        yield* onPage(page);
        resolved += 1;
      }

      if (batch.sroffset === null) break;
      offset = batch.sroffset;
      yield* Effect.sleep(fetchDelayMs);
    }

    return resolved;
  });
};

interface PixabayApiResponse {
  readonly totalHits?: number;
  readonly hits?: ReadonlyArray<{
    readonly id?: number;
    readonly pageURL?: string;
    readonly largeImageURL?: string;
    readonly webformatURL?: string;
    readonly previewURL?: string;
    readonly tags?: string;
    readonly user?: string;
  }>;
}

const isPixabayApiResponse = (value: unknown): value is PixabayApiResponse =>
  typeof value === 'object' && value !== null;

/** Returns true if the URL is a Pixabay image-search API seed URL. */
export const isPixabayApiSearchUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return normalizeHost(parsed.hostname) === 'pixabay.com' && parsed.pathname === '/api/';
  } catch {
    return false;
  }
};

const buildPixabayApiUrl = (
  seedUrl: string,
  apiKey: string,
  page: number,
  perPage: number,
): string => {
  const parsed = new URL(seedUrl);
  parsed.searchParams.delete('key');
  parsed.searchParams.set('key', apiKey);
  parsed.searchParams.set('page', String(page));
  parsed.searchParams.set('per_page', String(perPage));
  return parsed.toString();
};

type PixabayApiHit = NonNullable<PixabayApiResponse['hits']>[number];

const pickPixabayImageUrl = (hit: PixabayApiHit): string | null => {
  return hit.largeImageURL ?? hit.webformatURL ?? hit.previewURL ?? null;
};

/** Fetches one page of Pixabay API search results. */
export const fetchPixabaySearchBatch = (
  seedUrl: string,
  apiKey: string,
  fetchImpl: FetchLike,
  page: number,
  perPage: number,
): Effect.Effect<PixabaySearchBatch, FetchError | Error> => {
  return Effect.gen(function* () {
    const apiUrl = buildPixabayApiUrl(seedUrl, apiKey, page, perPage);
    const response = yield* tryFetch(() =>
      fetchImpl(apiUrl, {
        headers: { ...REQUEST_HEADERS, accept: 'application/json' },
      }),
    );

    if (!response.ok) {
      return yield* Effect.fail(new Error(`Pixabay API returned ${response.status}`));
    }

    const bodyBytes = yield* readLimitedBody(response, MAX_SEARCH_API_BYTES, 'Pixabay API');
    const raw: unknown = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (!isPixabayApiResponse(raw)) {
      return { results: [], nextPage: null };
    }

    const results: PixabaySearchResult[] = [];
    for (const hit of raw.hits ?? []) {
      const pageUrl = typeof hit.pageURL === 'string' ? hit.pageURL : null;
      const imageUrl = pickPixabayImageUrl(hit);
      if (!pageUrl || !imageUrl) continue;
      results.push({
        ...(typeof hit.id === 'number' ? { id: hit.id } : {}),
        pageUrl,
        imageUrl,
        ...(typeof hit.tags === 'string' && hit.tags.trim().length > 0 ? { tags: hit.tags } : {}),
        ...(typeof hit.user === 'string' && hit.user.trim().length > 0 ? { user: hit.user } : {}),
      });
    }

    const totalHits = typeof raw.totalHits === 'number' ? raw.totalHits : 0;
    const nextPage = page * perPage < totalHits && results.length > 0 ? page + 1 : null;

    return { results, nextPage };
  });
};

/** Fetches a remote image, returning its bytes and media type. */
export const fetchImage = (url: string, fetchImpl: FetchLike) => {
  return Effect.gen(function* () {
    const { response, finalUrl } = yield* fetchFollowingSameHost(
      url,
      fetchImpl,
      'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
      'image',
    );

    const bytes = yield* readLimitedBody(response, MAX_IMAGE_BYTES, `image ${finalUrl}`);
    return {
      bytes,
      mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  });
};
