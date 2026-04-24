import jsQRModule from 'jsqr';
import { normalizeDecodedText } from '../../shared/text.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import { createAvailableAvailability, failureResult, successResult } from './shared.js';

const scanWithJsqr = async (
  asset: Parameters<AccuracyEngine['scan']>[0],
): Promise<AccuracyScanResult> => {
  try {
    const image = await asset.loadImage();
    const decoded = jsQRModule.default(image.data, image.width, image.height, {
      inversionAttempts: 'attemptBoth',
    });
    const text = decoded ? normalizeDecodedText(decoded.data) : '';
    return successResult(text.length > 0 ? [{ text }] : [], text.length > 0 ? null : 'no_decode');
  } catch (error) {
    return failureResult(error);
  }
};

export const jsqrAccuracyEngine: AccuracyEngine = {
  id: 'jsqr',
  kind: 'third-party',
  capabilities: {
    multiCode: false,
    inversion: 'native',
    rotation: 'native',
    runtime: 'js',
  },
  cache: { enabled: true, version: 'adapter-v1' },
  availability: createAvailableAvailability,
  scan: scanWithJsqr,
};
