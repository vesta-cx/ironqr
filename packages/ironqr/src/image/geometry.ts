import type { Bounds, CornerSet, Point } from '../contracts/geometry.js';
import type { FinderCandidate } from './detect.js';

/**
 * The result of resolving a QR grid from finder pattern candidates.
 */
export interface GridResolution {
  /** Estimated QR version (1-40). */
  readonly version: number;
  /** Total number of modules per side. */
  readonly size: number;
  /** Pixel-coordinate corners of the QR symbol boundary. */
  readonly corners: CornerSet;
  /** Bounding box of the QR symbol in pixels. */
  readonly bounds: Bounds;
  /**
   * Maps a grid (row, col) module coordinate to a pixel (x, y) center.
   *
   * @param gridRow - Zero-based module row.
   * @param gridCol - Zero-based module column.
   * @returns Pixel coordinates of the module center.
   */
  readonly samplePoint: (gridRow: number, gridCol: number) => Point;
}

/**
 * Resolves a QR grid layout from three finder pattern candidates.
 *
 * Determines which finder is top-left / top-right / bottom-left, estimates
 * the QR version from inter-finder distances, and produces a sampling
 * transform from (gridRow, gridCol) to pixel coordinates.
 *
 * @param finders - Exactly 3 finder pattern candidates.
 * @returns Grid resolution for sampling, or null if geometry cannot be resolved.
 */
export const resolveGrid = (finders: readonly FinderCandidate[]): GridResolution | null => {
  if (finders.length < 3) return null;

  const [fa, fb, fc] = finders as [FinderCandidate, FinderCandidate, FinderCandidate];
  const pa: Point = { x: fa.cx, y: fa.cy };
  const pb: Point = { x: fb.cx, y: fb.cy };
  const pc: Point = { x: fc.cx, y: fc.cy };

  const dAB = dist(pa, pb);
  const dAC = dist(pa, pc);
  const dBC = dist(pb, pc);

  // The top-left finder is opposite the longest side (hypotenuse).
  let topLeft: Point;
  let topRight: Point;
  let bottomLeft: Point;

  if (dAB >= dAC && dAB >= dBC) {
    // fa or fb are the far pair; fc is the right-angle corner (top-left)
    topLeft = pc;
    topRight = pa;
    bottomLeft = pb;
  } else if (dAC >= dAB && dAC >= dBC) {
    topLeft = pb;
    topRight = pa;
    bottomLeft = pc;
  } else {
    topLeft = pa;
    topRight = pb;
    bottomLeft = pc;
  }

  // Orient so topRight is to the right and bottomLeft is below.
  // Use cross product: if cross(topLeft, topRight, bottomLeft) < 0, swap.
  if (cross(topLeft, topRight, bottomLeft) < 0) {
    [topRight, bottomLeft] = [bottomLeft, topRight];
  }

  // Estimate module size from all three candidates (averaged).
  const avgModuleSize = (fa.moduleSize + fb.moduleSize + fc.moduleSize) / 3;

  // Estimate QR version from distance between finder centers.
  // Distance in modules between top-left and top-right finder centers = (version * 4 + 10).
  const hDist = dist(topLeft, topRight);
  const vDist = dist(topLeft, bottomLeft);
  const avgModuleDist = (hDist + vDist) / 2;
  const modulesAcross = avgModuleDist / avgModuleSize;

  // modules between finder centers = size - 7; size = version*4+17
  // so version = (modulesAcross + 7 - 17) / 4 = (modulesAcross - 10) / 4
  const rawVersion = Math.round((modulesAcross - 10) / 4);
  const version = Math.max(1, Math.min(40, rawVersion));
  const size = version * 4 + 17;

  // Build an affine sampling transform.
  // Finder centers are at module 3.5 (center of 7-module finder) from the QR edge.
  // So top-left finder center is at grid (3, 3), top-right at (3, size-4), bottom-left at (size-4, 3).
  const finderOffset = 3;
  const trGridCol = size - 1 - finderOffset;
  const blGridRow = size - 1 - finderOffset;

  // Compute pixel-per-module vectors using the two non-top-left finders.
  // Right vector: from TL to TR, scaled to (trGridCol - finderOffset) modules.
  const hModules = trGridCol - finderOffset;
  const vModules = blGridRow - finderOffset;

  const rightVec: Point = {
    x: (topRight.x - topLeft.x) / hModules,
    y: (topRight.y - topLeft.y) / hModules,
  };
  const downVec: Point = {
    x: (bottomLeft.x - topLeft.x) / vModules,
    y: (bottomLeft.y - topLeft.y) / vModules,
  };

  // Origin: pixel position corresponding to grid (0, 0)
  const origin: Point = {
    x: topLeft.x - finderOffset * rightVec.x - finderOffset * downVec.x,
    y: topLeft.y - finderOffset * rightVec.y - finderOffset * downVec.y,
  };

  const samplePoint = (gridRow: number, gridCol: number): Point => ({
    x: origin.x + gridCol * rightVec.x + gridRow * downVec.x,
    y: origin.y + gridCol * rightVec.y + gridRow * downVec.y,
  });

  // Derive the 4 corners of the QR symbol (pixel coordinates of the outer boundary).
  const cornerTL = samplePoint(-0.5, -0.5);
  const cornerTR = samplePoint(-0.5, size - 0.5);
  const cornerBR = samplePoint(size - 0.5, size - 0.5);
  const cornerBL = samplePoint(size - 0.5, -0.5);

  const corners: CornerSet = {
    topLeft: cornerTL,
    topRight: cornerTR,
    bottomRight: cornerBR,
    bottomLeft: cornerBL,
  };

  const minX = Math.min(cornerTL.x, cornerTR.x, cornerBR.x, cornerBL.x);
  const minY = Math.min(cornerTL.y, cornerTR.y, cornerBR.y, cornerBL.y);
  const maxX = Math.max(cornerTL.x, cornerTR.x, cornerBR.x, cornerBL.x);
  const maxY = Math.max(cornerTL.y, cornerTR.y, cornerBR.y, cornerBL.y);

  const bounds: Bounds = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return { version, size, corners, bounds, samplePoint };
};

/**
 * Returns the Euclidean distance between two points.
 */
const dist = (a: Point, b: Point): number => {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
};

/**
 * Returns the cross product of vectors (b-a) and (c-a).
 * Positive = c is below/right of the directed line a→b (image coords, y increases downward).
 */
const cross = (a: Point, b: Point, c: Point): number => {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
};
