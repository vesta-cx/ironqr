import { describe, expect, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  importStagedRemoteAssets,
  readStagedRemoteAsset,
  scrapeRemoteAssets,
  streamStagedRemoteAssets,
} from '../../src/import/remote.js';
import { classifyLicense, isAutoRejectLicense } from '../../src/license.js';
import { detectQrKind } from '../../src/qr-kind.js';
import { readCorpusRejections } from '../../src/manifest.js';
import { reviewStagedAssets } from '../../src/review.js';
import { makeTestDir } from '../helpers.js';

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
  const repoRoot = await makeTestDir('corpus-review');
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
  it('always opens the source page, prefills ground truth with scan results, and marks acceptedAsTruth when unchanged', async () => {
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

    const openedUrls: string[] = [];
    const qrCountPrefills: Array<number | undefined> = [];

    const summary = await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      assets: streamStagedRemoteAssets(staged.stageDir),
      promptConfirmedLicense: async (_asset, suggestedLicense) => suggestedLicense,
      promptAllowInCorpus: async () => true,
      promptRejectReason: async () => 'license' as const,
      promptQrCount: async (_asset, initialValue) => {
        qrCountPrefills.push(initialValue);
        return initialValue ?? 0;
      },
      promptGroundTruth: async (_asset, qrCount, scanResult) => ({
        qrCount,
        codes: scanResult.results.map((entry) => ({
          text: entry.text,
          ...(entry.kind ? { kind: entry.kind } : {}),
        })),
      }),
      scanAsset: async () => ({
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com', kind: 'url' }],
      }),
      openSourcePage: async (url) => {
        openedUrls.push(url);
      },
      log: () => {},
    });

    expect(summary.approved).toBe(1);
    expect(qrCountPrefills).toEqual([1]);
    expect(openedUrls).toEqual(['https://pixabay.com/photos/first-qr-123/']);

    const reviewed = await readStagedRemoteAsset(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
    );
    expect(reviewed.review).toMatchObject({
      status: 'approved',
      reviewer: 'mia',
    });
    expect(reviewed.confirmedLicense).toBe('Pixabay License');
    expect(reviewed.suggestedLabel).toBe('qr-positive');
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

  it('does not promote a license hint into confirmed license when reviewer clears it', async () => {
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
      assets: streamStagedRemoteAssets(staged.stageDir),
      promptConfirmedLicense: async () => undefined,
      promptAllowInCorpus: async () => true,
      promptRejectReason: async () => 'license' as const,
      promptQrCount: async () => 1,
      promptGroundTruth: async () => ({
        qrCount: 1,
        codes: [{ text: 'https://example.com' }],
      }),
      scanAsset: async () => ({
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com' }],
      }),
      openSourcePage: async () => {},
      log: () => {},
    });

    const reviewed = await readStagedRemoteAsset(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
    );
    expect(reviewed.confirmedLicense).toBeUndefined();
    expect(reviewed.bestEffortLicense).toBe('Pixabay License');
  });

  it('marks acceptedAsTruth as false when reviewer edits the scanned text', async () => {
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
      assets: streamStagedRemoteAssets(staged.stageDir),
      promptConfirmedLicense: async (_asset, suggestedLicense) => suggestedLicense,
      promptAllowInCorpus: async () => true,
      promptRejectReason: async () => 'license' as const,
      promptQrCount: async () => 1,
      promptGroundTruth: async () => ({
        qrCount: 1,
        codes: [{ text: 'https://example.com/corrected' }],
      }),
      scanAsset: async () => ({
        attempted: true,
        succeeded: true,
        results: [{ text: 'https://example.com' }],
      }),
      openSourcePage: async () => {},
      log: () => {},
    });

    const reviewed = await readStagedRemoteAsset(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
    );
    expect(reviewed.groundTruth).toEqual({
      qrCount: 1,
      codes: [{ text: 'https://example.com/corrected' }],
    });
    expect(reviewed.autoScan).toEqual({
      attempted: true,
      succeeded: true,
      results: [{ text: 'https://example.com' }],
      acceptedAsTruth: false,
    });
  });

  it('rejects staged asset when reviewer does not allow it in corpus', async () => {
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

    const summary = await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      assets: streamStagedRemoteAssets(staged.stageDir),
      promptConfirmedLicense: async (_asset, suggestedLicense) => suggestedLicense,
      promptAllowInCorpus: async () => false,
      promptRejectReason: async () => 'license' as const,
      promptQrCount: async () => {
        throw new Error('rejected assets should not ask qr count');
      },
      promptGroundTruth: async () => {
        throw new Error('rejected assets should not ask ground truth');
      },
      scanAsset: async () => {
        throw new Error('rejected assets should not scan');
      },
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
    });
  });

  it('rejects staged source pages outside allowlisted source host before opening browser', async () => {
    const openedUrls: string[] = [];

    await expect(
      reviewStagedAssets({
        stageDir: '/corpus/staging/ironqr-stage',
        reviewer: 'mia',
        assets: (async function* () {
          yield {
            version: 1 as const,
            id: 'stage-deadbeefcafef00d',
            suggestedLabel: 'qr-positive' as const,
            imageFileName: 'image.webp',
            sourcePageUrl: 'http://127.0.0.1/internal',
            imageUrl: 'https://cdn.pixabay.com/first.png',
            seedUrl: 'https://pixabay.com/images/search/qr%20code/',
            sourceHost: 'pixabay.com',
            fetchedAt: '2026-04-10T00:00:00.000Z',
            mediaType: 'image/webp',
            byteLength: 1,
            sha256: '00',
            sourceSha256: '11',
            sourceMediaType: 'image/png',
            sourceByteLength: 1,
            width: 1,
            height: 1,
            review: { status: 'pending' as const },
          };
        })(),
        promptConfirmedLicense: async () => undefined,
        promptAllowInCorpus: async () => true,
        promptRejectReason: async () => 'license' as const,
        promptQrCount: async () => 0,
        promptGroundTruth: async () => ({ qrCount: 0, codes: [] }),
        scanAsset: async () => ({ attempted: false, succeeded: false, results: [] }),
        openSourcePage: async (url) => {
          openedUrls.push(url);
        },
        log: () => {},
      }),
    ).rejects.toThrow(/Source page host is not allowlisted/);

    expect(openedUrls).toEqual([]);
  });

  it('marks approved zero-qr assets as non-qr-negative', async () => {
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
      assets: streamStagedRemoteAssets(staged.stageDir),
      promptConfirmedLicense: async (_asset, suggestedLicense) => suggestedLicense,
      promptAllowInCorpus: async () => true,
      promptRejectReason: async () => 'license' as const,
      promptQrCount: async () => 0,
      promptGroundTruth: async () => ({ qrCount: 0, codes: [] }),
      scanAsset: async () => ({
        attempted: true,
        succeeded: false,
        results: [],
      }),
      openSourcePage: async () => {},
      log: () => {},
    });

    const reviewed = await readStagedRemoteAsset(
      staged.stageDir,
      staged.assets[0]?.id ?? 'missing',
    );
    expect(reviewed.suggestedLabel).toBe('non-qr-negative');
    expect(reviewed.groundTruth).toEqual({ qrCount: 0, codes: [] });
  });

  it('records rejection reason to rejections log on import and skips the asset in subsequent scrapes', async () => {
    const repoRoot = await createRepoRoot();

    // Scrape and reject the first image with reason 'license'
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

    await reviewStagedAssets({
      stageDir: first.stageDir,
      reviewer: 'mia',
      assets: streamStagedRemoteAssets(first.stageDir),
      promptConfirmedLicense: async () => undefined,
      promptAllowInCorpus: async () => false,
      promptRejectReason: async () => 'license' as const,
      promptQrCount: async () => {
        throw new Error('should not be called');
      },
      promptGroundTruth: async () => {
        throw new Error('should not be called');
      },
      scanAsset: async () => {
        throw new Error('should not be called');
      },
      openSourcePage: async () => {},
      log: () => {},
    });

    // Import persists the rejection entry
    await importStagedRemoteAssets({ repoRoot, stageDir: first.stageDir });

    const rejectionsLog = await readCorpusRejections(repoRoot);
    expect(rejectionsLog.rejections).toHaveLength(1);
    expect(rejectionsLog.rejections[0]).toMatchObject({
      reason: 'license',
      rejectedBy: 'mia',
      sourcePageUrl: 'https://pixabay.com/photos/first-qr-123/',
    });

    // Second scrape with staging cleared: rejected image must be skipped
    // (mock listing only has the one image, so nothing fresh gets staged)
    const { rm } = await import('node:fs/promises');
    await rm(first.stageDir, { recursive: true, force: true });

    const second = await scrapeRemoteAssets(
      {
        repoRoot,
        seedUrls: ['https://pixabay.com/images/search/qr%20code/'],
        label: 'qr-positive',
        limit: 2,
      },
      buildMockFetch(),
    );

    expect(second.assets).toHaveLength(0);
  });
});

