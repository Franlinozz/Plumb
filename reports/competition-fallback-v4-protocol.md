# Competition fallback v4 — predeclared protocol

Frozen before first replay: 2026-08-22 UTC

## Status: RESEARCH ONLY — NOT AUTHORISED FOR LIVE EXECUTION

The 15m fallback is permanently rejected (1,102 OOS trades, PF 0.924, net -166.54 USDT). This is a
separate hypothesis, not a parameter repair. It preserves the higher-timeframe structure of the
development-positive but sparse `competition_trend_pullback@3.0.0`, while removing conjunctions
that made a live signal exceptionally rare.

There is no unused protected holdout. This candidate uses development data only and can never be
described as independently validated. P8, v3, the failed holdout and the current live monitor stay
untouched.

## Candidate fixed before replay

Identifier: `competition_trend_continuation@4.0.0`

Universe: BTC-USDT-SWAP, ETH-USDT-SWAP, SOL-USDT-SWAP. Decision timeframe: fully closed 1H bars.
Fully closed, contiguous UTC 4H bars are reconstructed from the same 1H history.

1. 4H EMA20/EMA50 and directional movement must agree, with ADX at least 20.
2. For a long, the 1H close must be above EMA20, EMA20 must be non-decreasing, the current close
   must exceed the prior close, RSI must be 48–72, and MACD histogram must improve. Short is exact
   symmetry: below EMA20, non-increasing EMA20, lower close, RSI 28–52, worsening histogram.
3. MACD need not already be above/below zero. The exact prior-bar EMA cross and prior-bar high/low
   break from v3 are removed.
4. Current volume must be at least 50% of the prior 20-bar mean. It is a dead-market veto, not a
   rare activity confirmation.
5. Stop is the farther of the six-bar swing plus 0.25 ATR and 1.5% from entry. Reject beyond 2.0%.
6. One take-profit at 2R; maximum hold 24 bars; validity one hour. Stop wins an ambiguous same-bar
   stop/target collision. Entry is the next bar open with pessimistic taker costs and slippage.

Live-only vetoes, if separately authorised: spread at most 2 bps; absolute funding at most 10 bps;
veto severe deleveraging if 1H OI is below -1.0% or 4H OI below -3.0%; projected net target at
least 5.50 USDT; all existing halt, freshness, cost, account, signed-reconciliation, one-shot,
A2A-before-execution, Agent Trade Kit and attached-exit requirements remain mandatory.

## One-run evaluation

- Development partition only through 2026-05-12; holdout and competition data excluded.
- Walk-forward 60-day IS / 20-day OOS / 20-day step; seed `20260823`.
- Corrected backtest with first take-profit, next-bar entry, full fees, slippage and funding.
- Minimum: 120 OOS trades, positive net, PF >=1.15, P(ruin) <=5%, no kill-floor breach,
  >=50% profitable windows, both chronological halves positive, positive without best ten, and
  every instrument >=20 trades with positive net.
- If the default passes, one-parameter neighbours (4H ADX 18/22, volume 40/60%, RSI bands one
  point wider/narrower) are stability vetoes only. At least four of six must remain net-positive
  with PF above 1, and 1.5x non-funding friction must remain positive.

Any primary failure permanently rejects v4 and stops the secondary runs. Passing means only that
the operator may consider an explicit evidence-limited amendment; it is not a profit guarantee.
