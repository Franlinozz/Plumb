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
| First attached take-profit replay with pessimistic same-bar stop precedence and exit friction | `@plumb/backtest` | internal | `engine.test.ts` › "models the first attached take-profit" + ambiguous-candle test |
| Lookahead detection — a cheating window throws | `@plumb/backtest` | internal | `engine.test.ts` › lookahead |
| Pessimistic cost model — taker fees, slippage, gap-side stop fills, real funding | `@plumb/backtest` | internal | `backtest/src/costs.test.ts` |
| Walk-forward IS/OOS windows that never overlap | `@plumb/backtest` | internal | `backtest/src/analysis.test.ts` |
| Full metrics incl. per-regime and per-strategy breakdown | `@plumb/backtest` | internal | `analysis.test.ts` › metrics |
| Monte Carlo — seeded, 10k paths, P(ruin) and 5th percentile | `@plumb/backtest` | internal | `analysis.test.ts` › Monte Carlo |
| Eligibility gate — 5 criteria, signed record, tamper-evident | `@plumb/backtest` | internal | `analysis.test.ts` › gate |
| Markdown report with inline SVG equity curve + "what this does not prove" | `@plumb/backtest` | `reports/` | `analysis.test.ts` › report |
| Trade Kit wrapper — demo-only, timeout, error classification, retry-transient-only | `@plumb/executor` | internal | `executor/src/executor.test.ts` |
| Bracketed placement — stop attached; stop failure closes the entry immediately | `@plumb/executor` | internal | `executor.test.ts` › fault injection |
| Idempotency — clOrdId from signal id, replay opens one position | `@plumb/executor` | internal | `executor.test.ts` › idempotency |
| Crash recovery — intent persisted before placement, adopted on boot | `@plumb/executor` | internal | `executor.test.ts` › crash recovery |
| Reconciliation — unmatched fill / drift / missing / unknown all halt | `@plumb/executor` | internal | `executor.test.ts` › reconciliation |
| Stop never moves away from entry (fuzzed) | `@plumb/executor` | internal | `executor.test.ts` › lifecycle |
| maxHoldBars expiry + invalidation close | `@plumb/executor` | internal | `executor.test.ts` › lifecycle |
| Cycle loop — never overlaps, overrun skipped not queued | `@plumb/executor` | internal | `executor.test.ts` › cycle loop |
| Eligibility lock — refuses unsigned/failed/forged records | `@plumb/executor` | internal | `executor.test.ts` › eligibility lock |
| **Publish-before-execute — the executor cannot reach an unpublished signal** | `@plumb/asp` | internal | `asp.test.ts` + `executor/src/publish_gate.test.ts` |
| Trading Signal v1.2 perpetual formatter — one price, fixed field order, <=200 chars | `@plumb/asp` | A2A delivery | `asp/src/decision-delivery.test.ts` |
| First-trade amendment — ETH only, one entry, $0.25 stop risk / $0.35 planned loss / $40 notional | `@plumb/core`, `@plumb/ops`, `@plumb/executor` | competition | `ops/src/competition-decision.test.ts` + `executor/src/competition.test.ts` |
| Emergency participation amendment — one ETH minimum-lot entry, zero edge claimed, all signal/publication/execution safety retained | `@plumb/core`, `@plumb/strategy`, `@plumb/ops`, `@plumb/asp`, `@plumb/executor` | competition | `core/src/decision-event.test.ts` + `ops/src/emergency-participation-decision.test.ts` + `executor/src/competition.test.ts` |
| Boundary-correct rolling OI confirmation (sample at/before boundary; fail closed on insufficient history) | `@plumb/market` | competition monitors + emergency preparation | `market/src/open-interest.test.ts` |
| Read-only first-trade condition monitor; no publication or order path | script + isolated timer | `node scripts/competition-v2-monitor.mjs` | `ops/src/competition-monitor.test.ts` + live public-data smoke test |
| Evidence-limited second-entry factory — BTC/ETH/SOL, multi-window OI, $4.00 stop / $4.35 planned-loss / $200 notional caps | `@plumb/core`, `@plumb/ops`, `@plumb/executor` | competition | `ops/src/second-entry-decision.test.ts` + `executor/src/competition.test.ts` |
| One-shot unattended second-entry orchestration — public gate → private preparation → A2A acknowledgement → Agent Trade Kit, uncertainty never retried | script + isolated timer | `competition-second-entry-auto.mjs` | `ops/src/competition-monitor.test.ts` + `executor/src/competition.test.ts` |
| Venue-native competition TP/SL exit reconciliation — exact entry intent + algo execution + fill + closed-position proof before signed ledger update | script + competition ledger | `competition-reconcile-exits.mjs` | live Agent Trade Kit proof + `ops/src/competition-monitor.test.ts` |
| Authorised competition hard time-stop — idempotent reduce-only Agent Trade Kit close at 2026-08-25T03:30Z with fill/flat/ledger proof | `@plumb/executor` + armed timer | `CompetitionTimeStopExecutor` | `competition-time-stop.test.ts` + `competition-monitor.test.ts` |
| Idempotent Discord readiness/result alerts | script + isolated timer | `competition-v3-discord-alert.mjs` | `ops/src/competition-monitor.test.ts` |
| Deadline contingency v1 — distinct zero-edge approval basis, shared one-shot claim, ETH/SOL only; **armed by explicit operator exception after disclosure of negative frozen audit** | `@plumb/core`, `@plumb/strategy`, `@plumb/ops`, `@plumb/asp`, `@plumb/executor` | enabled post-cutoff competition path | `deadline-contingency-decision.test.ts` + `deadline_contingency.test.ts` + executor/time-stop/monitor tests |
| Hash-chained append-only published feed; tampering detected | `@plumb/asp` | internal | `asp.test.ts` › the published feed |
| Claude rationale with schema validation + deterministic template fallback | `@plumb/asp` | internal | `asp.test.ts` › rationale |
| No model output reaches the signal object (signal frozen first) | `@plumb/asp` | internal | `asp.test.ts` › guardrail 4 |
| Subscription service — one, never deleted, deletion guard throws | `@plumb/asp` | internal | `asp.test.ts` › subscription |
| Track record computed from the ledger only (source scan) | `@plumb/asp` | `GET /track-record` | `asp.test.ts` › no hand-written numbers |
| Public HTTP: /health, manifest, feed, signal detail, track record, chain verify | `@plumb/asp` | HTTP | `asp.test.ts` › the HTTP surface |
| Four free MCP tools for agent consumers | `@plumb/asp` | MCP | `asp.test.ts` › MCP tools |
| Rate limiting, body caps, sanitised errors, no secret leakage | `@plumb/asp` | HTTP | `asp.test.ts` › leaks no secret |
| Fixture recording | — | `npm run record-fixtures` | manual, once per phase |
| Live snapshot inspection | — | `npm run snapshot` | manual eyeball check |
| Historical backfill | — | `npm run backfill -- --days 180 --tf 15m,1H` | `history.test.ts` |
| Indicator divergence vs OKX Agent Trade Kit | — | `npm run divergence` | manual, findings in AGENTS.md |
| Regime fixture verification | — | `npm run probe:regimes` | `regime.test.ts` pins each label |
| Strategy event-fixture verification | — | `npm run probe:strategies` | `strategies.test.ts` pins each |
| 180-day signal-frequency replay | — | `npm run replay` | `engine.test.ts` (fixture-scale twin) |
| Hostile-strategy simulation, full history, 5 scenarios | — | `npm run hostile` | `hostile.test.ts` (fixture-scale twin) |
| Walk-forward backtest of every strategy config | — | `npm run backtest` | `analysis.test.ts`, `engine.test.ts` |
| Live-data execution session (simulated venue) | — | `npm run demo-session` | `executor.test.ts` |
| Publish a real signal and show the subscriber view | — | `npm run feed-sample` | `asp.test.ts` |
| OI-state + hour-of-day measurement tables | — | `npm run measure` | `evidence.test.ts` |
| Real Trade Kit demo venue session | — | `npm run demo-venue` | `executor/src/cli.test.ts` |
| Holdout partition + guard + token-gated audited access | `@plumb/backtest` | internal | `backtest/src/evidence.test.ts` |
| Funding reconstruction (75th-pct conservative constant, cost-only) | `@plumb/backtest` | internal | `evidence.test.ts` › funding model |
| Historical regime segmentation (bull/bear/chop, trailing-only) | `@plumb/backtest` | internal | `evidence.test.ts` › regimes |
| Bull-only verdict for a config that is really a leveraged long | `@plumb/backtest` | internal | `evidence.test.ts` › regimes |

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Scaffold + constitution | ✅ shipped |
| 1 | `@plumb/market` — data, indicators, snapshot, watchdog, cache, history | ✅ shipped |
| 2 | `@plumb/strategy` — pure signal engine, regime, gate, portfolio | ✅ shipped |
| 3 | `@plumb/risk` — governor, sizing, drawdown ladder, kill switch | ✅ shipped |
| 4 | `@plumb/backtest` — walk-forward harness, cost model, eligibility gate | ✅ shipped |
| 5 | `@plumb/executor` — bracketed placement, idempotency, reconciliation | ✅ shipped |
| 5B | Real demo venue session | ⚠️ read paths verified; writes blocked on OKX account mode |
| 4B | Evidence expansion | ⚠️ Parts A–E shipped except `dispersion` |
| 6 | `@plumb/asp` — published feed, subscription, MCP + HTTP | ✅ shipped |
| 7 | Ops, monitoring, daily review, deployment | ⏳ not started |
| 8 | 21-day paper validation | ⏳ not started (a 21-day clock; P7 must land first) |
| 9–10 | Not yet written | — |

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

