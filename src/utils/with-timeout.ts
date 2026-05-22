/** Race `promise` against a deadline; rejects with `Error` on timeout. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** On timeout or rejection, return `fallback` instead of throwing. */
export async function withTimeoutOr<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  try {
    return await withTimeout(promise, ms);
  } catch {
    return fallback;
  }
}
