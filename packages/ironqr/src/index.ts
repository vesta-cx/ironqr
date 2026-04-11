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
import { scanFrame as scanFrameEffect } from './image/index.js';
import { decodeGridLogical } from './qr/index.js';
import { notImplemented } from './runtime/index.js';

export * from './contracts/index.js';
export { ScannerError } from './qr/index.js';
export { ScannerNotImplementedError } from './runtime/index.js';

/**
 * Runs an internal Effect program at the public API boundary.
 *
 * Thin wrapper over `Effect.runPromise` so every Effect-returning internal
 * funnels through a single entry point — a future home for tracing, service
 * injection, or custom runtime configuration.
 */
const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  return Effect.runPromise(effect);
};

/**
 * Decodes a pre-sampled logical QR grid into a structured scan result.
 *
 * @param input - Square boolean grid and decode options.
 * @returns A promise for the decoded payload and QR metadata.
 */
export const decodeGrid = async (input: DecodeGridInput): Promise<DecodeGridResult> => {
  return runEffect(decodeGridLogical({ grid: input.grid }));
};

/**
 * Scans a single still image or video frame for QR symbols.
 *
 * @param input - Browser image source to inspect.
 * @param _options - Scan behavior overrides.
 * @returns A promise containing every decoded symbol found in the frame.
 */
export const scanFrame = async (
  input: ScanFrameInput,
  // Options are accepted for API stability but not yet forwarded to the pipeline.
  // Behavioral overrides (signal, maxCandidates, debug) will be wired in a future slice.
  _options?: ScanOptions,
): Promise<readonly ScanResult[]> => {
  return runEffect(scanFrameEffect(input));
};

/**
 * Scans an image-like source by delegating to the frame scanner.
 *
 * @param input - Browser image source to inspect.
 * @param options - Scan behavior overrides.
 * @returns A promise containing every decoded symbol found in the image.
 */
export const scanImage = async (
  input: ScanImageInput,
  options?: ScanOptions,
): Promise<readonly ScanResult[]> => {
  return scanFrame(input, options);
};

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
