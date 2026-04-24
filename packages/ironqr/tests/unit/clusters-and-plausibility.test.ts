import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { clusterRankedProposals } from '../../src/pipeline/clusters.js';
import { createNormalizedImage, normalizeImageInput } from '../../src/pipeline/frame.js';
import { assessProposalStructure } from '../../src/pipeline/plausibility.js';
import type { FinderEvidence, ScanProposal } from '../../src/pipeline/proposals.js';
import { generateProposals, rankProposals } from '../../src/pipeline/proposals.js';
import { scanFrameRankedEffect } from '../../src/pipeline/scan.js';
import { createTraceCollector, createTraceCounter } from '../../src/pipeline/trace.js';
import { createViewBank, otsuBinarize, toGrayscale } from '../../src/pipeline/views.js';
import { buildHiGrid, gridToImageData, makeImageData } from '../helpers.js';

const makeFinder = (centerX: number, centerY: number, score: number): FinderEvidence => ({
  source: 'matcher',
  centerX,
  centerY,
  moduleSize: 4,
  hModuleSize: 4,
  vModuleSize: 4,
  score,
});

describe('proposal clusters', () => {
  it('groups near-duplicate proposals from different views into one cluster', () => {
    const findersA = [
      makeFinder(40, 40, 10),
      makeFinder(120, 42, 10),
      makeFinder(42, 120, 10),
    ] as const;
    const findersB = [
      makeFinder(43, 41, 9),
      makeFinder(123, 43, 9),
      makeFinder(43, 123, 9),
    ] as const;
    const findersC = [
      makeFinder(220, 220, 8),
      makeFinder(300, 222, 8),
      makeFinder(222, 300, 8),
    ] as const;
    const proposals = [
      {
        id: 'a',
        kind: 'finder-triple',
        binaryViewId: 'gray:otsu:normal',
        finders: findersA,
        estimatedVersions: [1],
        proposalScore: 10,
        scoreBreakdown: {
          detectorScore: 0,
          geometryScore: 0,
          quietZoneScore: 0,
          timingScore: 0,
          alignmentScore: 0,
          penalties: 0,
          total: 10,
        },
      },
      {
        id: 'b',
        kind: 'finder-triple',
        binaryViewId: 'r:otsu:normal',
        finders: findersB,
        estimatedVersions: [1],
        proposalScore: 9,
        scoreBreakdown: {
          detectorScore: 0,
          geometryScore: 0,
          quietZoneScore: 0,
          timingScore: 0,
          alignmentScore: 0,
          penalties: 0,
          total: 9,
        },
      },
      {
        id: 'c',
        kind: 'finder-triple',
        binaryViewId: 'gray:otsu:normal',
        finders: findersC,
        estimatedVersions: [1],
        proposalScore: 8,
        scoreBreakdown: {
          detectorScore: 0,
          geometryScore: 0,
          quietZoneScore: 0,
          timingScore: 0,
          alignmentScore: 0,
          penalties: 0,
          total: 8,
        },
      },
    ] satisfies readonly ScanProposal[];

    const clusters = clusterRankedProposals(proposals, { maxRepresentatives: 3 });
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.proposals.map((proposal) => proposal.id)).toEqual(['a', 'b']);
    expect(clusters[0]?.representatives.map((proposal) => proposal.id)).toEqual([
      'cluster:1:3:3:3:3:average',
      'a',
    ]);
    expect(clusters[1]?.proposals.map((proposal) => proposal.id)).toEqual(['c']);
  });
});

