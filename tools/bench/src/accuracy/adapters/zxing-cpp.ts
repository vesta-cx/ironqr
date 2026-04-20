import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { cloneRgbaBuffer, readImageData } from '../../shared/image.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import { createCapabilities, failureResult, serializeAsync, successResult } from './shared.js';

const require = createRequire(import.meta.url);
const ZXING_READER_WASM_PATH = require.resolve('zxing-wasm/reader/zxing_reader.wasm');

let zxingPrepared: Promise<void> | null = null;

const prepareLocalZXingReader = async (): Promise<void> => {
  zxingPrepared ??= (async () => {
    const wasmBinary = await Bun.file(ZXING_READER_WASM_PATH).arrayBuffer();
    await prepareZXingModule({
      overrides: { wasmBinary },
      fireImmediately: true,
    });
  })();

  await zxingPrepared;
};

const scanWithZXingCpp = serializeAsync(async (imagePath: string): Promise<AccuracyScanResult> => {
  try {
    await prepareLocalZXingReader();
    const image = await readImageData(imagePath);
    const results = await readBarcodes(
      {
        data: cloneRgbaBuffer(image.data),
        width: image.width,
        height: image.height,
        colorSpace: 'srgb',
      },
      {
        formats: ['QRCode'],
        maxNumberOfSymbols: 0,
        tryHarder: true,
        tryInvert: true,
        tryRotate: true,
      },
    );

    return successResult(results.map((result) => ({ text: result.text })));
  } catch (error) {
    return failureResult(error);
  }
});

export const zxingCppAccuracyEngine: AccuracyEngine = {
  id: 'zxing-cpp',
  kind: 'third-party',
  capabilities: createCapabilities({
    multiCode: true,
    inversion: 'native',
    rotation: 'native',
    runtime: 'wasm',
  }),
  scanImage: scanWithZXingCpp,
};
