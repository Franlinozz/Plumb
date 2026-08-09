# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Franlinozz/Plumb/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Franlinozz/Plumb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Franlinozz/Plumb/releases/tag/v0.1.0
