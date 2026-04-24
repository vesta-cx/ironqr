import sharp from 'sharp';

/** RGBA image data in sRGB order; `data.length` must be `width * height * 4`. */
export interface BenchImageData {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace: 'srgb';
}

const MAX_CACHED_IMAGES = 32;
const imageCache = new Map<string, Promise<BenchImageData>>();

/** Read one local image file into RGBA data. Returned buffers are safe for callers to mutate. */
export const readBenchImage = async (imagePath: string): Promise<BenchImageData> => {
  let pending = imageCache.get(imagePath);
  if (!pending) {
    pending = readImage(imagePath).catch((error) => {
      imageCache.delete(imagePath);
      throw error;
    });
    imageCache.set(imagePath, pending);
    evictOldestImageIfNeeded();
  }
  const cached = await pending;
  return cloneBenchImage(cached);
};

/** Build a grayscale luminance plane from an RGBA image. */
export const buildLuminanceBuffer = (image: BenchImageData): Uint8ClampedArray => {
  assertRgbaImageData(image);
  const luminance = new Uint8ClampedArray(image.width * image.height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    const red = byteAt(image.data, offset);
    const green = byteAt(image.data, offset + 1);
    const blue = byteAt(image.data, offset + 2);
    luminance[index] = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
  }
  return luminance;
};

/** Invert a grayscale luminance plane. */
export const invertLuminanceBuffer = (luminance: Uint8ClampedArray): Uint8ClampedArray => {
  const inverted = new Uint8ClampedArray(luminance.length);
  for (let index = 0; index < luminance.length; index += 1) {
    inverted[index] = 255 - byteAt(luminance, index);
  }
  return inverted;
};

/** Clone an RGBA buffer for engines that mutate their input. */
export const cloneRgbaBuffer = (data: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> => {
  const clone = new Uint8ClampedArray(new ArrayBuffer(data.length));
  clone.set(data);
  return clone;
};

const readImage = async (imagePath: string): Promise<BenchImageData> => {
  const { data, info } = await sharp(imagePath)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const image = {
    path: imagePath,
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
    colorSpace: 'srgb',
  } satisfies BenchImageData;
  assertRgbaImageData(image);
  return image;
};

const cloneBenchImage = (image: BenchImageData): BenchImageData => ({
  ...image,
  data: cloneRgbaBuffer(image.data),
});

const evictOldestImageIfNeeded = (): void => {
  if (imageCache.size <= MAX_CACHED_IMAGES) return;
  const oldest = imageCache.keys().next().value;
  if (oldest !== undefined) imageCache.delete(oldest);
};

const byteAt = (data: Uint8ClampedArray, index: number): number => {
  const value = data[index];
  if (value === undefined) {
    throw new Error(`Missing image byte at offset ${index}`);
  }
  return value;
};

const assertRgbaImageData = (image: BenchImageData): void => {
  const expectedLength = image.width * image.height * 4;
  if (image.data.length !== expectedLength) {
    throw new Error(
      `Invalid RGBA image data for ${image.path}: expected ${expectedLength} bytes, got ${image.data.length}`,
    );
  }
};
