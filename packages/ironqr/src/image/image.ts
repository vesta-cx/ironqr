import type { BrowserImageSource } from '../contracts/scan.js';

/**
 * Converts any supported browser image source into an `ImageData` object.
 *
 * Uses `createImageBitmap` to decode the source then draws it onto an
 * `OffscreenCanvas` to obtain raw pixel data.
 *
 * @param source - Browser image source to convert.
 * @returns An `ImageData` containing the full pixel content of the source.
 */
export const toImageData = async (source: BrowserImageSource): Promise<ImageData> => {
  if (source instanceof ImageData) {
    return source;
  }

  const bitmap = await createImageBitmap(source);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    bitmap.close();
    throw new Error('Failed to get 2d context from OffscreenCanvas.');
  }

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
};
