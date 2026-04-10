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
import { decodeGridLogical } from './internal/decode-grid.js';
import { notImplemented } from './internal/not-implemented.js';
import { scanFrameInternal } from './internal/scan-frame.js';

export * from './contracts/index.js';
export { ScannerError } from './internal/errors.js';
export { ScannerNotImplementedError } from './internal/not-implemented.js';

/**
 * Decodes a pre-sampled logical QR grid into a structured scan result.
 *
 * @param input - Square boolean grid and decode options.
 * @returns A promise for the decoded payload and QR metadata.
 */
export async function decodeGrid(input: DecodeGridInput): Promise<DecodeGridResult> {
  return decodeGridLogical({ grid: input.grid });
}

/**
 * Scans a single still image or video frame for QR symbols.
 *
 * @param input - Browser image source to inspect.
 * @param _options - Scan behavior overrides.
 * @returns A promise containing every decoded symbol found in the frame.
 */
export async function scanFrame(
  input: ScanFrameInput,
  // Options are accepted for API stability but not yet forwarded to the pipeline.
  // Behavioral overrides (signal, maxCandidates, debug) will be wired in a future slice.
  _options?: ScanOptions,
): Promise<readonly ScanResult[]> {
  return scanFrameInternal(input);
}

/**
 * Scans an image-like source by delegating to the frame scanner.
 *
 * @param input - Browser image source to inspect.
 * @param options - Scan behavior overrides.
 * @returns A promise containing every decoded symbol found in the image.
 */
export async function scanImage(
  input: ScanImageInput,
  options?: ScanOptions,
): Promise<readonly ScanResult[]> {
  return scanFrame(input, options);
}

/**
 * Continuously scans frames from a media stream or video element.
 *
 * @param _input - Streaming source that yields frames over time.
 * @param _options - Streaming callbacks and scan behavior overrides.
 * @returns A promise that resolves with the collected scan results for the session.
 * @throws {ScannerNotImplementedError} Thrown until stream scanning is implemented.
 */
export async function scanStream(
  _input: ScanStreamInput,
  _options?: ScanStreamOptions,
): Promise<readonly ScanResult[]> {
  return notImplemented('scanStream');
}
