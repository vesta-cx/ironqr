import { createRequire } from 'node:module';
import { readImageData } from '../../shared/image.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createAvailableAvailability,
  createCapabilities,
  failureResult,
  successResult,
} from './shared.js';

interface JsqrCode {
  readonly data: string;
}

interface JsqrOptions {
  readonly inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst';
}

type JsqrDecode = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: JsqrOptions,
) => JsqrCode | null;

const require = createRequire(import.meta.url);
const jsqr = require('../../../vendors/jsqr/dist/jsQR.js') as JsqrDecode;

const scanWithJsqr = async (imagePath: string): Promise<AccuracyScanResult> => {
  try {
    const image = await readImageData(imagePath);
    const decoded = jsqr(image.data, image.width, image.height, {
      inversionAttempts: 'attemptBoth',
    });

    return successResult(decoded ? [{ text: decoded.data }] : []);
  } catch (error) {
    return failureResult(error);
  }
};

export const jsqrAccuracyEngine: AccuracyEngine = {
  id: 'jsqr',
  kind: 'third-party',
  capabilities: createCapabilities({
    multiCode: false,
    inversion: 'native',
    rotation: 'native',
    runtime: 'js',
  }),
  availability: createAvailableAvailability,
  scanImage: scanWithJsqr,
};
