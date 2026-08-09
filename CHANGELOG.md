# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-08-09

Phase 3 — `@plumb/risk`, the component that decides whether money moves. Deterministic, persisted,
and with no model anywhere near it.

### Added
- `params.ts` — imports the locked constants from `@plumb/core` and adds a startup assertion plus a
  SECOND tripwire, deliberately redundant with P0's. If somebody edits `locked.ts` and its test in
  one commit, this still fails.
- `sizing.ts` — position sizing from stop distance. Notional is reduced to satisfy the leverage
  ceiling; the stop is NEVER widened to fit a size. Below-minimum sizes are rejected outright.
  Lot rounding is downward, so post-rounding risk is always at or under the budget, and the REAL
  risk is reported rather than the intended one.
- `state.ts` — persisted governor state in SQLite. Halt flags survive a restart; the daily counter
  rolls on the UTC boundary, explicitly not the UTC+8 competition boundary.
- `governor.ts` — the veto: 14 structured codes in a fixed precedence, first failure wins.
- `drawdown.ts` — the ladder at −2/−5/−8/−12%, unwinding only on realised gains.
- `flatten.ts` — idempotent emergency close-out that depends only on persisted state, so it works
  when everything upstream is broken.
- `rearm.ts` — manual re-arm requiring an operator token and a reason, writing an audit record.
  The system cannot re-arm itself; denied attempts are recorded too.
- `simulate.ts` — the hostile-strategy harness, pure and shared by the test and `npm run hostile`.
- `INSTRUMENT_SPECS` in `@plumb/market`, recorded from the live exchange (BTC ctVal 0.01,
  ETH 0.1, SOL 1; all minSz/lotSz 0.01).
- 92 new tests (323 total), including a 10,000-case fuzz and the hostile simulation.

### Changed
- **The `Signal` type, the id factories and the regime-label vocabulary moved to `@plumb/core`.**
  `risk` must read signals to veto them, and reaching that type through `@plumb/strategy` would
  have given `@plumb/executor` a transitive path back to strategy internals. `strategy` re-exports
  them; all 231 prior tests passed unchanged across the move.

### Verified
- **Fuzz: 10,000 random signals against random equity states.** No approved signal ever breached
  the per-trade risk, the leverage ceiling, the notional cap, the concurrency limit, the kill
  switch, the daily limit or the averaging-down prohibition.
- **Hostile simulation over 180 days of real history, 5 scenarios — the governor held in all of
  them.** Worst approved risk 3.9998 of 4; worst leverage 1.57 of 3; peak notional 799.45 of 800;
  zero approvals after a kill switch.
- Starting at 340 USDT, equity reached **331.17** before the switch fired: a position was already
  open and its stop filled with slippage. **The kill switch bounds new risk, not equity.** From the
  locked 400 the ladder keeps the account 35+ USDT clear of the floor (baseline min 370.74).
- `MAX_TOTAL_NOTIONAL` (800) binds before the 3× leverage ceiling on 400 USDT of equity, and
  `correlated_exposure` (600) binds before both.

## [0.3.0] — 2026-08-09

Phase 2 — `@plumb/strategy`, pure signal generation. Zero I/O, zero network, zero clock reads, zero
unseeded randomness, enforced by a source scan. **No edge is claimed for any strategy.**

### Added
- `Signal` type + zod schema with **no `size`, `leverage` or `notional` field** — sizing belongs to
  `@plumb/risk`. Enforced by the type, by `.strict()` parsing, and by a runtime `assertNoSizing`.
- Deterministic regime classifier: `trending_up | trending_down | ranging | expanding | compressed |
  unclear`, with a confidence in 0–1. `unclear` is a first-class answer with a deliberate dead zone
  between the ranging ceiling and the trending floor.
- `RegimeHint` interface for a future model label — it may only LOWER confidence when it disagrees,
  never change the label, never contribute a number. Nothing calls it.
- Four candidate strategies, each individually enable/disable-able: `trend_ema`, `revert_band`,
  `breakout_range`, `funding_skew` (which never fires without a same-side peer).
- Pre-emission gate with 14 structured rejection codes. A degraded snapshot rejects everything
  before any other check. Opposite sides on one instrument emit NEITHER and log the conflict.
- Portfolio coordination: correlation cap across BTC/ETH/SOL (default 1 per direction per cycle),
  one signal per instrument per cycle, and never adding to an already-open direction.
- `rationale.ts` — payload interface for LLM-written rationale plus `findUnsanctionedNumbers`,
  which catches a figure the model invented. Not called in this phase.
- `engine.ts` — regime → strategies → gate → portfolio → validated `Signal[]`, clock and id source
  injected.
- Seeded synthetic-market testkit exported at `@plumb/strategy/testkit`, with regime fixtures and
  event fixtures verified by probe scripts.
- `snapshotFromCandles` in `@plumb/market` for historical replay.
- 123 new tests (231 total).

### Fixed
- `revert_band` could emit a stop on the PROFITABLE side of entry when price had already collapsed
  through the band. The gate caught all six occurrences across 180 days of real history; the
  strategy now refuses to build the order at all. `stop_wrong_side` rejections: 6 → 0.
