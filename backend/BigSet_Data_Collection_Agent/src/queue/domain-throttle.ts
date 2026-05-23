/**
 * Limits concurrent work per domain (e.g. max 2 fetches on yelp.com at once).
 */
export class DomainThrottle {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly maxPerDomain: number) {}

  async acquire(domain: string): Promise<() => void> {
    if (!domain) {
      return () => undefined;
    }

    await new Promise<void>((resolve) => {
      const tryAcquire = (): void => {
        const count = this.active.get(domain) ?? 0;
        if (count < this.maxPerDomain) {
          this.active.set(domain, count + 1);
          resolve();
          return;
        }
        const queue = this.waiters.get(domain) ?? [];
        queue.push(tryAcquire);
        this.waiters.set(domain, queue);
      };
      tryAcquire();
    });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.active.get(domain) ?? 1) - 1;
      if (count <= 0) {
        this.active.delete(domain);
      } else {
        this.active.set(domain, count);
      }
      const queue = this.waiters.get(domain);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        next();
      }
    };
  }

  async withDomains<T>(domains: string[], fn: () => Promise<T>): Promise<T> {
    const unique = [...new Set(domains.filter(Boolean))].sort();
    const releases: Array<() => void> = [];

    try {
      for (const domain of unique) {
        releases.push(await this.acquire(domain));
      }
      return await fn();
    } finally {
      for (const release of releases.reverse()) {
        release();
      }
    }
  }
}
