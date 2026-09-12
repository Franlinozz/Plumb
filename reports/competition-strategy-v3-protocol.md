# Competition strategy v3 — predeclared research protocol

Frozen before the first v3 replay: 2026-08-20 UTC

## Status: RESEARCH ONLY — NOT LIVE-ELIGIBLE

This protocol responds to the permanent protected-holdout failure of `vol_expansion@1.1.0` without
editing, rerunning, relabelling or bypassing that result. It defines one structurally different
candidate before measuring it. Competition-period prices and leaderboard outcomes are excluded
from parameter selection and backtest input.

There is no unused protected holdout. Consequently, even a development PASS is insufficient for
live promotion under the existing constitution. A live deployment would require a separately
recorded operator decision acknowledging that evidence limitation; the code must never claim that
the original holdout passed.

## Candidate fixed before replay

Identifier: `competition_trend_pullback@3.0.0`

Universe for research: BTC-USDT-SWAP, ETH-USDT-SWAP and SOL-USDT-SWAP. Any possible first
competition deployment remains ETH-only and minimum-lot sized under the existing v2 damage caps.

The candidate is symmetric. It does not predict a direction in advance:

1. Reconstruct fully closed UTC-aligned 4H bars from the 1H development series.
2. Require 4H EMA20/EMA50 direction, ADX at least 25 and matching directional movement.
3. Require a 1H pullback through EMA20 followed by a close back with the 4H trend and through the
   prior 1H extreme.
4. Require RSI in a non-exhausted continuation band: 50–68 long, 32–50 short.
5. Require MACD histogram to agree and improve in the trade direction.
6. Require current volume at least 80% of the prior 20-bar mean.
7. Put the structural stop beyond the six-bar swing plus 0.25 ATR; sizing remains the governor's
   responsibility. Take-profit and maximum hold use the existing deterministic configuration.

The live-only decision layer, if ever authorised, must additionally require fresh market/account
state, signed reconciliation, no halt, price-and-OI directional participation, full friction at the
existing 3x cost multiple, active-subscriber publication acknowledgements and the exact Agent Trade
Kit order path.

## One-run evaluation

- Data: development partition only, ending 2026-05-12; protected holdout and competition period
  excluded.
- Walk-forward: fixed 60-day in-sample / 20-day out-of-sample / 20-day step.
- Costs: existing default OKX fee, slippage and funding model.
- Starting capital and all locked governor parameters: unchanged.
- Seed: `20260820`.
- No parameter sweep and no neighbour may replace this candidate after seeing results.
- Report every zero-trade, losing or unstable result as a failure; do not repair the candidate from
  the output in this competition.

Minimum development evidence for further consideration: at least 30 OOS trades, PF above 1,
positive net result, no kill-floor breach, Monte Carlo ruin at or below the existing 5% ceiling,
positive first and second chronological halves, and positive result without the three best trades.
Passing these checks would mean only “worthy of future validation,” not “proven profitable” or
“approved for live trading.”
