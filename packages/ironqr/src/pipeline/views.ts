import type { ScanMetricsSink, ScanTimingSpanName } from '../contracts/scan.js';
import {
  getOklabPlanes,
  type NormalizedImage,
  type OklabPlanes,
  validateImageDimensions,
} from './frame.js';
import type { TraceSink } from './trace.js';

const WHITE = 255;
const SIGNED_OKLAB_SCALE = 180;
const DEFAULT_SAUVOLA_RADIUS_DIVISOR = 8;
const DEFAULT_HYBRID_RADIUS_DIVISOR = 10;
const OTSU_INITIAL_THRESHOLD = 128;
const SAUVOLA_K = 0.34;
const SAUVOLA_DYNAMIC_RANGE = 128;
const HYBRID_DEVIATION_WEIGHT = 0.08;
const HYBRID_GLOBAL_WEIGHT = 0.45;
const HYBRID_ADAPTIVE_WEIGHT = 0.55;

/**
 * Stable identifiers for scalar proposal views.
 */
export type ScalarViewId =
  | 'gray'
  | 'r'
  | 'g'
  | 'b'
  | 'oklab-l'
  | 'oklab+a'
  | 'oklab-a'
  | 'oklab+b'
  | 'oklab-b';

/**
 * Stable identifiers for threshold families.
 */
export type ThresholdMethod = 'otsu' | 'sauvola' | 'hybrid';

/**
 * Binary polarity relative to a scalar view.
 */
export type BinaryPolarity = 'normal' | 'inverted';

/**
 * Stable identifiers for binary proposal/decode views.
 */
export type BinaryViewId = `${ScalarViewId}:${ThresholdMethod}:${BinaryPolarity}`;

/**
 * A scalar image plane derived from the normalized input image.
 */
export interface ScalarView {
  /** Stable scalar view id. */
  readonly id: ScalarViewId;
  /** Frame width in pixels. */
  readonly width: number;
  /** Frame height in pixels. */
  readonly height: number;
  /** Per-pixel scalar values. */
  readonly values: Uint8Array;
  /** View family for decode-neighborhood heuristics. */
  readonly family: 'rgb' | 'oklab' | 'derived';
}

/**
 * Polarity-free threshold plane shared by normal and inverted binary views.
 *
 * Pixels are stored as bits encoded in bytes: `1` means dark and `0` means light.
 */
export interface BinaryPlane {
  /** Parent scalar view id. */
  readonly scalarViewId: ScalarViewId;
  /** Threshold method used to build the plane. */
  readonly threshold: ThresholdMethod;
  /** Frame width in pixels. */
  readonly width: number;
  /** Frame height in pixels. */
  readonly height: number;
  /** Per-pixel threshold bits where 1 is dark and 0 is light. */
  readonly data: Uint8Array;
}

/**
 * A thresholded binary view derived from a scalar image plane.
 */
export interface BinaryView {
  /** Stable binary view id. */
  readonly id: BinaryViewId;
  /** Parent scalar view id. */
  readonly scalarViewId: ScalarViewId;
  /** Threshold method used to build the view. */
  readonly threshold: ThresholdMethod;
  /** Whether dark/light are inverted when reading the shared plane. */
  readonly polarity: BinaryPolarity;
  /** Frame width in pixels. */
  readonly width: number;
  /** Frame height in pixels. */
  readonly height: number;
  /** Shared polarity-free threshold plane. */
  readonly plane: BinaryPlane;
  /** Shared threshold bits where 1 is dark before applying view polarity. */
  readonly binary: Uint8Array;
}

/**
 * Lazy scalar and binary view cache shared across the scan pipeline.
 */
