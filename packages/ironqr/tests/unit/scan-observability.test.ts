import { describe, expect, it } from 'bun:test';
import { scanFrame } from '../../src/index.js';
import { buildHiGrid, gridToImageData, makeImageData } from '../helpers.js';

describe('scanFrame observability', () => {
  it('returns a report envelope when observability is requested', async () => {
    const imageData = gridToImageData(buildHiGrid());
    const report = await scanFrame(imageData, {
      observability: {
        result: {
          path: 'basic',
          attempts: 'summary',
        },
        scan: {
          proposals: 'summary',
          timings: 'full',
          failure: 'summary',
        },
      },
    });

    expect('results' in report).toBe(true);
    expect('scan' in report).toBe(true);
    if (!('results' in report) || !('scan' in report)) return;

    expect(report.results).toHaveLength(1);
    const first = report.results[0];
    expect(first?.payload.text).toBe('HI');
    expect(first?.metadata.path?.proposalId).toBeString();
    expect(first?.metadata.path?.proposalBinaryViewId).toBeString();
    expect(first?.metadata.path?.decodeAttempt.decodeBinaryViewId).toBeString();
    expect(first?.metadata.attempts?.attemptCount).toBeGreaterThan(0);
    expect(report.scan.summary.successCount).toBe(1);
    expect(report.scan.failure?.succeeded).toBe(true);
    expect(report.scan.proposals?.viewCount).toBeGreaterThan(0);
    expect(report.scan.proposals?.viewCount).toBeLessThan(18);
    expect(report.scan.proposals?.proposalCount).toBeGreaterThan(0);
    const firstProposalView = report.scan.proposals?.views[0];
    expect(firstProposalView?.binaryViewId).toBeString();
    expect(firstProposalView?.finderEvidence.dedupedCount).toBeNumber();
    expect(firstProposalView?.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.scan.timings && 'attempts' in report.scan.timings).toBe(true);
    if (report.scan.timings && 'attempts' in report.scan.timings) {
      expect(report.scan.timings.attempts.length).toBeGreaterThan(0);
    }
  });

  it('exhausts proposal views when no early single-code result decodes', async () => {
    const width = 64;
    const height = 64;
    const imageData = makeImageData(
      width,
      height,
      new Uint8ClampedArray(width * height * 4).fill(255),
    );
    const report = await scanFrame(imageData, {
      observability: {
        scan: {
          proposals: 'summary',
          failure: 'summary',
        },
      },
    });

    expect('scan' in report).toBe(true);
    if (!('scan' in report)) return;
    expect(report.results).toHaveLength(0);
    expect(report.scan.proposals?.viewCount).toBe(18);
    expect(report.scan.failure?.succeeded).toBe(false);
  });

  it('captures proposal-view trace events when full trace is requested', async () => {
    const imageData = gridToImageData(buildHiGrid());
    const report = await scanFrame(imageData, {
      observability: {
        trace: {
          events: 'full',
        },
      },
    });

    expect('scan' in report).toBe(true);
    if (!('scan' in report)) return;
    expect(report.scan.trace && 'events' in report.scan.trace).toBe(true);
    if (report.scan.trace && 'events' in report.scan.trace) {
      expect(
        report.scan.trace.events.some((event) => event.type === 'proposal-view-generated'),
      ).toBe(true);
    }
  });

  it('omits proposal summaries unless requested', async () => {
    const imageData = gridToImageData(buildHiGrid());
    const report = await scanFrame(imageData, {
      observability: {
        scan: {
          timings: 'summary',
        },
      },
    });

    expect('scan' in report).toBe(true);
    if (!('scan' in report)) return;
    expect(report.scan.proposals).toBeUndefined();
  });

  it('keeps the plain array contract when observability is omitted', async () => {
    const imageData = gridToImageData(buildHiGrid());
    const results = await scanFrame(imageData);

    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.payload.text).toBe('HI');
  });
});
