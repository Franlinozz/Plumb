/**
 * EXTERNAL LIVENESS.
 *
 * Everything else in this system reports on itself. If the VPS dies entirely, all of it goes quiet
 * together — and silence is indistinguishable from a calm market. So one thing pings OUTWARD every
 * minute, and the operator learns about a dead box from a third party rather than from an absence.
 */

export interface HeartbeatOptions {
  /** Uptime-monitor ping URL. Absent means heartbeats are disabled, which is logged once. */
  readonly url?: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly now: () => number;
  readonly fetchFn?: typeof globalThis.fetch;
}

export interface HeartbeatState {
  readonly lastSuccessAt: number | undefined;
  readonly lastAttemptAt: number | undefined;
  readonly consecutiveFailures: number;
  readonly totalSent: number;
  readonly enabled: boolean;
}

export class Heartbeat {
  private lastSuccessAt: number | undefined;
  private lastAttemptAt: number | undefined;
  private consecutiveFailures = 0;
  private totalSent = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: HeartbeatOptions) {}

  get state(): HeartbeatState {
    return {
      lastSuccessAt: this.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      consecutiveFailures: this.consecutiveFailures,
      totalSent: this.totalSent,
      enabled: this.options.url !== undefined,
    };
  }

  /**
   * Send one ping.
   *
   * A failed heartbeat NEVER throws and never affects trading. The monitor noticing our silence is
   * the point — a heartbeat that could crash the process would be worse than none.
   */
  async ping(payload: Record<string, unknown> = {}): Promise<boolean> {
    if (this.options.url === undefined) return false;
    this.lastAttemptAt = this.options.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const fetchFn = this.options.fetchFn ?? globalThis.fetch;
      const response = await fetchFn(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ at: this.lastAttemptAt, ...payload }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.lastSuccessAt = this.lastAttemptAt;
      this.consecutiveFailures = 0;
      this.totalSent += 1;
      return true;
    } catch {
      this.consecutiveFailures += 1;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  start(payload: () => Record<string, unknown> = () => ({})): void {
    if (this.options.url === undefined || this.timer !== undefined) return;
    const interval = this.options.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.ping(payload());
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