## Data on hand after P4B

| Instrument | 15m | 1H | 4H | Span | Real funding |
| --- | --- | --- | --- | --- | --- |
| BTC-USDT-SWAP | 105,300 | 26,400 | 6,600 | 2023-08-09 → 2026-08-10 | 293 settlements (97d) |
| ETH-USDT-SWAP | 105,300 | 26,400 | 6,600 | 2023-08-09 → 2026-08-10 | 293 settlements (97d) |
| SOL-USDT-SWAP | 105,300 | 26,400 | 6,600 | 2023-08-09 → 2026-08-10 | 293 settlements (97d) |

Zero gaps, zero duplicates. **Development set ends 2026-05-12; the last 90 days are a locked
holdout.** ~91% of the 3-year window has no real funding and uses the conservative model.

## Fixed candidates (P4B Part C), measured over 3 years

`npm run replay --tf 1H` over 78,303 cycles:

| Strategy | Before (180d) | After (3y) | Rate | Note |
| --- | --- | --- | --- | --- |
| `revert_band` | 2 | **2,606** | 3.33% | now the dominant signal source — changes the combined config's character |
| `funding_skew` | 0 | **305** | 0.39% | standalone mode; was structurally unable to fire alone |
| `trend_ema` | 16 | 94 | 0.12% | unchanged logic |
| `breakout_range` | 46 | 132 | 0.17% | unchanged logic |

