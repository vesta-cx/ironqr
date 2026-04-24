import { describe, expect, it } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { resolveSeedFetchDelayMs } from '../../src/import/remote/adapters.js';
import { fetchText, isPixabayApiSearchUrl } from '../../src/import/remote/fetch.js';
import { assertAllowedSeed } from '../../src/import/remote/policy.js';
import {
  importStagedRemoteAssets,
  readStagedRemoteAsset,
  resolveStagedAssetPath,
  scrapeRemoteAssets,
  startScrapeRemoteAssets,
  updateStagedRemoteAsset,
  writeStagedRemoteAsset,
} from '../../src/import/remote.js';
import { readCorpusManifest } from '../../src/manifest.js';
import { MAJOR_VERSION } from '../../src/version.js';
import { createPngBytes, createRepoRoot, makeTestDir } from '../helpers.js';

const LISTING_HTML = `
  <html>
    <body>
      <a href="/photos/first-qr-123/">first</a>
      <a href="/photos/second-qr-456/">second</a>
    </body>
  </html>
`;

const PIXABAY_API_QR_SEARCH_URL =
  'https://pixabay.com/api/?q=qr+code&image_type=photo&safesearch=true&order=popular';

const FIRST_PAGE_HTML = `
  <html>
    <head>
      <title>First QR</title>
      <meta property="og:image" content="https://cdn.pixabay.com/first.png" />
      <div>Pixabay License</div>
    </head>
  </html>
`;

const SECOND_PAGE_HTML = `
  <html>
    <head>
      <title>Second QR</title>
      <meta property="og:image" content="https://cdn.pixabay.com/second.png" />
      <div>Pixabay License</div>
    </head>
  </html>
`;

const buildMockFetch = (): ((input: string | URL) => Promise<Response>) => {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    const firstBytes = await createPngBytes(255, 255, 255);
    const secondBytes = await createPngBytes(0, 0, 0);

    if (url === 'https://pixabay.com/images/search/qr%20code/') {
      return new Response(LISTING_HTML, {
        headers: { 'content-type': 'text/html' },
      });
    }

    if (url === 'https://pixabay.com/photos/first-qr-123/') {
      return new Response(FIRST_PAGE_HTML, {
        headers: { 'content-type': 'text/html' },
      });
    }

    if (url === 'https://pixabay.com/photos/second-qr-456/') {
      return new Response(SECOND_PAGE_HTML, {
        headers: { 'content-type': 'text/html' },
      });
    }

    if (url === 'https://cdn.pixabay.com/first.png') {
      return new Response(Buffer.from(firstBytes), {
        headers: { 'content-type': 'image/png' },
      });
    }

    if (url === 'https://cdn.pixabay.com/second.png') {
      return new Response(Buffer.from(secondBytes), {
        headers: { 'content-type': 'image/png' },
      });
    }

    return new Response('not found', { status: 404 });
  };
};

