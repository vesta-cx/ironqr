import { createRequire } from 'node:module';
import { scanRGBABuffer, setModuleArgs, ZBarSymbolType } from '@undecaf/zbar-wasm';
import { cloneRgbaBuffer, readImageData } from '../../shared/image.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createAvailableAvailability,
  createCapabilities,
  failureResult,
  normalizeDecodedText,
  serializeAsync,
  successResult,
} from './shared.js';

interface ZBarSymbol {
  readonly type: ZBarSymbolType;
  readonly typeName: string;
  decode: (encoding?: string) => string;
}

const require = createRequire(import.meta.url);
const ZBAR_WASM_PATH = require.resolve('@undecaf/zbar-wasm/dist/zbar.wasm');

setModuleArgs({
  locateFile: () => ZBAR_WASM_PATH,
});

const scanWithZbar = serializeAsync(async (imagePath: string): Promise<AccuracyScanResult> => {
  try {
    const image = await readImageData(imagePath);
    const symbols = (await scanRGBABuffer(
      cloneRgbaBuffer(image.data).buffer,
      image.width,
      image.height,
    )) as readonly ZBarSymbol[];

    return successResult(
      symbols
        .filter((symbol) => symbol.type === ZBarSymbolType.ZBAR_QRCODE)
        .map((symbol) => ({
          text: normalizeDecodedText(symbol.decode()),
          kind: symbol.typeName,
        })),
    );
  } catch (error) {
    return failureResult(error);
  }
});

export const zbarAccuracyEngine: AccuracyEngine = {
  id: 'zbar',
  kind: 'third-party',
  capabilities: createCapabilities({
    multiCode: true,
    inversion: 'native',
    rotation: 'native',
    runtime: 'wasm',
  }),
  availability: createAvailableAvailability,
  scanImage: scanWithZbar,
};
