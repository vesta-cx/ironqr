import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { cloneRgbaBuffer } from '../../shared/image.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createAvailableAvailability,
  createCachePolicy,
  createCapabilities,
  createUnavailableAvailability,
  failureResult,
  serializeAsync,
  successResult,
} from './shared.js';

const require = createRequire(import.meta.url);

const resolveReaderWasm = (): string => require.resolve('zxing-wasm/reader/zxing_reader.wasm');

let zxingPrepared: Promise<void> | null = null;

const prepareReader = async (): Promise<void> => {
  zxingPrepared ??= (async () => {
    try {
      const wasmBinary = await Bun.file(resolveReaderWasm()).arrayBuffer();
      await prepareZXingModule({
        overrides: { wasmBinary },
        fireImmediately: true,
      });
    } catch (error) {
      zxingPrepared = null;
      throw error;
    }
  })();
  await zxingPrepared;
};

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
      return successResult(
        results.map((result) => ({ text: result.text })),
        results.length === 0 ? 'no_decode' : null,
      );
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
  capabilities: createCapabilities({
    multiCode: true,
    inversion: 'native',
    rotation: 'native',
    runtime: 'wasm',
  }),
  cache: createCachePolicy({ enabled: true, version: 'adapter-v1' }),
  availability: zxingCppAvailability,
  scan: scanWithZxingCpp,
};
