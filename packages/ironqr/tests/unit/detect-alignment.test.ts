import { describe, expect, it } from 'bun:test';
import type { GridResolution } from '../../src/pipeline/geometry.js';
import { locateAlignmentPatternCorrespondences } from '../../src/pipeline/refine.js';

describe('locateAlignmentPatternCorrespondences', () => {
  it('finds the version-2 alignment center near a drifted prediction', () => {
    const width = 320;
    const height = 320;
    const modulePitch = 10;
    const origin = { x: 20, y: 20 };
    const predicted = {
      x: origin.x + 18 * modulePitch,
      y: origin.y + 18 * modulePitch,
    };
    const actual = {
      x: predicted.x + 4,
      y: predicted.y - 3,
    };

    const binary = new Uint8Array(width * height).fill(255);
    drawAlignmentPattern(binary, width, height, actual.x, actual.y, modulePitch);

    const resolution: GridResolution = {
      version: 2,
      size: 25,
      corners: {
        topLeft: { x: origin.x - 5, y: origin.y - 5 },
        topRight: { x: origin.x + 24 * modulePitch + 5, y: origin.y - 5 },
        bottomRight: { x: origin.x + 24 * modulePitch + 5, y: origin.y + 24 * modulePitch + 5 },
        bottomLeft: { x: origin.x - 5, y: origin.y + 24 * modulePitch + 5 },
      },
      bounds: {
        x: origin.x - 5,
        y: origin.y - 5,
        width: 25 * modulePitch,
        height: 25 * modulePitch,
      },
      homography: [modulePitch, 0, origin.x, 0, modulePitch, origin.y, 0, 0, 1],
      samplePoint: (gridRow, gridCol) => ({
        x: origin.x + gridCol * modulePitch,
        y: origin.y + gridRow * modulePitch,
      }),
    };

    const points = locateAlignmentPatternCorrespondences(resolution, binary, width, height);
    expect(points).toHaveLength(1);
    expect(points[0]?.moduleRow).toBe(18);
    expect(points[0]?.moduleCol).toBe(18);
    expect(Math.abs((points[0]?.pixelX ?? 0) - actual.x)).toBeLessThanOrEqual(4);
    expect(Math.abs((points[0]?.pixelY ?? 0) - actual.y)).toBeLessThanOrEqual(4);
  });

  it('rejects off-image alignment predictions instead of scanning a giant search window', () => {
    const width = 1000;
    const height = 404;
    const binary = new Uint8Array(width * height).fill(255);
    const resolution: GridResolution = {
      version: 3,
      size: 29,
      corners: {
        topLeft: { x: 876, y: 208 },
        topRight: { x: 928, y: 104 },
        bottomRight: { x: 810, y: 256 },
        bottomLeft: { x: 856, y: 338 },
      },
      bounds: {
        x: 810,
        y: 104,
        width: 118,
        height: 234,
      },
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      samplePoint: (gridRow, gridCol) => {
        if (gridRow === 22 && gridCol === 22) {
          return { x: 2328.667614434665, y: -847.847312971413 };
        }
        return { x: 880 + gridCol, y: 200 + gridRow };
      },
    };

    const points = locateAlignmentPatternCorrespondences(resolution, binary, width, height);
    expect(points).toEqual([]);
  });
});

const drawAlignmentPattern = (
  binary: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  modulePitch: number,
): void => {
  for (let moduleRow = -2; moduleRow <= 2; moduleRow += 1) {
    for (let moduleCol = -2; moduleCol <= 2; moduleCol += 1) {
      const outerRing = Math.abs(moduleRow) === 2 || Math.abs(moduleCol) === 2;
      const center = moduleRow === 0 && moduleCol === 0;
      if (!(outerRing || center)) continue;

      const cellCenterX = centerX + moduleCol * modulePitch;
      const cellCenterY = centerY + moduleRow * modulePitch;
      const half = Math.floor(modulePitch * 0.35);
      for (
        let py = Math.max(0, Math.round(cellCenterY) - half);
        py <= Math.min(height - 1, Math.round(cellCenterY) + half);
        py += 1
      ) {
        for (
          let px = Math.max(0, Math.round(cellCenterX) - half);
          px <= Math.min(width - 1, Math.round(cellCenterX) + half);
          px += 1
        ) {
          binary[py * width + px] = 0;
        }
      }
    }
  }
};
