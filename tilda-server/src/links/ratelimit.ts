// tilda-server/src/links/ratelimit.ts
export interface RateLimiter { allow(key: string, now: number): boolean }

/** Fixed-window counter per key; the map is pruned when it grows past 10k keys. */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key, now) {
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      if (w.count >= limit) return false;
      w.count += 1;
      return true;
    },
  };
}