export interface ViewBank {
  /** Returns one scalar view, materializing and caching it on first access. */
  getScalarView(id: ScalarViewId): ScalarView;
  /** Returns one binary view, materializing and caching it on first access. */
  getBinaryView(id: BinaryViewId): BinaryView;
  /** Returns all scalar-view ids in the default materialization order. */
  listScalarViewIds(): readonly ScalarViewId[];
  /** Returns all binary-view ids in the default materialization order. */
  listBinaryViewIds(): readonly BinaryViewId[];
  /** Returns the cheaper proposal-generation subset in priority order. */
  listProposalViewIds(): readonly BinaryViewId[];
  /** Returns decode-neighborhood ids ordered from closest to farthest. */
  getDecodeNeighborhood(id: BinaryViewId): readonly BinaryViewId[];
}

/**
 * View-bank construction options.
 */
export interface ViewBankOptions {
  /** Optional trace sink used to report view materialization. */
  readonly traceSink?: TraceSink;
  /** Optional metrics sink used to report first materialization timing. */
  readonly metricsSink?: ScanMetricsSink;
}

/**
 * Creates the ranked-pipeline view bank for a normalized image.
 *
 * @param image - Normalized input image.
 * @param options - Optional trace configuration.
 * @returns A lazy scalar/binary view cache.
 */
export const createViewBank = (image: NormalizedImage, options: ViewBankOptions = {}): ViewBank => {
  const scalarIds = [...SCALAR_VIEW_IDS] as const;
  const binaryIds = scalarIds.flatMap((scalarViewId) =>
    THRESHOLD_METHODS.flatMap((threshold) =>
      POLARITIES.map((polarity) => `${scalarViewId}:${threshold}:${polarity}` as BinaryViewId),
    ),
  );
  const proposalIds = [...PROPOSAL_VIEW_IDS] as const;

  return {
    getScalarView(id) {
      return getOrBuildScalarView(image, id, options.traceSink, options.metricsSink);
    },
    getBinaryView(id) {
      return getOrBuildBinaryView(image, id, options.traceSink, options.metricsSink);
    },
    listScalarViewIds() {
      return [...scalarIds];
    },
    listBinaryViewIds() {
      return [...binaryIds];
    },
    listProposalViewIds() {
      return [...proposalIds];
    },
    getDecodeNeighborhood(id) {
      return orderDecodeNeighborhood(id, binaryIds);
    },
  };
};

/**
 * Materializes every default scalar view eagerly.
 *
 * @param image - Normalized input image.
 * @param options - Optional trace configuration.
 * @returns All scalar views in deterministic order.
 */
export const buildScalarViews = (
  image: NormalizedImage,
  options: ViewBankOptions = {},
): readonly ScalarView[] => {
  const bank = createViewBank(image, options);
  return bank.listScalarViewIds().map((id) => bank.getScalarView(id));
};

/**
 * Materializes every default binary view eagerly.
 *
 * @param image - Normalized input image.
 * @param options - Optional trace configuration.
 * @returns All binary views in deterministic order.
 */
export const buildBinaryViews = (
  image: NormalizedImage,
  options: ViewBankOptions = {},
): readonly BinaryView[] => {
  const bank = createViewBank(image, options);
  return bank.listBinaryViewIds().map((id) => bank.getBinaryView(id));
};

/**
 * Lists every default binary-view id in deterministic materialization order.
 */
export const listDefaultBinaryViewIds = (): readonly BinaryViewId[] =>
  SCALAR_VIEW_IDS.flatMap((scalarViewId) =>
    THRESHOLD_METHODS.flatMap((threshold) =>
      POLARITIES.map((polarity) => `${scalarViewId}:${threshold}:${polarity}` as BinaryViewId),
    ),
  );

/**
 * Reads one polarity-aware binary bit from a binary view.
 *
 * @returns `1` for dark and `0` for light.
 */
export const readBinaryBit = (view: BinaryView, index: number): 0 | 1 => {
  const bit = view.plane.data[index] === 1 ? 1 : 0;
  if (view.polarity === 'normal') return bit;
  return bit === 1 ? 0 : 1;
};

/**
 * Returns whether one polarity-aware binary pixel is dark.
 */
export const isDarkPixel = (view: BinaryView, index: number): boolean =>
  readBinaryBit(view, index) === 1;

