export const memoizeAsyncResetOnReject = <Result>(
  load: () => Promise<Result>,
): (() => Promise<Result>) => {
  let pending: Promise<Result> | null = null;
  return () => {
    if (pending) return pending;
    pending = load().catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
};
