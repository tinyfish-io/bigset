import { sleep } from "./retry.js";

/**
 * Token-bucket style limiter: at most `maxRequests` starts per `intervalMs`.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly maxRequests: number,
    private readonly intervalMs: number,
  ) {
    this.tokens = maxRequests;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed < this.intervalMs) return;

    const periods = Math.floor(elapsed / this.intervalMs);
    this.tokens = Math.min(
      this.maxRequests,
      this.tokens + periods * this.maxRequests,
    );
    this.lastRefillAt += periods * this.intervalMs;
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.min(250, this.intervalMs));
    }
  }
}
