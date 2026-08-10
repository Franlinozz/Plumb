# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] — 2026-08-10

Phase 6 — `@plumb/asp`. The published feed, the subscription service, and the public surface.

### Added
- `feed.ts` — append-only, hash-chained published feed. Each entry carries the previous entry's
  hash, so an edited or removed signal breaks the chain and `verifyChain` says where.
- `publish_gate.ts` — **guardrail 2 made structural.** `requirePublished` throws for a signal that
  is not in the feed, and `publishThenExecute` is the only sanctioned path from a signal to an
  order: rationale → publish → deliver → execute, with the executor receiving the PUBLISHED ENTRY
  rather than the Signal. If publication fails, execution never happens.
- `rationale.ts` — the Claude call P2 designed the interface for. Schema-validated, with a
  deterministic template fallback for an unavailable model, an unparseable response, or a response
  that introduces a number not present in the signal. The signal is frozen before generation and
  the rationale is written to the FEED, never back onto the signal.
- `subscription.ts` — one service, created once, never deleted. There is no delete function;
  `refuseDeletion` exists to make the refusal explicit and testable. Description follows the
  current A2A docs' Trade Kit template, with a signal example and the ordered pre-subscription
  confirmations a subscriber's agent parses.
- `track_record.ts` — every figure computed from the ledger, with a caveat that scales with the
  sample size. A source scan proves no performance number is hand-written.
- `http.ts` — `/health` (no model, no venue, <100ms), `/.well-known/plumb.json`, `/signals/recent`,
  `/signals/:id`, `/track-record`, `/feed/verify`. Rate-limited, body-capped, sanitised errors.
- `tools.ts` — four free MCP tools: recent signals, track record, signal detail, risk disclosure.
- 45 new tests (527 total).

### Verified
A real signal published end-to-end against live market data with a Claude-written rationale that
passed the foreign-number check, the executor receiving the published entry, and the chain
verifying clean.

## [0.8.0] — 2026-08-10

Phase 4B Parts D–E. **0 of 10 configurations passed the gate on three years of data.** The holdout
was not read. No threshold was changed and no parameter was tuned.

### Added
- `vol_expansion` — compression by percentile, then the first decisive break out of it, stop INSIDE
  the compressed range. The bet is that expansion occurs, not on which way.
- `oi_divergence` — the four order-flow states, trading only the two least ambiguous.
- `session_bias` — built ONLY because the measurement justified it (see below).
- `scripts/measure-tables.mjs` (`npm run measure`) — the OI-state and hour-of-day tables, computed
  on the development set before any rule was written.
- `utcHourOf` / `utcDayOfWeek` in `@plumb/core`, so `@plumb/strategy` can ask what hour a bar falls
  in without constructing a `Date` and breaking its own purity scan.
- Gate reporting extended with trades-per-14-day-window, regime segmentation and the
  modelled-vs-real funding split.

### Results — nothing eligible
`vol_expansion` was the only positive configuration (+42 USDT, PF 1.195) and fails anyway:
**profitable only in bull regimes** (+96.48 bull vs −54.31 across 99 trades outside), P(ruin) 72%,
and removing its single best trade turns +42 into −159.

`session_bias` confirmed the arithmetic it was built to test: the one hour surviving regime
segmentation (08:00 UTC, +3–5bp on all three instruments) is smaller than the 10bp round-trip taker
fee. 1,495 trades, profit factor 0.754. Retired.

`oi_divergence` and `funding_skew` fired ZERO times on the development set — the first because no
historical open-interest series exists, the second because OKX's 97-day real-funding window lies
almost entirely inside the holdout. Neither is evaluable against this data.

### Not done
- **`dispersion` was not built.** The spread architecture spans strategy, risk and executor and
  owes a test per invariant; a version that can half-open is worse than none.

### Measurement caveat, recorded in AGENTS.md
The pooled OOS curve is a concatenation of ~47 independent 20-day windows, each starting fresh at
400 USDT with its own kill switch — so pooled drawdown and P(ruin) overstate what a continuously
traded account would see. The gate's floor criterion uses PER-WINDOW minimum equity, which is the
meaningful number.

## [0.7.1] — 2026-08-10

Phase 5B COMPLETE. The operator whitelisted the VPS IPv6 address and switched the demo account to
`acctLv 2`, unblocking every write path.

### Verified against the real demo venue
- Order placed and filled (`ordId 3819947522874556416`), position opened `net -0.34`.
- **clOrdId round-trips EXACTLY** — `SIG6NogRjfTDK` sent, `SIG6NogRjfTDK` returned. The idempotency
  scheme needs no adjustment.
