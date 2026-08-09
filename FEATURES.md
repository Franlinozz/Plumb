# FEATURES.md

Every shipped capability, the package that owns it, the surface it is reachable from, and the test
that proves it. Updated **every phase** (AGENTS.md guardrail 9).

Rules for this table:
- A row is added only when the capability actually works. No aspirational rows.
- "Surface" is how a human or another agent reaches it — a CLI command, an HTTP route, an MCP tool,
  or `internal` if it is only reachable from other Plumb code.
- "Test" names the test file (and case, where useful) that would fail if the capability broke.

| Capability | Package | Surface | Test |
| --- | --- | --- | --- |
| Locked competition parameters, frozen and tripwired | `@plumb/core` | internal | `core/src/locked.test.ts` |
| UTC ↔ UTC+8 conversion; UTC day bucketing for the daily loss limit | `@plumb/core` | internal | `core/src/time.test.ts` |
| OKX public REST client — ticker, candles, history candles, mark price, index ticker, funding (current + history), open interest (+ history), price limit | `@plumb/market` | internal | `market/src/client.test.ts` |
| Locked-instrument guard — an out-of-set instId throws before any request | `@plumb/market` | internal | `client.test.ts` › "the locked instrument guard" |
| Candles normalised to chronological order at the boundary | `@plumb/market` | internal | `client.test.ts` › "returns candles OLDEST-FIRST" |
| Per-attempt timeout, exponential backoff with jitter, retry only on transient failures | `@plumb/market` | internal | `client.test.ts` › "failure and retry behaviour" |
| Serialised rate gate holding a minimum inter-request interval | `@plumb/market` | internal | `client.test.ts` › "the rate gate" |
| Indicators: SMA, EMA, RSI, MACD, true range, ATR, Bollinger, realised volatility, ADX/±DI — pure, aligned, Wilder-smoothed | `@plumb/market` | internal | `market/src/indicators.test.ts` |
| MarketSnapshot assembly — immutable, deterministic, clock injected | `@plumb/market` | internal | `market/src/snapshot.test.ts` |
| Data watchdog — per-field ages and budgets, `degraded` + named failing fields | `@plumb/market` | internal | `market/src/staleness.test.ts` |
| `isTradeable(snapshot)` — the single gate a degraded snapshot cannot pass | `@plumb/market` | internal | `staleness.test.ts`, `snapshot.test.ts` |
| Candle store — SQLite-backed, in-memory tail, closed candles immutable, survives restart | `@plumb/market` | internal | `market/src/cache.test.ts` |
| Historical backfill — backwards pagination, gap/duplicate detection, already-downloaded pages skipped | `@plumb/market` | internal | `market/src/history.test.ts` |
| Recorded-fixture replay (`PLUMB_MODE=fake`) — raw OKX envelopes, zero network | `@plumb/market` | internal | every `market` test |
| No credentials reachable from `@plumb/market` | `@plumb/market` | internal | `market/src/no-credentials.test.ts` |
| Signal primacy — `strategy` cannot reach `executor` at any depth | `@plumb/strategy` | internal | `strategy/src/no-order-path.test.ts` |
| Strategy purity — no clock, no randomness, no network, no I/O | `@plumb/strategy` | internal | `strategy/src/purity.test.ts` |
| `Signal` type + zod schema, with NO size/leverage/notional field | `@plumb/strategy` | internal | `strategy/src/signal.test.ts` |
| Deterministic + entropy signal-id factories (nanoid shape, injected source) | `@plumb/strategy` | internal | `signal.test.ts` › "signal ids" |
| Deterministic regime classifier — 6 labels, `unclear` first-class, confidence 0–1 | `@plumb/strategy` | internal | `strategy/src/regime.test.ts` |
| Model regime hint may lower confidence, never change the label | `@plumb/strategy` | internal | `regime.test.ts` › "corroborate, never override" |
| Candidate strategy: `trend_ema` (EMA cross + ADX + trending regime) | `@plumb/strategy` | internal | `strategy/src/strategies.test.ts` |
| Candidate strategy: `revert_band` (band touch + RSI extreme, ranging only) | `@plumb/strategy` | internal | `strategies.test.ts` › revert_band |
| Candidate strategy: `breakout_range` (ATR-normalised range break) | `@plumb/strategy` | internal | `strategies.test.ts` › breakout_range |
| Candidate strategy: `funding_skew` (percentile funding extreme, never alone) | `@plumb/strategy` | internal | `strategies.test.ts` › funding_skew |
| Pre-emission gate — 14 structured rejection codes, degraded rejects all | `@plumb/strategy` | internal | `strategy/src/gate.test.ts` |
| Conflicting sides in one cycle → neither emitted, conflict logged | `@plumb/strategy` | internal | `gate.test.ts` › "emits NEITHER side" |
| Portfolio coordination — correlation cap, one signal per instrument, no adding to open direction | `@plumb/strategy` | internal | `strategy/src/portfolio.test.ts` |
| Engine — regime → strategies → gate → portfolio → validated `Signal[]` | `@plumb/strategy` | internal | `strategy/src/engine.test.ts` |
| LLM rationale payload interface + unsanctioned-number detector (not called) | `@plumb/strategy` | internal | `engine.test.ts` › "rationale interface" |
| Synthetic market testkit (regime + event fixtures, seeded) | `@plumb/strategy` | `@plumb/strategy/testkit` | `regime.test.ts`, `strategies.test.ts` |
| Snapshot from candles alone (historical replay) | `@plumb/market` | internal | `strategy/src/engine.test.ts` |
| Instrument specs (ctVal, minSz, lotSz, tickSz) recorded from the live exchange | `@plumb/market` | internal | `risk/src/sizing.test.ts` |
| Position sizing from stop distance, leverage clamp, lot rounding | `@plumb/risk` | internal | `risk/src/sizing.test.ts` |
| Post-rounding actual risk never exceeds the budget | `@plumb/risk` | internal | `sizing.test.ts` › "post-rounding risk" |
| Below-minimum size rejected rather than traded | `@plumb/risk` | internal | `sizing.test.ts` › rejections |
| Funding-cost estimate (credits never counted as benefit) | `@plumb/risk` | internal | `sizing.test.ts` › funding |
| Persisted governor state — a killed system stays killed across restart | `@plumb/risk` | internal | `risk/src/state.test.ts` |
| UTC daily roll (not the UTC+8 competition boundary) | `@plumb/risk` | internal | `state.test.ts` › "the UTC daily roll" |
| The veto — 14 codes in fixed precedence, first failure wins | `@plumb/risk` | internal | `risk/src/governor.test.ts` |
| Averaging-down prohibition, unreachable by any config | `@plumb/risk` | internal | `governor.test.ts` › 6, 6b, 6c |
| Drawdown ladder −2/−5/−8/−12%, unwinds only on realised gains | `@plumb/risk` | internal | `state.test.ts` › ladder |
| Kill switch at 335, permanent, flattens | `@plumb/risk` | internal | `governor.test.ts` › 2, 2b, 2c |
| Idempotent flatten — calling twice does not double-close | `@plumb/risk` | internal | `risk/src/flatten.test.ts` |
| Manual re-arm requires an operator token + reason, writes an audit record | `@plumb/risk` | internal | `flatten.test.ts` › re-arm |
| Second locked-parameter tripwire inside the money package | `@plumb/risk` | internal | `state.test.ts` › "the second tripwire" |
| No model, no network, no key reachable from `@plumb/risk` | `@plumb/risk` | internal | `risk/src/no-llm.test.ts` |
| Fuzz: 10,000 random signals never breach a locked parameter | `@plumb/risk` | internal | `risk/src/fuzz.test.ts` |
| Hostile-strategy simulation over real history | `@plumb/risk` | `npm run hostile` | `risk/src/hostile.test.ts` |
| Funding-rate history storage + backfill | `@plumb/market` | `npm run backfill` | `backtest/src/costs.test.ts` |
| Full-pipeline bar-by-bar replay (governor in the loop) | `@plumb/backtest` | internal | `backtest/src/engine.test.ts` |
| Lookahead detection — a cheating window throws | `@plumb/backtest` | internal | `engine.test.ts` › lookahead |
| Pessimistic cost model — taker fees, slippage, gap-side stop fills, real funding | `@plumb/backtest` | internal | `backtest/src/costs.test.ts` |
| Walk-forward IS/OOS windows that never overlap | `@plumb/backtest` | internal | `backtest/src/analysis.test.ts` |
| Full metrics incl. per-regime and per-strategy breakdown | `@plumb/backtest` | internal | `analysis.test.ts` › metrics |
| Monte Carlo — seeded, 10k paths, P(ruin) and 5th percentile | `@plumb/backtest` | internal | `analysis.test.ts` › Monte Carlo |
| Eligibility gate — 5 criteria, signed record, tamper-evident | `@plumb/backtest` | internal | `analysis.test.ts` › gate |
| Markdown report with inline SVG equity curve + "what this does not prove" | `@plumb/backtest` | `reports/` | `analysis.test.ts` › report |
| Fixture recording | — | `npm run record-fixtures` | manual, once per phase |
| Live snapshot inspection | — | `npm run snapshot` | manual eyeball check |
| Historical backfill | — | `npm run backfill -- --days 180 --tf 15m,1H` | `history.test.ts` |
| Indicator divergence vs OKX Agent Trade Kit | — | `npm run divergence` | manual, findings in AGENTS.md |
| Regime fixture verification | — | `npm run probe:regimes` | `regime.test.ts` pins each label |
| Strategy event-fixture verification | — | `npm run probe:strategies` | `strategies.test.ts` pins each |
| 180-day signal-frequency replay | — | `npm run replay` | `engine.test.ts` (fixture-scale twin) |
| Hostile-strategy simulation, full history, 5 scenarios | — | `npm run hostile` | `hostile.test.ts` (fixture-scale twin) |
| Walk-forward backtest of every strategy config | — | `npm run backtest` | `analysis.test.ts`, `engine.test.ts` |

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Scaffold + constitution | ✅ shipped |
| 1 | `@plumb/market` — data, indicators, snapshot, watchdog, cache, history | ✅ shipped |
| 2 | `@plumb/strategy` — pure signal engine, regime, gate, portfolio | ✅ shipped |
| 3 | `@plumb/risk` — governor, sizing, drawdown ladder, kill switch | ✅ shipped |
| 4 | `@plumb/backtest` — walk-forward harness, cost model, eligibility gate | ✅ shipped |
| 5–10 | Not yet written | — |

