import { describe, expect, it } from 'bun:test';
import { parseArgs } from '../../src/cli.js';

describe('bench cli args', () => {
  it('keeps ironqr cache and auto progress enabled by default', () => {
    const { options } = parseArgs(['accuracy']);
    expect(options.cacheEnabled).toBe(true);
    expect(options.ironqrCacheEnabled).toBe(true);
    expect(options.progressMode).toBe('auto');
  });

  it('can disable only the ironqr cache', () => {
    const { options } = parseArgs(['accuracy', '--no-ironqr-cache']);
    expect(options.cacheEnabled).toBe(true);
    expect(options.ironqrCacheEnabled).toBe(false);
  });

  it('can disable every accuracy cache', () => {
    const { options } = parseArgs(['accuracy', '--no-cache']);
    expect(options.cacheEnabled).toBe(false);
    expect(options.ironqrCacheEnabled).toBe(true);
  });

  it('keeps ironqr trace disabled by default', () => {
    const { options } = parseArgs(['accuracy']);
    expect(options.ironqrTraceMode).toBe('off');
  });

  it('accepts help after a mode', () => {
    const { mode, options } = parseArgs(['accuracy', '--help']);
    expect(mode).toBe('accuracy');
    expect(options.help).toBe(true);
  });

  it('can select a progress renderer', () => {
    expect(parseArgs(['accuracy', '--progress=plain']).options.progressMode).toBe('plain');
    expect(parseArgs(['accuracy', '--progress', 'dashboard']).options.progressMode).toBe(
      'dashboard',
    );
    expect(parseArgs(['accuracy', '--progress=tui']).options.progressMode).toBe('tui');
    expect(parseArgs(['accuracy', '--quiet']).options.progressMode).toBe('off');
  });
});