- **Stop visible at the venue** (`slTriggerPx 66385.2`) — guardrail 3 is now checkable, not asserted.
- Reconciliation clean: 1 fill matched, 0 issues.
- Replay ×5 → **0 new positions**. Crash recovery abandoned correctly. An invalid stop price was
  rejected and **the entry never opened**. Close path works; the venue reports flat.

### Fixed
- **An attached stop is not in the order's top-level `slTriggerPx`** — it lives in
  `attachAlgoOrds[0]` with its own `attachAlgoId`. The wrapper read only the top level and so
  reported "no stop attached" for a protected order, which would have made guardrail 3
  unverifiable at the venue.

### Found, not yet fixed
- **`swap close` produces a fill with an EMPTY `clOrdId`**, unattributable by construction, so
  reconciliation flags our own emergency close. The normal close path must be a REDUCE-ONLY order
  carrying `toCloseClOrdId`; `swap close` belongs to the emergency path only. Recorded as
  AGENTS.md gotcha 15 and left for the phase that wires the lifecycle close.

## [0.7.0] — 2026-08-10

Phase 4B Parts A–C — evidence expansion. **Parts D and E are NOT done; see below.**

### Added
- `holdout.ts` — the history is partitioned ONCE: development to 2026-05-12, the last 90 days a
  write-protected holdout. `assertDevelopmentOnly` throws on any window reaching past the boundary
  (no tolerance parameter — a tolerance is how a holdout leaks), and reading the holdout needs an
  operator token plus an audit record carrying the date, config hash and reason. A test asserts the
  normal backtest path cannot read holdout data.
- `funding_model.ts` — real settlements where they exist; elsewhere a conservative constant at the
  75th percentile of observed |funding|, charged AGAINST the position in both directions. Never a
  credit we did not observe. Every report states the real-vs-modelled fraction.
- `regimes.ts` — bull/bear/chop classification from TRAILING 90-day return and realised volatility
  only, plus `bullOnlyVerdict`, which labels a config that is really a leveraged long.
- 3 years of history: 105,300 × 15m, 26,400 × 1H, 6,600 × 4H per instrument, zero gaps/duplicates.
- 33 new tests (482 total).

### Fixed (Part C — specification errors, not bugs)
- `revert_band` conditions loosened to `ranging` OR low-ADX, and band touch OR RSI extreme.
  **Fires 2 → 2,606 times over 3 years.** It is now the dominant signal source, which materially
  changes the character of the combined configuration.
- `funding_skew` gained a standalone mode with a self-evaluated confirmation. **Fires 0 → 305.**
  Previously it could not fire alone by design, so it could never be backtested alone.

### Not done
- **Part D (new candidates)** — `vol_expansion`, `oi_divergence`, `session_bias` and `dispersion`
  are not built. `dispersion` in particular is a spread-position architecture change spanning
  strategy, risk and executor (pairId, MAX_CONCURRENT semantics, correlation-veto special-casing,
  two-leg atomicity) and warrants its own phase.
- **Part E (gate re-run)** — not run, because it should be run once the candidate set is complete.
  The P4 result therefore still stands: nothing is eligible.

## [0.6.1] — 2026-08-10

Phase 5B — the real Agent Trade Kit demo venue. **Write paths are blocked on an OKX account
setting; read paths are all verified.**

### Added
- `cli.ts` — the CLI-backed `AtkClient`, spawning `okx … --demo --json`, with account-mode
  awareness (`getAccountConfig`, `resolvePosSide`).
- `demo-override.ts` — a demo-ONLY eligibility bypass that requires `PLUMB_MODE=demo` and a demo
  venue, with no force flag. The only bypass in the system, and it cannot apply in live mode.
- `scripts/demo-venue-session.mjs` (`npm run demo-venue`).
- 14 new tests (449 total).

### Findings against the real venue
- **IPv6 egress vs IPv4 whitelist** → every call 401'd until `--dns-result-order=ipv4first`.
- **`--slOrdPx -1` is parsed as a flag** → the `=` form is required, else no bracket can be placed.
- **The demo account is `acctLv: 1` (Spot mode)** → `sCode 51010` on every swap order, with both
  `posSide: long` and `posSide: net`. Perpetuals cannot be traded until the account is switched to
  Single-currency margin or higher in the OKX UI. The CLI cannot change it.

### Verified
Balance (5,000 USDT), positions, fills, account config, order lookup by clOrdId, boot recovery and
the eligibility override all work against the real venue. Placement, stop attachment, clOrdId
round-trip, reconciliation-against-real-fills and the close path remain UNVERIFIED — blocked.

## [0.6.0] — 2026-08-09

Phase 5 — `@plumb/executor`, the only component that places orders. **Demo mode only.**

### Added
- `atk.ts` — Agent Trade Kit wrapper. `assertDemo` refuses to construct a live client without two
  deliberate flags this phase never sets. Errors are classified so a REJECTION is never retried
  blindly — retries are for timeouts and transport failures only.