/**
 * Reads one polarity-aware binary pixel in image-export byte form.
 *
 * @returns `0` for dark and `255` for light.
 */
export const readBinaryPixel = (view: BinaryView, index: number): 0 | 255 =>
  readBinaryBit(view, index) === 1 ? 0 : 255;

/**
 * Converts a binary view to image-export byte form.
 */
export const materializeBinaryBytes = (view: BinaryView): Uint8Array => {
  const out = new Uint8Array(view.width * view.height);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = readBinaryPixel(view, index);
  }
  return out;
};

/**
 * Materializes the grayscale scalar view for a normalized image.
 *
 * @param image - Normalized input image.
 * @returns The grayscale scalar values.
 */
export const toGrayscale = (image: NormalizedImage): Uint8Array => {
  return getOrBuildScalarView(image, 'gray').values;
};

/**
 * Materializes one RGB channel as an 8-bit scalar plane.
 *
 * @param image - Normalized input image.
 * @param channel - RGB channel index.
 * @returns The channel values composited on white.
 */
export const toChannelGray = (image: NormalizedImage, channel: 0 | 1 | 2): Uint8Array => {
  if (channel === 0) return getOrBuildScalarView(image, 'r').values;
  if (channel === 1) return getOrBuildScalarView(image, 'g').values;
  return getOrBuildScalarView(image, 'b').values;
};

/**
 * Public OKLab conversion helper retained for diagnostics and tests.
 *
 * @param image - Normalized input image.
 * @returns Cached OKLab planes.
 */
export const toOklabPlanes = (image: NormalizedImage): OklabPlanes => {
  return getOklabPlanes(image);
};

/**
 * Otsu global thresholding.
 *
 * @param values - Scalar image values.
 * @param width - Image width.
 * @param height - Image height.
 * @returns Binary pixels where 0 is dark and 255 is light.
 */
export const otsuBinarize = (values: Uint8Array, width: number, height: number): Uint8Array => {
  return bitPlaneToBytes(otsuBitPlane(values, width, height));
};

/**
 * Sauvola local thresholding.
 *
 * @param values - Scalar image values.
 * @param width - Image width.
 * @param height - Image height.
 * @param radius - Half-width of the local window.
 * @returns Binary pixels where 0 is dark and 255 is light.
 */
export const sauvolaBinarize = (
  values: Uint8Array,
  width: number,
  height: number,
  radius = Math.max(8, Math.floor(Math.min(width, height) / DEFAULT_SAUVOLA_RADIUS_DIVISOR)),
): Uint8Array => {
  return bitPlaneToBytes(sauvolaBitPlane(values, width, height, radius));
};

/**
 * Hybrid thresholding that blends a global Otsu cut with local mean/variance.
 *
 * This stays intentionally simple: it is a rescue-family threshold for hard
 * photographed assets, not a whole second scanner.
 *
 * @param values - Scalar image values.
 * @param width - Image width.
 * @param height - Image height.
 * @param radius - Half-width of the local window.
 * @returns Binary pixels where 0 is dark and 255 is light.
 */
export const hybridBinarize = (
  values: Uint8Array,
  width: number,
  height: number,
  radius = Math.max(6, Math.floor(Math.min(width, height) / DEFAULT_HYBRID_RADIUS_DIVISOR)),
): Uint8Array => {
  return bitPlaneToBytes(hybridBitPlane(values, width, height, radius));
};

/**
 * Returns an inverted copy of a binary image.
 *
 * @param binary - Thresholded binary pixels.
 * @returns Inverted binary pixels.
 */
export const invertBinary = (binary: Uint8Array): Uint8Array => {
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = WHITE - (binary[index] ?? 0);
  }
  return out;
};

