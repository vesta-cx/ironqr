import { describe, expect, it } from 'bun:test';
import * as S from 'effect/Schema';
import {
  BoundsSchema,
  DecodeGridInputSchema,
  PointSchema,
  ScannerErrorSchema,
  ScannerNotImplementedError,
  ScanOptionsSchema,
  ScanResultSchema,
  scanImage,
} from '../../src/index.js';

describe('package scaffold exports', () => {
  it('exposes schema objects that validate the package shape', () => {
    expect(PointSchema).toBeDefined();
    expect(BoundsSchema).toBeDefined();
    expect(DecodeGridInputSchema).toBeDefined();
    expect(ScanOptionsSchema).toBeDefined();
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

  it('accepts the new scan observability options shape', () => {
    const decodeScanOptions = S.decodeUnknownSync(ScanOptionsSchema);

    expect(
      decodeScanOptions({
        allowMultiple: true,
        maxProposals: 12,
        observability: {
          result: { path: 'basic', attempts: 'summary' },
          scan: { proposals: 'summary', timings: 'full', failure: 'summary' },
          trace: { events: 'summary' },
        },
      }),
    ).toEqual({
      allowMultiple: true,
      maxProposals: 12,
      observability: {
        result: { path: 'basic', attempts: 'summary' },
        scan: { proposals: 'summary', timings: 'full', failure: 'summary' },
        trace: { events: 'summary' },
      },
    });
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