## Data on hand

Stored in `data/plumb.db` (gitignored — 65,700 rows is repo bloat, and it is reproducible with
`npm run backfill`). Recorded 2026-08-09:

| Instrument | TF | Rows | Span | Gaps | Duplicates |
| --- | --- | --- | --- | --- | --- |
| BTC-USDT-SWAP | 15m | 17,400 | 181.2 days | 0 | 0 |
| BTC-USDT-SWAP | 1H | 4,500 | 187.5 days | 0 | 0 |
| ETH-USDT-SWAP | 15m | 17,400 | 181.2 days | 0 | 0 |
| ETH-USDT-SWAP | 1H | 4,500 | 187.5 days | 0 | 0 |
| SOL-USDT-SWAP | 15m | 17,400 | 181.2 days | 0 | 0 |
| SOL-USDT-SWAP | 1H | 4,500 | 187.5 days | 0 | 0 |

Fixtures in `packages/market/fixtures/` (committed): 33 files, 3,318 rows — 8 point-in-time
endpoints × 3 instruments, plus 300 candles each at 15m / 1H / 4H.

## Signal frequency over 180 days of real history

`npm run replay --tf 1H` over 12,603 cycles (3 instruments × ~4,200 bars). **This is a smoke test,
not a performance claim — no edge is claimed for any strategy until P4 produces evidence.**

