# Competition fallback — predeclared protocol

Frozen before the first replay: 2026-08-22 UTC

## Status: RESEARCH ONLY — NOT AUTHORISED FOR LIVE EXECUTION

This is an emergency fallback for the final competition window. It does not modify P8, the
protected holdout result, or `competition_trend_pullback@3.0.0`. It is deliberately easier to
trigger, and therefore riskier. It may be armed only after the one-run development evaluation,
cost stress, and execution-path tests pass and the operator explicitly authorises this exact
version and damage envelope.

There is no unused protected holdout. The 2026-05-12 through 2026-08-10 holdout was consumed once
by `vol_expansion@1.1.0` and failed. It will not be opened again. Competition-period prices and
leaderboard results are excluded from parameter selection and replay. Any development pass is
evidence-limited and must never be described as proof of profitability.

## Research basis

- Liu and Tsyvinski document time-series momentum in large cryptocurrencies at daily and weekly
  horizons: https://www.nber.org/papers/w24877
- Shen, Urquhart and Wang find Bitcoin intraday momentum is strongest during high-volume or
  high-volatility sessions: https://doi.org/10.1111/fire.12290
- Wen, Bouri, Xu and Zhao find both intraday momentum and reversal, conditional on jumps,
  liquidity and events. This argues against an unconditional always-momentum rule:
  https://doi.org/10.1016/j.najef.2022.101733
- Bysik and Slepaczuk find naive hourly cryptocurrency direction trading fails after ten-basis-
  point costs, while cost-aware filtering can restore profitability in selected walk-forward
  configurations: https://arxiv.org/abs/2606.00060
- OKX Agent Trade Kit exposes candles, spreads, funding, OI, fee rates, attached exits and signed
  position verification. Competition orders must remain USDT perpetual orders identifiable
  through that kit: https://www.okx.com/docs-v5/agent_en/

These papers support testing a cost-aware continuation hypothesis; they do not predict the next
trade and do not guarantee a positive outcome.

## Candidate fixed before replay

Identifier: `competition_intraday_continuation@1.0.0`

Universe: BTC-USDT-SWAP, ETH-USDT-SWAP, SOL-USDT-SWAP.

Decision timeframe: fully closed 15-minute bars. The 1H bars are reconstructed from closed,
contiguous, UTC-aligned 15-minute bars. Warm-up is 300 bars, matching the current public endpoint's
single-request ceiling and the live/backtest replayability contract.

Direction and trigger:

1. The latest closed 1H bar must be above EMA20 above EMA50 for a long, or below EMA20 below EMA50
   for a short.
2. EMA20 must have moved in that direction over the preceding three closed 1H bars.
3. 1H ADX must be at least 18 and directional movement must agree.
4. The latest 15m close must break the high or low of the prior eight closed 15m bars.
5. 15m RSI must be 52–72 for a long or 28–48 for a short.
6. Current 15m volume must be at least 60% of the preceding 20-bar mean. This rejects dead bars but
   does not require a rare volume spike.

Stops and exits:

- Start with the farther of the prior eight-bar structural extreme plus 0.25 ATR and 1.5% from
  entry. Reject a signal if that stop is more than 2.0% from entry.
- One take-profit at 2R. With the separately authorised 200 USDT notional ceiling, the minimum
  1.5% stop produces approximately 6 USDT gross target before friction.
- Maximum hold: 96 bars (24 hours). Signal validity: one 15-minute bar. The existing competition
  hard exit remains 2026-08-25T03:30:00Z if a live amendment is later authorised.
- Stops take priority when stop and target are both touched in the same bar. Entries fill at the
  next bar open; every market fill pays the existing pessimistic taker/slippage/funding model.

Live-only vetoes, if later authorised:

- current spread must be at most 2 bps;
- absolute current funding must be at most 10 bps per settlement;
- OI is participation context, not a directional oracle: veto only a severe unwind, defined as
  1H OI below -1.0% or 4H OI below -3.0%;
- projected target after estimated round-trip fees, spread, slippage and funding must be at least
  5.50 USDT;
- all existing halt, staleness, metadata, sizing, dedicated-account, signed reconciliation,
  duplicate, A2A acknowledgement, Agent Trade Kit, native TP/SL and one-shot gates remain.

## One-run evaluation fixed before measurement

- Data: development partition only, ending 2026-05-12. Protected holdout and competition period
  are not read.
- Walk-forward: 120-day in-sample, 30-day out-of-sample, 30-day step.
- Costs: existing pessimistic taker fee, next-bar entry, volatility/size slippage and funding.
- Starting capital and locked governor parameters: unchanged.
- Seed: `20260823`.
- The backtest must model the actual first take-profit. Stop wins an ambiguous same-bar collision.
- One fixed candidate is measured. Neighbours (breakout 6/10 bars, ADX 16/20, volume 50/70%) are
  stability vetoes only and may not replace the candidate.

Minimum evidence for further consideration:

- at least 120 out-of-sample trades;
- positive net PnL and profit factor at least 1.15 after all costs;
- no kill-floor breach and Monte Carlo P(ruin) at or below 5%;
- at least 50% of walk-forward windows profitable;
- positive first and second chronological halves;
- positive result without the ten best trades;
- every instrument has at least 20 trades and positive net PnL;
- at least four of six stability neighbours retain positive net PnL and PF above 1;
- the cost-stress run at 1.5x non-funding trading friction remains positive.

Failure of any condition keeps the fallback unarmed. Passing means only “eligible for an explicit
evidence-limited operator amendment,” not “safe,” “proven,” or “likely to win.”

## Pre-measurement implementation correction

The first evaluator invocation produced zero trades because `runBacktest` defaulted regime
classification to `config.trendEma.timeframe` (`1H`) while the replay snapshot intentionally held
the declared `15m` decision series. Every otherwise valid draft was therefore labelled
`regime_unclear` before reaching the governor. A separate development-only emission diagnostic
found 554 raw drafts over the final 90 development days (251 passed the gate when the declared
15m regime timeframe was supplied). The evaluator was corrected to classify the regime on 15m.
No candidate condition, threshold, stop, target, dataset boundary or cost was changed; the invalid
zero-trade invocation is not treated as a strategy result.

## Final result: FAIL / DO NOT ARM

After the evaluator-timeframe correction, the exact predeclared candidate produced 1,102
out-of-sample trades, net **-166.54 USDT**, profit factor **0.924**, and only **12/29** profitable
walk-forward windows. The protected holdout and competition period were not read. The primary net,
profit-factor and window-consistency gates failed, so sensitivity and cost-stress variants were
stopped as non-decisive. This version is permanently rejected for the competition.