- `percentileRank` now uses the mid-rank convention. The naive form scored a perfectly flat series
  at 1.0, which would read a dead-quiet market as violently expanding.

### Verified
- Purity: byte-identical `Signal[]` across 100 runs with the same snapshot and seed; source scan
  finds no clock read, randomness, network call or I/O.
- A degraded snapshot emits zero signals for every strategy in every regime, including on a window
  that otherwise emits.
- 180-day replay: 12,603 cycles, no throw. `trend_ema` 16 signals (0.13%), `revert_band` 2 (0.02%),
  `breakout_range` 46 (0.36%), `funding_skew` unevaluable (no stored funding history).

## [0.2.0] — 2026-08-09

Phase 1 — `@plumb/market`, the only component that talks to market data. **No API key is used
anywhere in this release**; every OKX endpoint called here is public.

### Added
- `@plumb/core` time primitives: `utc8ToUtcMs`, `utcMsToUtc8Parts`, `utcDayStartMs`, `utcDayKey`,
  `isSameUtcDay`, `toUtcIso`. The competition clock (UTC+8) and the accounting clock (UTC) are now
  converted explicitly, and never via the ambient system timezone.
- `OkxPublicClient` — ticker, candles, history candles, mark price, index ticker, funding rate
  (current + history), open interest (+ history) and price limit, with a locked-instrument guard,
  per-attempt timeouts, exponential backoff with full jitter, retries only on transient failures,
  and a serialised rate gate.
- `indicators.ts` — SMA, EMA, RSI, MACD, true range, ATR, Bollinger, realised volatility and
  ADX/±DI. Pure, aligned to the input, Wilder-smoothed where the original definition says so.
- `snapshot.ts` — `MarketSnapshot`, the single immutable object `strategy` will consume, built by
  a pure function with the clock injected.
- `staleness.ts` — the data watchdog: per-field ages and budgets, `degraded` plus the names of the
  failing fields, and `isTradeable()`.
- `cache.ts` — SQLite-backed candle store with an in-memory tail. Closed candles are immutable and
  are never refetched or overwritten; history survives a restart.
- `history.ts` — backwards-paginating backfill with gap and duplicate detection, skipping windows
  already held as finalised bars.
- `fixtures/` — 33 files of real recorded OKX payloads (3,318 rows), replayed by every test.
- Scripts: `record-fixtures`, `snapshot`, `backfill`, `divergence`.
- 121 new tests (129 total), all offline.

### Fixed
- **`client.candles()` returned OKX's newest-first order** while every indicator assumes
  chronological order, so a caller using the raw client fed indicators a reversed price series —
  silently producing plausible, wrong numbers. Order is now normalised once at the boundary, and
  pinned by a test that also asserts the raw envelope is the other way round.

### Verified
- Live run against real market data for all three instruments: prices match the market, RSI inside
  0–100, ATR positive and scaling correctly with timeframe (0.08% → 0.56% of price from 15m to 4H).
- 65,700 historical candles stored (≈181 days of 15m and ≈187 days of 1H per instrument), zero gaps
  and zero duplicates. A re-run costs 12 requests instead of 219 and inserts nothing.
- Indicator divergence measured against the OKX Agent Trade Kit: SMA, Bollinger and EMA(14) match
  exactly; RSI, ATR, ADX and MACD differ because the Trade Kit uses a short (~40–80 bar) warm-up
  while we compute over the full series. Formulas agree. See AGENTS.md § Deviations.

## [0.1.0] — 2026-08-09

### Added
- npm-workspaces monorepo scaffold (Node 22, TypeScript strict incl. `exactOptionalPropertyTypes`)
  with eight workspaces: `core`, `market`, `strategy`, `risk`, `backtest`, `executor`, `asp`, `ops`.
- `AGENTS.md` — the build constitution: mission, locked parameters, ten hard guardrails, the
  competition rules that create disqualification risk, cost discipline, inherited gotchas, live
  platform-doc links, and an append-only deviations log.
- `PLUMB.md` — vision: signal primacy, why risk-first, the post-competition subscription business,
  and an explicit statement that no strategy edge is claimed until backtest and paper trading
  produce evidence.
- `@plumb/core` — `LOCKED`, the frozen competition parameters, plus the derived-invariant helpers.
- Locked-parameter tripwire (`packages/core/src/locked.test.ts`): pins every locked value literally,
  pins the exact key set, asserts the object is deeply frozen, asserts the derived invariants
  (`CAPITAL − MAX_LOSS = KILL_SWITCH_EQUITY`, `PER_TRADE_RISK = 1%` of capital,
  `MAX_TOTAL_NOTIONAL ≤ CAPITAL × LEVERAGE_CEILING`), and asserts that no averaging-down-shaped key
  can be introduced.
- `RUNBOOK.md` (stub, Phase 10), `FEATURES.md`, `SECURITY.md`, `README.md`, `.env.example` covering
  every `PLUMB_*` and provider variable, `.gitignore`.
- Vitest across all workspaces; one placeholder test per workspace.

[Unreleased]: https://github.com/Franlinozz/Plumb/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Franlinozz/Plumb/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Franlinozz/Plumb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Franlinozz/Plumb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Franlinozz/Plumb/releases/tag/v0.1.0
