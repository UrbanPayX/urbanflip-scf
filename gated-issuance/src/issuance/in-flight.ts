/** Raised when the same operation is already running for this key in this process. */
export class OperationInProgressError extends Error {
  constructor(readonly key: string) {
    super(`${key} already in progress; retry when it finishes`);
    this.name = 'OperationInProgressError';
  }
}

/**
 * In-process guard: at most one run per key. A concurrent duplicate is
 * refused, not queued, so it can never act on state the first run is about
 * to change (e.g. mint before the first mint is recorded). Across processes,
 * the JSON-file stores' state lock (store/state-lock.ts) ensures one process,
 * and one store instance, owns a state directory.
 */
export class InFlightGuard {
  private readonly running = new Set<string>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.running.has(key)) throw new OperationInProgressError(key);
    this.running.add(key);
    try {
      return await fn();
    } finally {
      this.running.delete(key);
    }
  }
}

const guards = new WeakMap<object, InFlightGuard>();

/** One guard per shared resource (a store), so services built over the same store share it. */
export function inFlightGuardFor(resource: object): InFlightGuard {
  let guard = guards.get(resource);
  if (!guard) guards.set(resource, (guard = new InFlightGuard()));
  return guard;
}
