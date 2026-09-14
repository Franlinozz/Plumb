# Post-competition operating plan

Status: **forward research active; autonomous live execution locked**.

Stage 2 protocol v1 result (2026-09-14): H1 passed development but failed its single validation
look; H3 failed development; H2 remains unmeasured pending a causal historical open-interest data
path. Consequently no v1 candidate is eligible for Stage 3. See
`reports/post-competition-development-v1.md` and `reports/post-competition-validation-v1.md`.

Season 1 is finished and its reward has been claimed. Competition-only deadlines, one-shot entry
authorisations and payoff exceptions are historical evidence; none authorises a future order.

## Objective

Run Plumb continuously as an autonomous signal and execution system only when a strategy has shown
positive expectancy after realistic costs on data that was not used to design it. Profit cannot be
guaranteed; the engineering objective is to reject weak signals, bound losses and make every action
auditable.

## Stage 1 — reconstruct observation infrastructure

- Record public ticker, mark, index, funding, open interest, instrument metadata and closed candles
  for BTC, ETH and SOL continuously.
- Record event-level public trades plus best bid/ask and 20-level depth observations before
  researching passive execution or adverse selection.
- Preserve raw source timestamps and ingestion timestamps.
- Alert on recorder gaps and data staleness.
- Never read the consumed 2026-05-12 → 2026-08-10 holdout for candidate selection.

Exit: 30 uninterrupted days with no unexplained gap greater than two collection intervals.

## Stage 2 — frozen hypothesis research

- Predeclare at most three hypotheses, their features, direction rules, costs and rejection criteria.
- Use the historical development set for implementation checks only.
- Include fees, spread, slippage, funding, latency, next-observation execution and adverse selection.
- Reject any result dependent on one instrument, one regime or a handful of outliers.
- Do not tune a failed candidate until it passes.

Exit: one frozen candidate passes the existing development robustness gate without changing a
threshold after seeing its result.

## Stage 3 — forward shadow trading

- Emit immutable signals in real time and record the executable quote available after each signal.
- Apply the real governor and position lifecycle with simulated fills.
- Publish shadow signals to the ledger and optional Discord channel, clearly labelled `SHADOW`.
- Measure net expectancy, fill probability, drawdown, calibration and regime stability.

Minimum gate, fixed before the first shadow signal:

| Check | Requirement |
| --- | --- |
| Duration | at least 60 calendar days |
| Closed trades | at least 30 |
| Net result | positive after observed costs |
| Profit factor | at least 1.20 |
| Outlier independence | positive without the best three trades |
| Maximum drawdown | no more than 10% |
| Kill-floor breach | none |
| Reconciliation | zero unexplained mismatches |
| Data integrity | no signal evaluated on stale/incomplete inputs |

If a criterion fails, the candidate is rejected. A revised candidate starts a new forward clock.

## Stage 4 — canary execution

Requires an explicit operator decision after Stage 3 passes. Start with a separate trade-only OKX
sub-account, no withdrawal permission, IP allowlisting and materially smaller risk than the locked
ceiling. Observe the first complete publish → order → bracket → fill → exit → reconciliation cycle.

No unattended live execution begins until all of these are true:

1. dependency audit, tests, typecheck and build pass;
2. forward evidence gate passes without post-result edits;
3. Discord/webhook alert delivery is tested;
4. stale-data, venue-outage, restart and ambiguous-write drills pass;
5. the account is signed-flat and free of pending orders before arming;
6. the operator supplies the new live-mode authorization and risk allocation.

## Non-goals

- Trading merely to remain active.
- Reusing competition deadline exceptions.
- Promising profitability.
- Allowing an LLM, social post or leaderboard to choose order numbers or direction.
- Reopening the consumed holdout.
