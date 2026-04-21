import { scanFrame } from '../../../../../packages/ironqr/src/index.js';
import { readImageData } from '../../shared/image.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createAvailableAvailability,
  createCapabilities,
  failureResult,
  successResult,
} from './shared.js';

const scanWithIronqr = async (imagePath: string): Promise<AccuracyScanResult> => {
  try {
    const imageData = await readImageData(imagePath);
    const results = await scanFrame(imageData, { allowMultiple: true });
    return successResult(
      results.map((result) => ({
        text: result.payload.text,
        ...(result.payload.kind ? { kind: result.payload.kind } : {}),
      })),
    );
  } catch (error) {
    return failureResult(error);
  }
};

export const ironqrAccuracyEngine: AccuracyEngine = {
  id: 'ironqr',
  kind: 'first-party',
  capabilities: createCapabilities({
    multiCode: true,
    inversion: 'native',
    rotation: 'native',
    runtime: 'js',
  }),
  availability: createAvailableAvailability,
  scanImage: scanWithIronqr,
};
