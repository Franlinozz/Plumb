import { DERIVED, LOCKED } from '@plumb/core';

/**
 * @plumb/risk — the deterministic risk governor.
 *
 * Placeholder. The real governor lands in a later phase: it sizes a position from the stop
 * distance, checks every locked limit, and stamps a signal `approved` or `vetoed` with a
 * reason. No model is consulted anywhere in that path (guardrail 4), and its counters —
 * daily loss, peak equity, drawdown, halt flags — are persisted, so a crash or restart
 * never resets one (guardrail 6).
 */
export const RISK_PACKAGE = Object.freeze({
  name: '@plumb/risk',
  /** May veto any signal. Never creates one. */
  responsibility: 'veto',
  /** Every arithmetic input is a locked parameter, never a model output. */
  limits: LOCKED,
  /** Flat everything, halt permanently, require a manual re-arm. */
  killSwitchEquityUsdt: DERIVED.killSwitchEquityUsdt,
  /** Guardrail 6 — counters survive a restart. */
  statePersisted: true,
});

export type RiskVerdict = 'approved' | 'vetoed';
