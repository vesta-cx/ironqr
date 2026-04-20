import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { buildLuminanceBuffer, invertLuminanceBuffer, readImageData } from '../../shared/image.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import { createCapabilities, failureResult, successResult } from './shared.js';

const decodeText = (luminance: Uint8ClampedArray, width: number, height: number): string | null => {
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)),
  );
  const reader = new QRCodeReader();
  return reader.decode(bitmap).getText();
};

const scanWithZxing = async (imagePath: string): Promise<AccuracyScanResult> => {
  try {
    const image = await readImageData(imagePath);
    const luminance = buildLuminanceBuffer(image);

    for (const candidate of [luminance, invertLuminanceBuffer(luminance)]) {
      try {
        const text = decodeText(candidate, image.width, image.height);
        return successResult(text ? [{ text }] : []);
      } catch {
        // try the next luminance candidate
      }
    }

    return successResult([]);
  } catch (error) {
    return failureResult(error);
  }
};

export const zxingAccuracyEngine: AccuracyEngine = {
  id: 'zxing',
  kind: 'third-party',
  capabilities: createCapabilities({
    multiCode: false,
    inversion: 'caller',
    rotation: 'native',
    runtime: 'js',
  }),
  scanImage: scanWithZxing,
};
