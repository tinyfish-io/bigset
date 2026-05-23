export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      return true;
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  return /429|502|503|504|timeout|timed out|ECONNRESET|ETIMEDOUT|rate limit|temporarily unavailable/i.test(
    message,
  );
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    baseDelayMs: number;
    label?: string;
  },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= options.maxRetries) {
        throw error;
      }
      const delay = options.baseDelayMs * 2 ** attempt;
      const label = options.label ? ` (${options.label})` : "";
      console.warn(
        `[retry]${label} attempt ${attempt + 1}/${options.maxRetries} failed, retrying in ${delay}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
