import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { buildLuminanceBuffer, invertLuminanceBuffer } from '../../shared/image.js';
import { normalizeDecodedText } from '../../shared/text.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import { createAvailableAvailability, failureResult, successResult } from './shared.js';

const decodeCandidate = (
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): string | null => {
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)),
  );
  const reader = new QRCodeReader();
  return reader.decode(bitmap).getText();
};

const tryDecodeCandidate = (
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): string | null => {
  try {
    const text = decodeCandidate(luminance, width, height);
    if (!text) return null;
    const normalized = normalizeDecodedText(text);
    return normalized.length > 0 ? normalized : null;
  } catch (error) {
    if (isZxingNoDecode(error)) return null;
    throw error;
  }
};

const isZxingNoDecode = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.name === 'NotFoundException' || error.message.includes('No MultiFormat Readers');
};

const scanWithZxing = async (
  asset: Parameters<AccuracyEngine['scan']>[0],
): Promise<AccuracyScanResult> => {
  try {
    const image = await asset.loadImage();
    const luminance = buildLuminanceBuffer(image);
    const normalText = tryDecodeCandidate(luminance, image.width, image.height);
    if (normalText) return successResult([{ text: normalText }]);
    const invertedText = tryDecodeCandidate(
      invertLuminanceBuffer(luminance),
      image.width,
      image.height,
    );
    if (invertedText) return successResult([{ text: invertedText }]);
    return successResult([], 'no_decode');
  } catch (error) {
    return failureResult(error);
  }
};

export const zxingAccuracyEngine: AccuracyEngine = {
  id: 'zxing',
  kind: 'third-party',
  capabilities: {
    multiCode: false,
    inversion: 'caller',
    rotation: 'native',
    runtime: 'js',
  },
  cache: { enabled: true, version: 'adapter-v1' },
  availability: createAvailableAvailability,
  scan: scanWithZxing,
};