describe('QR kind detector', () => {
  it('detects URL schemes', () => {
    expect(detectQrKind('https://example.com')).toBe('url');
    expect(detectQrKind('http://example.com/path?q=1')).toBe('url');
    expect(detectQrKind('ftp://files.example.com')).toBe('url');
  });

  it('detects email', () => {
    expect(detectQrKind('mailto:user@example.com')).toBe('email');
    expect(detectQrKind('user@example.com')).toBe('email');
  });

  it('detects phone, sms, geo, wifi', () => {
    expect(detectQrKind('tel:+1-555-1234')).toBe('phone');
    expect(detectQrKind('sms:+15551234')).toBe('sms');
    expect(detectQrKind('smsto:+15551234')).toBe('sms');
    expect(detectQrKind('geo:51.5074,-0.1278')).toBe('geo');
    expect(detectQrKind('WIFI:T:WPA;S:MyNetwork;P:secret;;')).toBe('wifi');
  });

  it('detects vcard and mecard', () => {
    expect(detectQrKind('BEGIN:VCARD\nFN:Jane Doe\nEND:VCARD')).toBe('vcard');
    expect(detectQrKind('MECARD:N:Doe,Jane;EMAIL:jane@example.com;;')).toBe('mecard');
  });

  it('detects otpauth and crypto', () => {
    expect(detectQrKind('otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP')).toBe('otpauth');
    expect(detectQrKind('bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf')).toBe('crypto');
    expect(detectQrKind('ethereum:0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BA')).toBe('crypto');
  });

  it('falls back to text for plain strings', () => {
    expect(detectQrKind('Hello, world!')).toBe('text');
    expect(detectQrKind('12345')).toBe('text');
  });
});

