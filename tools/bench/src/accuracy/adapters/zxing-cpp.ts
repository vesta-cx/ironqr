import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { memoizeAsyncResetOnReject } from '../../shared/async.js';
import { cloneRgbaBuffer } from '../../shared/image.js';
import { normalizeDecodedText } from '../../shared/text.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createAvailableAvailability,
  createUnavailableAvailability,
  failureResult,
  serializeAsync,
  successResult,
} from './shared.js';

const require = createRequire(import.meta.url);

const resolveReaderWasm = (): string => require.resolve('zxing-wasm/reader/zxing_reader.wasm');

const prepareReader = memoizeAsyncResetOnReject(async (): Promise<void> => {
  const wasmBinary = await Bun.file(resolveReaderWasm()).arrayBuffer();
  await prepareZXingModule({
    overrides: { wasmBinary },
    fireImmediately: true,
  });
});

const scanWithZxingCpp = serializeAsync(
  async (asset: Parameters<AccuracyEngine['scan']>[0]): Promise<AccuracyScanResult> => {
    try {
      await prepareReader();
      const image = await asset.loadImage();
      const results = await readBarcodes(
        {
          data: cloneRgbaBuffer(image.data),
          width: image.width,
          height: image.height,
          colorSpace: image.colorSpace,
        },
        {
          formats: ['QRCode'],
          maxNumberOfSymbols: 0,
          tryHarder: true,
          tryInvert: true,
          tryRotate: true,
        },
      );
      const decoded = results.flatMap((result) => {
        const text = normalizeDecodedText(result.text);
        return text.length > 0 ? [{ text }] : [];
      });
      return successResult(decoded, decoded.length === 0 ? 'no_decode' : null);
    } catch (error) {
      return failureResult(error);
    }
  },
);

const zxingCppAvailability = () => {
  try {
    resolveReaderWasm();
    return createAvailableAvailability();
  } catch (error) {
    return createUnavailableAvailability(error instanceof Error ? error.message : String(error));
  }
};

export const zxingCppAccuracyEngine: AccuracyEngine = {
  id: 'zxing-cpp',
  kind: 'third-party',
  capabilities: {
    multiCode: true,
    inversion: 'native',
    rotation: 'native',
    runtime: 'wasm',
  },
  cache: { enabled: true, version: 'adapter-v1' },
  availability: zxingCppAvailability,
  scan: scanWithZxingCpp,
};
