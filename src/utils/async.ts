const inFlight = new Map<unknown, Promise<unknown>>();

/** Maps values in input order without flooding native APIs with unbounded parallel work. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('并发数量必须是正整数');
  }
  if (!values.length) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let stopped = false;
  async function worker(): Promise<void> {
    while (!stopped) {
      const index = nextIndex;
      if (index >= values.length) return;
      nextIndex += 1;
      const value = values[index] as T;
      try {
        results[index] = await mapper(value, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

/** Coalesces concurrent work for the same key and clears failures so a later retry can run. */
export function singleFlight<T>(key: unknown, operation: () => Promise<T>): Promise<T> {
  const current = inFlight.get(key) as Promise<T> | undefined;
  if (current) return current;

  let promise: Promise<T>;
  promise = Promise.resolve()
    .then(operation)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}
