export interface PartialMapResult<Output> {
  readonly completed: readonly Output[];
  readonly completedCount: number;
  readonly pendingCount: number;
  readonly error: unknown;
  readonly interrupted: boolean;
}

export const abortReason = (signal?: AbortSignal): string => {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'Interrupted by user request.';
};

export const mapConcurrentPartial = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input, index: number) => Promise<Output>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<PartialMapResult<Output>> => {
  if (values.length === 0) {
    return { completed: [], completedCount: 0, pendingCount: 0, error: null, interrupted: false };
  }

  const results = new Array<Output | undefined>(values.length);
  let nextIndex = 0;
  let completedCount = 0;
  let error: unknown = null;

  const shouldStop = (): boolean => error !== null || options.signal?.aborted === true;

  const worker = async (): Promise<void> => {
    while (!shouldStop()) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) return;
      const value = values[currentIndex];
      if (value === undefined) continue;
      try {
        results[currentIndex] = await map(value, currentIndex);
        completedCount += 1;
      } catch (caught) {
        if (options.signal?.aborted === true) return;
        error = caught;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  const interrupted = options.signal?.aborted === true && error === null;
  const completed = results.filter((value): value is Output => value !== undefined);
  return {
    completed,
    completedCount,
    pendingCount: values.length - completedCount,
    error,
    interrupted,
  };
};
