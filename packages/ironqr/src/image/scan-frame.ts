import { Effect } from 'effect';
import type { BrowserImageSource, ScanResult } from '../contracts/scan.js';
import { decodeGridLogical } from '../qr/index.js';
import { otsuBinarize, toGrayscale } from './binarize.js';
import { detectFinderPatterns } from './detect.js';
import { resolveGrid } from './geometry.js';
import { toImageData } from './image.js';
import { sampleGrid } from './sample.js';

/**
 * Builds the single-frame QR scanning pipeline as an Effect program.
 *
 * Pipeline: toImageData → toGrayscale → otsuBinarize → detectFinderPatterns
 *   → resolveGrid → sampleGrid → decodeGridLogical → ScanResult[].
 *
 * Succeeds with an empty array when no QR symbol is detected or decoding
 * fails. Fails through the Effect error channel when `toImageData` throws.
 *
 * @param input - Any supported browser image source.
 * @returns An Effect yielding one `ScanResult` per decoded QR symbol found.
 */
export const scanFrame = (input: BrowserImageSource) => {
  return Effect.gen(function* () {
    const imageData = yield* Effect.tryPromise(() => toImageData(input));
    const { width, height } = imageData;

    const luma = toGrayscale(imageData);
    const binary = otsuBinarize(luma, width, height);
    const finders = detectFinderPatterns(binary, width, height);

    if (finders.length < 3) return [] as ScanResult[];

    const resolution = resolveGrid(finders);
    if (resolution === null) return [] as ScanResult[];

    const grid = sampleGrid(width, height, resolution, binary);

    // Per the doc contract, decode failures collapse to an empty result set.
    const decoded = yield* decodeGridLogical({ grid }).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

    if (decoded === null) return [] as ScanResult[];

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
  });
};
