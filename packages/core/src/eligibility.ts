/**
 * The eligibility record — the artifact `@plumb/backtest` produces and `@plumb/executor` refuses
 * to trade without.
 *
 * It lives in core for the same reason `Signal` does: both ends need it, and routing the executor
 * through the backtest package to reach a type would give it a transitive path back to strategy
 * internals.
 *
 * The signature is not a cryptographic authority — anyone with the code can recompute it. Its job
 * is to make a hand-edited `"eligible": true` obvious, so a configuration cannot be promoted to
 * live trading by editing a JSON file.
 */

import { createHash } from 'node:crypto';

export interface EligibilityCriterion {
  readonly name: string;
  readonly passed: boolean;
  readonly actual: string;
}

/** The decisive contents — exactly what the signature covers. */
export interface EligibilitySummary {
  readonly label: string;
  readonly eligible: boolean;
  readonly failedOn: readonly string[];
  readonly criteria: readonly EligibilityCriterion[];
  readonly tradeCount: number;
  readonly profitFactor: number;
  readonly totalReturnUsdt: number;
  readonly maxDrawdownPct: number;
  readonly probabilityOfRuin: number;
  readonly p5Equity: number;
  readonly criteriaUsed: Readonly<Record<string, number>>;
  readonly evaluatedAt: number;
}

export function signEligibility(summary: EligibilitySummary): string {
  const canonical = JSON.stringify({
    label: summary.label,
    eligible: summary.eligible,
    failedOn: summary.failedOn,
    criteria: summary.criteria.map((c) => [c.name, c.passed, c.actual]),
    tradeCount: summary.tradeCount,
    profitFactor: round(summary.profitFactor),
    totalReturnUsdt: round(summary.totalReturnUsdt),
    maxDrawdownPct: round(summary.maxDrawdownPct),
    probabilityOfRuin: round(summary.probabilityOfRuin),
    p5Equity: round(summary.p5Equity),
    criteriaUsed: summary.criteriaUsed,
    evaluatedAt: summary.evaluatedAt,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function verifyEligibility(summary: EligibilitySummary, signature: string): boolean {
  return signEligibility(summary) === signature;
}

function round(value: number): number | string {
  if (!Number.isFinite(value)) return String(value);
  return Number(value.toFixed(8));
}
