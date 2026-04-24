import { createRequire } from 'node:module';
import path from 'node:path';
import { memoizeAsyncResetOnReject } from '../../shared/async.js';
import { buildLuminanceBuffer } from '../../shared/image.js';
import { normalizeDecodedText } from '../../shared/text.js';
import type { AccuracyEngine, AccuracyScanResult } from '../types.js';
import {
  createAvailableAvailability,
  createUnavailableAvailability,
  failureResult,
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

const resolveQuirc = (): { readonly Quirc: QuircConstructor; readonly wasmPath: string } => {
  const entryPath = require.resolve('quirc');
  const module = require(entryPath) as { Quirc: QuircConstructor };
  return {
    Quirc: module.Quirc,
    wasmPath: path.resolve(path.dirname(entryPath), '../libquirc.wasm'),
  };
};

const getQuircModule = memoizeAsyncResetOnReject(async (): Promise<WebAssembly.Module> => {
  const { wasmPath } = resolveQuirc();
  const binary = await Bun.file(wasmPath).arrayBuffer();
  return WebAssembly.compile(binary);
});

const createQuircDecoder = async (): Promise<QuircDecoder> => {
  const { Quirc } = resolveQuirc();
  const instance = await WebAssembly.instantiate(await getQuircModule());
  return new Quirc(instance);
};

const scanWithQuirc = serializeAsync(
  async (asset: Parameters<AccuracyEngine['scan']>[0]): Promise<AccuracyScanResult> => {
    try {
      const decoder = await createQuircDecoder();
      const image = await asset.loadImage();
      const results = decoder.decode(buildLuminanceBuffer(image), image.width, image.height);
      const decoded = results.flatMap((result) => {
        const text = result.data.text ? normalizeDecodedText(result.data.text) : '';
        return text.length > 0 ? [{ text }] : [];
      });
      return successResult(decoded, decoded.length === 0 ? 'no_decode' : null);
    } catch (error) {
      return failureResult(error);
    }
  },
);

const quircAvailability = () => {
  try {
    const { wasmPath } = resolveQuirc();
    if (!Bun.file(wasmPath).exists()) {
      throw new Error(`Missing quirc WASM asset: ${wasmPath}`);
    }
    return createAvailableAvailability();
  } catch (error) {
    return createUnavailableAvailability(error instanceof Error ? error.message : String(error));
  }
};

export const quircAccuracyEngine: AccuracyEngine = {
  id: 'quirc',
  kind: 'third-party',
  capabilities: {
    multiCode: true,
    inversion: 'none',
    rotation: 'native',
    runtime: 'wasm',
  },
  cache: { enabled: true, version: 'adapter-v1' },
  availability: quircAvailability,
  scan: scanWithQuirc,
};
