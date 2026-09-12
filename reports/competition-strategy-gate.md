# Competition strategy gate

Audit updated: 2026-08-20 UTC

## Status: RED — protected holdout FAIL; amendment preparation cannot manufacture eligibility

The corrected walk-forward engine and the predeclared trend-aligned volatility-breakout candidate
passed the development and stability gates, then failed the single-use protected 90-day holdout.
No approved live DecisionEvent may be created. External market commentary, leaderboard pressure,
or a compliance-only order cannot override this result.

On 2026-08-18 the operator authorised a capital-preservation amendment for a possible first valid
trade. The failed candidate remains failed and is neither rerun nor relabelled. The amendment adds
strict timing and damage caps plus a read-only condition monitor; it does **not** bypass the signed
development/calibration/holdout evidence gate. Current official A2A output was also migrated from
the obsolete V1.1 syntax to Trading Signal v1.2 before any executable publication.

The 2026-08-18T16:25Z monitor was **NO TRADE**: ETH 4H ADX was 14.14 (ranging), 24H open interest
was down 0.83%, no closed-1H candidate existed, and the authorised window had not opened.

## 2026-08-20 compliance-warning audit

The operator received a first warning saying activity in the registered account did not align with
the ASP's signals, with a re-review scheduled for 2026-08-21. A read-only audit at approximately
2026-08-20T11:15Z found **no competition-period CEX trade to match to that warning**:

- current, recent and archived USDT-perpetual orders: none;
- current, recent and archived fills: none;
- open positions and SWAP/account bills: none;
- local Agent Trade Kit audit log: read operations only, no order write;
- X Layer identity wallet: no transaction after the competition began;
- executable A2A DecisionEvent deliveries: none (only non-executable no-trade notices and welcomes).

This evidence does not prove what the platform's warning system observed. Plausible causes include
an attribution/binding issue or automated treatment of a signal-only/no-trade state as a mismatch.
The operator must ask OKX.AI support for the exact instrument, order id, timestamp, execution path
and signal they classified as mismatched. Plumb will not create a speculative order merely to make
the warning disappear.

The same audit exposed two independent constraints:

1. The participating service is active, online and has three currently ACTIVE subscriptions, but
   has delivered zero executable signals. The public convenience feed contains only two expired
   pre-competition test signals; it is not the official A2A subscription ledger.
2. The current `createCompetitionDecision` path can never approve a live event because the sole
   protected holdout is permanently RED. Time and market conditions cannot change that fact. A new
   strategy/version would require an explicit, honest governance amendment and fresh evidence; the
   failed result must never be relabelled or bypassed.

Current leaderboard visibility does not establish eligibility: the official page says ASPs with
status issues or minimal performance changes may be hidden and updates approximately every ten
minutes. Plumb's absence is consistent with zero recognized trades, but only OKX can confirm the
warning's internal attribution.

The persistent observation recorder also had a data-integrity defect: it inserted the first partial
form of each candle and ignored the later closed form because both share a primary key. The store now
permits only a monotonic `closed=false` to `closed=true` replacement. This repair does not alter the
live monitor, protected holdout or any trading decision.

## Final protected holdout — consumed once

| Trades | Net USDT | PF | Max drawdown | Minimum equity | Without best trade | Verdict |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 14 | -15.45 | 0.494 | 6.90% | 384.55 | -22.46 | **FAIL** |

The durable audit contains exactly one access record at 2026-08-18T09:04:40Z. The candidate failed
the frozen net-PnL, profit-factor and outlier-independence requirements. It will not be rerun,
relabelled, or replaced during this competition.

## Development evidence (historical; superseded by holdout FAIL)

| Candidate | OOS trades | PF | Net USDT | P(ruin) | Verdict |
|---|---:|---:|---:|---:|---|
| `vol_expansion` (unaligned baseline) | 183 | 1.390 | +166.77 | 6.20% | REJECT — ruin above locked 5% ceiling |
| `vol_expansion@1.1.0` (`aligned-default`) | 121 | 1.999 | +215.50 | 0.12% | DEVELOPMENT PASS |
| `trend_and_breakout` | 334 | 1.110 | +86.45 | 33.90% | REJECT |
| `trend_ema` | 79 | 0.660 | -71.60 | 66.30% | REJECT |
| `breakout_range` | 158 | 0.870 | -57.37 | 65.80% | REJECT |
| `oi_divergence` | 0 | — | 0 | — | REJECT — no historical sample |

