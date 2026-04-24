import sharp from 'sharp';

export interface BenchImageData {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace: 'srgb';
}

const imageCache = new Map<string, Promise<BenchImageData>>();

/** Read one local image file into a cached RGBA buffer. */
export const readBenchImage = async (imagePath: string): Promise<BenchImageData> => {
  let pending = imageCache.get(imagePath);
  if (!pending) {
    pending = (async () => {
      const { data, info } = await sharp(imagePath)
        .flatten({ background: '#ffffff' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return {
        path: imagePath,
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data),
        colorSpace: 'srgb',
      } satisfies BenchImageData;
    })();
    imageCache.set(imagePath, pending);
  }
  return pending;
};

/** Build a grayscale luminance plane from an RGBA image. */
export const buildLuminanceBuffer = (image: BenchImageData): Uint8ClampedArray => {
  const luminance = new Uint8ClampedArray(image.width * image.height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    luminance[index] = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
  }
  return luminance;
};

/** Invert a grayscale luminance plane. */
export const invertLuminanceBuffer = (luminance: Uint8ClampedArray): Uint8ClampedArray => {
  const inverted = new Uint8ClampedArray(luminance.length);
  for (let index = 0; index < luminance.length; index += 1) {
    inverted[index] = 255 - (luminance[index] ?? 0);
  }
  return inverted;
};

/** Clone an RGBA buffer for engines that mutate their input. */
export const cloneRgbaBuffer = (data: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> => {
  const clone = new Uint8ClampedArray(new ArrayBuffer(data.length));
  clone.set(data);
  return clone;
};
