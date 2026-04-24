import * as S from 'effect/Schema';
import { BoundsSchema, CornerSetSchema } from './geometry.js';

export const PayloadKindSchema = S.Literals([
  'text',
  'url',
  'email',
  'sms',
  'wifi',
  'contact',
  'calendar',
  'binary',
  'unknown',
]);
export type PayloadKind = S.Schema.Type<typeof PayloadKindSchema>;

export const ErrorCorrectionLevelSchema = S.Literals(['L', 'M', 'Q', 'H']);
export type ErrorCorrectionLevel = S.Schema.Type<typeof ErrorCorrectionLevelSchema>;

export const ScannerErrorCodeSchema = S.Literals([
  'not_implemented',
  'invalid_input',
  'decode_failed',
  'internal_error',
]);
export type ScannerErrorCode = S.Schema.Type<typeof ScannerErrorCodeSchema>;

export const ScannerErrorSchema = S.Struct({
  name: S.Literal('ScannerError'),
  code: ScannerErrorCodeSchema,
  message: S.String,
});
export type ScannerErrorShape = S.Schema.Type<typeof ScannerErrorSchema>;

export const ScanPathMetadataLevelSchema = S.Literals(['none', 'basic', 'full']);
export type ScanPathMetadataLevel = S.Schema.Type<typeof ScanPathMetadataLevelSchema>;

export const ScanAttemptMetadataLevelSchema = S.Literals(['none', 'summary', 'full']);
export type ScanAttemptMetadataLevel = S.Schema.Type<typeof ScanAttemptMetadataLevelSchema>;

export const ScanViewMetadataLevelSchema = S.Literals(['none', 'summary']);
export type ScanViewMetadataLevel = S.Schema.Type<typeof ScanViewMetadataLevelSchema>;

export const ScanFailureMetadataLevelSchema = S.Literals(['none', 'summary']);
export type ScanFailureMetadataLevel = S.Schema.Type<typeof ScanFailureMetadataLevelSchema>;

export const ScanProposalMetadataLevelSchema = S.Literals(['none', 'summary']);
export type ScanProposalMetadataLevel = S.Schema.Type<typeof ScanProposalMetadataLevelSchema>;

export const ScanTimingMetadataLevelSchema = S.Literals(['none', 'summary', 'full']);
export type ScanTimingMetadataLevel = S.Schema.Type<typeof ScanTimingMetadataLevelSchema>;

export const ScanTraceEventsLevelSchema = S.Literals(['off', 'summary', 'full']);
export type ScanTraceEventsLevel = S.Schema.Type<typeof ScanTraceEventsLevelSchema>;

export const ScanObservabilityResultSchema = S.Struct({
  path: S.optional(ScanPathMetadataLevelSchema),
  attempts: S.optional(ScanAttemptMetadataLevelSchema),
});
export type ScanObservabilityResult = S.Schema.Type<typeof ScanObservabilityResultSchema>;

export const ScanObservabilityScanSchema = S.Struct({
  views: S.optional(ScanViewMetadataLevelSchema),
  failure: S.optional(ScanFailureMetadataLevelSchema),
  proposals: S.optional(ScanProposalMetadataLevelSchema),
  timings: S.optional(ScanTimingMetadataLevelSchema),
});
export type ScanObservabilityScan = S.Schema.Type<typeof ScanObservabilityScanSchema>;

export const ScanObservabilityTraceSchema = S.Struct({
  events: S.optional(ScanTraceEventsLevelSchema),
});
export type ScanObservabilityTrace = S.Schema.Type<typeof ScanObservabilityTraceSchema>;

export const ScanObservabilityOptionsSchema = S.Struct({
  result: S.optional(ScanObservabilityResultSchema),
  scan: S.optional(ScanObservabilityScanSchema),
  trace: S.optional(ScanObservabilityTraceSchema),
});
export type ScanObservabilityOptions = S.Schema.Type<typeof ScanObservabilityOptionsSchema>;

export const ScanOptionsSchema = S.Struct({
  allowMultiple: S.optional(S.Boolean),
  /** @deprecated Prefer `maxProposals`. Kept as a compatibility alias during migration. */
  maxCandidates: S.optional(S.Number),
  maxProposals: S.optional(S.Number),
  maxProposalsPerView: S.optional(S.Number),
  observability: S.optional(ScanObservabilityOptionsSchema),
});
export type ScanOptions = S.Schema.Type<typeof ScanOptionsSchema>;

export const DecodeGridOptionsSchema = S.Struct({
  debug: S.optional(S.Boolean),
});
export type DecodeGridOptions = S.Schema.Type<typeof DecodeGridOptionsSchema>;

export const DecodeGridInputSchema = S.Struct({
  grid: S.Array(S.Array(S.Boolean)),
  options: S.optional(DecodeGridOptionsSchema),
});
export type DecodeGridInput = S.Schema.Type<typeof DecodeGridInputSchema>;

export const DecodedPayloadSchema = S.Struct({
  kind: PayloadKindSchema,
  text: S.String,
  bytes: S.Uint8Array,
});
export type DecodedPayload = S.Schema.Type<typeof DecodedPayloadSchema>;

export const SegmentModeSchema = S.Literals([
  'numeric',
  'alphanumeric',
  'byte',
  'kanji',
  'eci',
  'fnc1-first',
  'fnc1-second',
]);
export type SegmentMode = S.Schema.Type<typeof SegmentModeSchema>;

export const DecodedSegmentSchema = S.Struct({
  mode: SegmentModeSchema,
  text: S.String,
  bytes: S.Uint8Array,
});
export type DecodedSegment = S.Schema.Type<typeof DecodedSegmentSchema>;

export const ScanResultSchema = S.Struct({
  payload: DecodedPayloadSchema,
  confidence: S.Number,
  version: S.Number,
  errorCorrectionLevel: ErrorCorrectionLevelSchema,
  bounds: BoundsSchema,
  corners: CornerSetSchema,
  headers: S.Array(S.Tuple([S.String, S.String])),
  segments: S.Array(DecodedSegmentSchema),
});
export type ScanResult = S.Schema.Type<typeof ScanResultSchema>;

export const DecodeGridResultSchema = ScanResultSchema;
export type DecodeGridResult = S.Schema.Type<typeof DecodeGridResultSchema>;

/**
 * Minimal structural pixel buffer accepted by the scan pipeline.
 *
 * This keeps the public contract aligned with the runtime path in non-DOM hosts
 * (tests, workers, Bun/Node tooling) where callers already pass `{ width,
 * height, data }` buffers without constructing a real `ImageData` instance.
 */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace?: string;
}

export type BrowserImageSource =
  | Blob
  | File
  | ImageBitmap
  | ImageData
  | ImageDataLike
  | HTMLCanvasElement
  | HTMLImageElement
  | OffscreenCanvas
  | VideoFrame;

export type ScanImageInput = BrowserImageSource;
export type ScanFrameInput = BrowserImageSource;
export type ScanStreamInput = MediaStream | HTMLVideoElement;

export interface ScanStreamOptions extends ScanOptions {
  readonly onResult?: (result: ScanResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly signal?: AbortSignal;
}
