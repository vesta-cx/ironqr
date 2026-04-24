import { uniqueTexts } from '../shared/text.js';
import type {
  AccuracyScanResult,
  EngineAssetResult,
  NegativeOutcome,
  PositiveOutcome,
} from './types.js';

export const expectedTextsFor = (asset: {
  readonly expectedTexts: readonly string[];
}): readonly string[] => uniqueTexts(asset.expectedTexts);

export const scorePositiveScan = (
  expectedTexts: readonly string[],
  scan: AccuracyScanResult,
): PositiveOutcome => {
  const decodedTexts = uniqueTexts(scan.results.map((result) => result.text));
  if (!scan.succeeded) {
    return {
      kind: 'fail-error',
      decodedTexts,
      matchedTexts: [],
      expectedTexts,
      failureReason: scan.failureReason,
      error: scan.error,
    };
  }
  if (decodedTexts.length === 0) {
    return {
      kind: 'fail-no-decode',
      decodedTexts,
      matchedTexts: [],
      expectedTexts,
      failureReason: scan.failureReason,
      error: scan.error,
    };
  }
  if (expectedTexts.length === 0) {
    return {
      kind: 'fail-mismatch',
      decodedTexts,
      matchedTexts: [],
      expectedTexts,
      failureReason: 'text_mismatch',
      error: 'Positive QR asset has no expected text',
    };
  }
  const matchedTexts = expectedTexts.filter((expected) => decodedTexts.includes(expected));
  if (matchedTexts.length === expectedTexts.length) {
    return {
      kind: 'pass',
      decodedTexts,
      matchedTexts,
      expectedTexts,
      failureReason: null,
      error: null,
    };
  }
  if (matchedTexts.length > 0) {
    return {
      kind: 'partial-pass',
      decodedTexts,
      matchedTexts,
      expectedTexts,
      failureReason: null,
      error: null,
    };
  }
  return {
    kind: 'fail-mismatch',
    decodedTexts,
    matchedTexts: [],
    expectedTexts,
    failureReason: 'text_mismatch',
    error: null,
  };
};

export const scoreNegativeScan = (scan: AccuracyScanResult): NegativeOutcome => {
  const decodedTexts = uniqueTexts(scan.results.map((result) => result.text));
  if (!scan.succeeded) {
    return {
      kind: 'fail-error',
      decodedTexts,
      failureReason: scan.failureReason,
      error: scan.error,
    };
  }
  if (decodedTexts.length > 0) {
    return {
      kind: 'false-positive',
      decodedTexts,
      failureReason: 'false_positive',
      error: null,
    };
  }
  return {
    kind: 'pass',
    decodedTexts,
    failureReason: null,
    error: null,
  };
};

export type AccuracyStatusCode = 'pass' | 'partial' | 'mismatch' | 'no-decode' | 'fp' | 'error';

export const statusCodeForResult = (result: EngineAssetResult): AccuracyStatusCode => {
  switch (result.outcome) {
    case 'pass':
      return 'pass';
    case 'partial-pass':
      return 'partial';
    case 'fail-mismatch':
      return 'mismatch';
    case 'fail-no-decode':
      return 'no-decode';
    case 'false-positive':
      return 'fp';
    case 'fail-error':
      return 'error';
  }
};
