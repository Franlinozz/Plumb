import { LOCKED } from '@plumb/core';
import { ASP_PACKAGE } from '@plumb/asp';
import { RISK_PACKAGE } from '@plumb/risk';

/**
 * @plumb/executor — OKX Agent Trade Kit execution.
 *
 * Placeholder. The real executor lands in a later phase. Its contract is fixed now:
 *
 *  - It reads approved signals out of the **published** feed (`@plumb/asp`), never out of
 *    strategy internals (guardrail 2). That is what makes a fill provably signal-derived.
 *  - It refuses any signal whose risk verdict is not `approved` (guardrail 1).
 *  - It brackets at placement: **no stop → no order** (guardrail 3).
 *  - It reconciles every fill back to a signal ID; an unmatched fill raises an alarm and
 *    halts trading immediately (guardrail 5).
 */
export const EXECUTOR_PACKAGE = Object.freeze({
  name: '@plumb/executor',
  responsibility: 'execute',
  /** Guardrail 2 — the published feed is the only input. */
  readsFrom: ASP_PACKAGE.name,
  /** Guardrail 1 — anything else is refused. */
  requiresVerdict: 'approved',
  /** Guardrail 3 — bracket at placement, or no order at all. */
  requiresStopBeforeOpen: true,
  /** Guardrail 5 — an orphan fill halts trading. */
  haltsOnUnmatchedFill: true,
  vetoedBy: RISK_PACKAGE.name,
  /** Only trades through the Agent Trade Kit count toward the competition. */
  accountingBasis: LOCKED.ACCOUNTING_BASIS,
});
