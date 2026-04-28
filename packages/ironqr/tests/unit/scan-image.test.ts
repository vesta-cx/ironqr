import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import {
  createNormalizedImage,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SOURCE_BYTES,
  normalizeImageInput,
  validateImageDimensions,
} from '../../src/pipeline/frame.js';
import { createGeometryCandidates, resolveGrid } from '../../src/pipeline/geometry.js';
import {
  detectBestFinderEvidence,
  generateProposalBatchForView,
  generateProposals,
  rankProposalCandidates,
  summarizeProposalBatches,
} from '../../src/pipeline/proposals.js';
import { sampleGrid } from '../../src/pipeline/samplers.js';
import { createTraceCollector } from '../../src/pipeline/trace.js';
import {
  createViewBank,
  listDefaultBinaryViewIds,
  otsuBinarize,
  readBinaryBit,
  toGrayscale,
} from '../../src/pipeline/views.js';
import { decodeGridLogical } from '../../src/qr/index.js';
import {
  appendBits,
  buildVersion1Grid,
  finalizeV1DataCodewords,
  gridToImageData,
  makeImageData,
} from '../helpers.js';

describe('single-image baseline pipeline (internal modules)', () => {
  it('toGrayscale converts an all-white ImageData to all-255 luma', () => {
    const width = 10;
    const height = 10;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const imageData = makeImageData(width, height, pixels);
    const luma = toGrayscale(createNormalizedImage(imageData));
    expect(luma.every((value) => value === 255)).toBe(true);
  });

  it('toGrayscale converts an all-black ImageData to all-0 luma', () => {
    const width = 4;
    const height = 4;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + 3] = 255;
    }
    const imageData = makeImageData(width, height, pixels);
    const luma = toGrayscale(createNormalizedImage(imageData));
    expect(luma.every((value) => value === 0)).toBe(true);
  });

  it('toGrayscale composites fully transparent pixels onto white (matches browser behaviour)', () => {
    const width = 4;
    const height = 4;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const imageData = makeImageData(width, height, pixels);
    const luma = toGrayscale(createNormalizedImage(imageData));
    expect(luma.every((value) => value === 255)).toBe(true);
  });

  it('toGrayscale composites partial alpha onto white (50% opaque black → ~128)', () => {
    const width = 2;
    const height = 2;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + 3] = 128;
    }
    const imageData = makeImageData(width, height, pixels);
    const luma = toGrayscale(createNormalizedImage(imageData));
    for (const value of luma) {
      expect(value).toBeGreaterThanOrEqual(126);
      expect(value).toBeLessThanOrEqual(129);
    }
  });

  it('otsuBinarize on a blank (all-white) image returns all-255 (light)', () => {
    const width = 100;
    const height = 100;
    const luma = new Uint8Array(width * height).fill(255);
    const binary = otsuBinarize(luma, width, height);
    expect(binary.every((value) => value === 255)).toBe(true);
  });

  it('accepts an 8192x4320 8K screen capture area budget', () => {
    expect(MAX_IMAGE_PIXELS).toBe(8192 * 4320);
    expect(() => validateImageDimensions(8192, 4320)).not.toThrow();
  });

  it('rejects oversized canvas-like browser sources before bitmap conversion', async () => {
    await expect(
      Effect.runPromise(normalizeImageInput({ width: 8193, height: 1 })),
    ).rejects.toThrow('must not exceed 8192px per side');
  });

  it('rejects oversized Blob-like browser sources before bitmap conversion', async () => {
    await expect(
      Effect.runPromise(
        normalizeImageInput({
          size: MAX_IMAGE_SOURCE_BYTES + 1,
          type: 'image/png',
          arrayBuffer: async () => new ArrayBuffer(0),
        }),
      ),
    ).rejects.toThrow('Browser image source size must not exceed');
  });

  it('shares one threshold plane across normal and inverted binary view identities', () => {
    const imageData = makeImageData(
      2,
      1,
      new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
    );
    const bank = createViewBank(createNormalizedImage(imageData));
    const normal = bank.getBinaryView('gray:otsu:normal');
    const inverted = bank.getBinaryView('gray:otsu:inverted');

    expect(normal.plane).toBe(inverted.plane);
    expect(bank.listBinaryViewIds()).toHaveLength(54);
    expect(listDefaultBinaryViewIds()).toHaveLength(54);
    expect(readBinaryBit(normal, 0)).toBe(1);
    expect(readBinaryBit(inverted, 0)).toBe(0);
  });

  it('orders proposal views by the current view-study priority list', () => {
    const imageData = makeImageData(2, 2, new Uint8ClampedArray(2 * 2 * 4).fill(255));
    const bank = createViewBank(createNormalizedImage(imageData));

    expect(bank.listProposalViewIds()).toEqual([
      'gray:otsu:normal',
      'oklab-l:hybrid:normal',
      'gray:sauvola:normal',
      'oklab-l:sauvola:normal',
      'oklab-l:otsu:normal',
      'b:hybrid:normal',
      'gray:hybrid:normal',
      'r:otsu:normal',
      'r:sauvola:normal',
      'g:sauvola:normal',
      'b:otsu:normal',
      'g:otsu:normal',
      'g:hybrid:normal',
      'b:sauvola:normal',
      'r:hybrid:normal',
      'oklab+b:hybrid:normal',
      'gray:hybrid:inverted',
      'gray:otsu:inverted',
    ]);
  });

  it('generates a first-class proposal batch for one binary view', () => {
    const imageData = gridToImageData(buildHiGrid());
    const bank = createViewBank(createNormalizedImage(imageData));
    const trace = createTraceCollector();
    const batch = generateProposalBatchForView(bank, 'gray:otsu:normal', { traceSink: trace });
    const generated = generateProposals(bank, { viewIds: ['gray:otsu:normal'] });
    const summary = summarizeProposalBatches([batch]);

    expect(batch.binaryViewId).toBe('gray:otsu:normal');
    expect(batch.summary.binaryViewId).toBe(batch.binaryViewId);
    expect(batch.summary.proposalCount).toBe(batch.proposals.length);
    expect(batch.proposals.length).toBeGreaterThan(0);
    expect(generated.map((proposal) => proposal.id)).toEqual(
      batch.proposals.map((proposal) => proposal.id),
    );
    expect(summary.viewCount).toBe(1);
    expect(summary.proposalCount).toBe(batch.proposals.length);
    expect(trace.events.some((event) => event.type === 'proposal-view-generated')).toBe(true);
  });

  it('keeps inferred quad geometry as a seed on the finder-triple proposal', () => {
    const imageData = gridToImageData(buildHiGrid());
    const bank = createViewBank(createNormalizedImage(imageData));
    const batch = generateProposalBatchForView(bank, 'gray:otsu:normal');
    const proposal = batch.proposals[0];

    expect(proposal?.kind).toBe('finder-triple');
    if (proposal?.kind !== 'finder-triple') return;
    expect(proposal.geometrySeeds?.some((seed) => seed.kind === 'inferred-quad')).toBe(true);
    expect(batch.proposals.some((candidate) => candidate.kind === 'quad')).toBe(false);
    expect(
      createGeometryCandidates(proposal).some(
        (candidate) => candidate.geometryMode === 'quad-homography',
      ),
    ).toBe(true);
  });

  it('keeps ranking-time geometry candidates for decode reuse', () => {
    const imageData = gridToImageData(buildHiGrid());
    const bank = createViewBank(createNormalizedImage(imageData));
    const ranked = rankProposalCandidates(bank, generateProposals(bank));

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.proposal.proposalScore).toBeGreaterThan(0);
    expect(ranked[0]?.initialGeometryCandidates.length).toBeGreaterThan(0);
    expect(ranked[0]?.initialGeometryCandidates[0]?.proposalId).toBe(ranked[0]?.proposal.id);
  });

  it('detectBestFinderEvidence returns fewer than 3 candidates for a blank image', () => {
    const width = 210;
    const height = 210;
    const binary = new Uint8Array(width * height).fill(255);
    const finders = detectBestFinderEvidence(binary, width, height);
    expect(finders.length).toBeLessThan(3);
  });

  const buildHiGrid = () => {
    const bits: number[] = [];
    appendBits(bits, 0b0010, 4);
    appendBits(bits, 2, 9);
    appendBits(bits, 17 * 45 + 18, 11);
    return buildVersion1Grid(finalizeV1DataCodewords(bits, 'M'), 'M', 0);
  };

  it('detects 3 finder patterns in a synthetic v1-M QR image at 10px/module', () => {
    const imageData = gridToImageData(buildHiGrid());
    const luma = toGrayscale(createNormalizedImage(imageData));
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const finders = detectBestFinderEvidence(binary, imageData.width, imageData.height);
    expect(finders.length).toBe(3);
  });

  it('resolveGrid returns a valid GridResolution from 3 finder candidates', () => {
    const imageData = gridToImageData(buildHiGrid());
    const luma = toGrayscale(createNormalizedImage(imageData));
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const finders = detectBestFinderEvidence(binary, imageData.width, imageData.height);
    expect(finders.length).toBe(3);
    const [topLeft, topRight, bottomLeft] = finders;
    if (!topLeft || !topRight || !bottomLeft) throw new Error('Expected exactly three finders.');

    const resolution = resolveGrid([topLeft, topRight, bottomLeft]);
    expect(resolution).not.toBeNull();
    expect(resolution?.version).toBe(1);
    expect(resolution?.size).toBe(21);
  });

  it('full internal pipeline decodes a synthetic v1-M "HI" QR image', async () => {
    const imageData = gridToImageData(buildHiGrid());
    const luma = toGrayscale(createNormalizedImage(imageData));
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const finders = detectBestFinderEvidence(binary, imageData.width, imageData.height);
    expect(finders.length).toBe(3);
    const [topLeft, topRight, bottomLeft] = finders;
    if (!topLeft || !topRight || !bottomLeft) throw new Error('Expected exactly three finders.');

    const resolution = resolveGrid([topLeft, topRight, bottomLeft]);
    expect(resolution).not.toBeNull();
    if (resolution === null) return;

    const sampledGrid = sampleGrid(imageData.width, imageData.height, resolution, binary);
    const result = await Effect.runPromise(decodeGridLogical({ grid: sampledGrid }));

    expect(result.payload.text).toBe('HI');
    expect(result.version).toBe(1);
    expect(result.errorCorrectionLevel).toBe('M');
  });

  it('not-found path: detectBestFinderEvidence returns fewer than 3 candidates for a blank image', () => {
    const width = 210;
    const height = 210;
    const luma = new Uint8Array(width * height).fill(255);
    const binary = otsuBinarize(luma, width, height);
    const finders = detectBestFinderEvidence(binary, width, height);
    expect(finders.length).toBeLessThan(3);
  });
});
