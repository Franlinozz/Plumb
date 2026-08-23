# Competition last-minute strategy review

Generated 2026-08-23 UTC. This is an evidence and safety review, not a profit guarantee.

## Decision: RED — do not arm an easier fallback

The attempt to produce a materially more frequent, evidence-backed competition strategy failed.
All three predeclared alternatives lost after fees, slippage and funding on development-only
walk-forward tests. A newly found backtest defect also weakened the evidence for the existing v3
strategy. The isolated autonomous competition-entry timer has therefore been paused fail-closed.
The P8 runner remains active and untouched.

## Competition and delivery constraints retained

- The OKX.AI Trading Hackathon competition window ends 2026-08-25 12:00 UTC+8
  (2026-08-25 04:00 UTC). The self-imposed research cutoff was 2026-08-23 16:00 UTC.
- The desired prize zone is rank 4–40, but leaderboard position is an outcome, not a valid strategy
  input. Competition-period returns and current leaderboard moves were excluded from candidate
  selection.
- A scored order must correspond to the participating ASP's signal and use Agent Trade Kit. Plumb's
  publish-before-execute, active-subscription, native TP/SL, idempotency, signed reconciliation and
  hard-exit safeguards remain mandatory.
- The ASP must remain online and useful to subscribers even when there is no executable trade.

## Research basis

The literature supports a hypothesis, not a guaranteed order. Longer-horizon crypto time-series
momentum has published evidence, and Bitcoin intraday momentum has been associated with high-volume
or high-volatility sessions. More recent walk-forward work also finds that naive hourly conversion
of forecasts into trades fails at about 10 bps of friction and that cost-aware selectivity is
decisive. These findings motivated regime alignment, participation filters and an explicit cost
gate. They do not establish that a particular BTC, ETH or SOL perpetual entry will be profitable.

Primary sources:

- https://www.nber.org/papers/w24877
- https://onlinelibrary.wiley.com/doi/abs/10.1111/fire.12290
- https://arxiv.org/abs/2606.00060
- https://www.okx.com/docs-v5/agent_en/
- https://web3.okx.com/onchainos/dev-docs/okxai/a2a-subscription
- https://www.okx.ai/hackathon

Social posts, influencer calls and leaderboard imitation were reviewed only as idea sources and
were not permitted to set direction, thresholds or size. They are not reproducible evidence.

## Critical correction: take-profit was absent from historical replay

The backtest engine previously modeled stop, timeout and flatten exits but did not close a position
when its first attached take-profit was hit. Live execution did attach and verify TP/SL, so this was
an evidence defect rather than a venue-order defect. The engine now:

1. persists the signal's first take-profit in the simulated position;
2. charges exit slippage and fees when that target fills;
3. gives the stop precedence when one OHLC candle touches both target and stop; and
4. rejects a replayed signal without the take-profit required by live execution.

Targeted regression tests and TypeScript compilation pass.

## Frozen development results

| Candidate | OOS trades | Net USDT | PF | Positive windows | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| 15m continuation | 1,102 | -166.54 | 0.924 | 12/29 | FAIL |
| Broad 1H trend continuation | 959 | -350.76 | 0.824 | 12/47 | FAIL |
| Final 4H trend + 1H reclaim/break | 330 | -212.12 | 0.731 | 15/47 | FAIL |

The final candidate failed across every instrument: BTC -124.37, ETH -52.32 and SOL -35.43 USDT.
Its two chronological halves were both negative, and removing its five best trades yielded
-248.87 USDT. Sensitivity and 1.5x-friction runs were correctly skipped after primary failure.

## Exact v3 re-audit with corrected target handling

| Measure | Original report | TP-aware exact replay |
| --- | ---: | ---: |
| OOS trades | 53 | 54 |
| Net USDT | +141.42 | +15.22 |
| Profit factor | 1.900 | 1.121 |
| P(ruin) | 3.78% | 2.72% |
| Profitable windows | 12/47 | 15/47 |
| Without best three | +8.27 | -1.57 |

