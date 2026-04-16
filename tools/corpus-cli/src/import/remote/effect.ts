import { Effect } from 'effect';
import { FetchError, FilesystemError } from '../../errors.js';

/** Wraps a Promise-returning thunk in an Effect with a FilesystemError error channel. */
export const tryPromise = <A>(evaluate: () => Promise<A>) => {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new FilesystemError(cause instanceof Error ? cause.message : String(cause), cause),
  });
};

/** Wraps a fetch-like Promise in an Effect with a FetchError error channel. */
export const tryFetch = <A>(evaluate: () => Promise<A>) => {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new FetchError(cause instanceof Error ? cause.message : String(cause), cause),
  });
};