describe('proposal structural plausibility', () => {
  it('passes a clean synthetic QR proposal and rejects a blank fake candidate', async () => {
    const cleanImage = gridToImageData(buildHiGrid());
    const cleanFrame = await Effect.runPromise(normalizeImageInput(cleanImage));
    const cleanBank = createViewBank(cleanFrame);
    const cleanProposal = rankProposals(cleanBank, generateProposals(cleanBank))[0];
    expect(cleanProposal).toBeDefined();
    if (!cleanProposal) return;

    const cleanAssessment = assessProposalStructure(cleanProposal, cleanBank);
    expect(cleanAssessment.passed).toBe(true);
    expect(cleanAssessment.timingScore).toBeGreaterThan(0.5);
    expect(cleanAssessment.finderScore).toBeGreaterThan(0.5);

    const blankWidth = 320;
    const blankHeight = 320;
    const blankPixels = new Uint8ClampedArray(blankWidth * blankHeight * 4).fill(255);
    const blankImage = makeImageData(blankWidth, blankHeight, blankPixels);
    const blankFrame = createNormalizedImage(blankImage);
    const blankBank = createViewBank(blankFrame);
    const fakeProposal = {
      id: 'fake',
      kind: 'finder-triple',
      binaryViewId: 'gray:otsu:normal',
      finders: [makeFinder(50, 50, 4), makeFinder(250, 60, 4), makeFinder(60, 250, 4)] as const,
      estimatedVersions: [2],
      proposalScore: 4,
      scoreBreakdown: {
        detectorScore: 0,
        geometryScore: 0,
        quietZoneScore: 0,
        timingScore: 0,
        alignmentScore: 0,
        penalties: 0,
        total: 4,
      },
    } satisfies ScanProposal;

    const blankAssessment = assessProposalStructure(fakeProposal, blankBank);
    expect(blankAssessment.passed).toBe(false);
    expect(blankAssessment.finderScore).toBeLessThan(0.4);
  });

  it('clean finder detection still yields exactly three finders on a synthetic QR', () => {
    const imageData = gridToImageData(buildHiGrid());
    const luma = toGrayscale(createNormalizedImage(imageData));
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const bank = createViewBank(createNormalizedImage(imageData));
    const proposals = generateProposals(bank);
    expect(binary.length).toBe(imageData.width * imageData.height);
    expect(proposals.length).toBeGreaterThan(0);
    const first = proposals[0];
    expect(first?.kind).toBe('finder-triple');
    if (first?.kind !== 'finder-triple') return;
    expect(first.finders).toHaveLength(3);
  });

  it('emits cluster-level trace events that explain the clustered scan path', async () => {
    const trace = createTraceCollector();
    const imageData = gridToImageData(buildHiGrid());

    const results = await Effect.runPromise(scanFrameRankedEffect(imageData, { traceSink: trace }));
    expect(results.length).toBe(1);

    const clustering = trace.events.find((event) => event.type === 'proposal-clusters-built');
    expect(clustering).toBeDefined();
    if (!clustering || clustering.type !== 'proposal-clusters-built') return;
    expect(clustering.rankedProposalCount).toBeGreaterThan(0);
    expect(clustering.clusterCount).toBeGreaterThan(0);
    expect(clustering.clusterCount).toBeLessThanOrEqual(clustering.boundedProposalCount);
    expect(clustering.representativeCount).toBeGreaterThan(0);

    const clusterStarted = trace.events.filter((event) => event.type === 'cluster-started');
    const clusterFinished = trace.events.filter((event) => event.type === 'cluster-finished');
    const representatives = trace.events.filter(
      (event) => event.type === 'cluster-representative-started',
    );
    const structure = trace.events.filter((event) => event.type === 'proposal-structure-assessed');
    const finished = trace.events.find((event) => event.type === 'scan-finished');

    expect(clusterStarted.length).toBeGreaterThan(0);
    expect(clusterFinished.length).toBe(clusterStarted.length);
    expect(representatives.length).toBeGreaterThan(0);
    expect(structure.length).toBe(representatives.length);
    expect(
      trace.events.some(
        (event) => event.type === 'cluster-finished' && event.outcome === 'decoded',
      ),
    ).toBe(true);
    expect(finished).toBeDefined();
    if (!finished || finished.type !== 'scan-finished') return;
    expect(finished.clusterCount).toBe(clustering.clusterCount);
    expect(finished.representativeCount).toBe(clustering.representativeCount);
    expect(finished.processedRepresentativeCount).toBe(representatives.length);
  });

  it('exposes clustering summaries on the low-overhead trace counter', async () => {
    const trace = createTraceCounter();
    const imageData = gridToImageData(buildHiGrid());

    const results = await Effect.runPromise(scanFrameRankedEffect(imageData, { traceSink: trace }));
    expect(results.length).toBe(1);
    expect(trace.clustering).not.toBeNull();
    expect(trace.scanFinished).not.toBeNull();
    expect(trace.clusterOutcomes.length).toBeGreaterThan(0);
    expect(trace.scanFinished?.clusterCount).toBe(trace.clustering?.clusterCount);
    expect(trace.scanFinished?.processedRepresentativeCount).toBe(
      trace.counts['cluster-representative-started'] ?? 0,
    );
  });
});
