import sharp from 'sharp';

export interface ScanImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace: 'srgb' | 'display-p3';
}

export const buildLuminanceBuffer = (image: ScanImageData): Uint8ClampedArray => {
  const pixels = image.width * image.height;
  const luminance = new Uint8ClampedArray(pixels);

  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    luminance[index] = Math.round((red + green * 2 + blue) / 4);
  }

  return luminance;
};

export const invertLuminanceBuffer = (luminance: Uint8ClampedArray): Uint8ClampedArray => {
  const inverted = new Uint8ClampedArray(luminance.length);
  for (let index = 0; index < luminance.length; index += 1) {
    inverted[index] = 255 - (luminance[index] ?? 0);
  }
  return inverted;
};

export const cloneRgbaBuffer = (data: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> => {
  const cloned = new Uint8ClampedArray(new ArrayBuffer(data.length));
  cloned.set(data);
  return cloned;
};

export const readImageData = async (imagePath: string): Promise<ScanImageData> => {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
    colorSpace: 'srgb',
  };
};
