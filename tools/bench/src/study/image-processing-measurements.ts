import {
  createNormalizedImage,
  getOklabPlanes,
} from '../../../../packages/ironqr/src/pipeline/frame.js';
import type { BinaryView } from '../../../../packages/ironqr/src/pipeline/views.js';

const WHITE = 255;

export interface BinaryViewSignal {
  readonly binaryViewId: string;
  readonly scalarViewId: string;
  readonly threshold: string;
  readonly polarity: string;
  readonly durationMs: number;
  readonly darkRatio: number;
  readonly horizontalTransitionDensity: number;
  readonly verticalTransitionDensity: number;
  readonly horizontalRunCount: number;
  readonly verticalRunCount: number;
}

export interface ScalarStatsMeasurement {
  readonly scalarViewId: string;
  readonly histogramMs: number;
  readonly otsuMs: number;
  readonly integralMs: number;
  readonly integralBytes: number;
  readonly otsuThreshold: number;
}

export interface ScalarFusionMeasurement {
  readonly rgbFamilyMs: number;
  readonly oklabFamilyMs: number;
  readonly rgbPlaneBytes: number;
  readonly oklabPlaneBytes: number;
}

export interface SharedArtifactMeasurement {
  readonly planeCount: number;
  readonly polarityViewCount: number;
  readonly shareableRunSignalMs: number;
  readonly perPolarityRunSignalMs: number;
  readonly estimatedSavedMs: number;
}

export const measureBinarySignals = (view: BinaryView): BinaryViewSignal => {
  const startedAt = performance.now();
  const { scalarViewId, threshold, polarity, width, height } = view;
  const data = view.plane.data;
  const invert = polarity === 'inverted' ? 1 : 0;
  let darkCount = 0;
  let horizontalTransitions = 0;
  let verticalTransitions = 0;
  let horizontalRunCount = 0;
  let verticalRunCount = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const bit = (data[index] ?? 0) ^ invert;
      darkCount += bit;
      if (x === 0) horizontalRunCount += 1;
      else {
        const left = (data[index - 1] ?? 0) ^ invert;
        if (left !== bit) {
          horizontalTransitions += 1;
          horizontalRunCount += 1;
        }
      }
      if (y === 0) verticalRunCount += 1;
      else {
        const up = (data[index - width] ?? 0) ^ invert;
        if (up !== bit) {
          verticalTransitions += 1;
          verticalRunCount += 1;
        }
      }
    }
  }

  const pixelCount = Math.max(1, width * height);
  return {
    binaryViewId: view.id,
    scalarViewId,
    threshold,
    polarity,
    durationMs: round(performance.now() - startedAt),
    darkRatio: roundRatio(darkCount / pixelCount),
    horizontalTransitionDensity: roundRatio(
      horizontalTransitions / Math.max(1, height * Math.max(1, width - 1)),
    ),
    verticalTransitionDensity: roundRatio(
      verticalTransitions / Math.max(1, width * Math.max(1, height - 1)),
    ),
    horizontalRunCount,
    verticalRunCount,
  };
};

export const measureScalarStats = (
  scalarViewId: string,
  values: Uint8Array,
  width: number,
  height: number,
): ScalarStatsMeasurement => {
  const histogramStartedAt = performance.now();
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value] = (histogram[value] ?? 0) + 1;
  const histogramMs = round(performance.now() - histogramStartedAt);

  const otsuStartedAt = performance.now();
  const threshold = otsuThresholdFromHistogram(histogram, values.length);
  const otsuMs = round(performance.now() - otsuStartedAt);

  const integralStartedAt = performance.now();
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
  const integralMs = round(performance.now() - integralStartedAt);

  return {
    scalarViewId,
    histogramMs,
    otsuMs,
    integralMs,
    integralBytes: sum.byteLength + sumSq.byteLength,
    otsuThreshold: threshold,
  };
};

