import { type ScanTimingSpan, scanFrame } from '../../../../packages/ironqr/src/index.js';
import type {
  BinaryViewId,
  createViewBank,
} from '../../../../packages/ironqr/src/pipeline/views.js';
import { readBinaryPixel } from '../../../../packages/ironqr/src/pipeline/views.js';
import { normalizeDecodedText } from '../shared/text.js';
import type {
  BinaryReadMeasurement,
  DecodeMeasurement,
  ImageProcessingTimingSummary,
} from './image-processing-types.js';

const EXHAUSTIVE_SCAN_CEILING = 10_000;

export const measureBinaryReadVariants = async (
  viewBank: ReturnType<typeof createViewBank>,
  viewIds: readonly BinaryViewId[],
  assetId: string,
  log: (message: string) => void,
  yieldToDashboard: () => Promise<void>,
): Promise<BinaryReadMeasurement> => {
  let byteReaderMs = 0;
  let directBitReaderMs = 0;
  let byteDarkCount = 0;
  let directDarkCount = 0;
  let pixelReads = 0;

  for (const viewId of viewIds) {
    const view = viewBank.getBinaryView(viewId);
    const byteStartedAt = performance.now();
    for (let index = 0; index < view.plane.data.length; index += 1) {
      if (readBinaryPixel(view, index) === 0) byteDarkCount += 1;
    }
    byteReaderMs += performance.now() - byteStartedAt;

    const directStartedAt = performance.now();
    const invert = view.polarity === 'inverted' ? 1 : 0;
    for (let index = 0; index < view.plane.data.length; index += 1) {
      directDarkCount += (view.plane.data[index] ?? 0) ^ invert;
    }
    directBitReaderMs += performance.now() - directStartedAt;
    pixelReads += view.plane.data.length;
    log(`${assetId}: binary read polarity variant ${viewId}`);
    await yieldToDashboard();
  }

  const deltaMs = byteReaderMs - directBitReaderMs;
  return {
    byteReaderMs: round(byteReaderMs),
    directBitReaderMs: round(directBitReaderMs),
    deltaMs: round(deltaMs),
    improvementPct: percent(deltaMs, byteReaderMs),
    pixelReads,
    countsEqual: byteDarkCount === directDarkCount,
  };
};

export const runDecodeMeasurement = async (
  image: Parameters<typeof scanFrame>[0],
  viewIds: readonly BinaryViewId[],
  asset: { readonly id: string },
  log: (message: string) => void,
): Promise<DecodeMeasurement & { readonly decodedTexts: readonly string[] }> => {
  const spans: ScanTimingSpan[] = [];
  const startedAt = performance.now();
  log(`${asset.id}: running decode scanner for module-sampling evidence`);
  const results = await scanFrame(image, {
    allowMultiple: true,
    maxProposals: EXHAUSTIVE_SCAN_CEILING,
    maxClusterRepresentatives: EXHAUSTIVE_SCAN_CEILING,
    maxClusterStructuralFailures: EXHAUSTIVE_SCAN_CEILING,
    continueAfterDecode: true,
    proposalViewIds: viewIds,
    metricsSink: { record: (span: ScanTimingSpan) => spans.push(span) },
  });
  const decodedTexts = uniqueTexts(
    results.map((result) => normalizeDecodedText(result.payload.text)).filter(Boolean),
  );
  return {
    scanDurationMs: round(performance.now() - startedAt),
    moduleSamplingMs: sumSpans(spans, 'module-sampling'),
    sampledModuleCount: spans
      .filter((span) => span.name === 'module-sampling')
      .reduce((sum, span) => sum + numberMetadata(span.metadata?.moduleCount), 0),
    decodeAttemptMs: sumSpans(spans, 'decode-attempt'),
    decodeCascadeMs: sumSpans(spans, 'decode-cascade'),
    decodedTexts,
  };
};

export const stripDecodedTexts = (
  decode: DecodeMeasurement & { readonly decodedTexts: readonly string[] },
): DecodeMeasurement => ({
  scanDurationMs: decode.scanDurationMs,
  moduleSamplingMs: decode.moduleSamplingMs,
  sampledModuleCount: decode.sampledModuleCount,
  decodeAttemptMs: decode.decodeAttemptMs,
  decodeCascadeMs: decode.decodeCascadeMs,
});

export const summarizeTimingSpans = (
  spans: readonly ScanTimingSpan[],
): ImageProcessingTimingSummary => ({
  scalarViewMs: sumSpans(spans, 'scalar-view'),
  binaryPlaneMs: sumSpans(spans, 'binary-plane'),
  binaryViewMs: sumSpans(spans, 'binary-view'),
  proposalViewMs: sumSpans(spans, 'proposal-view'),
  moduleSamplingMs: sumSpans(spans, 'module-sampling'),
  decodeAttemptMs: sumSpans(spans, 'decode-attempt'),
  decodeCascadeMs: sumSpans(spans, 'decode-cascade'),
});

const sumSpans = (spans: readonly ScanTimingSpan[], name: ScanTimingSpan['name']): number =>
  round(spans.filter((span) => span.name === name).reduce((sum, span) => sum + span.durationMs, 0));

const numberMetadata = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const uniqueTexts = (values: readonly string[]): readonly string[] => [...new Set(values)];
const round = (value: number): number => Math.round(value * 100) / 100;
const percent = (delta: number, baseline: number): number =>
  baseline === 0 ? 0 : round((delta / baseline) * 100);
