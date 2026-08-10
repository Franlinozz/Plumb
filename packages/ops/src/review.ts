/**
 * THE DAILY WRITTEN REVIEW.
 *
 * Once a day, Claude reads the day's ledger and writes the operator a plain-English account of
 * what happened: what fired, what the governor caught, what looks anomalous, what to watch.
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS A MORNING READ, NOT AN INPUT TO TRADING.                                            │
 * │                                                                                             │
 * │ Prose only. No number it produces re-enters the system, and nothing it suggests executes.   │
 * │ It cannot change a parameter, place an order, clear a halt, or be parsed for a decision —   │
 * │ the return value is a string that goes to the operator and nowhere else.                    │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 */

export interface DayLedger {
  readonly dateUtc: string;
  readonly signalsEmitted: number;
  readonly signalsPublished: number;
  readonly vetoesByReason: Readonly<Record<string, number>>;
  readonly gateRejectionsByReason: Readonly<Record<string, number>>;
  readonly tradesOpened: number;
  readonly tradesClosed: number;
  readonly realisedPnlUsdt: number;
  readonly equityStartUsdt: number;
  readonly equityEndUsdt: number;
  readonly peakEquityUsdt: number;
  readonly drawdownPct: number;
  readonly drawdownRung: string;
  readonly haltFlags: Readonly<Record<string, boolean>>;
  readonly cyclesCompleted: number;
  readonly cyclesSkipped: number;
  readonly degradedSnapshots: number;
  readonly venueErrors: number;
  readonly reconcileIssues: number;
  readonly alertsBySeverity: Readonly<Record<string, number>>;
}

export interface ReviewDeps {
  readonly complete?: (prompt: string, system: string) => Promise<string>;
  readonly apiKey?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface ReviewResult {
  readonly text: string;
  readonly source: 'model' | 'template';
  readonly fallbackReason?: string;
}

const SYSTEM = [
  'You write a short daily operations review for the operator of an automated futures trading',
  'system. You are given the day\'s ledger. Write 150-250 words of plain prose.',
  '',
  'Cover, in this order: what the system did, what the risk governor stopped and whether that',
  'pattern is normal, anything anomalous, and what to watch tomorrow.',
  '',
  'RULES:',
  '- Prose only. No bullet lists, no headings, no JSON.',
  '- Do NOT recommend parameter changes. Do NOT predict. Do NOT give trading advice.',
  '- A quiet day is a fine outcome — say so plainly rather than manufacturing significance.',
  '- If the governor vetoed heavily, that is the system working, not a fault.',
  '- Be direct. The reader is the person who built this and wants to know what actually happened.',
].join('\n');

/**
 * The deterministic fallback — a factual summary with no interpretation.
 *
 * The operator always gets their morning read; without the model it is simply a plainer one.
 */
export function templateReview(ledger: DayLedger): string {
  const topVetoes = Object.entries(ledger.vetoesByReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');
  const halts = Object.entries(ledger.haltFlags)
    .filter(([, on]) => on)
    .map(([f]) => f);
  const pnl = ledger.realisedPnlUsdt;

  return [
    `${ledger.dateUtc}: ${ledger.cyclesCompleted} cycles completed` +
      (ledger.cyclesSkipped > 0 ? `, ${ledger.cyclesSkipped} skipped` : '') +
      `. ${ledger.signalsEmitted} signals emitted and ${ledger.signalsPublished} published.`,
    `${ledger.tradesOpened} positions opened, ${ledger.tradesClosed} closed, for a realised ` +
      `${pnl >= 0 ? 'gain' : 'loss'} of ${Math.abs(pnl).toFixed(2)} USDT. Equity moved from ` +
      `${ledger.equityStartUsdt.toFixed(2)} to ${ledger.equityEndUsdt.toFixed(2)}, ` +
      `${ledger.drawdownPct.toFixed(1)}% below peak (${ledger.drawdownRung}).`,
    topVetoes === ''
      ? 'The governor vetoed nothing today.'
      : `The governor's most frequent vetoes were ${topVetoes}.`,
    ledger.degradedSnapshots > 0 || ledger.venueErrors > 0
      ? `Data incidents: ${ledger.degradedSnapshots} degraded snapshots, ${ledger.venueErrors} venue errors.`
      : 'No data incidents.',
    ledger.reconcileIssues > 0
      ? `RECONCILIATION ISSUES: ${ledger.reconcileIssues}. This is a P0 — every fill must trace to a published signal.`
      : 'Reconciliation was clean.',
    halts.length > 0 ? `Active halt flags: ${halts.join(', ')}.` : 'No halt flags are set.',
    '(Model unavailable — this is the deterministic summary.)',
  ].join(' ');
}

export function buildReviewPrompt(ledger: DayLedger): string {
  return [
    `Date (UTC): ${ledger.dateUtc}`,
    '',
    `Cycles completed: ${ledger.cyclesCompleted}, skipped: ${ledger.cyclesSkipped}`,
    `Signals emitted: ${ledger.signalsEmitted}, published: ${ledger.signalsPublished}`,
    `Positions opened: ${ledger.tradesOpened}, closed: ${ledger.tradesClosed}`,
    `Realised PnL: ${ledger.realisedPnlUsdt.toFixed(2)} USDT`,
    `Equity: ${ledger.equityStartUsdt.toFixed(2)} → ${ledger.equityEndUsdt.toFixed(2)} (peak ${ledger.peakEquityUsdt.toFixed(2)})`,
    `Drawdown: ${ledger.drawdownPct.toFixed(2)}% — ladder rung "${ledger.drawdownRung}"`,
    '',
    `Governor vetoes: ${JSON.stringify(ledger.vetoesByReason)}`,
    `Pre-emission gate rejections: ${JSON.stringify(ledger.gateRejectionsByReason)}`,
    '',
    `Degraded snapshots: ${ledger.degradedSnapshots}`,
    `Venue errors: ${ledger.venueErrors}`,
    `Reconciliation issues: ${ledger.reconcileIssues}`,
    `Halt flags: ${JSON.stringify(ledger.haltFlags)}`,
    `Alerts: ${JSON.stringify(ledger.alertsBySeverity)}`,
  ].join('\n');
}

/**
 * Generate the review.
 *
 * Returns a STRING for the operator. There is no structured output, deliberately — a structured
 * review invites a future caller to parse a field out of it and act on it.
 */
export async function generateReview(ledger: DayLedger, deps: ReviewDeps = {}): Promise<ReviewResult> {
  const complete = deps.complete ?? (deps.apiKey === undefined ? undefined : anthropicCompletion(deps));
  if (complete === undefined) {
    return { text: templateReview(ledger), source: 'template', fallbackReason: 'no model configured' };
  }

  let raw: string;
  try {
    raw = await complete(buildReviewPrompt(ledger), SYSTEM);
  } catch (error) {
    return {
      text: templateReview(ledger),
      source: 'template',
      fallbackReason: `model unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const text = raw.trim();
  if (text.length < 60) {
    return { text: templateReview(ledger), source: 'template', fallbackReason: 'model returned too little' };
  }
  return { text, source: 'model' };
}

function anthropicCompletion(deps: ReviewDeps) {
  return async (prompt: string, system: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 30_000);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': deps.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: deps.model ?? 'claude-sonnet-5',
          max_tokens: 700,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { content?: Array<{ text?: string }> };
      return body.content?.[0]?.text ?? '';
    } finally {
      clearTimeout(timer);
    }
  };
}
