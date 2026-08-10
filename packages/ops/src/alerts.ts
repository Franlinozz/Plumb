/**
 * ALERTING.
 *
 * Four tiers, and the one that matters most is the deduplication. An incident that fires 400
 * messages does not get 400 times the attention — it trains the operator to ignore the channel,
 * which is strictly worse than not alerting at all.
 *
 * Every alert carries current equity, open positions and active halt flags, because "reconcile
 * mismatch" without those is a message that requires opening a laptop to interpret.
 */

export type Severity = 'INFO' | 'WARN' | 'URGENT' | 'CRITICAL';

export interface AlertContext {
  readonly equityUsdt: number;
  readonly openPositions: number;
  readonly haltFlags: Readonly<Record<string, boolean>>;
  readonly mode: string;
}

export interface Alert {
  readonly severity: Severity;
  /** Stable identity for deduplication — one incident, one key. */
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly at: number;
  readonly context: AlertContext;
}

export interface AlertSink {
  send(alert: Alert, body: string): Promise<void>;
}

export interface AlerterOptions {
  readonly sink: AlertSink;
  readonly now: () => number;
  /** Repeat window per key. A CRITICAL repeats sooner than an INFO. */
  readonly dedupeWindowMs?: Partial<Record<Severity, number>>;
  /** Hard ceiling on messages per hour, whatever happens. */
  readonly maxPerHour?: number;
}

const DEFAULT_DEDUPE: Record<Severity, number> = {
  INFO: 6 * 3_600_000,
  WARN: 3_600_000,
  URGENT: 15 * 60_000,
  CRITICAL: 5 * 60_000,
};

export function formatAlert(alert: Alert): string {
  const halts = Object.entries(alert.context.haltFlags)
    .filter(([, on]) => on)
    .map(([flag]) => flag);
  return [
    `[${alert.severity}] ${alert.title}`,
    alert.detail,
    '',
    `equity ${alert.context.equityUsdt.toFixed(2)} USDT · open positions ${alert.context.openPositions} · ` +
      `mode ${alert.context.mode}`,
    `halt flags: ${halts.length === 0 ? 'none' : halts.join(', ')}`,
    new Date(alert.at).toISOString(),
  ].join('\n');
}

export class Alerter {
  private readonly lastSent = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private readonly hourWindow: number[] = [];

  readonly sent: Alert[] = [];

  constructor(private readonly options: AlerterOptions) {}

  /**
   * Send, unless this exact incident was reported recently.
   *
   * A suppressed alert is COUNTED, and the count is attached to the next one that gets through —
   * so the operator learns "this happened 37 more times" rather than losing the information.
   */
  async raise(
    severity: Severity,
    key: string,
    title: string,
    detail: string,
    context: AlertContext,
  ): Promise<{ readonly sent: boolean; readonly reason?: string }> {
    const now = this.options.now();
    const window = { ...DEFAULT_DEDUPE, ...this.options.dedupeWindowMs }[severity];
    const last = this.lastSent.get(key);

    if (last !== undefined && now - last < window) {
      this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return { sent: false, reason: 'deduplicated' };
    }

    // The global ceiling. A storm of DISTINCT keys is still a storm.
    while (this.hourWindow.length > 0 && now - (this.hourWindow[0] as number) > 3_600_000) {
      this.hourWindow.shift();
    }
    const ceiling = this.options.maxPerHour ?? 30;
    if (this.hourWindow.length >= ceiling && severity !== 'CRITICAL') {
      this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return { sent: false, reason: 'hourly ceiling reached' };
    }

    const repeats = this.suppressed.get(key) ?? 0;
    this.suppressed.delete(key);
    const alert: Alert = {
      severity,
      key,
      title,
      detail: repeats === 0 ? detail : `${detail}\n(also occurred ${repeats} more times since the last alert)`,
      at: now,
      context,
    };

    this.lastSent.set(key, now);
    this.hourWindow.push(now);
    this.sent.push(alert);
    await this.options.sink.send(alert, formatAlert(alert));
    return { sent: true };
  }

  suppressedCount(key: string): number {
    return this.suppressed.get(key) ?? 0;
  }

  countsBySeverity(): Readonly<Record<Severity, number>> {
    const counts: Record<Severity, number> = { INFO: 0, WARN: 0, URGENT: 0, CRITICAL: 0 };
    for (const alert of this.sent) counts[alert.severity] += 1;
    return counts;
  }
}

/** Webhook sink. Never logs the URL — it is a credential. */
export function webhookSink(url: string, timeoutMs = 10_000): AlertSink {
  return {
    async send(alert, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: body, severity: alert.severity, key: alert.key }),
          signal: controller.signal,
        });
      } catch {
        // An alerting failure must never take the trading system down with it. The watchdog's
        // job is to halt trading; the alerter's job is best-effort notification.
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Console sink, for drills and for when no webhook is configured. */
export function consoleSink(log: (line: string) => void = console.log): AlertSink {
  return {
    async send(_alert, body) {
      log(body);
    },
  };
}
