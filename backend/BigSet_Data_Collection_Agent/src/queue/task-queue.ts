import type { DomainThrottle } from "./domain-throttle.js";
import type { RateLimiter } from "./rate-limiter.js";
import { withRetry } from "./retry.js";

export interface TaskQueueOptions {
  name: string;
  concurrency: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  rateLimiter?: RateLimiter;
  domainThrottle?: DomainThrottle;
}

export class TaskQueue {
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly options: TaskQueueOptions) {
    this.maxRetries = options.maxRetries ?? 0;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  /**
   * Run handler for each item with bounded concurrency, optional rate limit,
   * per-domain throttle, and retries on transient failures.
   */
  async runAll<T, R>(
    items: T[],
    handler: (item: T, index: number) => Promise<R>,
    getDomains?: (item: T) => string[],
  ): Promise<R[]> {
    if (items.length === 0) return [];

    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const runOne = async (index: number, item: T): Promise<void> => {
      const execute = async (): Promise<R> => {
        if (this.options.rateLimiter) {
          await this.options.rateLimiter.acquire();
        }

        const runHandler = () => handler(item, index);

        if (this.options.domainThrottle && getDomains) {
          const domains = getDomains(item);
          return this.options.domainThrottle.withDomains(domains, runHandler);
        }

        return runHandler();
      };

      const wrapped = () =>
        withRetry(execute, {
          maxRetries: this.maxRetries,
          baseDelayMs: this.retryBaseDelayMs,
          label: `${this.options.name}#${index}`,
        });

      results[index] = await wrapped();
    };

    async function worker(): Promise<void> {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        await runOne(index, items[index]!);
      }
    }

    const workers = Array.from(
      { length: Math.min(this.options.concurrency, items.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }
}
