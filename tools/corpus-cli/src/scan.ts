import { Effect } from 'effect';
import { scanFrame } from 'ironqr';
import sharp from 'sharp';
import type { AutoScan } from './schema.js';

export const scanLocalImageFile = (imagePath: string): Promise<AutoScan> => {
  return Effect.runPromise(scanLocalImageFileEffect(imagePath));
};

const scanLocalImageFileEffect = (imagePath: string) => {
  return Effect.gen(function* () {
    const imageData = yield* readImageData(imagePath);
    const results = yield* Effect.tryPromise(() => scanFrame(imageData)).pipe(
      Effect.catch(() => Effect.succeed([])),
    );

    if (results.length === 0) {
      return emptyAutoScan();
    }

    return {
      attempted: true,
      succeeded: true,
      results: results.map((result) => ({
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

const makeImageData = (width: number, height: number, pixels: Uint8ClampedArray): ImageData => {
  return { width, height, data: pixels, colorSpace: 'srgb' } as unknown as ImageData;
};

const emptyAutoScan = (): AutoScan => {
  return {
    attempted: true,
    succeeded: false,
    results: [],
  };
};
