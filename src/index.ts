import * as S from 'effect/Schema';
import { notImplemented } from './internal/not-implemented.js';

export { ScannerNotImplementedError } from './internal/not-implemented.js';

export const PointSchema = S.Struct({
  x: S.Number,
  y: S.Number,
});
export type Point = S.Schema.Type<typeof PointSchema>;

export const BoundsSchema = S.Struct({
  x: S.Number,
  y: S.Number,
  width: S.Number,
  height: S.Number,
});
export type Bounds = S.Schema.Type<typeof BoundsSchema>;

export const CornerSetSchema = S.Struct({
  topLeft: PointSchema,
  topRight: PointSchema,
  bottomRight: PointSchema,
  bottomLeft: PointSchema,
});
export type CornerSet = S.Schema.Type<typeof CornerSetSchema>;

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

export const ScannerErrorSchema = S.Struct({
  name: S.Literal('ScannerError'),
  code: S.String,
  message: S.String,
});
export type ScannerErrorShape = S.Schema.Type<typeof ScannerErrorSchema>;

export class ScannerError extends Error {
  constructor(
    public readonly code: 'not_implemented' | 'invalid_input' | 'decode_failed' | 'internal_error',
    message: string,
  ) {
    super(message);
    this.name = 'ScannerError';
  }
}

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

export const ScanResultSchema = S.Struct({
  payload: DecodedPayloadSchema,
  confidence: S.Number,
  version: S.Number,
  errorCorrectionLevel: ErrorCorrectionLevelSchema,
  bounds: BoundsSchema,
  corners: CornerSetSchema,
  headers: S.Array(S.Tuple([S.String, S.String])),
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

export async function decodeGrid(_input: DecodeGridInput): Promise<DecodeGridResult> {
  return notImplemented('decodeGrid');
}

export async function scanFrame(
  _input: ScanFrameInput,
  _options?: ScanOptions,
): Promise<readonly ScanResult[]> {
  return notImplemented('scanFrame');
}

export async function scanImage(
  input: ScanImageInput,
  options?: ScanOptions,
): Promise<readonly ScanResult[]> {
  return scanFrame(input, options);
}

export async function scanStream(
  _input: ScanStreamInput,
  _options?: ScanStreamOptions,
): Promise<readonly ScanResult[]> {
  return notImplemented('scanStream');
}