## Eligibility gate — P4B Part E: 0 of 10 configurations passed

Development set only (2023-08-06 → 2026-05-12, ~24,000 1H bars/instrument). **The holdout was not
read.** No threshold was changed and no parameter was tuned.

| Config | OOS trades | Win% | PF | Net USDT | MaxDD% | P(ruin) | Without best trade | Trades/14d (median) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `trend_ema` | 238 | 36.6 | 0.689 | −198 | 70.5 | 86.2% | −252 | 1 |
| `revert_band` | 1,458 | 28.5 | 0.929 | −868 | 235.5 | 97.9% | −1,037 | 7 |
| `breakout_range` | 468 | 31.2 | 0.758 | −180 | 55.2 | 90.0% | −242 | 2 |
| `vol_expansion` | 533 | 40.5 | **1.195** | **+42** | 34.1 | 72.1% | −159 | 2 |
| `oi_divergence` | 0 | — | — | 0 | — | — | — | 0 |
| `session_bias` | 1,495 | 23.5 | 0.754 | −1,233 | 252.7 | 100% | −1,312 | 8 |
| `funding_skew` | 0 | — | — | 0 | — | — | — | 0 |
| `all_combined` | 2,298 | 30.8 | 0.886 | −926 | 157.0 | 98.6% | −1,377 | 14 |
| `trend_and_breakout` | 981 | 37.7 | 0.941 | −272 | 85.2 | 91.8% | −373 | 4 |
| `mean_reversion_pair` | 1,458 | 28.5 | 0.929 | −868 | 235.5 | 97.9% | −1,037 | 7 |

`vol_expansion` is the only positive configuration, and it fails anyway: **profitable only in bull
regimes** (+96.48 in bull, −54.31 across 99 trades outside it — a leveraged long, not an edge),
P(ruin) 72%, and removing its single best trade turns +42 into −159.

**100% of development-set funding is modelled**, because OKX's 97-day real-funding window lies
almost entirely inside the holdout. `vol_expansion`'s entire profit therefore sits in the modelled
period — flagged red by the report.

