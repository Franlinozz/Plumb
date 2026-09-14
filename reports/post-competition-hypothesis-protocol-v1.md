# Post-competition hypothesis protocol v1

Status: **frozen before post-competition outcome evaluation**  
Freeze date: 2026-09-14  
Purpose: Stage 2 development and rejection—not authorization to trade.

## Data boundaries

- Implementation/development data ends at `2026-08-09T23:59:59Z`.
- The already-consumed competition holdout (`2026-05-12` through `2026-08-10`) remains excluded
  from candidate selection and may only be reported as historical context.
- The first untouched post-competition validation interval is `2026-08-11T00:00:00Z` through
  `2026-09-11T23:59:59Z`. It may be opened once, after all three candidates run correctly on the
  development data.
- Observations from 2026-09-12 through 2026-09-14 were used to rebuild and test collection
  infrastructure. They are excluded from strategy evidence.
- Forward shadow evidence begins no earlier than `2026-09-15T00:00:00Z`. It is separate from the
  historical validation result and follows the 60-day Stage 3 clock.

No threshold below may be changed after a result is viewed. A changed candidate receives a new
version and a new untouched validation/forward clock.

## Fixed portfolio and execution assumptions

- Universe: BTC-USDT-SWAP, ETH-USDT-SWAP and SOL-USDT-SWAP only.
- Decision timeframe: closed 1-hour bars; execution occurs on the next observable quote, never on
  the signal bar's close.
- Starting equity: 400 USDT. Maximum risk: 4 USDT per trade; daily loss limit: 20 USDT; kill floor:
  335 USDT; maximum leverage: 3x; maximum aggregate notional: 800 USDT; maximum two concurrent
  positions; no averaging down.
- Stops use the candidate's existing structural/ATR rule. Profit-taking remains the repository
  default of 1.5R and 3R; maximum holding time is 48 bars and signal expiry is two bars.
- Historical costs include the repository's OKX fee model, taker entry and exit unless a fill is
  independently demonstrated, spread crossing, size-dependent slippage, funding settlements and
  one-observation latency. Shadow evaluation replaces modelled spread with the captured executable
  quote and reports adverse movement after the signal.
- A signal is invalid when any required input is incomplete or stale. Missing data is never filled
  with a favourable assumption.

## The three hypotheses

### H1 — trend-aligned volatility expansion (`vol_expansion` 1.1.0)

Run the existing 1H module with `requireTrendAlignment=true`, compression lookback 100,
compression percentile 0.25, range length 20 and minimum break 0.5 ATR. Long breakouts require the
repository regime classifier to be `trending_up`; shorts require `trending_down`. This tests whether
quiet-range breaks have positive continuation expectancy only when aligned with the broader trend.

### H2 — open-interest-backed continuation (`oi_divergence` 1.0.0)

Run the existing 1H module with six-bar lookback, 24 observations minimum, 0.1% deadband, 0.75 ATR
minimum price move and 2 ATR stop. Only `price up + OI up` longs and `price down + OI up` shorts are
eligible. This tests whether directional moves supported by newly opened positioning persist after
costs.

### H3 — funding-crowding fade (`funding_skew` 1.0.0)

Run the existing 1H module using the instrument's own funding history, 90th/10th percentile extremes,
20 settlements minimum, standalone confirmation enabled and maximum contrary-trend ADX 30. Trade
against the crowded side. This tests whether an extreme recurring carry imbalance reverses enough to
pay for a two-sided taker execution.

## Pass/reject rules

Each hypothesis is evaluated separately and across the pooled portfolio. It is rejected unless all
of the following hold without threshold edits:

1. At least 30 combined out-of-sample closed trades.
2. Net PnL is positive after all costs and pooled profit factor is greater than 1.0.
3. No walk-forward window reaches or falls below 335 USDT.
4. Monte Carlo probability of reaching the kill floor is at most 5%.
5. Net PnL remains positive without the single best trade.
6. At least two instruments have trades and no single instrument supplies more than 70% of positive
   gross PnL.
7. At least two classified market regimes have trades and neither alone supplies more than 80% of
   positive gross PnL.
8. The validation interval is positive after costs and does not contradict the development result.

A passing Stage 2 hypothesis is only eligible to enter Stage 3 shadow trading. Live execution stays
locked until every Stage 3 requirement in `POST_COMPETITION.md` passes and the operator explicitly
authorizes Stage 4.
