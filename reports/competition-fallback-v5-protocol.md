# Competition fallback v5 — final predeclared protocol

Frozen before first replay: 2026-08-22 UTC

## Status: RESEARCH ONLY — FINAL ALTERNATIVE

Two frequent alternatives are permanently rejected: the 15m continuation (1,102 OOS trades,
PF 0.924) and broad 1H trend continuation (959 trades, PF 0.824). This final hypothesis makes the
smallest practical relaxation of `competition_trend_pullback@3.0.0`; it is not a broad momentum
rule and no further candidate will be designed from its result during this competition.

Identifier: `competition_trend_reclaim@5.0.0`.

Universe BTC/ETH/SOL USDT swaps; fully closed 1H decisions and contiguous UTC 4H aggregation.

1. Keep v3's closed 4H EMA20/EMA50 and directional-movement agreement with ADX >=25.
2. A long requires either (a) prior close at/below EMA20 and current close above it, or (b) current
   close above the previous three-bar high while already above EMA20. Short is symmetric.
3. Keep directional MACD sign, but remove the additional “improving versus previous histogram”
   conjunction. RSI is 48–70 long / 30–52 short.
4. Volume must be at least 60% of the prior 20-bar mean.
5. Stop is the farther of the six-bar swing plus 0.25 ATR and 1.5%; reject beyond 2.0%.
6. First and only TP is 2R, maximum hold 24 hours, validity one hour. Stop wins ambiguous candles;
   next-bar entry and all pessimistic costs apply.

Live OI is a severe-unwind veto (1H below -1% or 4H below -3%), not mandatory positive
confirmation. Spread <=2 bps, absolute funding <=10 bps, projected net target >=5.50 USDT, and all
existing account, A2A, Agent Trade Kit, stop, idempotency, reconciliation and hard-exit gates remain.

Evaluation: development only through 2026-05-12; holdout and competition period excluded; 60d IS /
20d OOS / 20d step; seed 20260823; corrected TP-aware engine. Primary pass requires >=60 OOS
trades, positive net, PF >=1.20, P(ruin) <=5%, no kill-floor breach, >=40% profitable windows,
positive chronological halves, positive without best five, and each instrument >=12 trades with
positive net. Passing then requires four of six one-parameter stability neighbours and a positive
1.5x-friction stress run. Failure is final and keeps the fallback unarmed.

## Final result: FAIL / DO NOT ARM

The exact predeclared candidate produced 330 out-of-sample trades, net **-212.12 USDT**, profit
factor **0.731**, and only **15/47** profitable walk-forward windows. Both chronological halves
lost money; every instrument lost money; removing the five best trades reduced net PnL to
**-248.87 USDT**. The protected holdout and competition period were not read. Primary failure
stopped every stability and friction-neighbour run. Per this protocol, no further candidate will be
derived from these results during the competition.
