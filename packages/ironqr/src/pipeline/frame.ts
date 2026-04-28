import { Effect } from 'effect';
import type {
  BlobLikeImageSource,
  BrowserImageSource,
  CanvasLikeImageSource,
  ImageBitmapLikeSource,
  ImageDataLike,
  VideoFrameLikeSource,
} from '../contracts/scan.js';
import { ScannerError } from '../qr/errors.js';

const RGBA_CHANNELS = 4;
const WHITE = 255;

type Canvas2dLike = {
  drawImage(image: ImageBitmapLikeSource, dx: number, dy: number): void;
  getImageData(x: number, y: number, width: number, height: number): ImageDataLike;
};

type OffscreenCanvasConstructorLike = new (
  width: number,
  height: number,
) => {
  getContext(contextId: '2d'): Canvas2dLike | null;
};

type BrowserBitmapRuntime = {
  createImageBitmap?: (
    input: Exclude<BrowserImageSource, ImageDataLike | ImageBitmapLikeSource>,
  ) => Promise<ImageBitmapLikeSource>;
  OffscreenCanvas?: OffscreenCanvasConstructorLike;
};

/** Maximum supported image side length accepted at the public scan boundary. */
export const MAX_IMAGE_DIMENSION = 8192;
/** Maximum supported image area accepted before allocation-heavy scan work. Allows an 8192×4320 8K screen capture. */
export const MAX_IMAGE_PIXELS = 35_389_440;
/** Maximum compressed browser source size accepted before bitmap decode. */
export const MAX_IMAGE_SOURCE_BYTES = MAX_IMAGE_PIXELS * RGBA_CHANNELS;

/**
 * Cached derived views attached to a normalized image.
 *
 * The pipeline materializes expensive color-space conversions lazily and stores
 * them here so proposal generation, ranking, and decode retries can reuse the
 * same work.
 */
export interface DerivedViewCache {
  /** Lazily filled scalar-view cache keyed by view id. */
  readonly scalarViews: Map<string, unknown>;
  /** Lazily filled binary-view cache keyed by view id. */
  readonly binaryViews: Map<string, unknown>;
  /** Lazily filled polarity-free binary-plane cache keyed by scalar view and threshold. */
  readonly binaryPlanes: Map<string, unknown>;
  /** Lazily filled OKLab planes used by multiple scalar views. */
  oklab?: OklabPlanes;
}

/**
 * Canonical pixel-backed image used by the ranked proposal pipeline.
 */
export interface NormalizedImage {
  /** Image width in pixels. */
  readonly width: number;
  /** Image height in pixels. */
  readonly height: number;
  /** RGBA pixels composited exactly as provided by the caller/runtime. */
  readonly rgbaPixels: Uint8ClampedArray;
  /** Shared lazy caches for downstream derived views. */
  readonly derivedViews: DerivedViewCache;
}

/**
 * OKLab planes cached off the normalized image.
 */
export interface OklabPlanes {
  /** Frame width in pixels. */
  readonly width: number;
  /** Frame height in pixels. */
  readonly height: number;
  /** Per-pixel lightness values. */
  readonly l: Float32Array;
  /** Per-pixel a-axis values. */
  readonly a: Float32Array;
  /** Per-pixel b-axis values. */
  readonly b: Float32Array;
}

/**
 * Converts any supported image input into the pipeline's canonical image shape.
 *
 * Validation lives here at the trust boundary. Downstream stages can assume the
 * image dimensions and RGBA buffer length are already correct.
 *
 * @param input - Any supported image-like source.
 * @returns An Effect that resolves to normalized image data.
 */
export const normalizeImageInput = (
  input: BrowserImageSource,
): Effect.Effect<NormalizedImage, ScannerError> => {
  return Effect.tryPromise({
    try: async () => createNormalizedImage(await toImageData(input)),
    catch: (error) =>
      error instanceof ScannerError
        ? error
        : new ScannerError(
            'invalid_input',
            error instanceof Error
              ? error.message
              : `Failed to normalize image input: ${String(error)}`,
          ),
  });
};

/**
 * Builds a normalized image from already pixel-backed image data.
 *
 * @param imageData - Raw image pixels.
 * @returns A normalized image with empty lazy caches.
 */
export const createNormalizedImage = (imageData: ImageDataLike): NormalizedImage => {
  validateImageDataLike(imageData);
  return {
    width: imageData.width,
    height: imageData.height,
    rgbaPixels: imageData.data,
    derivedViews: {
      scalarViews: new Map(),
      binaryViews: new Map(),
      binaryPlanes: new Map(),
    },
  };
};

/**
 * Converts pixel-backed image data into OKLab planes after alpha compositing on
 * white, matching how browsers display transparent QR artwork.
 *
 * @param image - Normalized image data.
 * @returns Cached OKLab planes.
 */
