type WindowEntry = { count: number; resetAt: number };
type RateLimitState = typeof globalThis & { resqivaRateLimits?: Map<string, WindowEntry> };

const state = globalThis as RateLimitState;
const windows = state.resqivaRateLimits ?? (state.resqivaRateLimits = new Map());

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Per-process fixed-window limiter; use a shared store before scaling to multiple instances. */
export function checkRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    const entry = { count: 1, resetAt: now + windowMs };
    windows.set(key, entry);
    prune(now);
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  if (current.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - current.count), retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

export function requestRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  const address = (real || forwarded || "unknown").slice(0, 128);
  return `${new URL(request.url).pathname}:${address}`;
}

function prune(now: number) {
  if (windows.size < 2000) return;
  for (const [key, value] of windows) {
    if (value.resetAt <= now) windows.delete(key);
  }
  if (windows.size >= 2000) {
    const oldestKey = windows.keys().next().value;
    if (oldestKey) windows.delete(oldestKey);
  }
}
