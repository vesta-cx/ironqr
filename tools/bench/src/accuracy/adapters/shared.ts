import { asMessage } from '../../shared/errors.js';
import type {
  AccuracyEngineAvailability,
  AccuracyScanCode,
  AccuracyScanDiagnostics,
  AccuracyScanResult,
  EngineFailureReason,
} from '../types.js';

export const createAvailableAvailability = (): AccuracyEngineAvailability => ({
  available: true,
  reason: null,
});

export const createUnavailableAvailability = (reason: string): AccuracyEngineAvailability => ({
  available: false,
  reason,
});

export const successResult = (
  results: readonly AccuracyScanCode[],
  failureReason: EngineFailureReason | null = null,
  diagnostics: AccuracyScanDiagnostics | null = null,
): AccuracyScanResult => {
  if (results.length === 0) {
    return {
      status: 'no-decode',
      attempted: true,
      succeeded: true,
      results: [],
      failureReason: normalizeNoDecodeReason(failureReason),
      error: null,
      diagnostics,
    };
  }

  return {
    status: 'decoded',
    attempted: true,
    succeeded: true,
    results,
    failureReason: null,
    error: null,
    diagnostics,
  };
};

export const failureResult = (
  error: unknown,
  failureReason: EngineFailureReason = 'engine_error',
  diagnostics: AccuracyScanDiagnostics | null = null,
): AccuracyScanResult => ({
  status: 'error',
  attempted: true,
  succeeded: false,
  results: [],
  failureReason,
  error: asMessage(error),
  diagnostics,
});

const normalizeNoDecodeReason = (
  failureReason: EngineFailureReason | null,
): 'failed_to_find_finders' | 'failed_to_resolve_geometry' | 'failed_to_decode' | 'no_decode' => {
  if (
    failureReason === 'failed_to_find_finders' ||
    failureReason === 'failed_to_resolve_geometry' ||
    failureReason === 'failed_to_decode'
  ) {
    return failureReason;
  }
  return 'no_decode';
};

export const serializeAsync = <Args extends readonly unknown[], Result>(
  run: (...args: Args) => Promise<Result>,
): ((...args: Args) => Promise<Result>) => {
  let tail = Promise.resolve();
  return (...args: Args): Promise<Result> => {
    const next = tail.then(() => run(...args));
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
};
