import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  importStagedRemoteAssets,
  readStagedRemoteAsset,
  resolveStagedAssetPath,
  scrapeRemoteAssets,
  updateStagedRemoteAsset,
} from '../../corpus/import/remote.js';
import { readCorpusManifest } from '../../corpus/manifest.js';

const LISTING_HTML = `
  <html>
    <body>
      <a href="/photos/first-qr-123/">first</a>
      <a href="/photos/second-qr-456/">second</a>
    </body>
  </html>
`;

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

async function createPngBytes(red: number, green: number, blue: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: red, g: green, b: blue, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  return new Uint8Array(buffer);
}

async function createRepoRoot(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'qreader-corpus-remote-'));
  await mkdir(path.join(repoRoot, 'corpus'), { recursive: true });
  return repoRoot;
}

function buildMockFetch(): (input: string | URL) => Promise<Response> {
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
}

describe('remote corpus import', () => {
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
    expect(staged.assets[0]?.imageFileName).toBe('image.png');

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

    const persistedStage = await readStagedRemoteAsset(staged.stageDir, asset.id);
    expect(persistedStage.importedAssetId).toBe(imported?.id);
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

  it('rejects redirects from allowlisted pages', async () => {
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
    ).rejects.toThrow('Unexpected redirect while fetching page');
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
    const stageDir = await mkdtemp(path.join(tmpdir(), 'qreader-corpus-unsafe-'));
    const safeDir = path.join(stageDir, 'stage-deadbeefcafef00d');
    await mkdir(safeDir, { recursive: true });
    await writeFile(
      path.join(safeDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        id: 'stage-deadbeefcafef00d',
        suggestedLabel: 'qr-positive',
        imageFileName: '../../etc/passwd',
        sourcePageUrl: 'https://pixabay.com/photos/first/',
        imageUrl: 'https://cdn.pixabay.com/first.png',
        seedUrl: 'https://pixabay.com/',
        sourceHost: 'pixabay.com',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/png',
        byteLength: 0,
        sha256: '00',
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
    const stageDir = '/tmp/qreader-stage';

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
    const stageDir = await mkdtemp(path.join(tmpdir(), 'qreader-corpus-unsafe-'));
    const safeDir = path.join(stageDir, 'stage-deadbeefcafef00d');
    await mkdir(safeDir, { recursive: true });
    await writeFile(
      path.join(safeDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        id: 'stage-deadbeefcafef00d',
        suggestedLabel: 'qr-positive',
        imageFileName: 'image.png',
        sourcePageUrl: 'file:///etc/passwd',
        imageUrl: 'https://cdn.pixabay.com/first.png',
        seedUrl: 'https://pixabay.com/',
        sourceHost: 'pixabay.com',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/png',
        byteLength: 0,
        sha256: '00',
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
});