### Regime segmentation (net USDT / trades)

| Config | bull | bear | chop |
| --- | --- | --- | --- |
| `trend_ema` | −245.44 / 40 | +39.20 / 21 | +8.16 / 19 |
| `revert_band` | −441.81 / 254 | −388.05 / 155 | −38.44 / 124 |
| `vol_expansion` | **+96.48 / 86** | −14.62 / 56 | −39.70 / 43 |
| `session_bias` | −391.65 / 269 | −406.35 / 181 | −434.89 / 160 |
| `all_combined` | −520.37 / 435 | −310.26 / 280 | −95.41 / 262 |

### Hour-of-day (session_bias measurement, development set)

One hour survived regime segmentation on all three instruments: **08:00 UTC, positive** —
BTC +3.16bp, ETH +3.33bp, SOL +4.65bp. A funding-settlement hour, so structurally plausible rather
than dredged. Hour 22 had larger raw means (+5.4/+7.1/+7.8bp) but did not survive segmentation.
**The surviving edge is ~3–5bp against a 10bp round-trip taker fee**, and the backtest confirmed it:
profit factor 0.754. A real effect smaller than the cost of capturing it is not an edge.

## Earlier gate results — NONE PASSED (measured on 180 days, P4)

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

## Operations — Phase 7

`@plumb/ops` supervises the system that the earlier phases built.

- **`alerts.ts`** — per-severity dedupe windows (INFO 6h, WARN 1h, URGENT 15m, CRITICAL 5m) and an
  hourly ceiling that **never** gags a CRITICAL. Suppressed counts are carried into the next
  message, so throttling loses timing, never information.
- **`watchdog.ts`** — `runner_stalled`, `data_stale`, `venue_unreachable`, `reconcile_mismatch`,
  `near_kill_switch`. `assess()` is pure and separately testable. `WATCHDOG_CAN_REARM` is `false`:
  it can halt and can never lift a halt. `venue_unreachable` deliberately does **not** flatten — a
  close cannot be placed through a venue that cannot be reached.
- **`review.ts`** — a daily prose review, model-written from a ledger derived entirely from the
  runner log, the feed and the governor state, with a deterministic template fallback.
- **`snapshot.ts`** — `VACUUM INTO` (safe on live WAL databases), restore verified by **content
  hash** rather than size, and pruning that only runs after the new backup has proven restorable.
- **`heartbeat.ts`** — an outward ping, so a dead box is reported by a third party rather than by
  an absence. It never throws and never affects trading.

Deployed as two systemd units behind Caddy on `plumb.assayed.xyz`, plus nightly backup and daily
review timers. Only ports 22, 80 and 443 are open; every service port is bound to loopback.

**Seven failure drills were executed against the real host** — `reports/drills.md`. Three found
real defects: a runner that could be `active` and inert under a venue outage, a crash-loop limiter
that was never armed because a systemd directive sat in the wrong section, and a backward clock
step that re-armed an already-spent daily loss budget. All three are fixed and pinned by tests.

## The paper run — Phase 8

Started **2026-08-10T12:33:41Z**, running unattended in demo mode. Gate readable 2026-08-31.

Its ten criteria are in `reports/p8-gate.md`, fixed before the run produced a number. Nine are
about the machinery — uptime, reconciliation, naked positions, parameter discipline, restart
recovery — and those need answering whether or not a strategy ever passes the evidence gate.

**This run cannot tell us whether Plumb makes money.** No configuration has passed the P4
eligibility gate, so it runs on a demo-only override with a permissive configuration. Two
independent locks stand between here and live money, and this opens only the first.

## Not yet built

Recorded so that nothing looks accidentally missing:


- **`dispersion` is not implemented.** Spreading risk across instruments touches the strategy, the
  risk governor and the executor at once, so it needs its own phase rather than a corner of this one.
- **Live trading is not armed.** Guardrail 10 holds: the live credentials are not in any running
  process, and `sanitizeEnv` strips them from every spawned child. Phase 9 arms them.
- **A true kernel reboot has not been drilled.** Boot configuration is verified and a cold start
  passes; the reboot itself is an operator action, recorded in `reports/drills.md`.
- **`oi_divergence` remains structurally unevaluable** — no historical open-interest series exists
  to backtest against, and `funding_skew` has no real funding data outside the holdout.