const SCALAR_VIEW_IDS = [
  'gray',
  'r',
  'g',
  'b',
  'oklab-l',
  'oklab+a',
  'oklab-a',
  'oklab+b',
  'oklab-b',
] satisfies readonly ScalarViewId[];
const THRESHOLD_METHODS = ['otsu', 'sauvola', 'hybrid'] satisfies readonly ThresholdMethod[];
const POLARITIES = ['normal', 'inverted'] satisfies readonly BinaryPolarity[];
/**
 * Proposal-generation fast path ordered from the current 88-asset exhaustive view-study
 * report. This is the ranked top subset, not a hand-picked family list.
 */
const PROPOSAL_VIEW_IDS = [
  'gray:otsu:normal',
  'oklab-l:hybrid:normal',
  'gray:sauvola:normal',
  'oklab-l:sauvola:normal',
  'oklab-l:otsu:normal',
  'b:hybrid:normal',
  'gray:hybrid:normal',
  'r:otsu:normal',
  'r:sauvola:normal',
  'g:sauvola:normal',
  'b:otsu:normal',
  'g:otsu:normal',
  'g:hybrid:normal',
  'b:sauvola:normal',
  'r:hybrid:normal',
  'oklab+b:hybrid:normal',
  'gray:hybrid:inverted',
  'gray:otsu:inverted',
] satisfies readonly BinaryViewId[];

const getOrBuildScalarView = (
  image: NormalizedImage,
  id: ScalarViewId,
  traceSink?: TraceSink,
  metricsSink?: ScanMetricsSink,
): ScalarView => {
  const cached = image.derivedViews.scalarViews.get(id);
  if (isScalarView(cached, id)) return cached;

  const startedAtMs = nowMs();
  const view = buildScalarView(image, id);
  image.derivedViews.scalarViews.set(id, view);
  recordTimingSpan(metricsSink, 'scalar-view', startedAtMs, {
    scalarViewId: view.id,
    width: view.width,
    height: view.height,
    family: view.family,
  });
  traceSink?.emit({
    type: 'scalar-view-built',
    scalarViewId: view.id,
    width: view.width,
    height: view.height,
    family: view.family,
  });
  return view;
};

const getOrBuildBinaryView = (
  image: NormalizedImage,
  id: BinaryViewId,
  traceSink?: TraceSink,
  metricsSink?: ScanMetricsSink,
): BinaryView => {
  const cached = image.derivedViews.binaryViews.get(id);
  if (isBinaryView(cached, id)) return cached;

  const startedAtMs = nowMs();
  const [scalarViewId, threshold, polarity] = parseBinaryViewId(id);
  const plane = getOrBuildBinaryPlane(image, scalarViewId, threshold, traceSink, metricsSink);
  const view = {
    id,
    scalarViewId,
    threshold,
    polarity,
    width: plane.width,
    height: plane.height,
    plane,
    binary: plane.data,
  } satisfies BinaryView;

  image.derivedViews.binaryViews.set(id, view);
  recordTimingSpan(metricsSink, 'binary-view', startedAtMs, {
    binaryViewId: view.id,
    scalarViewId: view.scalarViewId,
    threshold: view.threshold,
    polarity: view.polarity,
    width: view.width,
    height: view.height,
  });
  traceSink?.emit({
    type: 'binary-view-built',
    binaryViewId: view.id,
    scalarViewId: view.scalarViewId,
    threshold: view.threshold,
    polarity: view.polarity,
    width: view.width,
    height: view.height,
  });
  return view;
};

const getOrBuildBinaryPlane = (
  image: NormalizedImage,
  scalarViewId: ScalarViewId,
  threshold: ThresholdMethod,
  traceSink?: TraceSink,
  metricsSink?: ScanMetricsSink,
): BinaryPlane => {
  const key = binaryPlaneKey(scalarViewId, threshold);
  const cached = image.derivedViews.binaryPlanes.get(key);
  if (isBinaryPlane(cached, scalarViewId, threshold)) return cached;

  const scalarView = getOrBuildScalarView(image, scalarViewId, traceSink, metricsSink);
  const data =
    threshold === 'otsu'
      ? otsuBitPlane(scalarView.values, scalarView.width, scalarView.height)
      : threshold === 'sauvola'
        ? sauvolaBitPlane(scalarView.values, scalarView.width, scalarView.height)
        : hybridBitPlane(scalarView.values, scalarView.width, scalarView.height);
  const plane = {
    scalarViewId,
    threshold,
    width: scalarView.width,
    height: scalarView.height,
    data,
  } satisfies BinaryPlane;
  image.derivedViews.binaryPlanes.set(key, plane);
  return plane;
};