The earlier RED measurements were invalidated by a walk-forward boundary defect: bounded folds
could close positions using the full dataset tail and could fill a next-bar entry beyond the fold.
The corrected engine forbids both and enforces aligned instrument timestamps. The frozen aligned
candidate is positive in both chronological halves, on all three instruments, and after removing
its three best trades; all six one-parameter neighbours also remain positive with PF above 1.
Exact evidence and hashes are in `competition-candidate-development.{json,md}`. The protected
holdout was subsequently consumed once and failed; its frozen rules and final state are in
`competition-holdout-protocol.md` and `competition-candidate-holdout.md`.

The extra first-trade filter is intentionally narrower than the underlying candidate. Requiring a
fully closed 4H ADX ≥25 and directionally aligned EMA20/EMA50 leaves 44 development trades overall:
+38.52 USDT, PF 1.38, and +18.54 USDT without the best trade. Only ETH survives instrument-level
scrutiny (14 trades, +45.52 USDT, PF 2.60, +25.53 USDT without its best); BTC and SOL are therefore
hard-rejected by the DecisionEvent factory. ETH historical gross expectancy is cut in half to
110.32 bps before comparison with fresh live friction at the mandatory 3× multiple. The 95%
statistical lower bound remains negative because the exact subset is small; this uncertainty is
recorded rather than presented as certainty.

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

1. A signed GREEN development eligibility record and a passing single-use protected holdout record
   exist; no demo override and no compliance-only direction. **CURRENTLY FAILS: holdout is RED.**
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
6. The operator amendment narrows the first trade to ETH only, one entry, at most 10% account
   position, 40 USDT notional, 0.25 USDT stop risk, and 0.35 USDT stop-plus-friction planned loss.
   The position gets native attached TP and SL, both verified after placement. No averaging,
   adding, reversal shortcut, or widened stop.
7. The exact immutable DecisionEvent is previewed, delivered and acknowledged by every ACTIVE
   subscriber before the order. Execution uses only the dedicated Agent Trade Kit profile. The
   operator must then provide `CONFIRM LIVE <decisionId>` for that one event.

Persistent OKX-specific OI, funding, mark, index, OHLCV, spread/book and metadata recording is now
running through the timer/oneshot recorder; this corrects the stale statement in the prior report.

## Scheduled reassessment — 2026-08-14 16:32 UTC

**Verdict: NO TRADE.** No signal was published and no order was submitted.

The account preflight remained fully green (8 checks, 0 failures, 0 warnings), the account was
flat, all five halt flags were false, the ASP heartbeat was succeeding, and both ACTIVE
subscriptions had the current no-trade notice. Infrastructure readiness therefore did not cause
the rejection.

Closed-candle evidence rejected an entry:

| Instrument | Closed 4H regime | Closed 1H confirmation | OI (24h) | Funding context | Verdict |
|---|---|---|---:|---|---|
| BTC-USDT-SWAP | Bearish alignment, ADX 28.03 | No downside breakout; 15:00 UTC candle rebounded 62,590.1 to 62,966.1 on 2.33x 20h volume | +9.72% | +0.0100%, 100th percentile of 100 settlements | WAIT — squeeze/crowding risk |
| ETH-USDT-SWAP | ADX 18.30, below gate | No breakout; strong rebound | +5.17% | +0.0091%, 95th percentile | REJECT |
| SOL-USDT-SWAP | ADX 17.55, below gate | No breakout; rebound | -1.33% | -0.0001%, 23rd percentile | REJECT |

For BTC, the closed-bar range/ATR rule required a 1H close below approximately **62,385** for a
short or above approximately **63,743** for a long. The actual 15:00 UTC close was **62,966.1**.
An intrabar move through either level would still not qualify. The development evidence gate also
remains RED: no signed eligible strategy configuration exists, independently sufficient to reject
live execution.

The August CPI, PPI and retail-sales releases had passed, but their mixed readings did not override
the price/OI/funding gates. The next scheduled U.S. macro embargo remains the FOMC minutes on
2026-08-19 at 14:00 ET.
