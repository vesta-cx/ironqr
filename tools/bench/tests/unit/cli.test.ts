import { describe, expect, it } from 'bun:test';
import { parseArgs } from '../../src/cli.js';

describe('bench cli args', () => {
  it('keeps cache and OpenTUI progress enabled by default', () => {
    const { options } = parseArgs(['accuracy']);
    expect(options.cacheEnabled).toBe(true);
    expect(options.progressEnabled).toBe(true);
  });

  it('can disable every benchmark cache', () => {
    const { options } = parseArgs(['accuracy', '--no-cache']);
    expect(options.cacheEnabled).toBe(false);
  });

  it('rejects engine selection', () => {
    expect(() => parseArgs(['accuracy', '--engine=ironqr'])).toThrow('full target engine set');
    expect(() => parseArgs(['performance', '--engine', 'zbar'])).toThrow('full target engine set');
  });

  it('rejects focused accuracy trace collection', () => {
    expect(() => parseArgs(['accuracy', '--ironqr-trace=full'])).toThrow('full trace');
  });

  it('accepts help after a mode', () => {
    const { mode, options } = parseArgs(['accuracy', '--help']);
    expect(mode).toBe('accuracy');
    expect(options.help).toBe(true);
  });

  it('parses suite flags without requiring an explicit mode', () => {
    const { mode, options } = parseArgs(['--max-assets', '1', '--seed', 'smoke']);
    expect(mode).toBeUndefined();
    expect(options.maxAssets).toBe(1);
    expect(options.seed).toBe('smoke');
  });

  it('parses report directories', () => {
    const { options } = parseArgs(['performance', '--report-dir', 'tools/bench/reports/custom']);
    expect(options.reportDir).toBe('tools/bench/reports/custom');
  });

  it('parses study id before study flags', () => {
    const { mode, options } = parseArgs(['study', 'view-order', '--max-assets', '3']);
    expect(mode).toBe('study');
    expect(options.studyId).toBe('view-order');
    expect(options.maxAssets).toBe(3);
  });

  it('parses study list and plugin flags', () => {
    expect(parseArgs(['study', 'list']).options.listStudies).toBe(true);
    const { options } = parseArgs([
      'study',
      'run',
      'view-proposals',
      '--preset',
      'production',
      '--top-k=3',
    ]);
    expect(options.studyId).toBe('view-proposals');
    expect(options.studyFlags).toEqual({ preset: 'production', 'top-k': 3 });
  });

  it('rejects unsupported command-specific flags', () => {
    expect(() => parseArgs(['accuracy', '--iterations', '2'])).toThrow('only supported');
    expect(() => parseArgs(['study', 'view-order', '--iterations', '2'])).toThrow('not supported');
    expect(() => parseArgs(['engines', '--max-assets', '1'])).toThrow(
      'bench engines does not support',
    );
  });

  it('rejects partially numeric worker and iteration counts', () => {
    expect(() => parseArgs(['accuracy', '--workers=2abc'])).toThrow('non-negative integer');
    expect(() => parseArgs(['accuracy', '--workers', '1.5'])).toThrow('non-negative integer');
    expect(() => parseArgs(['performance', '--iterations=1.5'])).toThrow('positive integer');
  });

  it('accepts zero study workers to run on the main thread', () => {
    const { options } = parseArgs(['study', 'binary-prefilter-signals', '--workers=0']);
    expect(options.workers).toBe(0);
  });

  it('parses targeted cache refresh', () => {
    const { options } = parseArgs(['performance', '--refresh-cache', 'ironqr']);
    expect(options.refreshCache).toBe(true);
    expect(options.refreshCacheEngineId).toBe('ironqr');
  });

  it('only supports disabling OpenTUI progress', () => {
    expect(parseArgs(['accuracy', '--quiet']).options.progressEnabled).toBe(false);
    expect(parseArgs(['accuracy', '--no-progress']).options.progressEnabled).toBe(false);
    expect(() => parseArgs(['accuracy', '--progress=plain'])).toThrow('Use --no-progress');
    expect(() => parseArgs(['accuracy', '--progress', 'dashboard'])).toThrow('Use --no-progress');
  });
});