const buildScalarView = (image: NormalizedImage, id: ScalarViewId): ScalarView => {
  const { width, height, rgbaPixels } = image;
  const pixelCount = width * height;

  if (id === 'gray' || id === 'r' || id === 'g' || id === 'b') {
    const values = new Uint8Array(pixelCount);
    for (let index = 0; index < pixelCount; index += 1) {
      const base = index * 4;
      const alpha = (rgbaPixels[base + 3] ?? WHITE) / WHITE;
      const background = 1 - alpha;
      const r = ((rgbaPixels[base] ?? WHITE) / WHITE) * alpha + background;
      const g = ((rgbaPixels[base + 1] ?? WHITE) / WHITE) * alpha + background;
      const b = ((rgbaPixels[base + 2] ?? WHITE) / WHITE) * alpha + background;
      if (id === 'gray') {
        values[index] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * WHITE);
      } else if (id === 'r') {
        values[index] = Math.round(r * WHITE);
      } else if (id === 'g') {
        values[index] = Math.round(g * WHITE);
      } else {
        values[index] = Math.round(b * WHITE);
      }
    }

    return {
      id,
      width,
      height,
      values,
      family: id === 'gray' ? 'derived' : 'rgb',
    } satisfies ScalarView;
  }

  const planes = getOklabPlanes(image);
  const values = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    values[index] = encodeOklabValue(id, planes, index);
  }

  return {
    id,
    width,
    height,
    values,
    family: 'oklab',
  } satisfies ScalarView;
};

const encodeOklabValue = (id: ScalarViewId, planes: OklabPlanes, index: number): number => {
  if (id === 'oklab-l') return clampByte((planes.l[index] ?? 0) * WHITE);
  if (id === 'oklab+a') return clampByte(128 + (planes.a[index] ?? 0) * SIGNED_OKLAB_SCALE);
  if (id === 'oklab-a') return clampByte(128 - (planes.a[index] ?? 0) * SIGNED_OKLAB_SCALE);
  if (id === 'oklab+b') return clampByte(128 + (planes.b[index] ?? 0) * SIGNED_OKLAB_SCALE);
  return clampByte(128 - (planes.b[index] ?? 0) * SIGNED_OKLAB_SCALE);
};

const recordTimingSpan = (
  metricsSink: ScanMetricsSink | undefined,
  name: ScanTimingSpanName,
  startedAtMs: number,
  metadata: Record<string, unknown>,
): void => {
  metricsSink?.record({ name, startedAtMs, durationMs: nowMs() - startedAtMs, metadata });
};

const nowMs = (): number => performance.now();

const parseBinaryViewId = (id: BinaryViewId): [ScalarViewId, ThresholdMethod, BinaryPolarity] => {
  const [scalarViewId, threshold, polarity, extra] = id.split(':');
  if (
    extra !== undefined ||
    scalarViewId === undefined ||
    threshold === undefined ||
    polarity === undefined
  ) {
    throw new RangeError(`Invalid binary view id: ${id}.`);
  }
  if (!isScalarViewId(scalarViewId) || !isThresholdMethod(threshold) || !isPolarity(polarity)) {
    throw new RangeError(`Invalid binary view id: ${id}.`);
  }
  return [scalarViewId, threshold, polarity];
};

