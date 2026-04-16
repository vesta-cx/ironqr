import { Effect } from 'effect';
import { type FetchLike, fetchText } from './fetch.js';
import { extractPageLinks } from './html.js';
import type { SourcePage } from './page.js';

const MAX_RESOLVE_DEPTH = 3;

interface ResolveSourcePagesEnv {
  readonly fetchImpl: FetchLike;
  readonly log: (line: string) => void;
  readonly fetchDelayMs: number;
}

interface ResolveSourcePagesState {
  readonly seenPages: Set<string>;
  readonly yieldedLeaves: Set<string>;
  /** URLs of detail pages already fully processed in previous scrape runs. */
  readonly visitedSourcePageUrls?: ReadonlySet<string>;
}

/**
 * Recursively walks page links from `page`, calling `onPage` for each discovered detail page.
 * Respects `MAX_RESOLVE_DEPTH`, deduplicates via `state.seenPages`, and skips previously visited URLs.
 */
export const resolveSourcePages = <E>(
  page: SourcePage,
  env: ResolveSourcePagesEnv,
  state: ResolveSourcePagesState,
  onPage: (page: SourcePage) => Effect.Effect<void, E>,
  depth = 0,
): Effect.Effect<void, E> => {
  return Effect.gen(function* () {
    const emitLeaf = (leaf: SourcePage): Effect.Effect<void, E> => {
      if (state.yieldedLeaves.has(leaf.url)) return Effect.void;
      state.yieldedLeaves.add(leaf.url);
      env.log(`Source page ready ${leaf.url}`);
      return onPage(leaf);
    };

    if (state.seenPages.has(page.url) || depth >= MAX_RESOLVE_DEPTH) {
      yield* emitLeaf(page);
      return;
    }

    state.seenPages.add(page.url);
    const isSeedPage = depth === 0;
    const pageLinks = extractPageLinks(page.url, page.html, { allowFanOut: isSeedPage });

    if (pageLinks.length === 0) {
      yield* emitLeaf(page);
      return;
    }

    env.log(`Walking ${pageLinks.length} page link(s) from ${page.url}`);

    for (const pageLink of pageLinks) {
      if (state.visitedSourcePageUrls?.has(pageLink)) {
        env.log(`Skipped ${pageLink}: visited in a previous scrape`);
        continue;
      }
      env.log(`Fetching page ${pageLink}`);
      yield* Effect.sleep(env.fetchDelayMs);

      const nextPage = yield* fetchText(pageLink, env.fetchImpl, true).pipe(
        Effect.catchTag('FetchError', (error) => {
          env.log(`Skipped page ${pageLink}: ${error.message}`);
          return Effect.succeed(null);
        }),
      );

      if (nextPage === null) continue;

      yield* resolveSourcePages(nextPage, env, state, onPage, depth + 1);
    }
  });
};