export const measureScalarFusion = (image: {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}): ScalarFusionMeasurement => {
  const pixelCount = image.width * image.height;
  const rgbStartedAt = performance.now();
  const gray = new Uint8Array(pixelCount);
  const rPlane = new Uint8Array(pixelCount);
  const gPlane = new Uint8Array(pixelCount);
  const bPlane = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const base = index * 4;
    const alpha = (image.data[base + 3] ?? WHITE) / WHITE;
    const background = 1 - alpha;
    const r = ((image.data[base] ?? WHITE) / WHITE) * alpha + background;
    const g = ((image.data[base + 1] ?? WHITE) / WHITE) * alpha + background;
    const b = ((image.data[base + 2] ?? WHITE) / WHITE) * alpha + background;
    rPlane[index] = Math.round(r * WHITE);
    gPlane[index] = Math.round(g * WHITE);
    bPlane[index] = Math.round(b * WHITE);
    gray[index] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * WHITE);
  }
  const rgbFamilyMs = round(performance.now() - rgbStartedAt);

  const oklabStartedAt = performance.now();
  const normalized = createNormalizedImage(image);
  const planes = getOklabPlanes(normalized);
  const oklabL = new Uint8Array(pixelCount);
  const oklabPlusA = new Uint8Array(pixelCount);
  const oklabMinusA = new Uint8Array(pixelCount);
  const oklabPlusB = new Uint8Array(pixelCount);
  const oklabMinusB = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const l = planes.l[index] ?? 0;
    const a = planes.a[index] ?? 0;
    const b = planes.b[index] ?? 0;
    oklabL[index] = clampByte(l * WHITE);
    oklabPlusA[index] = clampByte(128 + a * 180);
    oklabMinusA[index] = clampByte(128 - a * 180);
    oklabPlusB[index] = clampByte(128 + b * 180);
    oklabMinusB[index] = clampByte(128 - b * 180);
  }
  const oklabFamilyMs = round(performance.now() - oklabStartedAt);

  return {
    rgbFamilyMs,
    oklabFamilyMs,
    rgbPlaneBytes: gray.byteLength + rPlane.byteLength + gPlane.byteLength + bPlane.byteLength,
    oklabPlaneBytes:
      oklabL.byteLength +
      oklabPlusA.byteLength +
      oklabMinusA.byteLength +
      oklabPlusB.byteLength +
      oklabMinusB.byteLength,
  };
};

export const emptyScalarFusionMeasurement = (): ScalarFusionMeasurement => ({
  rgbFamilyMs: 0,
  oklabFamilyMs: 0,
  rgbPlaneBytes: 0,
  oklabPlaneBytes: 0,
});

export const emptySharedArtifactMeasurement = (): SharedArtifactMeasurement => ({
  planeCount: 0,
  polarityViewCount: 0,
  shareableRunSignalMs: 0,
  perPolarityRunSignalMs: 0,
  estimatedSavedMs: 0,
});

export const summarizeSharedArtifacts = (
  signals: readonly BinaryViewSignal[],
): SharedArtifactMeasurement => {
  const planeIds = new Set(signals.map((signal) => `${signal.scalarViewId}:${signal.threshold}`));
  const fastestPerPlane = new Map<string, number>();
  for (const signal of signals) {
    const key = `${signal.scalarViewId}:${signal.threshold}`;
    fastestPerPlane.set(
      key,
      Math.min(fastestPerPlane.get(key) ?? Number.POSITIVE_INFINITY, signal.durationMs),
    );
  }
  const shareableRunSignalMs = round(
    [...fastestPerPlane.values()].reduce((sum, value) => sum + value, 0),
  );
  const perPolarityRunSignalMs = round(signals.reduce((sum, signal) => sum + signal.durationMs, 0));
  return {
    planeCount: planeIds.size,
    polarityViewCount: signals.length,
    shareableRunSignalMs,
    perPolarityRunSignalMs,
    estimatedSavedMs: round(Math.max(0, perPolarityRunSignalMs - shareableRunSignalMs)),
  };
};

const otsuThresholdFromHistogram = (histogram: Uint32Array, total: number): number => {
  let sum = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    sum += index * (histogram[index] ?? 0);
  }
  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    weightBackground += histogram[index] ?? 0;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += index * (histogram[index] ?? 0);
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = index;
    }
  }
  return threshold;
};

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
const round = (value: number): number => Math.round(value * 100) / 100;
const roundRatio = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
