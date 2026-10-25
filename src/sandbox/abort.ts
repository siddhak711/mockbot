export function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Rejects when `signal` aborts. The underlying work is left to finish on its own. */
export function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (settle: () => void) => {
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