The corrected run's first half was +27.23 but its second half was -12.01. BTC lost -14.77 while
ETH made +11.59 and SOL +18.40. It therefore fails the v3 protocol's requirements for two positive
halves and a positive result without the best three trades. The generic repository eligibility
record still returned true because it checks a broader legacy rubric; the frozen v3 protocol is
the controlling gate for this candidate.

## What this means

The scarcity problem is real, but relaxing the trigger is not a solution supported by Plumb's own
data. The observed pattern is consistent across three designs: frequency increases turnover faster
than predictive edge, and friction plus false continuations dominate. A last-minute indicator,
social-sentiment rule, lower timeframe, wider RSI band, or leaderboard-driven direction would be a
new unvalidated strategy, not an expert fix.

No source can make a near-term trade “almost perfect.” The only evidence-backed inference is that
forcing more opportunities materially worsens Plumb's expected outcome.

## Safe remaining path

1. Keep the autonomous competition-entry timer paused. Do not arm v1, v4 or v5.
2. Preserve the already completed signal-corresponding trade and capital rather than manufacture
   turnover for visibility. Absence from the public board can reflect its stated minimal-change or
   status filters; it is not evidence that a larger trade will cure eligibility.
3. Keep the ASP heartbeat, active-subscription delivery, reconciler and hard-exit protection
   healthy. No-trade notices may describe real vetoes but must not masquerade as executable signals.
4. Before any further live entry, require a new written operator amendment that explicitly accepts
   the corrected v3 failure and supplies a reason other than deadline pressure. Even then, the
   system should not label the order evidence-approved.
5. After the competition, acquire a genuinely untouched forward sample and event-level spread/book
   data, model passive fill probability and adverse selection, then test a small number of frozen
   hypotheses. Do not reuse the consumed holdout.

## Current operational state at review

- `plumb-okxai-v3-opportunity-monitor.timer`: inactive by deliberate fail-closed pause.
- `plumb-okxai-v3-opportunity-monitor.service`: inactive; last BTC/ETH/SOL cycle completed with no
  approved signal and no execution.
- `plumb-okxai-a2a.service` and `plumb-asp.service`: active; public health endpoint responds.
- `plumb-runner.service` (P8): process active and unchanged by this work, but **not healthy for new
  trading**. Its pre-existing state has `manual=true`, `reconcileMismatch=true`, and one demo
  position; runner logs repeatedly fail closed and request watchdog flattening. The flags have been
  present since 2026-08-18. Repair/restart is outside this competition-research change and the P8
  protection mandate forbids casually mutating it.
- Protected holdout read by this work: no.
- Competition-period data used to choose parameters: no.
- New live order placed by this work: no.
- Verification: 55 test files / 667 tests passed; TypeScript typecheck passed; research candidates
  are exported for explicit evaluation but absent from the default `ALL_STRATEGIES` registry.

## Subsequent operator decision — 2026-08-23 06:05 UTC

After receiving the TP-aware findings and the explicit comparison between preserving capital and a
bounded contest-risk option, the operator supplied the exact written authorization
`AUTHORIZE TP-AWARE V3 PRIZE-OPTION`. This supersedes only item 1 of the safe remaining path above:
the isolated one-shot v3 timer may be re-armed through the existing 2026-08-23T16:00:00Z personal
entry cutoff. All other findings remain controlling. In particular, v3 remains evidence-limited,
the market gate may not be relaxed, no failed fallback may be armed, and the existing damage,
publication, Agent Trade Kit, attached-exit, idempotency and reconciliation constraints remain
unchanged.

The timer was re-enabled at 2026-08-23 06:09 UTC after the live account preflight passed all eight
checks and the isolated and full test runs passed (76/76 focused; 667/667 full; TypeScript clean).
The immediate BTC/ETH/SOL cycle completed successfully with all three gates red, created no durable
one-shot state, published no signal and placed no order. The timer remains active on its 15-minute
schedule and the code-level cutoff remains 2026-08-23T16:00:00Z.
