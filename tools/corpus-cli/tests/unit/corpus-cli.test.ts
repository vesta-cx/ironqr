import { describe, expect, it } from 'bun:test';
import { parseArgv } from '../../src/args.js';
import {
  buildFilteredCliCommand,
  buildOpenExternalInvocation,
  buildOpenTargetInvocation,
  getUsageText,
  resolveRepoRootFromModuleUrl,
} from '../../src/cli.js';
import { promptManualGroundTruth } from '../../src/commands/shared.js';
import { getCorpusCliConfigPath } from '../../src/config.js';
import type { CliUi, SelectValue } from '../../src/ui.js';

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
      args: ['https://example.com/a%20b'],
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
      args: ['-a', 'Preview', '/tmp/image.png'],
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
      args: ['-a', 'Pixelmator Pro', '/tmp/image.png'],
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

  it('formats filtered CLI follow-up commands', () => {
    expect(buildFilteredCliCommand('import', ['/tmp/stage-dir'])).toBe(
      'bun --filter ironqr-corpus-cli run cli -- import "/tmp/stage-dir"',
    );
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
});
