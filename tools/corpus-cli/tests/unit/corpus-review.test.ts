import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { readStagedRemoteAsset, scrapeRemoteAssets } from '../../src/import/remote.js';
import { reviewStagedAssets } from '../../src/review.js';

const LISTING_HTML = `
  <html>
    <body>
      <a href="/photos/first-qr-123/">first</a>
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

const createPngBytes = async (red: number, green: number, blue: number): Promise<Uint8Array> => {
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
};

const createRepoRoot = async (): Promise<string> => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'ironqr-corpus-review-'));
  await mkdir(path.join(repoRoot, 'corpus'), { recursive: true });
  return repoRoot;
};

const buildMockFetch = (): ((input: string | URL) => Promise<Response>) => {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const firstBytes = await createPngBytes(255, 255, 255);

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

    if (url === 'https://cdn.pixabay.com/first.png') {
      return new Response(Buffer.from(firstBytes), {
        headers: { 'content-type': 'image/png' },
      });
    }

    return new Response('not found', { status: 404 });
  };
};

describe('interactive staged review', () => {
  it('approves a staged asset, confirms license, asks qr count first, then accepts auto-scan truth', async () => {
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

    const prompts: string[] = [];
    const answers = ['a', '', '1', 'y'];

    const summary = await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      prompt: async (message) => {
        prompts.push(message);
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error(`missing answer for prompt: ${message}`);
        }
        return answer;
      },
      scanAsset: async () => ({
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com', kind: 'url' }],
      }),
      openLocalImage: async () => {},
      openSourcePage: async () => {},
      log: () => {},
    });

    expect(summary.approved).toBe(1);
    expect(prompts[1]).toContain('license');
    expect(prompts[2]).toContain('How many QR codes');

    const reviewed = await readStagedRemoteAsset(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
    );
    expect(reviewed.review).toMatchObject({
      status: 'approved',
      reviewer: 'mia',
    });
    expect(reviewed.confirmedLicense).toBe('Pixabay License');
    expect(reviewed.groundTruth).toEqual({
      qrCount: 1,
      codes: [{ text: 'https://example.com', kind: 'url' }],
    });
    expect(reviewed.autoScan).toEqual({
      attempted: true,
      succeeded: true,
      results: [{ text: 'https://example.com', kind: 'url' }],
      acceptedAsTruth: true,
    });
  });

  it('reprompts when qr count is left blank before accepting the review', async () => {
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

    const prompts: string[] = [];
    const answers = ['a', '', '', '1', 'y'];

    const summary = await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      prompt: async (message) => {
        prompts.push(message);
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error(`missing answer for prompt: ${message}`);
        }
        return answer;
      },
      scanAsset: async () => ({
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com' }],
      }),
      openLocalImage: async () => {},
      openSourcePage: async () => {},
      log: () => {},
    });

    expect(summary.approved).toBe(1);
    expect(prompts.filter((message) => message.includes('How many QR codes'))).toHaveLength(2);

    const reviewed = await readStagedRemoteAsset(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
    );
    expect(reviewed.groundTruth).toEqual({
      qrCount: 1,
      codes: [{ text: 'https://example.com' }],
    });
  });

  it('skips already-reviewed staged assets on rerun without overwriting them', async () => {
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

    await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      prompt: async (message) => {
        if (message.includes('How many QR codes')) {
          return '1';
        }
        if (message.includes('Accept auto-scan results')) {
          return 'y';
        }
        return message.includes('license') ? '' : 'a';
      },
      scanAsset: async () => ({
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com', kind: 'url' }],
      }),
      openLocalImage: async () => {},
      openSourcePage: async () => {},
      log: () => {},
    });

    const before = await readStagedRemoteAsset(staged.stageDir, staged.assets[0]?.id ?? 'missing');
    const summary = await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      prompt: async () => {
        throw new Error('rerun should not prompt reviewed assets');
      },
      scanAsset: async () => {
        throw new Error('rerun should not scan reviewed assets');
      },
      openLocalImage: async () => {},
      openSourcePage: async () => {},
      log: () => {},
    });
    const after = await readStagedRemoteAsset(staged.stageDir, staged.assets[0]?.id ?? 'missing');

    expect(summary).toEqual({ approved: 0, rejected: 0, skipped: 0, quitEarly: false });
    expect(after).toEqual(before);
  });

  it('rejects a staged asset with reviewer notes', async () => {
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

    const answers = ['r', 'not actually usable'];

    const summary = await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      prompt: async () => {
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error('missing answer');
        }
        return answer;
      },
      scanAsset: async () => ({
        attempted: true,
        succeeded: false,
        results: [],
      }),
      openLocalImage: async () => {},
      openSourcePage: async () => {},
      log: () => {},
    });

    expect(summary.rejected).toBe(1);

    const reviewed = await readStagedRemoteAsset(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
    );
    expect(reviewed.review).toMatchObject({
      status: 'rejected',
      reviewer: 'mia',
      notes: 'not actually usable',
    });
  });
});
