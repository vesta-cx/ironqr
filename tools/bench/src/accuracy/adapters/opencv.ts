import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createAvailableAvailability,
  createUnavailableAvailability,
  failureResult,
  serializeAsync,
  successResult,
} from './shared.js';

interface OpenCvWorkerDecodedResult {
  readonly status: 'decoded';
  readonly texts: readonly string[];
}

interface OpenCvWorkerNoDecodeResult {
  readonly status: 'no-decode';
}

interface OpenCvWorkerErrorResult {
  readonly status: 'error';
  readonly error: string;
}

type OpenCvMode = 'single' | 'multi';

type OpenCvWorkerResult =
  | OpenCvWorkerDecodedResult
  | OpenCvWorkerNoDecodeResult
  | OpenCvWorkerErrorResult;

const execFileAsync = promisify(execFile);
const OPENCV_SCAN_TIMEOUT_MS = 45_000;
const workerScript = fileURLToPath(new URL('./opencv-node-worker.cjs', import.meta.url));
let availabilityError: string | null = null;

const createOpenCvScan = (mode: OpenCvMode) =>
  serializeAsync(
    async (asset: Parameters<AccuracyEngine['scan']>[0]): Promise<AccuracyScanResult> => {
      try {
        const { stdout } = await execFileAsync('node', [workerScript, asset.imagePath, mode], {
          timeout: OPENCV_SCAN_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        const result = parseWorkerResult(stdout);
        if (result.status === 'error') {
          availabilityError = result.error;
          return failureResult(new Error(result.error));
        }
        if (result.status === 'no-decode') return successResult([], 'no_decode');
        return successResult(result.texts.map((text) => ({ text })));
      } catch (error) {
        availabilityError = error instanceof Error ? error.message : String(error);
        return failureResult(error);
      }
    },
  );

const parseWorkerResult = (stdout: string): OpenCvWorkerResult => {
  const line = stdout
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return { status: 'error', error: 'OpenCV worker produced no output.' };

  const parsed = JSON.parse(line) as Partial<OpenCvWorkerResult>;
  if (parsed.status === 'decoded' && Array.isArray(parsed.texts)) {
    return { status: 'decoded', texts: parsed.texts.filter((text) => typeof text === 'string') };
  }
  if (parsed.status === 'no-decode') return { status: 'no-decode' };
  if (parsed.status === 'error' && typeof parsed.error === 'string') {
    return { status: 'error', error: parsed.error };
  }
  return { status: 'error', error: `Invalid OpenCV worker output: ${line}` };
};

const availability = () =>
  availabilityError === null
    ? createAvailableAvailability()
    : createUnavailableAvailability(availabilityError);

export const opencvAccuracyEngine: AccuracyEngine = {
  id: 'opencv',
  kind: 'third-party',
  capabilities: {
    multiCode: false,
    inversion: 'none',
    rotation: 'native',
    runtime: 'wasm',
  },
  cache: { enabled: true, version: 'adapter-v2-single' },
  execution: { workerSafe: false },
  availability,
  scan: createOpenCvScan('single'),
};

export const opencvMultiAccuracyEngine: AccuracyEngine = {
  id: 'opencv-multi',
  kind: 'third-party',
  capabilities: {
    multiCode: true,
    inversion: 'none',
    rotation: 'native',
    runtime: 'wasm',
  },
  cache: { enabled: true, version: 'adapter-v1-multi' },
  execution: { workerSafe: false },
  availability,
  scan: createOpenCvScan('multi'),
};
