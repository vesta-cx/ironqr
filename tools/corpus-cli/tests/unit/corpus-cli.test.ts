import { describe, expect, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { parseArgv } from '../../src/args.js';
import { buildOpenExternalInvocation, buildOpenTargetInvocation } from '../../src/cli.js';
import { buildFilteredCliCommand, getUsageText } from '../../src/command-text.js';
import { runImportCommand } from '../../src/commands/import.js';
import { runReviewCommand } from '../../src/commands/review.js';
import {
  promptManualGroundTruth,
  promptOptionalText,
  resolveSeedUrls,
} from '../../src/commands/shared.js';
import { getCorpusCliConfigPath } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { writeStagedRemoteAsset } from '../../src/import/remote.js';
import { readCorpusManifest } from '../../src/manifest.js';
import { resolveRepoRootFromModuleUrl } from '../../src/repo-root.js';
import type { CliUi, SelectValue } from '../../src/ui.js';
import { MAJOR_VERSION } from '../../src/version.js';
import { makeTestDir } from '../helpers.js';

describe('corpus cli helpers', () => {
  it('builds a Windows-safe opener invocation', () => {
    const target = 'https://example.com/a?x=1&y=2';

    expect(buildOpenTargetInvocation(target, 'win32')).toEqual({
      command: 'explorer.exe',
      args: [target],
      options: {
        stdio: 'ignore',
        detached: true,
      },
    });
  });

  it('builds a Quick Look opener invocation on macOS', () => {
    expect(buildOpenTargetInvocation('/tmp/image.png', 'darwin', { mode: 'quicklook' })).toEqual({
      command: 'qlmanage',
      args: ['-p', '/tmp/image.png'],
      options: {
        stdio: 'ignore',
        detached: true,
      },
    });
  });

  it('normalizes external URLs on macOS and Linux', () => {
    expect(buildOpenExternalInvocation('https://example.com/a b', 'darwin')).toEqual({
      command: 'open',
      args: ['-g', 'https://example.com/a%20b'],
      options: {
        stdio: 'ignore',
        detached: true,
      },
    });

    expect(buildOpenExternalInvocation('https://example.com/a b', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com/a%20b'],
      options: {
        stdio: 'ignore',
        detached: true,
      },
    });
  });

  it('rejects non-http external URLs on every platform', () => {
    expect(() => buildOpenExternalInvocation('file:///tmp/nope', 'darwin')).toThrow(
      'Expected http(s) URL',
    );
    expect(() => buildOpenExternalInvocation('file:///tmp/nope', 'linux')).toThrow(
      'Expected http(s) URL',
    );
    expect(() => buildOpenExternalInvocation('file:///tmp/nope', 'win32')).toThrow(
      'Expected http(s) URL',
    );
  });

  it('builds a Preview opener invocation on macOS', () => {
    expect(buildOpenTargetInvocation('/tmp/image.png', 'darwin', { mode: 'preview' })).toEqual({
      command: 'open',
      args: ['-g', '-a', 'Preview', '/tmp/image.png'],
      options: {
        stdio: 'ignore',
        detached: true,
      },
    });
  });

  it('builds a custom app opener invocation on macOS', () => {
    expect(
      buildOpenTargetInvocation('/tmp/image.png', 'darwin', {
        mode: 'custom-app',
        value: 'Pixelmator Pro',
      }),
    ).toEqual({
      command: 'open',
      args: ['-g', '-a', 'Pixelmator Pro', '/tmp/image.png'],
      options: {
        stdio: 'ignore',
        detached: true,
      },
    });
  });

  it('builds a default app opener invocation on macOS without stealing focus', () => {
    expect(buildOpenTargetInvocation('/tmp/image.png', 'darwin')).toEqual({
      command: 'open',
      args: ['-g', '/tmp/image.png'],
      options: {
        stdio: 'ignore',
        detached: true,
      },
    });
  });

  it('derives repo root from CLI module location', () => {
    expect(
      resolveRepoRootFromModuleUrl(
        'file:///Users/mia/Development/mia-cx/QReader/tools/corpus-cli/src/cli.ts',
      ),
    ).toBe('/Users/mia/Development/mia-cx/QReader');
  });

  it('prefers explicit repo root override', () => {
    expect(
      resolveRepoRootFromModuleUrl(
        'file:///Users/mia/Development/mia-cx/QReader/tools/corpus-cli/src/cli.ts',
        '/tmp/ironqr-root',
      ),
    ).toBe('/tmp/ironqr-root');
  });

  it('prints new command surface in usage text', () => {
    const usage = getUsageText();

    expect(usage).toContain('build-bench');
    expect(usage).toContain('guided scrape → review → import flow');
    expect(usage).not.toContain('import-local');
    expect(usage).not.toContain('export-benchmark');
  });

  it('formats root-script follow-up commands', () => {
    expect(buildFilteredCliCommand('import', ['/tmp/stage-dir'])).toBe(
      'bun run corpus:import "/tmp/stage-dir"',
    );
    expect(buildFilteredCliCommand('scan-corpus')).toBe('bun run corpus:scan');
  });

  it('parses new command names and flags', () => {
    expect(parseArgv(['scrape', '--limit', '10', 'https://example.com'])).toEqual({
      command: 'scrape',
      help: false,
      options: {
        limit: '10',
      },
      positionals: ['https://example.com'],
      verbose: false,
    });
  });

  it('recognizes --verbose global flag', () => {
    expect(parseArgv(['scrape', '-v', '--limit', '5', 'https://example.com'])).toEqual({
      command: 'scrape',
      help: false,
      options: {
        limit: '5',
      },
      positionals: ['https://example.com'],
      verbose: true,
    });
  });

  it('stores viewer config under repo-local .sc', () => {
    expect(getCorpusCliConfigPath('/tmp/ironqr-root')).toBe('/tmp/ironqr-root/.sc/corpus-cli.json');
  });

  it('offers scrape source presets in interactive mode', async () => {
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const selectCalls: Array<Parameters<CliUi['select']>[0]> = [];
    const ui: CliUi = {
      verbose: false,
      intro() {},
      outro() {},
      cancel() {},
      info() {},
      warn() {},
      debug() {},
      async text(options) {
        if (options.message === 'Pixabay API search term') {
          return 'qr code';
        }
        throw new Error('not used');
      },
      async confirm() {
        return true;
      },
      async select<T extends SelectValue>(options: Parameters<CliUi['select']>[0]): Promise<T> {
        selectCalls.push(options);
        return 'pixabay-api-qr-search' as T;
      },
      async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
        return task();
      },
    };

    try {
      await expect(
        resolveSeedUrls(
          { ui },
          { command: 'scrape', positionals: [], options: {}, help: false, verbose: false },
        ),
      ).resolves.toEqual([
        'https://pixabay.com/api/?q=qr+code&image_type=photo&safesearch=true&order=popular',
      ]);

      expect(selectCalls[0]).toEqual({
        message: 'Choose scrape source',
        initialValue: 'commons-qr-search',
        options: [
          {
            value: 'commons-qr-search',
            label: 'Wikimedia Commons QR search',
            hint: 'MediaSearch for “QR Code”',
          },
          {
            value: 'pixabay-api-qr-search',
            label: 'Pixabay API QR search',
            hint: 'pixabay.com/api?q=qr+code (requires PIXABAY_API_KEY)',
          },
          {
            value: 'custom',
            label: 'Custom URL(s)',
            hint: 'enter one or more seed URLs manually',
          },
        ],
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
  });

  it('supports non-interactive preset source and query flags', async () => {
    const ui: CliUi = {
      verbose: false,
      intro() {},
      outro() {},
      cancel() {},
      info() {},
      warn() {},
      debug() {},
      async text() {
        throw new Error('not used');
      },
      async confirm() {
        return true;
      },
      async select<T extends SelectValue>(): Promise<T> {
        throw new Error('not used');
      },
      async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
        return task();
      },
    };

    await expect(
      resolveSeedUrls(
        { ui },
        {
          command: 'scrape',
          positionals: [],
          options: { source: 'pixabay-api', query: 'wifi qr' },
          help: false,
          verbose: false,
        },
      ),
    ).resolves.toEqual([
      'https://pixabay.com/api/?q=wifi+qr&image_type=photo&safesearch=true&order=popular',
    ]);
  });

  it('prompts for a customizable search term when a preset source is selected', async () => {
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const textCalls: Array<Parameters<CliUi['text']>[0]> = [];
    const ui: CliUi = {
      verbose: false,
      intro() {},
      outro() {},
      cancel() {},
      info() {},
      warn() {},
      debug() {},
      async text(options) {
        textCalls.push(options);
        return 'QR';
      },
      async confirm() {
        return true;
      },
      async select<T extends SelectValue>(): Promise<T> {
        return 'pixabay-api-qr-search' as T;
      },
      async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
        return task();
      },
    };

    try {
      await expect(
        resolveSeedUrls(
          { ui },
          { command: 'scrape', positionals: [], options: {}, help: false, verbose: false },
        ),
      ).resolves.toEqual([
        'https://pixabay.com/api/?q=QR&image_type=photo&safesearch=true&order=popular',
      ]);

      expect(textCalls[0]).toEqual({
        message: 'Pixabay API search term',
        initialValue: 'qr code',
        validate: expect.any(Function),
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
  });

  it('falls back to manual seed URL entry when custom source is selected', async () => {
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const textCalls: Array<Parameters<CliUi['text']>[0]> = [];
    const ui: CliUi = {
      verbose: false,
      intro() {},
      outro() {},
      cancel() {},
      info() {},
      warn() {},
      debug() {},
      async text(options) {
        textCalls.push(options);
        return 'https://example.com/one https://example.com/two';
      },
      async confirm() {
        return true;
      },
      async select<T extends SelectValue>(): Promise<T> {
        return 'custom' as T;
      },
      async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
        return task();
      },
    };

    try {
      await expect(
        resolveSeedUrls(
          { ui },
          { command: 'scrape', positionals: [], options: {}, help: false, verbose: false },
        ),
      ).resolves.toEqual(['https://example.com/one', 'https://example.com/two']);

      expect(textCalls[0]).toEqual({
        message: 'Seed URL(s), separated by spaces or commas',
        placeholder:
          'https://commons.wikimedia.org/w/index.php?search=qr+code&title=Special%3AMediaSearch&type=image',
        validate: expect.any(Function),
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
  });

  it('treats undefined text responses as blank for optional prompts', async () => {
    const value = await promptOptionalText(
      {
        verbose: false,
        intro() {},
        outro() {},
        cancel() {},
        info() {},
        warn() {},
        debug() {},
        async text() {
          return undefined as unknown as string;
        },
        async confirm() {
          throw new Error('not used');
        },
        async select<T extends SelectValue>(): Promise<T> {
          throw new Error('not used');
        },
        async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
          return task();
        },
      },
      'Optional field',
    );

    expect(value).toBeUndefined();
  });

  it('uses multiline prompt for QR payload data', async () => {
    const calls: Array<{ readonly multiline: boolean | undefined; readonly message: string }> = [];
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const ui: CliUi = {
      verbose: false,
      intro() {},
      outro() {},
      cancel() {},
      info() {},
      warn() {},
      debug() {},
      async text(options) {
        calls.push({ multiline: options.multiline, message: options.message });
        if (options.message.includes('kind')) return 'url';
        if (options.message.includes('verified with')) return 'iphone camera';
        return 'line 1\nline 2';
      },
      async confirm() {
        return true;
      },
      async select<T extends SelectValue>(): Promise<T> {
        throw new Error('not used');
      },
      async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
        return task();
      },
    };

    try {
      const truth = await promptManualGroundTruth(ui, 1);

      expect(calls[0]).toEqual({
        multiline: true,
        message: 'QR #1 data (Enter newline, Esc then Enter submit)',
      });
      expect(truth.codes[0]?.text).toBe('line 1\nline 2');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
  });

  it('staged import still prompts for non-platform-guaranteed license hints', async () => {
    const repoRoot = await makeTestDir('import-cli');
    const stageDir = path.join(repoRoot, 'corpus', 'staging', 'manual-run');
    await mkdir(path.join(repoRoot, 'corpus'), { recursive: true });
    await mkdir(stageDir, { recursive: true });

    const imageBuffer = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .webp()
      .toBuffer();

    await writeStagedRemoteAsset(
      stageDir,
      {
        version: MAJOR_VERSION,
        id: 'stage-deadbeefcafef00d',
        suggestedLabel: 'qr-positive',
        imageFileName: 'image.webp',
        sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
        imageUrl: 'https://upload.wikimedia.org/example.webp',
        seedUrl:
          'https://commons.wikimedia.org/w/index.php?search=QR+Code&title=Special:MediaSearch&go=Go&type=image',
        sourceHost: 'commons.wikimedia.org',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/webp',
        byteLength: imageBuffer.byteLength,
        sha256: '00',
        sourceSha256: '11',
        sourceMediaType: 'image/png',
        sourceByteLength: imageBuffer.byteLength,
        width: 2,
        height: 2,
        bestEffortLicense: 'CC BY 4.0',
        review: { status: 'pending' },
        groundTruth: { qrCount: 1, codes: [{ text: 'https://example.com' }] },
      },
      new Uint8Array(imageBuffer),
    );

    const prompts: Array<Parameters<CliUi['text']>[0]> = [];
    const context: AppContext = {
      repoRoot,
      ui: {
        verbose: false,
        intro() {},
        outro() {},
        cancel() {},
        info() {},
        warn() {},
        debug() {},
        async text(options) {
          prompts.push(options);
          return 'CC0';
        },
        async confirm() {
          return true;
        },
        async select<T extends SelectValue>(): Promise<T> {
          throw new Error('not used');
        },
        async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
          return task();
        },
      },
      ensureImageViewer: async () => {},
      openImage: async () => {},
      openExternal: async () => {},
      detectGithubLogin: () => undefined,
    };

    await runImportCommand(
      context,
      {
        command: 'import',
        positionals: [stageDir],
        options: { review: 'approved', reviewer: 'mia' },
        help: false,
        verbose: false,
      },
      stageDir,
    );

    const licensePrompt = prompts.find((prompt) =>
      prompt.message.startsWith('Confirmed license for stage-deadbeefcafef00d'),
    );
    expect(licensePrompt).toBeDefined();
    expect(licensePrompt?.initialValue).toBeUndefined();
    expect(licensePrompt?.placeholder).toBe('CC BY 4.0');

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets[0]?.licenseReview?.confirmedLicense).toBe('CC0');
    expect(manifest.assets[0]?.licenseReview?.bestEffortLicense).toBe('CC BY 4.0');
  });

  it('skips the license prompt for trusted Pixabay staged imports', async () => {
    const repoRoot = await makeTestDir('corpus-cli-pixabay-import-license');
    const stageDir = path.join(repoRoot, 'corpus', 'staging', 'run-001');
    await mkdir(stageDir, { recursive: true });

    const imageBuffer = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .webp()
      .toBuffer();

    await writeStagedRemoteAsset(
      stageDir,
      {
        version: MAJOR_VERSION,
        id: 'stage-pixabay-license-skip',
        suggestedLabel: 'qr-positive',
        imageFileName: 'image.webp',
        sourcePageUrl: 'https://pixabay.com/photos/example/',
        imageUrl: 'https://cdn.pixabay.com/example.webp',
        seedUrl: 'https://pixabay.com/images/search/qr%20code/',
        sourceHost: 'pixabay.com',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/webp',
        byteLength: imageBuffer.byteLength,
        sha256: '00',
        sourceSha256: '11',
        sourceMediaType: 'image/png',
        sourceByteLength: imageBuffer.byteLength,
        width: 2,
        height: 2,
        bestEffortLicense: 'Pixabay License',
        review: { status: 'pending' },
        groundTruth: { qrCount: 1, codes: [{ text: 'https://example.com' }] },
      },
      new Uint8Array(imageBuffer),
    );

    const prompts: Array<Parameters<CliUi['text']>[0]> = [];
    const context: AppContext = {
      repoRoot,
      ui: {
        verbose: false,
        intro() {},
        outro() {},
        cancel() {},
        info() {},
        warn() {},
        debug() {},
        async text(options) {
          prompts.push(options);
          return 'should-not-be-used';
        },
        async confirm() {
          return true;
        },
        async select<T extends SelectValue>(): Promise<T> {
          throw new Error('not used');
        },
        async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
          return task();
        },
      },
      ensureImageViewer: async () => {},
      openImage: async () => {},
      openExternal: async () => {},
      detectGithubLogin: () => undefined,
    };

    await runImportCommand(
      context,
      {
        command: 'import',
        positionals: [stageDir],
        options: { review: 'approved', reviewer: 'mia' },
        help: false,
        verbose: false,
      },
      stageDir,
    );

    const licensePrompt = prompts.find((prompt) =>
      prompt.message.startsWith('Confirmed license for stage-pixabay-license-skip'),
    );
    expect(licensePrompt).toBeUndefined();

    const manifest = await readCorpusManifest(repoRoot);
    expect(manifest.assets[0]?.licenseReview?.confirmedLicense).toBe('Pixabay License');
    expect(manifest.assets[0]?.licenseReview?.bestEffortLicense).toBe('Pixabay License');
  });

  it('skips the license prompt during review for trusted Pixabay assets', async () => {
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const repoRoot = await makeTestDir('corpus-cli-pixabay-review-license');
    const stageDir = path.join(repoRoot, 'corpus', 'staging', 'run-001');
    await mkdir(stageDir, { recursive: true });

    const imageBuffer = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .webp()
      .toBuffer();

    await writeStagedRemoteAsset(
      stageDir,
      {
        version: MAJOR_VERSION,
        id: 'stage-pixabay-review-skip',
        suggestedLabel: 'non-qr-negative',
        imageFileName: 'image.webp',
        sourcePageUrl: 'https://pixabay.com/photos/example/',
        imageUrl: 'https://cdn.pixabay.com/example.webp',
        seedUrl: 'https://pixabay.com/images/search/qr%20code/',
        sourceHost: 'pixabay.com',
        fetchedAt: '2026-04-10T00:00:00.000Z',
        mediaType: 'image/webp',
        byteLength: imageBuffer.byteLength,
        sha256: '00',
        sourceSha256: '11',
        sourceMediaType: 'image/png',
        sourceByteLength: imageBuffer.byteLength,
        width: 2,
        height: 2,
        bestEffortLicense: 'Pixabay License',
        review: { status: 'pending' },
      },
      new Uint8Array(imageBuffer),
    );

    const prompts: Array<Parameters<CliUi['text']>[0]> = [];
    const infoMessages: string[] = [];
    const confirmMessages: string[] = [];
    const context: AppContext = {
      repoRoot,
      ui: {
        verbose: false,
        intro() {},
        outro() {},
        cancel() {},
        info(message) {
          infoMessages.push(message);
        },
        warn() {},
        debug() {},
        async text(options) {
          prompts.push(options);
          if (options.message.includes('reviewer')) {
            return 'mia';
          }
          if (options.message.startsWith('How many QR codes are present')) {
            return '0';
          }
          return 'should-not-be-used';
        },
        async confirm(options) {
          confirmMessages.push(options.message);
          return true;
        },
        async select<T extends SelectValue>(): Promise<T> {
          throw new Error('not used');
        },
        async spin<T>(_message: string, task: () => Promise<T>): Promise<T> {
          return task();
        },
      },
      ensureImageViewer: async () => {},
      openImage: async () => {},
      openExternal: async () => {},
      detectGithubLogin: () => 'mia',
    };

    try {
      await runReviewCommand(
        context,
        {
          command: 'review',
          positionals: [stageDir],
          options: { reviewer: 'mia' },
          help: false,
          verbose: false,
        },
        stageDir,
        'mia',
      );

      const licensePrompt = prompts.find((prompt) =>
        prompt.message.startsWith(
          'Confirmed license / permission basis for stage-pixabay-review-skip',
        ),
      );
      expect(licensePrompt).toBeUndefined();
      expect(infoMessages).toContain(
        'Trusted platform license for stage-pixabay-review-skip: Pixabay License',
      );
      expect(infoMessages).toContain(
        'Trusted platform source for stage-pixabay-review-skip: skipping allow prompt',
      );
      expect(confirmMessages).not.toContain('Allow stage-pixabay-review-skip in corpus?');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
  });
});
