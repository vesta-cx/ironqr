import type { BrowserImageSource, ScanResult } from '../contracts/scan.js';
import { otsuBinarize, toGrayscale } from './binarize.js';
import { decodeGridLogical } from './decode-grid.js';
import { detectFinderPatterns } from './detect.js';
import { resolveGrid } from './geometry.js';
import { toImageData } from './image.js';
import { sampleGrid } from './sample.js';

/**
 * Runs the full single-frame QR scanning pipeline on a browser image source.
 *
 * Pipeline: toImageData → toGrayscale → otsuBinarize → detectFinderPatterns
 *   → resolveGrid → sampleGrid → decodeGridLogical → ScanResult[].
 *
 * Returns an empty array when no QR symbol is detected or decoding fails.
 *
 * @param input - Any supported browser image source.
 * @returns An array containing one `ScanResult` per decoded QR symbol found.
 */
export async function scanFrameInternal(input: BrowserImageSource): Promise<ScanResult[]> {
  const imageData = await toImageData(input);
  const { width, height } = imageData;

  const luma = toGrayscale(imageData);
  const binary = otsuBinarize(luma, width, height);
  const finders = detectFinderPatterns(binary, width, height);

  if (finders.length < 3) return [];

  const resolution = resolveGrid(finders);
  if (resolution === null) return [];

  const grid = sampleGrid(width, height, resolution, binary);

  let decoded: Awaited<ReturnType<typeof decodeGridLogical>>;
  try {
    decoded = await decodeGridLogical({ grid });
  } catch {
    return [];
  }

  const result: ScanResult = {
    payload: decoded.payload,
    // TODO: replace with a real confidence signal (e.g. 1 - bestFormatHammingDistance / 15).
    confidence: 0.9,
    version: decoded.version,
    errorCorrectionLevel: decoded.errorCorrectionLevel,
    bounds: resolution.bounds,
    corners: resolution.corners,
    headers: decoded.headers,
    segments: decoded.segments,
  };

  return [result];
}
