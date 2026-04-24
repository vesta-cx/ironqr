import { describe, expect, it } from 'bun:test';
import {
  classifyTimingBucket,
  createBenchDashboardModel,
  ensureDashboardEngine,
  onDashboardBenchmarkStarted,
  onDashboardScanFinished,
  onDashboardScanStarted,
} from '../../src/accuracy/dashboard/model.js';
import { renderTimingChart } from '../../src/accuracy/dashboard/timing-chart.js';
import type { EngineAssetResult } from '../../src/accuracy/types.js';

const result = (
  overrides: Partial<EngineAssetResult> &
    Pick<EngineAssetResult, 'label' | 'outcome' | 'durationMs'>,
): EngineAssetResult => ({
  engineId: 'ironqr',
  decodedTexts: [],
  matchedTexts: [],
  failureReason: null,
  error: null,
  cached: false,
  ...overrides,
});

describe('bench dashboard model', () => {
  it('classifies scan outcomes into timing buckets', () => {
    expect(
      classifyTimingBucket(result({ label: 'qr-positive', outcome: 'pass', durationMs: 1 })),
    ).toBe('positive-pass');
    expect(
      classifyTimingBucket(
        result({ label: 'qr-positive', outcome: 'partial-pass', durationMs: 1 }),
      ),
    ).toBe('positive-pass');
    expect(
      classifyTimingBucket(
        result({ label: 'qr-positive', outcome: 'fail-no-decode', durationMs: 1 }),
      ),
    ).toBe('positive-fail');
    expect(
      classifyTimingBucket(
        result({ label: 'qr-positive', outcome: 'fail-mismatch', durationMs: 1 }),
      ),
    ).toBe('positive-fail');
    expect(
      classifyTimingBucket(result({ label: 'non-qr-negative', outcome: 'pass', durationMs: 1 })),
    ).toBe('negative-pass');
    expect(
      classifyTimingBucket(
        result({ label: 'non-qr-negative', outcome: 'false-positive', durationMs: 1 }),
      ),
    ).toBe('negative-fail');
  });

  it('tracks fresh timing buckets and excludes cached scans from averages', () => {
    const model = createBenchDashboardModel();
    onDashboardBenchmarkStarted(model, 10, ['ironqr'], 2);
    onDashboardScanFinished(model, {
      engineId: 'ironqr',
      assetId: 'asset-1',
      relativePath: 'assets/asset-1.webp',
      result: result({
        engineId: 'ironqr',
        label: 'qr-positive',
        outcome: 'pass',
        durationMs: 2000,
      }),
      wroteToCache: false,
      nowMs: 1,
    });
    onDashboardScanStarted(model, {
      engineId: 'ironqr',
      assetId: 'asset-2',
      relativePath: 'assets/asset-2.webp',
      cached: true,
      cacheable: true,
      nowMs: 2,
    });
    onDashboardScanFinished(model, {
      engineId: 'ironqr',
      assetId: 'asset-2',
      relativePath: 'assets/asset-2.webp',
      result: result({
        engineId: 'ironqr',
        label: 'qr-positive',
        outcome: 'pass',
        durationMs: 50,
        cached: true,
      }),
      wroteToCache: false,
      nowMs: 2,
    });

    const ironqr = model.engines.get('ironqr');
    expect(ironqr?.timing['positive-pass']).toEqual({ count: 1, totalMs: 2000, maxMs: 2000 });
    expect(ironqr?.completed).toBe(2);
    expect(ironqr?.cacheHits).toBe(1);
  });

  it('tracks active scans and cache misses', () => {
    const model = createBenchDashboardModel();
    onDashboardScanStarted(model, {
      engineId: 'ironqr',
      assetId: 'asset-1',
      relativePath: 'assets/asset-1.webp',
      cached: false,
      cacheable: true,
      nowMs: 100,
    });

    expect(model.activeScans.get('ironqr:asset-1')?.phase).toBe('scanning');
    expect(model.engines.get('ironqr')?.cacheMisses).toBe(1);
  });

  it('keeps the eight slowest fresh scans', () => {
    const model = createBenchDashboardModel();
    for (let index = 0; index < 10; index += 1) {
      onDashboardScanFinished(model, {
        engineId: 'ironqr',
        assetId: `asset-${index}`,
        relativePath: `assets/asset-${index}.webp`,
        result: result({
          engineId: 'ironqr',
          label: 'qr-positive',
          outcome: 'fail-no-decode',
          durationMs: index,
        }),
        wroteToCache: false,
        nowMs: index,
      });
    }

    expect(model.slowestFreshScans).toHaveLength(8);
    expect(model.slowestFreshScans[0]?.assetId).toBe('asset-9');
    expect(model.slowestFreshScans.at(-1)?.assetId).toBe('asset-2');
  });
});

describe('timing chart widget', () => {
  it('renders vertical bucket bars with centered labels and left-aligned counts', () => {
    const model = createBenchDashboardModel();
    onDashboardBenchmarkStarted(model, 10, ['ironqr', 'jsqr'], 2);
    onDashboardScanFinished(model, {
      engineId: 'ironqr',
      assetId: 'asset-1',
      relativePath: 'assets/asset-1.webp',
      result: result({
        engineId: 'ironqr',
        label: 'qr-positive',
        outcome: 'pass',
        durationMs: 2300,
      }),
      wroteToCache: false,
      nowMs: 1,
    });
    onDashboardScanFinished(model, {
      engineId: 'ironqr',
      assetId: 'asset-2',
      relativePath: 'assets/asset-2.webp',
      result: result({
        engineId: 'ironqr',
        label: 'qr-positive',
        outcome: 'fail-no-decode',
        durationMs: 12_000,
      }),
      wroteToCache: false,
      nowMs: 2,
    });
    onDashboardScanFinished(model, {
      engineId: 'ironqr',
      assetId: 'asset-3',
      relativePath: 'assets/asset-3.webp',
      result: result({
        engineId: 'ironqr',
        label: 'non-qr-negative',
        outcome: 'pass',
        durationMs: 1700,
      }),
      wroteToCache: false,
      nowMs: 3,
    });

    const output = renderTimingChart(model, { width: 80, barHeight: 4 }).join('\n');
    expect(output).toContain('avg fresh ms / asset');
    expect(output).toContain('ironqr');
    expect(output).toContain(' P    F    N    X ');
    expect(output).toContain('2.3s 12s  1.7s  - ');
    expect(output).toContain('1    1    1    0');
    expect(output).toContain('···');
  });

  it('supports horizontal engine offsets', () => {
    const model = createBenchDashboardModel();
    for (const engine of ['ironqr', 'jsqr', 'zxing']) ensureDashboardEngine(model, engine);

    const output = renderTimingChart(model, { width: 38, engineOffset: 1 }).join('\n');
    expect(output).not.toContain('ironqr');
    expect(output).toContain('jsqr');
    expect(output).toContain('engines 2-2/3');
  });
});
