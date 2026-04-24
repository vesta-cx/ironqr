import { describe, expect, it } from 'bun:test';
import { type ScanTimingSpan, scanFrame } from '../../src/index.js';
import { buildHiGrid, gridToImageData } from '../helpers.js';

describe('scanFrame metrics spans', () => {
  it('keeps the plain array contract while emitting opt-in timing spans', async () => {
    const imageData = gridToImageData(buildHiGrid());
    const spans: ScanTimingSpan[] = [];

    const results = await scanFrame(imageData, {
      metricsSink: { record: (span) => spans.push(span) },
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.payload.text).toBe('HI');
    expect(spans.length).toBeGreaterThan(0);

    const names = new Set(spans.map((span) => span.name));
    expect(names.has('normalize')).toBe(true);
    expect(names.has('scalar-view')).toBe(true);
    expect(names.has('binary-view')).toBe(true);
    expect(names.has('proposal-view')).toBe(true);
    expect(names.has('ranking')).toBe(true);
    expect(names.has('clustering')).toBe(true);
    expect(names.has('structure')).toBe(true);
    expect(names.has('geometry')).toBe(true);
    expect(names.has('decode-attempt')).toBe(true);
    expect(names.has('decode-cascade')).toBe(true);

    for (const span of spans) {
      expect(Number.isFinite(span.durationMs)).toBe(true);
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    }

    const decodeAttempt = spans.find((span) => span.name === 'decode-attempt');
    expect(decodeAttempt?.metadata?.decodeBinaryViewId).toBeString();
    expect(decodeAttempt?.metadata?.sampler).toBeString();
    expect(decodeAttempt?.metadata?.refinement).toBeString();
    expect(decodeAttempt?.metadata?.outcome).toBeString();
  });

  it('does not require a metrics sink for normal scans', async () => {
    const imageData = gridToImageData(buildHiGrid());
    const results = await scanFrame(imageData);

    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.payload.text).toBe('HI');
  });
});
