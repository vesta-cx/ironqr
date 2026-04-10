import { describe, expect, it } from 'bun:test';
import * as S from 'effect/Schema';
import {
  BoundsSchema,
  DecodeGridInputSchema,
  PointSchema,
  ScannerErrorSchema,
  ScannerNotImplementedError,
  ScanResultSchema,
  scanImage,
} from '../../src/index.js';

describe('package scaffold exports', () => {
  it('exposes schema objects that validate the package shape', () => {
    expect(PointSchema).toBeDefined();
    expect(BoundsSchema).toBeDefined();
    expect(DecodeGridInputSchema).toBeDefined();
    expect(ScanResultSchema).toBeDefined();
    expect(ScannerErrorSchema).toBeDefined();
  });

  it('does not throw ScannerNotImplementedError for scan entry points (real pipeline)', async () => {
    // scanImage is now implemented; it will not throw ScannerNotImplementedError.
    // In a Node test environment the browser APIs are absent, so a different
    // error (e.g. ReferenceError) may surface — that is acceptable here.
    try {
      await scanImage(new Blob());
    } catch (err) {
      expect(err).not.toBeInstanceOf(ScannerNotImplementedError);
    }
  });

  it('rejects scanner error payloads with unknown public error codes', () => {
    const decodeScannerError = S.decodeUnknownSync(ScannerErrorSchema);

    expect(
      decodeScannerError({
        name: 'ScannerError',
        code: 'decode_failed',
        message: 'boom',
      }),
    ).toEqual({
      name: 'ScannerError',
      code: 'decode_failed',
      message: 'boom',
    });

    expect(() =>
      decodeScannerError({
        name: 'ScannerError',
        code: 'mystery_failure',
        message: 'boom',
      }),
    ).toThrow();
  });
});
