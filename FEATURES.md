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
| Fixture recording | — | `npm run record-fixtures` | manual, once per phase |
| Live snapshot inspection | — | `npm run snapshot` | manual eyeball check |
| Historical backfill | — | `npm run backfill -- --days 180 --tf 15m,1H` | `history.test.ts` |
| Indicator divergence vs OKX Agent Trade Kit | — | `npm run divergence` | manual, findings in AGENTS.md |
| Regime fixture verification | — | `npm run probe:regimes` | `regime.test.ts` pins each label |
| Strategy event-fixture verification | — | `npm run probe:strategies` | `strategies.test.ts` pins each |
| 180-day signal-frequency replay | — | `npm run replay` | `engine.test.ts` (fixture-scale twin) |

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Scaffold + constitution | ✅ shipped |
| 1 | `@plumb/market` — data, indicators, snapshot, watchdog, cache, history | ✅ shipped |
| 2 | `@plumb/strategy` — pure signal engine, regime, gate, portfolio | ✅ shipped |
| 3–10 | Not yet written | — |

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

## Not yet built

Recorded so that nothing looks accidentally missing:

- **Funding-rate history is not stored.** `@plumb/market` fetches it live but the candle store has
  no table for it, so `funding_skew` cannot be replayed. **P4 prerequisite.**

- `@plumb/risk` — risk governor. Placeholder only; the locked limits exist but nothing enforces them yet.
- `@plumb/backtest` — replay + metrics. Placeholder only. **No backtest has been run.**
- `@plumb/executor` — Agent Trade Kit execution + reconciliation. Placeholder only.
- `@plumb/asp` — subscription feed + published ledger. Placeholder only.
- `@plumb/ops` — alerts, daily review, health. Placeholder only.
