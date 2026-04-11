/**
 * Converts an RGBA `ImageData` to an 8-bit grayscale array using luminance weighting.
 *
 * Luminance formula: 0.299R + 0.587G + 0.114B (BT.601).
 *
 * @param data - Source `ImageData`.
 * @returns Grayscale luma values, one byte per pixel.
 */
export const toGrayscale = (data: ImageData): Uint8Array => {
  const { width, height, data: pixels } = data;
  const luma = new Uint8Array(width * height);

  for (let i = 0; i < luma.length; i += 1) {
    const base = i * 4;
    const r = pixels[base] ?? 0;
    const g = pixels[base + 1] ?? 0;
    const b = pixels[base + 2] ?? 0;
    luma[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  return luma;
};

/**
 * Binarizes a grayscale image using Otsu's global thresholding method.
 *
 * @param luma - Grayscale pixel values (0-255).
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @returns Binary array: 0 = dark (QR module), 255 = light (background).
 */
export const otsuBinarize = (luma: Uint8Array, width: number, height: number): Uint8Array => {
  const total = width * height;
  const histogram: number[] = new Array<number>(256).fill(0);

  for (let i = 0; i < total; i += 1) {
    const bucket = luma[i] ?? 0;
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  let sumAll = 0;
  for (let t = 0; t < 256; t += 1) {
    sumAll += t * (histogram[t] ?? 0);
  }

  let weightBackground = 0;
  let sumBackground = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t] ?? 0;
    if (weightBackground === 0) continue;

    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * (histogram[t] ?? 0);

    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;
    const diff = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * diff * diff;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  const binary = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    binary[i] = (luma[i] ?? 0) > threshold ? 255 : 0;
  }

  return binary;
};
