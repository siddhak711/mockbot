/**
 * Counts failed attempts per key inside a sliding window. State lives in this
 * process only: each server instance (and each serverless worker) keeps its
 * own counts, so this slows guessing on one instance rather than enforcing a
 * global limit.
 */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Seconds until the key may try again, or 0 when it is not blocked. */
  retryAfter(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.max) return 0;
    const oldest = recent[0] ?? this.now();
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    this.failures.set(key, recent);
    if (this.failures.size > this.maxKeys) this.prune();
  }

  reset(key?: string): void {
    if (key === undefined) this.failures.clear();
    else this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  private prune(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
    // Still over after dropping expired entries: forget the oldest keys.
    const extra = this.failures.size - this.maxKeys;
    if (extra <= 0) return;
    let dropped = 0;
    for (const key of this.failures.keys()) {
      if (dropped >= extra) break;
      this.failures.delete(key);
      dropped += 1;
    }
  }
}

/** First hop of x-forwarded-for (set by Vercel and most proxies), else x-real-ip. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Failed password attempts per client IP and email: 5 per 15 minutes. Sign-up
 * shares it because a taken email falls through to a password check. Counts
 * live in this process, so each instance limits on its own.
 */
export const passwordAttempts = new AttemptLimiter(5, 15 * 60 * 1000);
