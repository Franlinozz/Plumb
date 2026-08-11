# Competition strategy gate

Audit time: 2026-08-11T13:20Z UTC

## Status: RED — wait; no approved live DecisionEvent

The account and delivery infrastructure are ready, but the evidence gate is not. External market
commentary cannot turn a rejected configuration into an approved strategy.

## Development evidence (holdout remains sealed)

| Candidate | OOS trades | PF | Net USDT | P(ruin) | Verdict |
|---|---:|---:|---:|---:|---|
| `vol_expansion` | 185 | 1.046 | +42.16 | 72.08% | REJECT — ruin and outlier dependence |
| `trend_and_breakout` |  — | 0.823 | -272.27 | 91.76% | REJECT |
| `trend_ema` | — | 0.661 | -198.09 | 86.23% | REJECT |
| `breakout_range` | — | 0.712 | -179.53 | 89.99% | REJECT |
| `oi_divergence` | 0 | — | 0 | — | REJECT — no historical sample |

`vol_expansion` loses 159.34 USDT after removing its single best trade. Its positive
`trending_up` subgroup is therefore a research lead, not permission to trade. No protected
holdout row was read during this audit.

## Live OKX snapshot

Snapshot: 2026-08-11T13:09Z UTC. Public endpoints only; no account write.

| Instrument | Last | 1H RSI | 1H EMA20 / EMA50 | 1H ADX | 4H ADX | 24h OI contracts | Funding percentile (100 settlements) |
|---|---:|---:|---:|---:|---:|---:|---:|
| BTC-USDT-SWAP | 64,342.70 | 52.60 | 64,224 / 64,442 | 24.82 | 23.18 | -1.45% | 65th |
| ETH-USDT-SWAP | 1,890.57 | 53.95 | 1,884.55 / 1,893.94 | 28.10 | 22.91 | -0.71% | 50th |
| SOL-USDT-SWAP | 75.99 | 48.34 | 76.01 / 76.08 | 22.15 | 18.94 | +1.74% | 10th |

BTC and ETH are rebounding while open interest falls, which is consistent with deleveraging or
short covering rather than confirmed new-long participation. SOL has rising OI and negative
funding, but price and 1H/4H trend alignment are absent. Open interest does not reveal direction
by itself. Result: **NO TRADE**.

## Macro event embargo

- U.S. CPI: 2026-08-12 08:30 ET.
- U.S. PPI: 2026-08-13 08:30 ET.
- U.S. retail sales: 2026-08-14 08:30 ET.
- FOMC minutes: 2026-08-19 14:00 ET.

Research using intraday crypto data finds volume, volatility and bid/ask spreads jump at major
U.S. announcements and stay elevated for roughly 30 minutes. Plumb will not initiate a first
competition trade into the August 12–14 release cluster. The earliest sensible reassessment is
**2026-08-14 16:15 UTC**, after retail sales and a completed 4H bar. That is an assessment time,
not a promised entry.

Sources:

- [OKX.AI Trading Hackathon rules](https://www.okx.ai/hackathon)
- [BLS CPI release schedule](https://www.bls.gov/schedule/news_release/cpi.htm)
- [BLS PPI release schedule](https://www.bls.gov/schedule/news_release/ppi.htm)
- [Census economic-indicator calendar](https://www.census.gov/economic-indicators/calendar-listview.html)
- [Federal Reserve August 2026 calendar](https://www.federalreserve.gov/newsevents/2026-august.htm)
- [Federal Reserve research on crypto around economic news](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6447644)
- [Realistic cryptocurrency momentum evidence](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4675565)

## First-trade acceptance protocol

All conditions are mandatory:

1. A signed GREEN development eligibility record exists; no demo override and no compliance-only
   direction. The protected holdout remains sealed until one final development configuration is
   selected under its existing operator-token procedure.
2. No macro embargo, halt flag, stale field, pending order, position mismatch, or account
   uncertainty.
3. A closed 4H bar establishes the same-direction regime, with ADX at least 25 and EMA20/EMA50
   aligned. A closed 1H bar supplies a genuine compression breakout; an intrabar wick is not an
   entry.
4. OI confirms new participation (price and OI rise for a long; price falls while OI rises for a
   short). Short covering or long liquidation alone is insufficient. Funding is a veto/cost input,
   never primary alpha.
5. Expected edge is at least **3x** the full estimated friction. Current Lv1 taker fees alone are
   5 bp per side / 10 bp round trip; spread, slippage and expected funding must be added.
6. For the first trade, use at most 25% account position and at most 2.00 USDT stop risk, despite
   the higher locked ceilings. The position gets native attached TP and SL, both verified after
   placement. No averaging, adding, reversal shortcut, or widened stop.
7. The exact immutable DecisionEvent is previewed, delivered and acknowledged by every ACTIVE
   subscriber before the order. Execution uses only the dedicated Agent Trade Kit profile. The
   operator must then provide `CONFIRM LIVE <decisionId>` for that one event.

Persistent OKX-specific OI, funding, mark, index, OHLCV, spread/book and metadata recording is now
running through the timer/oneshot recorder; this corrects the stale statement in the prior report.
