import { createRequire } from 'node:module';
import path from 'node:path';
import { buildLuminanceBuffer, readImageData } from '../../shared/image.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createCapabilities,
  failureResult,
  normalizeDecodedText,
  serializeAsync,
  successResult,
} from './shared.js';

interface QuircResult {
  readonly data: {
    readonly text?: string;
  };
}

interface QuircDecoder {
  decode: (
    image: Uint8Array | Uint8ClampedArray | ArrayBuffer,
    width: number,
    height: number,
  ) => readonly QuircResult[];
}

interface QuircConstructor {
  new (instance: WebAssembly.Instance): QuircDecoder;
}

const require = createRequire(import.meta.url);
const quircEntryPath = require.resolve('quirc');
const { Quirc } = require(quircEntryPath) as { Quirc: QuircConstructor };
const QUIRC_WASM_PATH = path.resolve(path.dirname(quircEntryPath), '../libquirc.wasm');

let quircModule: Promise<WebAssembly.Module> | null = null;

const loadQuircModule = async (): Promise<WebAssembly.Module> => {
  quircModule ??= (async () => {
    const wasmBinary = await Bun.file(QUIRC_WASM_PATH).arrayBuffer();
    return WebAssembly.compile(wasmBinary);
  })();

  return quircModule;
};

const createQuircDecoder = async (): Promise<QuircDecoder> => {
  const module = await loadQuircModule();
  const instance = await WebAssembly.instantiate(module);
  return new Quirc(instance);
};

const scanWithQuirc = serializeAsync(async (imagePath: string): Promise<AccuracyScanResult> => {
  try {
    const image = await readImageData(imagePath);
    const decoder = await createQuircDecoder();
    const results = decoder.decode(buildLuminanceBuffer(image), image.width, image.height);

    return successResult(
      results.flatMap((result) => {
        const text = result.data.text ? normalizeDecodedText(result.data.text) : '';
        return text.length > 0 ? [{ text }] : [];
      }),
    );
  } catch (error) {
    return failureResult(error);
  }
});

export const quircAccuracyEngine: AccuracyEngine = {
  id: 'quirc',
  kind: 'third-party',
  capabilities: createCapabilities({
    multiCode: true,
    inversion: 'none',
    rotation: 'native',
    runtime: 'wasm',
  }),
  scanImage: scanWithQuirc,
};