| Strategy | Signals | Rate | Verdict |
| --- | --- | --- | --- |
| `trend_ema` | 16 | 0.13% | plausible |
| `revert_band` | 2 | 0.02% | plausible, but barely reachable — see checkpoint |
| `breakout_range` | 46 | 0.36% | plausible |
| `funding_skew` | 0 | 0.00% | **unevaluable** — no funding history in the store (P4 prerequisite) |

Regime distribution: trending_down 25.7% · trending_up 23.4% · unclear 18.2% · ranging 17.7% ·
compressed 11.3% · expanding 3.8%. Total emitted 64 signals (0.51% of bars); 155 drafts were
produced and 91 rejected, dominated by `regime_low_confidence`.

## Hostile-strategy simulation over 180 days of real history

`npm run hostile` — a strategy that tries to open the maximum permitted size on every bar of every
instrument, widening its stop until the governor lets something through. **The governor held in
every scenario.**

| Scenario | Equity | Min | Worst risk | Worst leverage | Peak notional | Kill switch |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 400 → 370.74 | 370.74 | 3.9986 / 4 | 1.358 / 3 | 798.65 / 800 | not fired |
| brutal slippage (0.5%) | 400 → 356.58 | 356.58 | 3.9961 / 4 | 1.375 / 3 | 798.65 / 800 | not fired |
| punitive funding | 400 → 420.15 | 400.00 | 3.9983 / 4 | 1.329 / 3 | 599.13 / 800 | not fired |
| starting near the floor (340) | 340 → 342.05 | **331.17** | 3.9934 / 4 | 1.574 / 3 | 798.65 / 800 | **fired**, halted, flat |
| long holds (48 bars) | 400 → 414.06 | 386.69 | 3.9998 / 4 | 1.318 / 3 | 799.45 / 800 | not fired |

