import { config } from "../config.js";
import { DomainThrottle } from "./domain-throttle.js";
import { RateLimiter } from "./rate-limiter.js";
import { TaskQueue } from "./task-queue.js";

let sharedDomainThrottle: DomainThrottle | null = null;
let openRouterLimiter: RateLimiter | null = null;

export function getSharedDomainThrottle(): DomainThrottle {
  if (!sharedDomainThrottle) {
    sharedDomainThrottle = new DomainThrottle(config.maxConcurrentPerDomain);
  }
  return sharedDomainThrottle;
}

export function getOpenRouterLimiter(): RateLimiter {
  if (!openRouterLimiter) {
    openRouterLimiter = new RateLimiter(config.openRouterRpm, 60_000);
  }
  return openRouterLimiter;
}

const defaultRetry = {
  maxRetries: config.maxRetries,
  retryBaseDelayMs: config.retryBaseDelayMs,
};

export function createSearchQueue(): TaskQueue {
  return new TaskQueue({
    name: "search",
    concurrency: config.searchConcurrency,
    rateLimiter: new RateLimiter(config.tinyfishSearchRpm, 60_000),
    ...defaultRetry,
  });
}

export function createFetchQueue(): TaskQueue {
  return new TaskQueue({
    name: "fetch",
    concurrency: config.fetchConcurrency,
    rateLimiter: new RateLimiter(config.tinyfishFetchRpm, 60_000),
    domainThrottle: getSharedDomainThrottle(),
    ...defaultRetry,
  });
}

export function createTriageQueue(): TaskQueue {
  return new TaskQueue({
    name: "triage",
    concurrency: config.triageConcurrency,
    rateLimiter: getOpenRouterLimiter(),
    ...defaultRetry,
  });
}

export function createExtractionQueue(): TaskQueue {
  return new TaskQueue({
    name: "extract",
    concurrency: config.extractionConcurrency,
    rateLimiter: getOpenRouterLimiter(),
    ...defaultRetry,
  });
}

export function createAgentQueue(): TaskQueue {
  return new TaskQueue({
    name: "agent",
    concurrency: config.agentConcurrency,
    rateLimiter: new RateLimiter(config.tinyfishAgentRpm, 60_000),
    domainThrottle: getSharedDomainThrottle(),
    ...defaultRetry,
  });
}