const buildPixabayApiFetch = (counts?: {
  readonly apiCalls?: { count: number };
}): ((input: string | URL) => Promise<Response>) => {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    const firstBytes = await createPngBytes(255, 255, 255);
    const secondBytes = await createPngBytes(0, 0, 0);

    if (
      parsed.origin === 'https://pixabay.com' &&
      parsed.pathname === '/api/' &&
      parsed.searchParams.get('key') === 'test-key' &&
      parsed.searchParams.get('page') === '1'
    ) {
      if (counts?.apiCalls) counts.apiCalls.count += 1;
      return new Response(
        JSON.stringify({
          totalHits: 2,
          hits: [
            {
              id: 123,
              pageURL: 'https://pixabay.com/photos/first-qr-123/',
              largeImageURL: 'https://cdn.pixabay.com/first.png',
              tags: 'qr code, paper',
              user: 'alice',
            },
            {
              id: 456,
              pageURL: 'https://pixabay.com/photos/second-qr-456/',
              largeImageURL: 'https://cdn.pixabay.com/second.png',
              tags: 'qr code, sticker',
              user: 'bob',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    if (url === 'https://cdn.pixabay.com/first.png') {
      return new Response(Buffer.from(firstBytes), {
        headers: { 'content-type': 'image/png' },
      });
    }

    if (url === 'https://cdn.pixabay.com/second.png') {
      return new Response(Buffer.from(secondBytes), {
        headers: { 'content-type': 'image/png' },
      });
    }

    return new Response('not found', { status: 404 });
  };
};

describe('remote corpus import', () => {
  it('keeps fetch headers minimal so Cloudflare-hosted seeds do not get browser-fingerprint challenges', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      seen.push(init ?? {});
      return new Response('<html><title>ok</title></html>', {
        headers: { 'content-type': 'text/html' },
      });
    };

    await expect(
      Effect.runPromise(
        fetchText('https://pixabay.com/images/search/qr%20code/', fetchImpl, false),
      ),
    ).resolves.toMatchObject({ url: 'https://pixabay.com/images/search/qr%20code/' });

    expect(seen[0]?.headers).toEqual({
      'accept-language': 'en-US,en;q=0.9',
      accept: 'text/html,application/xhtml+xml',
    });
  });

  it('surfaces a clear error when Pixabay search pages return a Cloudflare challenge', async () => {
    const fetchImpl = async (_input: string | URL): Promise<Response> =>
      new Response('<html><title>Just a moment...</title></html>', {
        status: 403,
        headers: {
          'content-type': 'text/html',
          'cf-mitigated': 'challenge',
        },
      });

    await expect(
      Effect.runPromise(
        fetchText('https://pixabay.com/images/search/qr%20code/', fetchImpl, false),
      ),
    ).rejects.toThrow('Pixabay returned a Cloudflare challenge to this CLI fetch');
  });

  it('rejects non-HTTPS remote seeds before fetching', () => {
    expect(() => assertAllowedSeed('http://pixabay.com/api/?q=qr')).toThrow('must use HTTPS');
    expect(isPixabayApiSearchUrl('http://pixabay.com/api/?q=qr')).toBe(false);
  });

  it('uses burst pacing for Pixabay API runs under 100 staged assets', () => {
    expect(resolveSeedFetchDelayMs(PIXABAY_API_QR_SEARCH_URL, 99, 3_000)).toBe(0);
    expect(resolveSeedFetchDelayMs(PIXABAY_API_QR_SEARCH_URL, 100, 3_000)).toBe(750);
    expect(
      resolveSeedFetchDelayMs(
        'https://commons.wikimedia.org/w/index.php?search=QR+Code&title=Special%3AMediaSearch&type=image',
        99,
        3_000,
      ),
    ).toBe(3_000);
  });

  it('stages assets from the Pixabay API with attribution and license evidence', async () => {
    const repoRoot = await createRepoRoot();
    const originalApiKey = process.env.PIXABAY_API_KEY;
    process.env.PIXABAY_API_KEY = 'test-key';

    try {
      const staged = await scrapeRemoteAssets(
        {
          repoRoot,
          seedUrls: [PIXABAY_API_QR_SEARCH_URL],
          label: 'qr-positive',
          limit: 2,
        },
        buildPixabayApiFetch(),
      );

      expect(staged.assets).toHaveLength(2);
      expect(staged.assets[0]).toMatchObject({
        seedUrl: PIXABAY_API_QR_SEARCH_URL,
        sourcePageUrl: 'https://pixabay.com/photos/first-qr-123/',
        imageUrl: 'https://cdn.pixabay.com/first.png',
        pageTitle: 'Pixabay #123: qr code, paper',
        attributionText: 'Image by alice on Pixabay',
        bestEffortLicense: 'Pixabay License',
      });
      expect(staged.assets[0]?.licenseEvidenceText).toContain('Pixabay API docs');
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.PIXABAY_API_KEY;
      } else {
        process.env.PIXABAY_API_KEY = originalApiKey;
      }
    }
  });

  it('caches Pixabay API search batches for 24 hours', async () => {
    const repoRoot = await createRepoRoot();
    const originalApiKey = process.env.PIXABAY_API_KEY;
    process.env.PIXABAY_API_KEY = 'test-key';
    const apiCalls = { count: 0 };
    const fetchImpl = buildPixabayApiFetch({ apiCalls });

    try {
      await scrapeRemoteAssets(
        {
          repoRoot,
          seedUrls: [PIXABAY_API_QR_SEARCH_URL],
          label: 'qr-positive',
          limit: 1,
        },
        fetchImpl,
      );

      await scrapeRemoteAssets(
        {
          repoRoot,
          seedUrls: [PIXABAY_API_QR_SEARCH_URL],
          label: 'qr-positive',
          limit: 1,
        },
        fetchImpl,
      );

      expect(apiCalls.count).toBe(1);
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.PIXABAY_API_KEY;
      } else {
        process.env.PIXABAY_API_KEY = originalApiKey;
      }
    }
  });

  it('fails clearly when the Pixabay API preset is used without PIXABAY_API_KEY', async () => {
    const repoRoot = await createRepoRoot();
    const originalApiKey = process.env.PIXABAY_API_KEY;
    delete process.env.PIXABAY_API_KEY;

    try {
      await expect(
        scrapeRemoteAssets(
          {
            repoRoot,
            seedUrls: [PIXABAY_API_QR_SEARCH_URL],
            label: 'qr-positive',
            limit: 1,
          },
          buildPixabayApiFetch(),
        ),
      ).rejects.toThrow('Pixabay API seed requires PIXABAY_API_KEY');
    } finally {
      if (originalApiKey !== undefined) {
        process.env.PIXABAY_API_KEY = originalApiKey;
      }
    }
  });

  it('stages remote assets in per-image folders, then imports them with remote provenance', async () => {
    const repoRoot = await createRepoRoot();

    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 2,
      },
      buildMockFetch(),
    );

    expect(staged.assets).toHaveLength(2);
    expect(staged.assets[0]?.imageFileName).toBe('image.webp');
    expect(staged.assets[0]?.mediaType).toBe('image/webp');

    const stagedAssetPath = path.join(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
      staged.assets[0]?.imageFileName ?? 'image.png',
    );
    expect((await readFile(stagedAssetPath)).length).toBeGreaterThan(0);

    const result = await importStagedRemoteAssets({
      repoRoot,
      stageDir: staged.stageDir,
      reviewStatus: 'approved',
      reviewer: 'mia',
    });

    expect(result.imported).toHaveLength(2);
    expect(result.deduped).toHaveLength(0);

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets).toHaveLength(2);

    const firstAsset = manifest.assets.find(
      (asset) =>
        asset.provenance[0]?.kind === 'remote' &&
        asset.provenance[0].sourcePageUrl === 'https://pixabay.com/photos/first-qr-123/',
    );

    expect(firstAsset?.review.status).toBe('approved');
    expect(firstAsset?.provenance[0]).toMatchObject({
      kind: 'remote',
      sourcePageUrl: 'https://pixabay.com/photos/first-qr-123/',
      imageUrl: 'https://cdn.pixabay.com/first.png',
      pageTitle: 'First QR',
    });
    expect(firstAsset?.fileExtension).toBe('.webp');
    expect(firstAsset?.mediaType).toBe('image/webp');

    const storedAssetPath = path.join(repoRoot, 'corpus', 'data', firstAsset?.relativePath ?? '');
    expect((await readFile(storedAssetPath)).length).toBeGreaterThan(0);
  });

  it('starts review stream after first staged asset instead of waiting for all detail pages', async () => {
    const repoRoot = await createRepoRoot();
    const secondPageControl: { release: () => void } = {
      release: () => {
        throw new Error('expected second page release');
      },
    };
    const secondPageGate = new Promise<void>((resolve) => {
      secondPageControl.release = resolve;
    });

    const session = await startScrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 2,
      },
      async (input) => {
        const url = typeof input === 'string' ? input : input.toString();

        if (url === 'https://pixabay.com/images/search/qr%20code/') {
          return new Response(LISTING_HTML, {
            headers: { 'content-type': 'text/html' },
          });
        }

        if (url === 'https://pixabay.com/photos/first-qr-123/') {
          return new Response(FIRST_PAGE_HTML, {
            headers: { 'content-type': 'text/html' },
          });
        }

        if (url === 'https://pixabay.com/photos/second-qr-456/') {
          await secondPageGate;
          return new Response(SECOND_PAGE_HTML, {
            headers: { 'content-type': 'text/html' },
          });
        }

        if (url === 'https://cdn.pixabay.com/first.png') {
          return new Response(Buffer.from(await createPngBytes(255, 255, 255)), {
            headers: { 'content-type': 'image/png' },
          });
        }

        if (url === 'https://cdn.pixabay.com/second.png') {
          return new Response(Buffer.from(await createPngBytes(0, 0, 0)), {
            headers: { 'content-type': 'image/png' },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    const iterator = session.assets[Symbol.asyncIterator]();
    const firstYield = await iterator.next();
    expect(firstYield.done).toBe(false);
    expect(firstYield.value?.sourcePageUrl).toBe('https://pixabay.com/photos/first-qr-123/');

    secondPageControl.release();
    const staged = await session.done;
    expect(staged).toHaveLength(2);
  });

  it('prefers image-linked detail pages over unrelated matching anchors', async () => {
    const repoRoot = await createRepoRoot();

    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      async (input) => {
        const url = typeof input === 'string' ? input : input.toString();

        if (url === 'https://pixabay.com/images/search/qr%20code/') {
          return new Response(
            `<html><body>
              <a href="/photos/unrelated-nav-999/">nav link without image</a>
              <a href="/photos/first-qr-123/"><img src="https://cdn.pixabay.com/thumb-first.png" /></a>
            </body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        }

        if (url === 'https://pixabay.com/photos/first-qr-123/') {
          return new Response(FIRST_PAGE_HTML, {
            headers: { 'content-type': 'text/html' },
          });
        }

        if (url === 'https://cdn.pixabay.com/first.png') {
          return new Response(Buffer.from(await createPngBytes(255, 255, 255)), {
            headers: { 'content-type': 'image/png' },
          });
        }

        if (url === 'https://cdn.pixabay.com/thumb-first.png') {
          return new Response(Buffer.from(await createPngBytes(240, 240, 240)), {
            headers: { 'content-type': 'image/png' },
          });
        }

        if (url === 'https://pixabay.com/photos/unrelated-nav-999/') {
          throw new Error('should not follow unrelated non-image anchor');
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    expect(staged.assets).toHaveLength(1);
    expect(staged.assets[0]?.sourcePageUrl).toBe('https://pixabay.com/photos/first-qr-123/');
  });

  it('stages multiple images from a page that has no linked detail pages', async () => {
    const repoRoot = await createRepoRoot();
    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pdimagearchive.org/gallery/qr-samples/'],
        label: 'qr-positive',
        limit: 2,
      },
      async (input) => {
        const url = typeof input === 'string' ? input : input.toString();

        if (url === 'https://pdimagearchive.org/gallery/qr-samples/') {
          return new Response(
            `<html><body><img src="https://pdimagearchive.org/first.png" /><img src="https://pdimagearchive.org/second.png" /></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        }

        if (url === 'https://pdimagearchive.org/first.png') {
          return new Response(Buffer.from(await createPngBytes(255, 255, 255)), {
            headers: { 'content-type': 'image/png' },
          });
        }

        if (url === 'https://pdimagearchive.org/second.png') {
          return new Response(Buffer.from(await createPngBytes(0, 0, 0)), {
            headers: { 'content-type': 'image/png' },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    expect(staged.assets).toHaveLength(2);
    expect(staged.assets.map((asset) => asset.imageUrl)).toEqual([
      'https://pdimagearchive.org/first.png',
      'https://pdimagearchive.org/second.png',
    ]);
  });

  it('dedupes scraped assets by sourceSha256 when different urls resolve to identical bytes', async () => {
    const repoRoot = await createRepoRoot();
    const sameBytes = await createPngBytes(64, 64, 64);

    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 2,
      },
      async (input) => {
        const url = typeof input === 'string' ? input : input.toString();

        if (url === 'https://pixabay.com/images/search/qr%20code/') {
          return new Response(
            `<html><body><a href="/photos/first-qr-123/">first</a><a href="/photos/second-qr-456/">second</a></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        }

        if (url === 'https://pixabay.com/photos/first-qr-123/') {
          return new Response(
            `<html><head><meta property="og:image" content="https://cdn.pixabay.com/first.png" /></head></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        }

        if (url === 'https://pixabay.com/photos/second-qr-456/') {
          return new Response(
            `<html><head><meta property="og:image" content="https://cdn.pixabay.com/second.png" /></head></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        }

        if (
          url === 'https://cdn.pixabay.com/first.png' ||
          url === 'https://cdn.pixabay.com/second.png'
        ) {
          return new Response(Buffer.from(sameBytes), {
            headers: { 'content-type': 'image/png' },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    expect(staged.assets).toHaveLength(1);
  });

  it('skips previously visited source pages without fetching them on a subsequent scrape', async () => {
    const repoRoot = await createRepoRoot();
    const fetchedUrls: string[] = [];

    const trackingFetch = async (input: string | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);
      return buildMockFetch()(url);
    };

    // First scrape: visits first-qr-123 and stages its image
    await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      trackingFetch,
    );
    expect(fetchedUrls).toContain('https://pixabay.com/photos/first-qr-123/');

    const fetchedAfterFirst = [...fetchedUrls];
    fetchedUrls.length = 0;

    // Second scrape: first-qr-123 is in scrape-progress.json, must not be fetched again
    const second = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      trackingFetch,
    );

    expect(second.assets).toHaveLength(1);
    expect(second.assets[0]?.sourcePageUrl).toBe('https://pixabay.com/photos/second-qr-456/');
    expect(fetchedUrls).not.toContain('https://pixabay.com/photos/first-qr-123/');
    expect(fetchedUrls).toContain('https://pixabay.com/photos/second-qr-456/');
    // Seed page always re-fetched; only detail pages that were already visited get skipped
    expect(fetchedAfterFirst.length).toBeGreaterThan(fetchedUrls.length);
  });

  it('skips prior-run duplicates without counting them against stage limit', async () => {
    const repoRoot = await createRepoRoot();

    const first = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      buildMockFetch(),
    );
    expect(first.assets).toHaveLength(1);
    expect(first.assets[0]?.sourcePageUrl).toBe('https://pixabay.com/photos/first-qr-123/');

    const second = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      buildMockFetch(),
    );
    expect(second.assets).toHaveLength(1);
    expect(second.assets[0]?.sourcePageUrl).toBe('https://pixabay.com/photos/second-qr-456/');
  });

  it('skips already-approved corpus assets on a fresh scrape after staging is cleared', async () => {
    const repoRoot = await createRepoRoot();

    // First run: scrape and approve the first image
    const first = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      buildMockFetch(),
    );
    expect(first.assets).toHaveLength(1);
    const firstAsset = first.assets[0];
    if (!firstAsset) throw new Error('expected staged asset');

    await updateStagedRemoteAsset(first.stageDir, {
      ...firstAsset,
      review: { status: 'approved', reviewer: 'mia', reviewedAt: '2026-04-10T12:00:00.000Z' },
    });
    await importStagedRemoteAssets({ repoRoot, stageDir: first.stageDir });

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets).toHaveLength(1);

    // Simulate clearing staging (delete staging dir so cross-run dedup has nothing to find there)
    await rm(first.stageDir, { recursive: true, force: true });

    // Second run with limit: 2 — the already-approved first image must be skipped,
    // so only the second image gets staged
    const second = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 2,
      },
      buildMockFetch(),
    );

    expect(second.assets).toHaveLength(1);
    expect(second.assets[0]?.sourcePageUrl).toBe('https://pixabay.com/photos/second-qr-456/');
  });

  it('imports approved staged metadata for license review, ground truth, and auto-scan evidence', async () => {
    const repoRoot = await createRepoRoot();

    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      buildMockFetch(),
    );

    const asset = staged.assets[0];
    expect(asset).toBeDefined();
    if (!asset) {
      throw new Error('expected staged asset');
    }

    await updateStagedRemoteAsset(staged.stageDir, {
      ...asset,
      review: {
        status: 'approved',
        reviewer: 'mia',
        reviewedAt: '2026-04-10T12:00:00.000Z',
        notes: 'verified from phone scan',
      },
      confirmedLicense: 'CC0',
      groundTruth: {
        qrCount: 1,
        codes: [
          {
            text: 'https://example.com',
            kind: 'url',
            verifiedWith: 'iphone camera',
          },
        ],
      },
      autoScan: {
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com', kind: 'url' }],
        acceptedAsTruth: true,
      },
    });

    const result = await importStagedRemoteAssets({
      repoRoot,
      stageDir: staged.stageDir,
    });

    expect(result.imported).toHaveLength(1);

    const manifest = await readCorpusManifest(repoRoot);
    const imported = manifest.assets[0];
    expect(imported?.review).toMatchObject({
      status: 'approved',
      reviewer: 'mia',
      reviewedAt: '2026-04-10T12:00:00.000Z',
    });
    expect(imported?.licenseReview).toMatchObject({
      bestEffortLicense: 'Pixabay License',
      confirmedLicense: 'CC0',
      licenseVerifiedBy: 'mia',
      licenseVerifiedAt: '2026-04-10T12:00:00.000Z',
    });
    expect(imported?.groundTruth).toEqual({
      qrCount: 1,
      codes: [
        {
          text: 'https://example.com',
          kind: 'url',
          verifiedWith: 'iphone camera',
        },
      ],
    });
    expect(imported?.autoScan).toEqual({
      attempted: true,
      succeeded: true,
      results: [{ text: 'https://example.com', kind: 'url' }],
      acceptedAsTruth: true,
    });

    // Staged dir is removed after import — verify the corpus manifest instead.
    expect(imported?.sourceSha256).toBe(asset.sourceSha256);
  });

  it('rejects dedup imports that try to rewrite canonical truth metadata', async () => {
    const repoRoot = await createRepoRoot();

    const firstStage = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      buildMockFetch(),
    );

    const firstAsset = firstStage.assets[0];
    if (!firstAsset) {
      throw new Error('expected first staged asset');
    }

    await updateStagedRemoteAsset(firstStage.stageDir, {
      ...firstAsset,
      review: {
        status: 'approved',
        reviewer: 'mia',
        reviewedAt: '2026-04-10T12:00:00.000Z',
      },
      confirmedLicense: 'CC0',
      groundTruth: {
        qrCount: 1,
        codes: [{ text: 'https://example.com', kind: 'url' }],
      },
      autoScan: {
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com', kind: 'url' }],
        acceptedAsTruth: true,
      },
    });

    // Save bytes before import (staged dir is deleted during import).
    const sourcePath = path.join(firstStage.stageDir, firstAsset.id, firstAsset.imageFileName);
    const reusedBytes = new Uint8Array(await readFile(sourcePath));

    await importStagedRemoteAssets({
      repoRoot,
      stageDir: firstStage.stageDir,
    });

    const secondStageDir = path.join(repoRoot, 'corpus', 'staging', 'manual-run-2');
    await mkdir(secondStageDir, { recursive: true });
    await writeStagedRemoteAsset(
      secondStageDir,
      {
        ...firstAsset,
        review: {
          status: 'approved',
          reviewer: 'mia',
          reviewedAt: '2026-04-10T12:00:00.000Z',
        },
        confirmedLicense: 'CC0',
        groundTruth: {
          codes: [{ kind: 'url', text: 'https://different.example.com' }],
          qrCount: 1,
        },
        autoScan: {
          attempted: true,
          succeeded: true,
          results: [{ kind: 'url', text: 'https://different.example.com' }],
          acceptedAsTruth: true,
        },
      },
      reusedBytes,
    );

    await expect(
      importStagedRemoteAssets({
        repoRoot,
        stageDir: secondStageDir,
      }),
    ).rejects.toThrow('Cannot change ground truth on dedupe');
  });

  it('accepts canonical metadata with different key order on dedup imports', async () => {
    const repoRoot = await createRepoRoot();

    const firstStage = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      buildMockFetch(),
    );

    const firstAsset = firstStage.assets[0];
    if (!firstAsset) {
      throw new Error('expected first staged asset');
    }

    await updateStagedRemoteAsset(firstStage.stageDir, {
      ...firstAsset,
      review: {
        status: 'approved',
        reviewer: 'mia',
        reviewedAt: '2026-04-10T12:00:00.000Z',
      },
      confirmedLicense: 'CC0',
      groundTruth: {
        qrCount: 1,
        codes: [
          {
            text: 'https://example.com',
            kind: 'url',
            verifiedWith: 'iphone camera',
          },
        ],
      },
      autoScan: {
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com', kind: 'url' }],
        acceptedAsTruth: true,
      },
    });

    // Save bytes before import (staged dir is deleted during import).
    const sourcePath = path.join(firstStage.stageDir, firstAsset.id, firstAsset.imageFileName);
    const reusedBytes = new Uint8Array(await readFile(sourcePath));

    await importStagedRemoteAssets({
      repoRoot,
      stageDir: firstStage.stageDir,
    });

    const secondStageDir = path.join(repoRoot, 'corpus', 'staging', 'manual-run-2');
    await mkdir(secondStageDir, { recursive: true });
    await writeStagedRemoteAsset(
      secondStageDir,
      {
        ...firstAsset,
        review: {
          status: 'approved',
          reviewer: 'mia',
          reviewedAt: '2026-04-10T12:00:00.000Z',
        },
        confirmedLicense: 'CC0',
        groundTruth: {
          codes: [
            {
              kind: 'url',
              verifiedWith: 'iphone camera',
              text: 'https://example.com',
            },
          ],
          qrCount: 1,
        },
        autoScan: {
          attempted: true,
          succeeded: true,
          results: [{ kind: 'url', text: 'https://example.com' }],
          acceptedAsTruth: true,
        },
      },
      reusedBytes,
    );

    const result = await importStagedRemoteAssets({
      repoRoot,
      stageDir: secondStageDir,
    });

    expect(result.imported).toHaveLength(0);
    expect(result.deduped).toHaveLength(1);

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]?.groundTruth).toEqual({
      qrCount: 1,
      codes: [
        {
          text: 'https://example.com',
          kind: 'url',
          verifiedWith: 'iphone camera',
        },
      ],
    });
  });

  it('skips image urls whose host is not in the per-source CDN allowlist', async () => {
    const repoRoot = await createRepoRoot();
    const hostileFetch: (input: string | URL) => Promise<Response> = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://pixabay.com/images/search/qr%20code/') {
        return new Response(
          `<html><head><meta property="og:image" content="http://127.0.0.1/internal.png" /></head></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const skipped: string[] = [];
    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
        log: (line) => skipped.push(line),
      },
      hostileFetch,
    );

    expect(staged.assets).toHaveLength(0);
    expect(skipped.some((line) => line.includes('127.0.0.1'))).toBe(true);
  });

  it('rejects seed urls outside the explicit allowlist', async () => {
    const repoRoot = await createRepoRoot();

    await expect(
      scrapeRemoteAssets(
        {
          repoRoot,
          seedUrls: ['https://example.com/not-allowed'],
          label: 'non-qr-negative',
        },
        buildMockFetch(),
      ),
    ).rejects.toThrow('allowlist');
  });

  it('rejects cross-host redirects from allowlisted pages', async () => {
    const repoRoot = await createRepoRoot();
    const redirectFetch: (input: string | URL) => Promise<Response> = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://pixabay.com/images/search/qr%20code/') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://example.com/redirected' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await expect(
      scrapeRemoteAssets(
        {
          repoRoot,
          seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
          label: 'qr-positive',
        },
        redirectFetch,
      ),
    ).rejects.toThrow('Cross-host redirect not allowed');
  });

  it('follows same-host redirects when fetching staged pages', async () => {
    const repoRoot = await createRepoRoot();
    const redirectFetch: (input: string | URL) => Promise<Response> = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://pixabay.com/images/search/qr%20code/') {
        return new Response(
          `<html><body><a href="/photos/first-qr-123/"><img src="https://cdn.pixabay.com/thumb.png" /></a></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }

      if (url === 'https://pixabay.com/photos/first-qr-123/') {
        return new Response('', {
          status: 301,
          headers: { location: 'https://pixabay.com/photos/first-qr-123-resolved/' },
        });
      }

      if (url === 'https://pixabay.com/photos/first-qr-123-resolved/') {
        return new Response(
          `<html><head><meta property="og:image" content="https://cdn.pixabay.com/first.png" /></head></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }

      if (url === 'https://cdn.pixabay.com/first.png') {
        return new Response(Buffer.from(await createPngBytes(255, 255, 255)), {
          headers: { 'content-type': 'image/png' },
        });
      }

      if (url === 'https://cdn.pixabay.com/thumb.png') {
        return new Response(Buffer.from(await createPngBytes(240, 240, 240)), {
          headers: { 'content-type': 'image/png' },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
      },
      redirectFetch,
    );

    expect(staged.assets).toHaveLength(1);
    expect(staged.assets[0]?.sourcePageUrl).toBe(
      'https://pixabay.com/photos/first-qr-123-resolved/',
    );
  });

  it('skips oversized image responses before buffering the body', async () => {
    const repoRoot = await createRepoRoot();
    const oversizedFetch: (input: string | URL) => Promise<Response> = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://pixabay.com/images/search/qr%20code/') {
        return new Response(LISTING_HTML, {
          headers: { 'content-type': 'text/html' },
        });
      }

      if (url === 'https://pixabay.com/photos/first-qr-123/') {
        return new Response(FIRST_PAGE_HTML, {
          headers: { 'content-type': 'text/html' },
        });
      }

      if (url === 'https://pixabay.com/photos/second-qr-456/') {
        return new Response(SECOND_PAGE_HTML, {
          headers: { 'content-type': 'text/html' },
        });
      }

      if (url === 'https://cdn.pixabay.com/first.png') {
        return new Response(Buffer.from([0]), {
          headers: { 'content-type': 'image/png', 'content-length': '52428801' },
        });
      }

      if (url === 'https://cdn.pixabay.com/second.png') {
        return new Response(Buffer.from([0]), {
          headers: { 'content-type': 'image/png', 'content-length': '52428801' },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const logs: string[] = [];
    const staged = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 1,
        log: (line) => logs.push(line),
      },
      oversizedFetch,
    );

    expect(staged.assets).toHaveLength(0);
    expect(logs.some((line) => line.includes('exceeds'))).toBe(true);
  });

  it('rejects staged manifests with unsafe ids or filenames', async () => {
    const stageDir = await makeTestDir('corpus-unsafe');
    const safeDir = path.join(stageDir, 'stage-deadbeefcafef00d');
    await mkdir(safeDir, { recursive: true });
    await writeFile(
      path.join(safeDir, 'manifest.json'),
      JSON.stringify({
        version: MAJOR_VERSION,
        id: 'stage-deadbeefcafef00d',
        suggestedLabel: 'qr-positive',
        imageFileName: '../../etc/passwd',
        sourcePageUrl: 'https://pixabay.com/photos/first/',
        imageUrl: 'https://cdn.pixabay.com/first.png',
        seedUrl: 'https://pixabay.com/',
        sourceHost: 'pixabay.com',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/webp',
        byteLength: 0,
        sha256: '00',
        sourceSha256: '11',
        sourceMediaType: 'image/png',
        sourceByteLength: 0,
        width: 0,
        height: 0,
        review: { status: 'pending' },
      }),
      'utf8',
    );

    await expect(readStagedRemoteAsset(stageDir, 'stage-deadbeefcafef00d')).rejects.toThrow(
      /Unsafe image filename/,
    );
  });

  it('resolveStagedAssetPath rejects components containing path separators or parent traversal', async () => {
    const stageDir = '/corpus/staging/ironqr-stage';

    expect(() => resolveStagedAssetPath(stageDir, 'stage-abc', '../../etc/passwd')).toThrow(
      /Unsafe image filename/,
    );
    expect(() => resolveStagedAssetPath(stageDir, '../escape', 'image.png')).toThrow(
      /Unsafe asset id/,
    );
    expect(() => resolveStagedAssetPath(stageDir, 'stage-abc', 'sub/image.png')).toThrow(
      /Unsafe image filename/,
    );
  });

  it('rejects staged manifests with non-http source urls', async () => {
    const stageDir = await makeTestDir('corpus-unsafe');
    const safeDir = path.join(stageDir, 'stage-deadbeefcafef00d');
    await mkdir(safeDir, { recursive: true });
    await writeFile(
      path.join(safeDir, 'manifest.json'),
      JSON.stringify({
        version: MAJOR_VERSION,
        id: 'stage-deadbeefcafef00d',
        suggestedLabel: 'qr-positive',
        imageFileName: 'image.png',
        sourcePageUrl: 'file:///etc/passwd',
        imageUrl: 'https://cdn.pixabay.com/first.png',
        seedUrl: 'https://pixabay.com/',
        sourceHost: 'pixabay.com',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/webp',
        byteLength: 0,
        sha256: '00',
        sourceSha256: '11',
        sourceMediaType: 'image/png',
        sourceByteLength: 0,
        width: 0,
        height: 0,
        review: { status: 'pending' },
      }),
      'utf8',
    );

    await expect(readStagedRemoteAsset(stageDir, 'stage-deadbeefcafef00d')).rejects.toThrow(
      /http\(s\) URL for source page URL/,
    );
  });

  it('rejects staged manifests with source page hosts outside the seed allowlist', async () => {
    const stageDir = await makeTestDir('corpus-unsafe');
    const safeDir = path.join(stageDir, 'stage-deadbeefcafef00d');
    await mkdir(safeDir, { recursive: true });
    await writeFile(
      path.join(safeDir, 'manifest.json'),
      JSON.stringify({
        version: MAJOR_VERSION,
        id: 'stage-deadbeefcafef00d',
        suggestedLabel: 'qr-positive',
        imageFileName: 'image.png',
        sourcePageUrl: 'http://127.0.0.1/internal',
        imageUrl: 'https://cdn.pixabay.com/first.png',
        seedUrl: 'https://pixabay.com/',
        sourceHost: 'pixabay.com',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/webp',
        byteLength: 0,
        sha256: '00',
        sourceSha256: '11',
        sourceMediaType: 'image/png',
        sourceByteLength: 0,
        width: 0,
        height: 0,
        review: { status: 'pending' },
      }),
      'utf8',
    );

    await expect(readStagedRemoteAsset(stageDir, 'stage-deadbeefcafef00d')).rejects.toThrow(
      /Source page host is not allowlisted/,
    );
  });
});