const orderDecodeNeighborhood = (
  id: BinaryViewId,
  binaryIds: readonly BinaryViewId[],
): readonly BinaryViewId[] => {
  const [scalarViewId, threshold, polarity] = parseBinaryViewId(id);
  return [...binaryIds].sort((left, right) => {
    const leftScore = decodeNeighborhoodDistance(id, scalarViewId, threshold, polarity, left);
    const rightScore = decodeNeighborhoodDistance(id, scalarViewId, threshold, polarity, right);
    if (leftScore !== rightScore) return leftScore - rightScore;
    return left.localeCompare(right);
  });
};

const decodeNeighborhoodDistance = (
  originalId: BinaryViewId,
  scalarViewId: ScalarViewId,
  threshold: ThresholdMethod,
  polarity: BinaryPolarity,
  candidateId: BinaryViewId,
): number => {
  if (candidateId === originalId) return 0;
  const [candidateScalar, candidateThreshold, candidatePolarity] = parseBinaryViewId(candidateId);
  if (candidateScalar === scalarViewId && candidatePolarity === polarity) return 1;
  if (candidateScalar === scalarViewId) return 2;
  if (
    scalarFamily(candidateScalar) === scalarFamily(scalarViewId) &&
    candidatePolarity === polarity
  )
    return 3;
  if (candidateThreshold === threshold && candidatePolarity === polarity) return 4;
  if (scalarFamily(candidateScalar) === scalarFamily(scalarViewId)) return 5;
  return 6;
};

const scalarFamily = (id: ScalarViewId): 'rgb' | 'oklab' | 'derived' => {
  if (id === 'gray') return 'derived';
  if (id === 'r' || id === 'g' || id === 'b') return 'rgb';
  return 'oklab';
};

const binaryPlaneKey = (scalarViewId: ScalarViewId, threshold: ThresholdMethod): string =>
  `${scalarViewId}:${threshold}`;

const otsuBitPlane = (values: Uint8Array, width: number, height: number): Uint8Array => {
  assertPlaneLength(values.length, width, height, 'otsuBinarize');
  return thresholdBitPlane(values, otsuThreshold(values));
};

const sauvolaBitPlane = (
  values: Uint8Array,
  width: number,
  height: number,
  radius = Math.max(8, Math.floor(Math.min(width, height) / DEFAULT_SAUVOLA_RADIUS_DIVISOR)),
): Uint8Array => {
  assertPlaneLength(values.length, width, height, 'sauvolaBinarize');
  const { sum, sumSq, stride } = buildIntegralImages(values, width, height);
  const out = new Uint8Array(values.length);

  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const area = (right - left) * (bottom - top);
      const localSum = rectSum(sum, stride, left, top, right, bottom);
      const localSumSq = rectSum(sumSq, stride, left, top, right, bottom);
      const mean = localSum / area;
      const variance = Math.max(0, localSumSq / area - mean * mean);
      const deviation = Math.sqrt(variance);
      const threshold = mean * (1 + SAUVOLA_K * (deviation / SAUVOLA_DYNAMIC_RANGE - 1));
      out[y * width + x] = (values[y * width + x] ?? 0) > threshold ? 0 : 1;
    }
  }

  return out;
};

const hybridBitPlane = (
  values: Uint8Array,
  width: number,
  height: number,
  radius = Math.max(6, Math.floor(Math.min(width, height) / DEFAULT_HYBRID_RADIUS_DIVISOR)),
): Uint8Array => {
  assertPlaneLength(values.length, width, height, 'hybridBinarize');
  const global = otsuThreshold(values);
  const { sum, sumSq, stride } = buildIntegralImages(values, width, height);
  const out = new Uint8Array(values.length);

  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const area = (right - left) * (bottom - top);
      const localSum = rectSum(sum, stride, left, top, right, bottom);
      const localSumSq = rectSum(sumSq, stride, left, top, right, bottom);
      const mean = localSum / area;
      const variance = Math.max(0, localSumSq / area - mean * mean);
      const deviation = Math.sqrt(variance);
      const adaptive = mean - deviation * HYBRID_DEVIATION_WEIGHT;
      const threshold = global * HYBRID_GLOBAL_WEIGHT + adaptive * HYBRID_ADAPTIVE_WEIGHT;
      out[y * width + x] = (values[y * width + x] ?? 0) > threshold ? 0 : 1;
    }
  }

  return out;
};

