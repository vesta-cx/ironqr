import { describe, expect, it } from 'bun:test';
import {
  buildFilteredCliCommand,
  buildOpenTargetInvocation,
  getUsageText,
  resolveRepoRootFromModuleUrl,
} from '../../src/cli.js';

describe('corpus cli opener', () => {
  it('builds a Windows-safe opener invocation', () => {
    const target = 'https://example.com/a?x=1&y=2';

    expect(buildOpenTargetInvocation(target, 'win32')).toEqual({
      command: 'cmd',
      args: ['/d', '/s', '/c', 'start', '""', `"${target}"`],
      options: {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      },
    });
  });

  it('derives the repo root from the CLI module location', () => {
    expect(
      resolveRepoRootFromModuleUrl(
        'file:///Users/mia/Development/mia-cx/QReader/tools/corpus-cli/src/cli.ts',
      ),
    ).toBe('/Users/mia/Development/mia-cx/QReader');
  });

  it('prefers an explicit repo root override', () => {
    expect(
      resolveRepoRootFromModuleUrl(
        'file:///Users/mia/Development/mia-cx/QReader/tools/corpus-cli/src/cli.ts',
        '/tmp/ironqr-root',
      ),
    ).toBe('/tmp/ironqr-root');
  });

  it('prints supported filtered CLI commands in usage text', () => {
    const usage = getUsageText();

    expect(usage).toContain('bun --filter ironqr-corpus-cli run cli -- review-staged');
    expect(usage).not.toContain('bun run corpus/cli.ts');
  });

  it('formats filtered CLI commands for follow-up steps', () => {
    expect(buildFilteredCliCommand('import-staged', ['/tmp/stage-dir'])).toBe(
      'bun --filter ironqr-corpus-cli run cli -- import-staged "/tmp/stage-dir"',
    );
  });
});
