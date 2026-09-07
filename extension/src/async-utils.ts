/**
 * Reject *promise* if it does not settle within *ms*, with a clear message.
 * Used around messaging and network stages that have no native timeout so a
 * stalled stage degrades into a visible error instead of hanging silently.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}