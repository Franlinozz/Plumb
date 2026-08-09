import { LOCKED } from '@plumb/core';

/**
 * @plumb/asp — the ASP surface: the subscription feed and the published signal ledger.
 *
 * Placeholder. The real surface lands in a later phase. Two competition rules shape it and
 * are worth stating here because getting either wrong forfeits eligibility outright:
 *
 *  - **Exactly ONE subscription service**, created once. If several exist, the
 *    earliest-created is the scoring basis — and DELETING IT MID-COMPETITION FORFEITS
 *    ELIGIBILITY. There is no code in this repository that deletes a service.
 *  - **It must stay online and subscribable for the full two weeks.** Downtime is a
 *    scoring risk, so it is an engineering requirement, not an ops nicety.
 */
export const ASP_PACKAGE = Object.freeze({
  name: '@plumb/asp',
  /** Writes signals to the feed and the ledger BEFORE the executor may act (guardrail 2). */
  responsibility: 'publish',
  /** Exactly one, created once, never deleted. */
  subscriptionServiceCount: 1,
  instruments: LOCKED.INSTRUMENTS,
});
