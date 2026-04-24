/**
 * Stylized-QR regression suite — Phase 1 failure characterization.
 *
 * Each test documents a failure mode found in the real-world corpus:
 *   - inverted polarity (white modules on dark background) → detect-stage fail
 *   - color modules (dark hue on white background) → verify luma path
 *   - low contrast (dark gray on light gray) → Otsu boundary case
 *
 * Tests marked `.skip` represent executable failure-mode fixtures observed in corpus
 * diagnostics but whose fixes span later phases (geometry / multi-sample).
 */
import { describe, expect, it } from 'bun:test';
import { scanFrame } from '../../src/index.js';
import { createNormalizedImage } from '../../src/pipeline/frame.js';
import { resolveGrid } from '../../src/pipeline/geometry.js';
import { detectBestFinderEvidence } from '../../src/pipeline/proposals.js';
import { refineGeometryByFitness } from '../../src/pipeline/refine.js';
import { otsuBinarize, toGrayscale } from '../../src/pipeline/views.js';
import {
  buildHiGrid,
  gridToImageData,
  gridToImageDataColor,
  gridToImageDataDots,
  gridToImageDataInverted,
  gridToImageDataLowContrast,
  gridToImageDataPerspective,
  imageDataPerspective,
} from '../helpers.js';

describe('stylized QR scan — polarity and contrast variants', () => {
  // ── 1. Inverted polarity ──────────────────────────────────────────────
  //
  // Real corpus failure mode: 5 assets returned finders=0 — these are images
  // where the QR is rendered as light modules on a dark background.
  // crossCheckVertical bails when center pixel isn't dark (0), so the whole
  // detection stage fails silently.
  //
  // Fix target (Phase 2): try both normal and inverted binary in the pipeline;
  // detect finders against whichever orientation the image uses.

  it('inverted polarity: white modules on black background decode correctly', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataInverted(grid);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  // ── 2. Color modules — dark blue on white ────────────────────────────
  //
  // QR codes with colored modules are common in marketing materials.
  // The BT.601 luma of deep blue [0,0,139] is ~16 — high enough contrast
  // vs white (255) that Otsu should still find the threshold.
  // This tests that the luma-based path doesn't silently break on color input.

  it('color modules: dark blue on white background decode correctly', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataColor(grid, [0, 0, 139], [255, 255, 255]);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  // ── 3. Low contrast — dark gray on light gray ─────────────────────────
  //
  // Reduced contrast (60 vs 195 instead of 0 vs 255) with a clean bimodal
  // distribution. Global Otsu should still find a separating threshold;
  // if this fails the Otsu implementation is broken, not just incomplete.

  it('low contrast: dark gray (60) on light gray (195) decode correctly', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataLowContrast(grid, 60, 195);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  // ── 4. Inverted color — dark background with colored modules ──────────
  //
  // Corner case: dark brown background, cream modules.
  // The luma of [210,180,140] is ~185, background [40,30,20] is ~32.
  // Still bimodal but inverted — exercises both color luma and polarity.

  it('inverted color: cream modules on dark brown background decode correctly', async () => {
    const grid = buildHiGrid();
    // Render inverted: "dark" (QR dark module) = cream, "light" = dark brown.
    const imageData = gridToImageDataColor(grid, [210, 180, 140], [40, 30, 20]);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  it.skip('dotted modules: circle-rendered QR decode needs the next rescue slice (module-shape aware sampling)', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataDots(grid);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });
});

describe('stylized QR scan — geometry variants', () => {
  // ── 5. Perspective (keystone) distortion ──────────────────────────────
  //
  // Real corpus failure mode: ~10 portrait photos of QR codes on physical
  // objects (kiosks, signs, billboards) photographed at an angle. The old
  // 3-finder affine drifted by several pixels at the far corner; the new
  // homography fit plus local-basis sampling handles realistic camera angles.
  // For v1 symbols, a small bottom-right corner fallback search now recovers
  // cases where the three-finder fit is almost right but still long/short at
  // the far corner. Stronger warps still need better corner localization.

  it('mild keystone (5%): warped QR decodes correctly', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataPerspective(grid, 0.05);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  it('moderate keystone (10%) on v1 decodes correctly', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataPerspective(grid, 0.1);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  it.skip('strong keystone (15%) on v1 needs a stronger geometry rescue than the current proposal-local refiner', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataPerspective(grid, 0.15);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  it.skip('dotted modules under moderate keystone need the same module-shape rescue path', async () => {
    const grid = buildHiGrid();
    const dotted = gridToImageDataDots(grid);
    const imageData = imageDataPerspective(dotted, 0.1);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });

  it.skip('strong keystone (18%+) on v1 — needs better far-corner localization than the current fallback search', async () => {
    const grid = buildHiGrid();
    const imageData = gridToImageDataPerspective(grid, 0.18);
    const results = await scanFrame(imageData);
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe('HI');
  });
});

describe('fitness-driven homography refinement', () => {
  // The fitness refiner samples QR structural cells (timing patterns, finder
  // signatures, alignment patterns) and hill-climbs the homography parameters
  // to maximise expected/observed agreement. It exists as a precondition for
  // the next slice's improvements (flood-fill detection, multi-QR clustering)
  // — those will produce coarser initial homographies that need fitness-
  // refinement to land usable.

  it('keeps a clean v1 geometry unchanged when fitness is already maximal', () => {
    const imageData = gridToImageData(buildHiGrid());
    const luma = toGrayscale(createNormalizedImage(imageData));
    const binary = otsuBinarize(luma, imageData.width, imageData.height);
    const finders = detectBestFinderEvidence(binary, imageData.width, imageData.height);
    const [topLeft, topRight, bottomLeft] = finders;
    if (!topLeft || !topRight || !bottomLeft) {
      throw new Error('expected exactly three finders for clean v1');
    }
    const resolved = resolveGrid([topLeft, topRight, bottomLeft], 1);
    if (!resolved) throw new Error('expected resolveGrid to succeed for clean v1');
    const refined = refineGeometryByFitness(resolved, binary, imageData.width, imageData.height);
    expect(refined.version).toBe(1);
    expect(refined.size).toBe(21);
    expect(refined).toEqual(resolved);
  });
});
