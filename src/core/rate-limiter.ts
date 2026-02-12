import { logDebug } from "./logging.js";

/**
 * Rate limiter that serializes requests via a promise chain.
 * Each call appends to the chain, ensuring only one request
 * executes at a time with the configured delay between them.
 */
export class RateLimiter {
  private chain: Promise<void> = Promise.resolve();
  private lastRequestTime = 0;
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  waitIfNeeded(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.delayMs) {
        const waitTime = this.delayMs - elapsed;
        logDebug(`Rate limiting: waiting ${waitTime}ms`);
        await new Promise<void>((r) => setTimeout(r, waitTime));
      }
      this.lastRequestTime = Date.now();
    });
    return this.chain;
  }
}