describe('license classifier', () => {
  it('classifies permissive licenses', () => {
    expect(classifyLicense('CC BY 4.0')).toBe('permissive');
    expect(classifyLicense('CC BY-SA 4.0')).toBe('permissive');
    expect(classifyLicense('CC BY-ND 4.0')).toBe('permissive');
    expect(classifyLicense('CC0 1.0')).toBe('permissive');
    expect(classifyLicense('Public domain')).toBe('permissive');
    expect(classifyLicense('Pixabay License')).toBe('permissive');
    expect(classifyLicense('Unsplash License (free to use, no attribution required)')).toBe(
      'permissive',
    );
  });

  it('classifies non-commercial licenses', () => {
    expect(classifyLicense('CC BY-NC 4.0')).toBe('non-commercial');
    expect(classifyLicense('CC BY-NC-SA 4.0')).toBe('non-commercial');
    expect(classifyLicense('CC BY-NC-ND 4.0')).toBe('non-commercial');
  });

  it('classifies restricted licenses', () => {
    expect(classifyLicense('All rights reserved')).toBe('restricted');
    expect(classifyLicense('© 2024 Photographer Name')).toBe('restricted');
    expect(classifyLicense('Proprietary')).toBe('restricted');
    expect(classifyLicense('No redistribution')).toBe('restricted');
  });

  it('flags restricted licenses for auto-reject', () => {
    expect(isAutoRejectLicense('All rights reserved')).toBe(true);
    expect(isAutoRejectLicense('CC BY 4.0')).toBe(false);
    expect(isAutoRejectLicense('CC BY-NC 4.0')).toBe(false);
  });

  it('auto-rejects during review when confirmed license is restricted', async () => {
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

    const logs: string[] = [];
    const summary = await reviewStagedAssets({
      stageDir: staged.stageDir,
      reviewer: 'mia',
      assets: streamStagedRemoteAssets(staged.stageDir),
      promptConfirmedLicense: async () => 'All rights reserved',
      promptAllowInCorpus: async () => {
        throw new Error('should not reach allow-in-corpus prompt for restricted license');
      },
      promptRejectReason: async () => {
        throw new Error('should not reach reject-reason prompt for auto-reject');
      },
      promptQrCount: async () => {
        throw new Error('should not be called');
      },
      promptGroundTruth: async () => {
        throw new Error('should not be called');
      },
      scanAsset: async () => {
        throw new Error('should not be called');
      },
      openSourcePage: async () => {},
      log: (line) => logs.push(line),
    });

    expect(summary.rejected).toBe(1);
    expect(logs.some((l) => l.includes('Auto-rejected') && l.includes('All rights reserved'))).toBe(
      true,
    );

    const reviewed = await readStagedRemoteAsset(staged.stageDir, staged.assets[0]?.id ?? '');
    expect(reviewed.review.status).toBe('rejected');
    expect(reviewed.rejectionReason).toBe('license');
    expect(reviewed.confirmedLicense).toBe('All rights reserved');
  });
});