const thresholdBitPlane = (values: Uint8Array, threshold: number): Uint8Array => {
  const out = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    out[index] = (values[index] ?? 0) > threshold ? 0 : 1;
  }
  return out;
};

const bitPlaneToBytes = (bits: Uint8Array): Uint8Array => {
  const out = new Uint8Array(bits.length);
  for (let index = 0; index < bits.length; index += 1) {
    out[index] = bits[index] === 1 ? 0 : WHITE;
  }
  return out;
};

const otsuThreshold = (values: Uint8Array): number => {
  const histogram = new Array<number>(256).fill(0);
  for (let index = 0; index < values.length; index += 1) {
    const bucket = values[index] ?? 0;
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }

  let totalWeighted = 0;
  for (let value = 0; value < 256; value += 1) {
    totalWeighted += value * (histogram[value] ?? 0);
  }

  let bestThreshold = OTSU_INITIAL_THRESHOLD;
  let bestVariance = -1;
  let backgroundWeight = 0;
  let backgroundWeighted = 0;
  for (let threshold = 0; threshold < 256; threshold += 1) {
    backgroundWeight += histogram[threshold] ?? 0;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = values.length - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundWeighted += threshold * (histogram[threshold] ?? 0);
    const meanBackground = backgroundWeighted / backgroundWeight;
    const meanForeground = (totalWeighted - backgroundWeighted) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
};

const buildIntegralImages = (values: Uint8Array, width: number, height: number) => {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const sumSq = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < width; x += 1) {
      const value = values[y * width + x] ?? 0;
      rowSum += value;
      rowSumSq += value * value;
      const index = (y + 1) * stride + (x + 1);
      sum[index] = (sum[y * stride + (x + 1)] ?? 0) + rowSum;
      sumSq[index] = (sumSq[y * stride + (x + 1)] ?? 0) + rowSumSq;
    }
  }
  return { sum, sumSq, stride };
};

const rectSum = (
  table: Float64Array,
  stride: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number => {
  return (
    (table[bottom * stride + right] ?? 0) -
    (table[top * stride + right] ?? 0) -
    (table[bottom * stride + left] ?? 0) +
    (table[top * stride + left] ?? 0)
  );
};

const clampByte = (value: number): number => {
  return Math.max(0, Math.min(255, Math.round(value)));
};

const isScalarView = (value: unknown, id: ScalarViewId): value is ScalarView => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ScalarView>;
  return candidate.id === id && candidate.values instanceof Uint8Array;
};

const isBinaryView = (value: unknown, id: BinaryViewId): value is BinaryView => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BinaryView>;
  return (
    candidate.id === id &&
    candidate.plane !== undefined &&
    isBinaryPlane(candidate.plane, candidate.scalarViewId, candidate.threshold) &&
    candidate.binary === candidate.plane.data
  );
};

const isBinaryPlane = (
  value: unknown,
  scalarViewId: unknown,
  threshold: unknown,
): value is BinaryPlane => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BinaryPlane>;
  return (
    candidate.scalarViewId === scalarViewId &&
    candidate.threshold === threshold &&
    candidate.data instanceof Uint8Array
  );
};

const isScalarViewId = (value: string): value is ScalarViewId => {
  return (SCALAR_VIEW_IDS as readonly string[]).includes(value);
};

const isThresholdMethod = (value: string): value is ThresholdMethod => {
  return (THRESHOLD_METHODS as readonly string[]).includes(value);
};

const isPolarity = (value: string): value is BinaryPolarity => {
  return (POLARITIES as readonly string[]).includes(value);
};

const assertPlaneLength = (actual: number, width: number, height: number, caller: string): void => {
  validateImageDimensions(width, height);
  const expected = width * height;
  if (actual !== expected) {
    throw new RangeError(`${caller}: expected plane length ${expected}, got ${actual}.`);
  }
};