The 331.17 is real and expected: a position was already open when equity crossed 335, and its stop
filled with slippage. **The kill switch bounds new risk, not equity** — see AGENTS.md § Deviations.
From the locked 400 starting capital the ladder keeps the account 35+ USDT clear of the floor.

Vetoes are dominated by `no_new_positions` (13,128 in the baseline) — the drawdown ladder does most
of the work, and the kill switch is the backstop behind it.

## Eligibility gate results — NONE PASSED

`npm run backtest` over 5,100 bars/instrument on 1H with full pessimistic costs, walk-forward
60d IS / 20d OOS rolling 20d. **Reported exactly as measured; no parameter was tuned to make
anything pass, because tuning until something passes is overfitting.**

| Config | OOS trades | Win% | PF | Net USDT | MaxDD% | P5 equity | P(ruin) | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `trend_ema` | 9 | 44.4 | 0.52 | −11.23 | 2.4 | 370 | 0.0% | REJECTED — PF, sample size, outlier |
| `revert_band` | 0 | — | — | 0.00 | 0.0 | 400 | 0.0% | REJECTED — no trades at all |
| `breakout_range` | 30 | 40.0 | **1.19** | **+14.41** | 7.8 | 334 | **6.2%** | REJECTED — P(ruin), outlier |
| `funding_skew` | 0 | — | — | 0.00 | 0.0 | 400 | 0.0% | REJECTED — cannot fire alone by design |
| `all_four_combined` | 37 | 40.5 | 0.74 | −24.46 | 9.5 | 332 | 16.7% | REJECTED — P(ruin), PF, outlier |

`breakout_range` is the only configuration with a positive out-of-sample result, and it did not
degrade (OOS profit factor was 104% of in-sample). It fails anyway, for two reasons that matter:
**removing its single best trade turns +14.41 into −37.34**, and Monte-Carlo P(ruin) is 6.16%
against a 5% ceiling with a 5th-percentile equity of 334.32 — below the kill switch.

Full reports with equity curves in `reports/`.

## Not yet built

Recorded so that nothing looks accidentally missing:


- `@plumb/executor` — Agent Trade Kit execution + reconciliation. Placeholder only.
- `@plumb/asp` — subscription feed + published ledger. Placeholder only.
- `@plumb/ops` — alerts, daily review, health. Placeholder only.
