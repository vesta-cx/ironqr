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

export const ScanOptionsSchema = S.Struct({
  allowMultiple: S.optional(S.Boolean),
  debug: S.optional(S.Boolean),
  maxCandidates: S.optional(S.Number),
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

export type BrowserImageSource =
  | Blob
  | File
  | ImageBitmap
  | ImageData
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