export const getOklabPlanes = (image: NormalizedImage): OklabPlanes => {
  const cached = image.derivedViews.oklab;
  if (cached) return cached;

  const { width, height, rgbaPixels } = image;
  const pixelCount = width * height;
  const l = new Float32Array(pixelCount);
  const a = new Float32Array(pixelCount);
  const b = new Float32Array(pixelCount);

  for (let index = 0; index < pixelCount; index += 1) {
    const base = index * RGBA_CHANNELS;
    const alpha = (rgbaPixels[base + 3] ?? WHITE) / WHITE;
    const background = 1 - alpha;
    const sr = ((rgbaPixels[base] ?? WHITE) / WHITE) * alpha + background;
    const sg = ((rgbaPixels[base + 1] ?? WHITE) / WHITE) * alpha + background;
    const sb = ((rgbaPixels[base + 2] ?? WHITE) / WHITE) * alpha + background;

    const lr = srgbToLinear(sr);
    const lg = srgbToLinear(sg);
    const lb = srgbToLinear(sb);

    const lCone = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const mCone = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const sCone = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

    l[index] = 0.2104542553 * lCone + 0.793617785 * mCone - 0.0040720468 * sCone;
    a[index] = 1.9779984951 * lCone - 2.428592205 * mCone + 0.4505937099 * sCone;
    b[index] = 0.0259040371 * lCone + 0.7827717662 * mCone - 0.808675766 * sCone;
  }

  const planes = { width, height, l, a, b } satisfies OklabPlanes;
  image.derivedViews.oklab = planes;
  return planes;
};

/**
 * Structural runtime check for raw pixel buffers accepted by the scanner.
 *
 * @param value - Candidate image data.
 */
export const validateImageDataLike = (value: ImageDataLike): void => {
  validateImageDimensions(value.width, value.height);
  if (!(value.data instanceof Uint8ClampedArray)) {
    throw new ScannerError('invalid_input', 'Image data must be a Uint8ClampedArray.');
  }
  const expected = value.width * value.height * RGBA_CHANNELS;
  if (value.data.length !== expected) {
    throw new ScannerError(
      'invalid_input',
      `Image data length mismatch: got ${value.data.length}, expected ${expected}.`,
    );
  }
};

/**
 * Validates image dimensions before any allocation-heavy work.
 *
 * @param width - Candidate width in pixels.
 * @param height - Candidate height in pixels.
 */
export const validateImageDimensions = (width: number, height: number): void => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new ScannerError('invalid_input', 'Image width and height must be safe integers.');
  }
  if (width <= 0 || height <= 0) {
    throw new ScannerError('invalid_input', 'Image width and height must be greater than zero.');
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new ScannerError(
      'invalid_input',
      `Image dimensions must not exceed ${MAX_IMAGE_DIMENSION}px per side.`,
    );
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new ScannerError(
      'invalid_input',
      `Image area must not exceed ${MAX_IMAGE_PIXELS} pixels.`,
    );
  }
};

const isImageDataLike = (value: unknown): value is ImageDataLike => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImageDataLike>;
  return (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    candidate.data instanceof Uint8ClampedArray
  );
};

const isImageBitmapLike = (value: BrowserImageSource): value is ImageBitmapLikeSource => {
  return (
    'close' in value &&
    typeof value.close === 'function' &&
    'width' in value &&
    'height' in value &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
};

const isBlobLike = (value: BrowserImageSource): value is BlobLikeImageSource => {
  return (
    'size' in value &&
    typeof value.size === 'number' &&
    'arrayBuffer' in value &&
    typeof value.arrayBuffer === 'function'
  );
};

const hasCanvasDimensions = (value: BrowserImageSource): value is CanvasLikeImageSource => {
  return 'width' in value && 'height' in value;
};

const hasVideoFrameDimensions = (value: BrowserImageSource): value is VideoFrameLikeSource => {
  return (
    ('displayWidth' in value || 'codedWidth' in value) &&
    ('displayHeight' in value || 'codedHeight' in value)
  );
};

const preflightBrowserImageSource = (input: BrowserImageSource): void => {
  if (isBlobLike(input)) {
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new ScannerError('invalid_input', 'Browser image source size must be a safe integer.');
    }
    if (input.size > MAX_IMAGE_SOURCE_BYTES) {
      throw new ScannerError(
        'invalid_input',
        `Browser image source size must not exceed ${MAX_IMAGE_SOURCE_BYTES} bytes.`,
      );
    }
  }

  if (hasCanvasDimensions(input)) {
    validateImageDimensions(input.width, input.height);
    return;
  }

  if (hasVideoFrameDimensions(input)) {
    validateImageDimensions(
      input.displayWidth ?? input.codedWidth ?? 0,
      input.displayHeight ?? input.codedHeight ?? 0,
    );
  }
};

const toImageData = async (input: BrowserImageSource): Promise<ImageDataLike> => {
  if (isImageDataLike(input)) return input;

  preflightBrowserImageSource(input);

  const runtime = globalThis as unknown as BrowserBitmapRuntime;
  const OffscreenCanvasCtor = runtime.OffscreenCanvas;
  if (!OffscreenCanvasCtor) {
    throw new ScannerError(
      'invalid_input',
      'Browser image sources require OffscreenCanvas support.',
    );
  }

  const ownsBitmap = !isImageBitmapLike(input);
  const bitmap = ownsBitmap ? await createBitmap(input, runtime) : input;
  try {
    validateImageDimensions(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvasCtor(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new ScannerError('invalid_input', 'Failed to create a 2D canvas context.');
    }

    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    if (ownsBitmap) bitmap.close();
  }
};

const createBitmap = async (
  input: Exclude<BrowserImageSource, ImageDataLike | ImageBitmapLikeSource>,
  runtime: BrowserBitmapRuntime,
): Promise<ImageBitmapLikeSource> => {
  if (!runtime.createImageBitmap) {
    throw new ScannerError(
      'invalid_input',
      'Browser image sources require createImageBitmap support.',
    );
  }
  return runtime.createImageBitmap(input);
};

const srgbToLinear = (value: number): number => {
  if (value <= 0.04045) return value / 12.92;
  return ((value + 0.055) / 1.055) ** 2.4;
};
