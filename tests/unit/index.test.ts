import * as S from 'effect/Schema';
import { describe, expect, it } from 'vitest';
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

  it('throws a dedicated not-implemented error for scan entry points', async () => {
    await expect(scanImage(new Blob())).rejects.toBeInstanceOf(ScannerNotImplementedError);
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