- `bracket.ts` — the entry and its stop are one operation. Where an attached stop cannot be used,
  the fallback places the entry, places the stop, and **if the stop fails, immediately closes the
  entry** and raises an alarm. A naked position never survives a cycle.
- `idempotency.ts` — the signal id is the client order id; intent is persisted BEFORE placement
  (`synchronous = FULL`), so a crash between the two is recoverable from the venue's own records.
- `clord.ts` — OKX accepts only alphanumerics in `clOrdId`, so signal ids are sanitised on the way
  out and resolved back by lookup, never by computation.
- `reconcile.ts` — the audit loop. An unmatched fill, a missing position, size drift or a position
  we never opened all halt trading.
- `lifecycle.ts` — breakeven trailing at 1R, maxHoldBars expiry, invalidation closes, and a stop
  that can only ever move CLOSER to entry.
- `runner.ts` — serialised cycle loop that cannot overlap itself, plus `assertEligible`, the lock
  that refuses to trade a configuration without a signature-verified passing backtest record.
- `mock.ts` — a fault-injectable venue implementing the same interface as the real client.
- Eligibility signing moved to `@plumb/core` so executor can verify a record without importing
  `@plumb/backtest`.
- 51 new tests (435 total).

### Verified
- Live-data session: 6 cycles against real OKX market data, one order placed with the stop
  attached, idempotency held, reconciliation clean throughout, and an injected orphan fill
  correctly caught and halted.

### Not done
- **The Agent Trade Kit `--demo` session was NOT run.** Demo mode requires a separate demo API key;
  the key we hold is a live sub-account key and guardrail 10 forbids using it before P9. The
  session script therefore runs real data through a simulated venue, which is stated in its header,
  in the checkpoint, and here.

## [0.5.0] — 2026-08-09

Phase 4 — `@plumb/backtest`, the evidence gate. **All five configurations FAILED the gate.**
Reported as measured; nothing was tuned to make anything pass.

### Added
- `engine.ts` — bar-by-bar replay of the FULL pipeline (snapshot → strategy → gate → portfolio →
  governor → simulated execution), with `assertNoLookahead` run on every window.
- `costs.ts` — OKX's published Lv1 taker rate (0.05%, fetched not guessed), a slippage model that
  scales with size and bar volatility, entries filling at the NEXT bar's open, stops filling at the
  WORSE of stop price and next-bar open, and funding booked from the real historical series.
- `walkforward.ts` — rolling 60d IS / 20d OOS windows that never overlap, reported side by side
  with an explicit overfit verdict.
- `metrics.ts` — every metric, max drawdown first, plus per-regime and per-strategy breakdowns.
- `monte_carlo.ts` — seeded 10,000-path resampling reporting P(ruin) and the 5th percentile.
- `gate.ts` — five eligibility criteria and a signed, tamper-evident record.
- `report.ts` — markdown reports with a self-contained inline SVG equity curve and an explicit
  "what this does not prove" section.
- Funding-rate storage and backfill in `@plumb/market` — the P4 prerequisite P2 identified.
- 67 new tests (390 total).

### Results — none eligible
| Config | OOS trades | PF | Net | P(ruin) | Rejected on |
| --- | --- | --- | --- | --- | --- |
| `trend_ema` | 9 | 0.52 | −11.23 | 0.0% | PF, sample size, outlier |
| `revert_band` | 0 | — | 0.00 | 0.0% | no trades at all |
| `breakout_range` | 30 | 1.19 | +14.41 | 6.2% | P(ruin), outlier dependence |
| `funding_skew` | 0 | — | 0.00 | 0.0% | cannot fire alone, by design |
| `all_four_combined` | 37 | 0.74 | −24.46 | 16.7% | P(ruin), PF, outlier |

`breakout_range` was the only positive out-of-sample configuration and did not degrade (OOS profit
factor 104% of in-sample), but removing its single best trade turns +14.41 into −37.34, and its
5th-percentile equity is 334.32 — below the kill switch.

### Fixed
- The cost-model test asserted that full costs produce a worse final equity than zero costs. That
  is unsound: slippage moves fills, which moves when stops trigger, which produces a different set
  of trades. The test now asserts the property that actually holds — per trade, fees and funding
  are always subtracted from gross, never added.

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

[Unreleased]: https://github.com/Franlinozz/Plumb/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Franlinozz/Plumb/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Franlinozz/Plumb/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Franlinozz/Plumb/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Franlinozz/Plumb/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Franlinozz/Plumb/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Franlinozz/Plumb/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Franlinozz/Plumb/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Franlinozz/Plumb/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Franlinozz/Plumb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Franlinozz/Plumb/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Franlinozz/Plumb/releases/tag/v0.1.0
