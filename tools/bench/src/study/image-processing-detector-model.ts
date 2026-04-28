import type { FinderEvidence } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import type {
  DetectorFamilyOverlapMeasurement,
  DetectorUnitMeasurement,
  DetectorVariantMeasurement,
  VariantCacheMeasurement,
} from './image-processing-types.js';

export const compareDetectorVariant = (
  id: string,
  area: DetectorVariantMeasurement['area'],
  controlSignature: readonly string[],
  measurement: VariantCacheMeasurement,
  note: string,
): DetectorVariantMeasurement => {
  const outputsEqual = signaturesEqual(controlSignature, measurement.signature);
  const schedulerWaitMs = measurement.schedulerWaitMs ?? 0;
  return {
    id,
    area,
    durationMs: measurement.durationMs,
    outputCount: measurement.outputCount,
    outputsEqual,
    mismatchCount: outputsEqual ? 0 : 1,
    note,
    schedulerWaitMs,
    samples: [measurement.durationMs],
    schedulerWaitSamples: [schedulerWaitMs],
    queuedSamples: [measurement.durationMs + schedulerWaitMs],
  };
};

export const detectorTimingMeasurement = (
  durationMs: number,
  outputCount: number,
): VariantCacheMeasurement => ({
  durationMs: round(durationMs),
  outputCount,
  signature: [],
});

export const detectorUnit = (
  id: string,
  variantId: string,
  area: DetectorUnitMeasurement['area'],
  measurement: VariantCacheMeasurement,
  cached: boolean,
  outputsEqual: boolean,
): DetectorUnitMeasurement => ({
  id,
  variantId,
  area,
  durationMs: measurement.durationMs,
  outputCount: measurement.outputCount,
  outputsEqual,
  mismatchCount: outputsEqual ? 0 : 1,
  cached,
  schedulerWaitMs: measurement.schedulerWaitMs ?? 0,
});

export const finderSignature = (evidence: readonly FinderEvidence[]): readonly string[] =>
  evidence
    .map((entry) =>
      [
        entry.source,
        entry.centerX.toFixed(2),
        entry.centerY.toFixed(2),
        entry.moduleSize.toFixed(3),
        entry.hModuleSize.toFixed(3),
        entry.vModuleSize.toFixed(3),
        (entry.score ?? 0).toFixed(3),
      ].join(':'),
    )
    .sort();

export const parseFinderSignature = (signature: readonly string[]): FinderEvidence[] =>
  signature.flatMap((entry) => {
    const [source, centerX, centerY, moduleSize, hModuleSize, vModuleSize, score] =
      entry.split(':');
    if (source !== 'row-scan' && source !== 'flood' && source !== 'matcher' && source !== 'quad') {
      return [];
    }
    return [
      {
        source,
        centerX: Number(centerX),
        centerY: Number(centerY),
        moduleSize: Number(moduleSize),
        hModuleSize: Number(hModuleSize),
        vModuleSize: Number(vModuleSize),
        score: Number(score),
      },
    ];
  });

export const countSignatureSource = (
  signature: readonly string[],
  source: FinderEvidence['source'],
): number => signature.filter((entry) => entry.startsWith(`${source}:`)).length;

export const summarizeFloodOverlap = (
  flood: readonly FinderEvidence[],
  rowScan: readonly FinderEvidence[],
  matcher: readonly FinderEvidence[],
): Pick<
  DetectorFamilyOverlapMeasurement,
  | 'floodOverlapsRowScanCount'
  | 'floodOverlapsMatcherCount'
  | 'floodOverlapsBothCount'
  | 'floodOverlapsNeitherCount'
> => {
  let floodOverlapsRowScanCount = 0;
  let floodOverlapsMatcherCount = 0;
  let floodOverlapsBothCount = 0;
  let floodOverlapsNeitherCount = 0;
  for (const entry of flood) {
    const overlapsRowScan = overlapsAnyFinder(entry, rowScan);
    const overlapsMatcher = overlapsAnyFinder(entry, matcher);
    if (overlapsRowScan) floodOverlapsRowScanCount += 1;
    if (overlapsMatcher) floodOverlapsMatcherCount += 1;
    if (overlapsRowScan && overlapsMatcher) floodOverlapsBothCount += 1;
    if (!overlapsRowScan && !overlapsMatcher) floodOverlapsNeitherCount += 1;
  }
  return {
    floodOverlapsRowScanCount,
    floodOverlapsMatcherCount,
    floodOverlapsBothCount,
    floodOverlapsNeitherCount,
  };
};

export const countOverlappingFinders = (
  entries: readonly FinderEvidence[],
  candidates: readonly FinderEvidence[],
): number => entries.filter((entry) => overlapsAnyFinder(entry, candidates)).length;

export const mergeDetectorVariant = (
  variants: Map<string, DetectorVariantMeasurement>,
  next: DetectorVariantMeasurement,
): void => {
  const current = variants.get(next.id);
  if (!current) {
    variants.set(next.id, next);
    return;
  }
  variants.set(next.id, {
    ...next,
    durationMs: round(current.durationMs + next.durationMs),
    outputCount: current.outputCount + next.outputCount,
    outputsEqual: current.outputsEqual && next.outputsEqual,
    mismatchCount: current.mismatchCount + next.mismatchCount,
    schedulerWaitMs: round(current.schedulerWaitMs + next.schedulerWaitMs),
    samples: [...current.samples, ...next.samples],
    schedulerWaitSamples: [...current.schedulerWaitSamples, ...next.schedulerWaitSamples],
    queuedSamples: [...current.queuedSamples, ...next.queuedSamples],
  });
};

const signaturesEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const overlapsAnyFinder = (entry: FinderEvidence, candidates: readonly FinderEvidence[]): boolean =>
  candidates.some((candidate) => findersOverlap(entry, candidate));

const findersOverlap = (left: FinderEvidence, right: FinderEvidence): boolean =>
  distancePoint(left.centerX, left.centerY, right.centerX, right.centerY) <
  Math.max(2, Math.min(left.moduleSize, right.moduleSize) * 2.2);

const distancePoint = (x0: number, y0: number, x1: number, y1: number): number =>
  Math.hypot(x0 - x1, y0 - y1);

const round = (value: number): number => Math.round(value * 100) / 100;
