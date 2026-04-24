import { Effect } from 'effect';
import type {
  DecodeGridInput,
  DecodeGridResult,
  ScanFrameInput,
  ScanImageInput,
  ScanOptions,
  ScanResult,
  ScanStreamInput,
  ScanStreamOptions,
} from './contracts/index.js';
import {
  buildBinaryViews,
  buildScalarViews,
  createGeometryCandidates,
  createTraceCollector,
  createTraceCounter,
  generateProposals,
  type RankedProposalCandidate,
  type RankedScanResult,
  rankProposalCandidates,
  rankProposals,
  runDecodeCascade,
  type ScanFrameOutput,
  type ScanReport,
  type ScanRuntimeOptions,
  scanFrameEffect,
  scanFrameRankedEffect,
  type TraceCollector,
  type TraceCounter,
  type TraceSink,
} from './pipeline/index.js';
import { decodeGridLogical } from './qr/index.js';
import { notImplemented } from './runtime/index.js';

export * from './contracts/index.js';
export { ScannerError } from './qr/index.js';
export { ScannerNotImplementedError } from './runtime/index.js';
export type {
  RankedProposalCandidate,
  RankedScanResult,
  ScanFrameOutput,
  ScanReport,
  ScanRuntimeOptions,
  TraceCollector,
  TraceCounter,
  TraceSink,
};
export {
  buildBinaryViews,
  buildScalarViews,
  createGeometryCandidates,
  createTraceCollector,
  createTraceCounter,
  generateProposals,
  rankProposalCandidates,
  rankProposals,
  runDecodeCascade,
};

/**
 * Runs an internal Effect program at the public API boundary.
 *
 * Thin wrapper over `Effect.runPromise` so every internal Effect-returning
 * pipeline stage shares one future extension point for runtime services,
 * tracing configuration, and instrumentation.
 *
 * @param effect - Effect program to execute.
 * @returns The resolved successful value.
 */
const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  return Effect.runPromise(effect);
};

/**
 * Decodes a pre-sampled logical QR grid into a structured scan result.
 *
 * @param input - Square boolean grid and decode options.
 * @returns A decoded payload and QR metadata.
 */
export const decodeGrid = async (input: DecodeGridInput): Promise<DecodeGridResult> => {
  return runEffect(decodeGridLogical({ grid: input.grid }));
};

export function scanFrame(
  input: ScanFrameInput,
  options: ScanRuntimeOptions & {
    readonly observability: NonNullable<ScanRuntimeOptions['observability']>;
  },
): Promise<ScanReport>;
export function scanFrame(
  input: ScanFrameInput,
  options?: ScanRuntimeOptions,
): Promise<readonly ScanResult[]>;
/**
 * Scans a single still image or video frame for QR symbols.
 *
 * When `options.observability` is omitted, this returns plain decoded results.
 * When observability is requested, it returns a report envelope containing
 * decoded results plus the requested scan/result metadata.
 *
 * @param input - Browser image source to inspect.
 * @param options - Scan behavior and optional observability.
 * @returns Plain decoded results or an observability report.
 */
export async function scanFrame(
  input: ScanFrameInput,
  options?: ScanRuntimeOptions,
): Promise<readonly ScanResult[] | ScanReport> {
  return runEffect(scanFrameEffect(input, options));
}

/**
 * Scans a single still image and returns ranked winning-path metadata alongside
 * the decoded payload.
 *
 * @deprecated Prefer `scanFrame(..., { observability: { result: { path: 'full' } } })`
 * and add other requested observability buckets there. This legacy helper is
 * retained for callers that still want the old ranked-result shape.
 *
 * @param input - Browser image source to inspect.
 * @param options - Scan behavior and optional diagnostics.
 * @returns Ranked decoded results with proposal/search metadata.
 */
export const scanFrameRanked = async (
  input: ScanFrameInput,
  options?: ScanRuntimeOptions,
): Promise<readonly RankedScanResult[]> => {
  return runEffect(scanFrameRankedEffect(input, options));
};

export function scanImage(
  input: ScanImageInput,
  options: ScanRuntimeOptions & {
    readonly observability: NonNullable<ScanRuntimeOptions['observability']>;
  },
): Promise<ScanReport>;
export function scanImage(
  input: ScanImageInput,
  options?: ScanRuntimeOptions,
): Promise<readonly ScanResult[]>;
/**
 * Scans an image-like source by delegating to `scanFrame`.
 *
 * @param input - Browser image source to inspect.
 * @param options - Scan behavior and optional observability.
 * @returns Plain decoded results or an observability report.
 */
export async function scanImage(
  input: ScanImageInput,
  options?: ScanRuntimeOptions,
): Promise<readonly ScanResult[] | ScanReport> {
  return scanFrame(input, options as never);
}

/**
 * Continuously scans frames from a media stream or video element.
 *
 * @param _input - Streaming source that yields frames over time.
 * @param _options - Streaming callbacks and scan behavior overrides.
 * @returns A promise that resolves with the collected scan results for the session.
 * @throws {ScannerNotImplementedError} Thrown until stream scanning is implemented.
 */
export const scanStream = async (
  _input: ScanStreamInput,
  _options?: ScanStreamOptions,
): Promise<readonly ScanResult[]> => {
  return notImplemented('scanStream');
};

// Re-export the schema-backed scan options type name for call sites that import
// it directly from the package entrypoint.
export type { ScanOptions };
