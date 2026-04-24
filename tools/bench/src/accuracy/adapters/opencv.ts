import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import { createAvailableAvailability, failureResult } from './shared.js';

const scanWithOpenCv = async (): Promise<AccuracyScanResult> => {
  return failureResult(
    new Error('OpenCV QR detector adapter is wired but the runtime integration is not implemented yet.'),
  );
};

export const opencvAccuracyEngine: AccuracyEngine = {
  id: 'opencv',
  kind: 'third-party',
  capabilities: {
    multiCode: false,
    inversion: 'none',
    rotation: 'native',
    runtime: 'wasm',
  },
  cache: { enabled: true, version: 'adapter-v1' },
  availability: createAvailableAvailability,
  scan: scanWithOpenCv,
};
