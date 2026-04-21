import type {
  AccuracyEngineAvailability,
  AccuracyEngineCapabilities,
  AccuracyScanCode,
  AccuracyScanResult,
} from '../types.js';

export const normalizeError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const successResult = (results: readonly AccuracyScanCode[]): AccuracyScanResult => {
  return {
    attempted: true,
    succeeded: true,
    results,
  };
};

export const failureResult = (error: unknown): AccuracyScanResult => {
  return {
    attempted: true,
    succeeded: false,
    results: [],
    error: normalizeError(error),
  };
};

export const createCapabilities = (
  capabilities: AccuracyEngineCapabilities,
): AccuracyEngineCapabilities => capabilities;

export const createAvailableAvailability = (): AccuracyEngineAvailability => ({
  available: true,
  reason: null,
});

export const normalizeDecodedText = (text: string): string => text.replace(/\0+$/u, '');

export const serializeAsync = <Args extends readonly unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
): ((...args: Args) => Promise<Result>) => {
  let tail = Promise.resolve();

  return async (...args: Args): Promise<Result> => {
    const run = tail.then(() => fn(...args));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
};
