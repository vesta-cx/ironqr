import { Effect } from 'effect';
import type { ImageDataLike } from 'ironqr';
import { scanFrame } from 'ironqr';
import sharp from 'sharp';
import type { AutoScan } from './schema.js';

interface ScanFrameResult {
  readonly payload: { readonly text: string; readonly kind?: string };
}

interface ScanImageData extends ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace: 'srgb' | 'display-p3';
}

/** Scan a local image file for QR codes and return a normalized `AutoScan` result. */
export const scanLocalImageFile = (imagePath: string): Promise<AutoScan> => {
  return Effect.runPromise(scanLocalImageFileEffect(imagePath));
};

const scanLocalImageFileEffect = (imagePath: string) => {
  return Effect.gen(function* () {
    const imageData = yield* readImageData(imagePath);
    const scanOutcome = yield* Effect.match(
      Effect.tryPromise(() => scanFrame(imageData) as Promise<readonly ScanFrameResult[]>),
      {
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (results) => ({ ok: true as const, results }),
      },
    );

    if (!scanOutcome.ok) {
      const message =
        scanOutcome.error instanceof Error ? scanOutcome.error.message : String(scanOutcome.error);
      console.warn(`Scan failed for ${imagePath}: ${message}`);
      return { attempted: true, succeeded: false, results: [] } satisfies AutoScan;
    }

    if (scanOutcome.results.length === 0) {
      return { attempted: true, succeeded: true, results: [] } satisfies AutoScan;
    }

    return {
      attempted: true,
      succeeded: true,
      results: scanOutcome.results.map((result) => ({
        text: result.payload.text,
        kind: result.payload.kind,
      })),
    } satisfies AutoScan;
  });
};

const readImageData = (imagePath: string) => {
  return Effect.tryPromise(async () => {
    const { data, info } = await sharp(imagePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return makeImageData(info.width, info.height, new Uint8ClampedArray(data));
  });
};

const makeImageData = (width: number, height: number, pixels: Uint8ClampedArray): ScanImageData => {
  return { width, height, data: pixels, colorSpace: 'srgb' };
};
