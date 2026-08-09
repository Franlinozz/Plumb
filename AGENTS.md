# AGENTS.md — the Plumb build constitution

> Re-read this file at the start of EVERY session and EVERY phase, before writing any code.

## Mission

Plumb is a Trading ASP on OKX.AI. It emits signals with published rationale, vetoes them through a
deterministic risk governor, executes only approved signals through OKX Agent Trade Kit, and
reconciles every fill back to its signal. Its competition goal is a valid top-40 finish. Its
long-term goal is a subscription signal service with a public, verifiable track record.

Tagline: **"Every signal, measured before it's sent."**

## LOCKED PARAMETERS — immutable, never changed by you, only by the operator in writing

```
CAPITAL              400 USDT, funded once at registration, NEVER topped up mid-competition
                     (rule: Principal Base rises on deposit and never falls on withdrawal —
                      a mid-competition top-up permanently damages PnL%)
KILL_SWITCH_EQUITY   335 USDT  → flat everything, halt permanently, require manual re-arm
MAX_LOSS             65 USDT
DAILY_LOSS_LIMIT     20 USDT   → flat, no new signals until next UTC day
PER_TRADE_RISK       4 USDT (1% of starting equity) — stop distance determines size, never the reverse
LEVERAGE_CEILING     3x — hard cap, rejected above this
MAX_CONCURRENT       2 positions
MAX_TOTAL_NOTIONAL   800 USDT
INSTRUMENTS          BTC-USDT-SWAP, ETH-USDT-SWAP, SOL-USDT-SWAP — nothing else, ever
ACCOUNTING_BASIS     Agent Trade Kit (OKX UID, USDT perpetuals only)
AVERAGING_DOWN       Prohibited. Not a parameter. There is no config value that enables it.
```

These live in `packages/core/src/locked.ts` and are pinned by `packages/core/src/locked.test.ts`,
the tripwire. If you find yourself editing either file, stop and ask the operator.

## HARD GUARDRAILS (never breach)

1. **SIGNAL PRIMACY:** `strategy` emits Signal objects and CANNOT place orders. `risk` may veto any
   signal. `executor` places orders ONLY for signals that exist in the published ledger and carry
   riskVerdict "approved". No other code path may create a fill.
2. **PUBLISH BEFORE EXECUTE:** a signal is written to the subscription feed and the ledger BEFORE the
   executor is permitted to act on it. The executor reads from the published feed, not from
   strategy internals. This is what makes our trades provably signal-derived when audited.
3. **EVERY POSITION HAS A STOP BEFORE IT OPENS.** Bracket at placement. No stop → no order.
4. **LLMs NEVER produce numbers that reach an order.** Not entry, size, leverage, stop, or TP.
   Models produce labels and prose only. All arithmetic is deterministic code.
5. **RECONCILIATION:** every executed fill must match a signal ID. An unmatched fill raises an alarm
   and HALTS trading immediately.
6. The risk governor's state (daily loss, peak equity, drawdown, halt flags) is **PERSISTED**. A crash
   or restart never resets a counter.
7. **No secrets in the repo.** Sub-account API key only, never the main account. Env/EnvironmentFile.
8. **Honesty:** no fabricated backtest results, no invented metrics, no self-trading, no wash trades.
9. **FEATURES.md current every phase:** capability | package | surface | test.
10. **LIVE KEYS DO NOT EXIST until Phase 9.** Everything before that is fake-mode or `--demo`.

## BREATHING SPACE

You are the executor on the ground. You MAY choose libraries, restructure internals, add logging,
take pragmatic debugging shortcuts, and resequence work within a phase — PROVIDED the guardrails
and LOCKED PARAMETERS hold exactly, and every deviation is logged below with one line of reasoning.
Never silently drop scope; report it in the CHECKPOINT.

## COMPETITION RULES THAT CREATE DISQUALIFICATION RISK (from the official rules + FAQ)

- Trades must correspond to signals delivered by the participating subscription service. Trades
  "clearly unrelated to those signals" can void ranking and award eligibility.
- The ASP must have ONE subscription service, snapshotted at competition start as the scoring basis.
  If multiple exist, the EARLIEST-CREATED is used. **DELETING IT MID-COMPETITION FORFEITS ELIGIBILITY.**
- ASP must remain online and subscribable for the full two weeks.
- At least one valid trade is required; a funded idle account is not an entry.
- Only trades through Agent Trade Kit count. Manual orders do not.
- PnL includes unrealised PnL on open positions at the close of the competition.
- Risk tokens are excluded from PnL%. Abnormal profits, self-trading, and abnormal fund flows are
  reviewed and may be disqualified.

**Scoring:** Overall Score = PnL% Rank × 50% + PnL Rank × 50%. Ranks 4–40 all pay 500 USDT equally.
The objective function is therefore NOT maximum return — it is **maximum probability of finishing
valid**. The three things that kill entrants are disqualification (trades not traceable to published
signals), downtime (ASP offline or subscription service deleted), and blowup (leverage destroying the
account before day 14). All three are engineering problems. Build accordingly.

## COMPETITION STATUS — Season 1 NOT ENTERED (operator decision, 2026-08-09)

Verified live from https://www.okx.ai/hackathon on 2026-08-09:

| | |
| --- | --- |
| Registration | Jul 31 – **Aug 11, 12:00 UTC+8** (= 2026-08-11 04:00 UTC), no entries after |
| Competition | Aug 11 12:00 → **Aug 25 12:00 UTC+8**, two weeks |
| Minimum capital | **300 USDT** equivalent (our locked 400 clears it) |
| Prize | 1st $10,000 · 2nd $7,000 · 3rd $4,500 · **ranks 4–40 $500 each** |
| Accounting basis | Onchain OS **or** Agent Trade Kit — chosen at registration, **cannot be changed after** |
| Agent Trade Kit restriction | **USDT Perpetual only**; trades outside the kit do not count |
| Subscription service | **Exactly one**, snapshotted at start as the scoring basis; if several exist the earliest-created is used; **deleting it mid-competition loses eligibility** |
| Other eligibility | ≥1 valid trade during the period; ASP online and subscribable throughout |

The binding constraint was ASP review: it takes ~24h and must COMPLETE before competition
registration, which left ~12 working hours. **The operator elected not to enter Season 1** and to
build Plumb properly across all ten phases as a subscription signal product, targeting a later
event.

**Nothing else in this constitution changes.** The LOCKED PARAMETERS stay exactly as they are —
they are sound risk discipline for a real signal service, not competition-specific tuning — and
every guardrail still holds. The competition rules above remain in force as design constraints
because they are what a future entry will be judged against, and because "one subscription service,
created once, never deleted" is already asserted in `@plumb/asp`.

**ASP identity (decided):** Plumb registers as a NEW ASP agent under the existing
**archonaudit@gmail.com** profile, alongside Assay #8599 — not by reusing #8599, whose
earliest-created service is a résumé scan and would become the scoring basis. That profile is also
already the active `onchainos` session.

## COST DISCIPLINE

`PLUMB_MODE=fake` is default for all dev and tests — deterministic fixtures, zero spend, zero network.
Market data from OKX public endpoints needs no auth. DeepSeek for regime labels (cheap, bounded,
schema-validated). Claude for signal rationale and the daily written review. Never iterate against
paid providers; one real call at phase end at most.

## GOTCHAS (paid for by Sigil, Occestra and Assay)

1. MCP: fresh `McpServer` + transport per HTTP request; stateless `/mcp`; close on res `'close'`.
2. `JSON.stringify` needs a bigint replacer.
3. Test HTTP via `app.listen(0)`, never fixed ports.
4. `better-sqlite3` is synchronous — thin sync repo layer, no async wrappers.
5. express 5 + `@types/express` 5.
6. `exactOptionalPropertyTypes`: spread optional props conditionally.
7. Platform docs DRIFT: any phase touching payments, subscriptions or the trade kit re-fetches the
   CURRENT docs and implements what is documented TODAY. Log the shapes in Deviations.
8. All competition times are **UTC+8**. All internal accounting is **UTC**. Convert explicitly, never
   implicitly — a timezone bug in a daily loss limit is a real money bug.
9. Anything slow becomes a job. Marketplace clients time out.
10. Every external reference must be verified live, not assumed.

## PLATFORM DOCS (fetch live, never from memory)

All seven verified reachable (HTTP 200) on 2026-08-09. Re-verify — don't assume — in any phase
that touches payments, subscriptions or the trade kit.

| What | URL |
| --- | --- |
| Hackathon rules | https://www.okx.ai/hackathon |
| Agent Trade Kit (repo) | https://github.com/okx/agent-trade-kit |
| Agent Trade Kit (docs) | https://www.okx.com/docs-v5/agent_en/ |
| A2A subscription | https://web3.okx.com/onchainos/dev-docs/okxai/a2a-subscription |
| Agent installation | https://web3.okx.com/onchainos/dev-docs/okxai/agent-installation-guide |
| ASP tutorial | https://www.okx.ai/tutorial/asp |
| Payments | https://web3.okx.com/onchainos/dev-docs/payments/app |

## Deviations

(append-only log — one line of reasoning each)

- **P0 · repo is a clone, not `git init`.** `Franlinozz/Plumb` already existed with `LICENSE` +
  `README.md`; cloned it so the remote and the MIT LICENSE (already correct) are preserved.
- **P0 · tests live in `src/**/*.test.ts` and are compiled into `dist`.** Assay learned that a
  `tsconfig` whose `include` misses the test files means the tests are never typechecked; keeping
  them inside the composite project makes `npm run typecheck` cover them. The emitted `.test.js`
  files in `dist` are inert and nothing is published to npm.
- **P0 · dual module resolution: TS project references for typecheck, vitest `resolve.alias` for
  tests.** `tsc -b` resolves `@plumb/*` through the built `dist/*.d.ts` (so build order is enforced
  topologically and cannot compile against a stale dist — the Occestra failure), while vitest maps
  `@plumb/*` straight to `src` so `npm test` needs no prior build.
- **P4 · ALL FIVE CONFIGURATIONS FAILED THE ELIGIBILITY GATE.** Reported as-is; no parameter was
  tuned to make something pass, because tuning until something passes IS overfitting.
  `breakout_range` was the only positive out-of-sample config (+14.41 USDT, PF 1.19, and it did not
  degrade — OOS was 104% of IS) but it fails on two counts: **without its single best trade it is
  −37.34**, so one trade carried the entire result; and Monte-Carlo P(ruin) is **6.16%** against a
  5% ceiling, with a 5th-percentile equity of 334.32 — below the kill switch.
- **P4 · `funding_skew` can NEVER fire when run alone, by design.** It requires a same-side peer
  from another strategy, so a solo backtest of it is structurally guaranteed to produce zero
  trades. That is the strategy working as specified, not a harness fault. It only has a chance of
  firing in the combined configuration.
- **P4 · `revert_band` produced ZERO out-of-sample trades** over 5,100 bars per instrument,
  confirming P2's finding that its conditions (RSI extreme AND band touch AND `ranging` regime AND
  ADX < 20) are close to mutually exclusive. It is not tradeable as specified.
- **P4 · Funding history only reaches back ~97 days**, while candles reach 180+. OKX does not
  retain more. Settlements outside the covered window are charged a pessimistic fallback rate as a
  COST regardless of direction — never a credit we did not observe — and every report prints the
  count of fallback settlements.
- **P4 · "Costs make the final equity worse" is NOT a sound assertion, and the test was corrected.**
  Slippage moves fill prices, which moves when stops trigger, which produces a different SET of
  trades — a zero-cost and a full-cost run are not the same experiment. What is guaranteed, and
  what is now tested, is per-trade: fees and funding are always subtracted from gross, never added.
- **P4 · Entries fill at the NEXT bar's open, not the signal bar's close.** A decision made from
  bar N's close cannot be executed at bar N's close. This is stricter than most backtests and costs
  the results real money — deliberately.
- **P4 · A `permissive_test` strategy ships in `@plumb/backtest`.** The four candidates fire too
  rarely to demonstrate that the governor is in the loop; the phase's own test requires non-zero
  veto counts, which needs a strategy that signals constantly. It is not a candidate and claims
  nothing.
- **P4 · Eligibility records are signed** (sha256 over the decisive contents). Not a cryptographic
  authority — anyone with the code can recompute it — but it makes a hand-edited `"eligible": true`
  obvious, so a config cannot be promoted to live by editing a JSON file.
- **P3 · The `Signal` type MOVED to `@plumb/core`** (with the id factories and the regime-label
  vocabulary). `risk` must read signals to veto them, but routing that through `@plumb/strategy`
  would have given `@plumb/executor` a transitive path back to strategy internals via
  `executor → risk → strategy`, weakening guardrail 1. Core is where a domain type shared by
  strategy, risk, asp, executor and backtest belongs. `strategy` re-exports it; 231 tests passed
  unchanged across the move.
- **P3 · THE KILL SWITCH BOUNDS NEW RISK, NOT EQUITY.** Verified on 180 days of real history:
  starting at 340 USDT the hostile simulation reached **331.17**, below the 335 floor, because a
  position was already open and its stop filled with slippage. A switch cannot un-take a trade that
  is already on. What it does guarantee — and what the tests assert — is that it fires, flattens,
  and approves nothing afterwards. From the locked 400 the ladder keeps this far away: the baseline
  hostile run bottomed at **370.74**, never within 35 USDT of the floor. The undershoot is bounded
  by roughly one per-trade risk plus slippage, and that bound is now a test.
- **P3 · `MAX_TOTAL_NOTIONAL` (800) binds before the 3× leverage ceiling ever does** on 400 USDT of
  equity, since 400 × 3 = 1,200. The leverage clamp is therefore a second line of defence rather
  than the operative limit, and `correlated_exposure` (600) binds before both. Found because the
  first hostile simulation got ZERO approvals — every attempt was vetoed on notional. The sim now
  ladders its stop outward until something is approved, which is what a real adversary would do.
- **P3 · `params.ts` deliberately duplicates the core tripwire.** If somebody edits `locked.ts` and
  updates its test in the same commit, `assertLockedParameters()` still fails. Redundancy is the
  point in the one package where being wrong costs money.
- **P3 · `simulate.ts` ships in `dist`.** The hostile simulation is a pure function used by both
  the committed test (300-bar fixtures) and `npm run hostile` (full history), and P4's backtest
  will want the same harness.
- **P3 · `rearm` reads no environment.** The expected `PLUMB_ADMIN_TOKEN` is passed IN, so the
  package has no ambient authority and the token comparison is testable. Comparison is
  length-independent so a token cannot be probed a character at a time.
- **P2 · THE STALE-SNAPSHOT TEST BUG (found by the engine, not by the strategies).** The synthetic
  test helper pinned `now` to a fixed instant while slicing windows that ended earlier, so every
  synthetic snapshot was older than its own freshness budget. Module-level probes bypassed the gate
  and showed strategies firing; the full engine emitted nothing, because the watchdog was correctly
  rejecting stale data. Both were right — they were being asked different questions. The clock is
  now derived from the window (`snapshot.ts`) everywhere. **Rule: a probe that bypasses the gate is
  not evidence about the system, only about the component.**
- **P2 · `revert_band` emitted geometrically impossible stops.** When price collapsed far through
  the lower band, `lower − k·ATR` landed ABOVE the close — a "stop" on the profitable side. The gate
  caught all six occurrences across 180 days of real history, but a strategy should not rely on a
  downstream check to tidy up after it. Guarded at the source; `stop_wrong_side` rejections went
  6 → 0.
- **P2 · `percentileRank` now uses the MID-RANK convention.** The naive at-or-below form scores a
  perfectly flat series at 1.0 — "the highest it has ever been" — which would read a dead-quiet
  market as violently expanding. Ties now score 0.5.
- **P2 · Signal ids use the nanoid ALPHABET but an injected entropy source**, not the `nanoid`
  package. The phase specified `nanoid(10)`; importing it would put an ambient RNG inside a package
  whose defining property is that the same snapshot yields a byte-identical `Signal[]`.
  `createSeededIdFactory` (tests, backtests) and `createEntropyIdFactory` (production, fed from
  `@plumb/ops`) produce the same shape.
- **P2 · `engine.ts` was added** beyond the listed files. The phase specified the parts but not the
  thing that composes them, and the required "replay history through the engine" test needs one.
- **P2 · `snapshotFromCandles` was added to `@plumb/market`**, not `@plumb/strategy`. It builds a
  snapshot from candles alone for replay. Two approximations are documented in the code: `mark` is
  set equal to `last` (no historical mark series exists on the public API), and all timestamps are
  set to `now` so replayed bars are never `degraded` — historical data is old, not stale.
- **P2 · The 180-day replay lives in a SCRIPT; the committed test replays the fixtures.** The full
  history is in gitignored `data/plumb.db`, so a test depending on it would be green on this box and
  red everywhere else.
- **P2 · `funding_skew` is UNEVALUABLE in replay, not dead.** The candle store holds no funding-rate
  history, so the strategy cannot rank funding against its own past. It is proven to fire by unit
  test when history and a confirming peer exist. **Storing funding-rate history is a P4
  prerequisite** and is recorded in FEATURES.md as not-yet-built.
- **P1 · THE CANDLE-ORDER BUG (found by the live run, not by the tests).** `client.candles()`
  originally returned OKX's own newest-first order, while every indicator assumes chronological
  order. The unit tests missed it because `fixtureCandles()` sorts and `buildSnapshot()` sorts
  defensively — so the two paths the tests exercised were both correct, and only a script using
  the raw client fed indicators a **reversed price series**. It did not throw; it produced
  plausible, confidently wrong numbers. Fixed at the boundary: the client now normalises to
  oldest-first once, and a test pins it (and asserts the raw envelope really is the other way
  round, so the test cannot go vacuous). **Rule: normalise ordering where data enters the system,
  never at each call site.**
- **P1 · Trade Kit indicator divergence — measured, explained, and accepted.**
  `scripts/indicator-divergence.mjs` compares our locals against `okx market indicator` (no auth
  needed) over 19 settled 1H bars of BTC-USDT-SWAP:
  - **Exact match** (≤0.0001%, i.e. their display rounding): `MA(14)`, `BB upper/middle/lower`.
    **EMA(14)** matches to 0.006%.
  - **Divergent**: `RSI(14)` 13%, `ATR(14)` 8%, `ADX(14)` 14%, `±DI` 6–10%, `MACD dif/dea` large.
  - **Cause: warm-up length, not formula.** Recomputing ours over shrinking windows shows our
    values converge and stay flat from ~150 bars (RSI 69.691, ATR 104.308, ADX 18.439), while
    OKX's sit near our **40–80 bar** values (their ADX 20.69 vs our 60-bar 20.732; their RSI 70.20
    vs our 60-bar 70.497). Exactly the indicators with long recursive memory (Wilder RSI/ATR/ADX,
    the EMA-26 inside MACD) diverge; windowed ones (SMA, Bollinger) match exactly, and EMA(14)
    matches because it converges inside their window. This is inferred from behaviour, not from
    their source.
  - **We keep ours.** Our value at a bar is a function of all history up to that bar, so it is
    identical live and in backtest — which is the entire reason for computing locally. A value
    that depends on how many bars a server happened to load is not replayable.
  - **Noted for P3:** ATR sets position size, so a ~2.8% ATR difference is a ~2.8% size
    difference. Immaterial against a 4 USDT per-trade risk budget, but recorded rather than
    discovered later.
- **P1 · Two freshness budgets beyond the three specified.** The phase named candles (2× the
  timeframe), funding (1h) and mark (30s). `last` (30s, same reasoning as mark — it is a price)
  and `openInterest` (1h) are also aged, because a snapshot field with no budget is a field that
  can silently freeze.
- **P1 · Fixtures live at the PACKAGE root, not under `src/`.** `packages/market/fixtures/` is
  reachable by the same relative path from both `src/` (vitest) and `dist/` (runtime); `tsc` does
  not copy `.json` into `outDir`, so a `src/fixtures/` would exist in tests and vanish in prod.
- **P1 · The Trade Kit CLI is installed OUTSIDE the repo**, at `/root/.plumb/atk` (a global
  `npm i -g` is blocked in this environment). `scripts/indicator-divergence.mjs` finds it via
  `PLUMB_ATK_BIN` and degrades to "UNAVAILABLE" rather than failing when it is absent.
- **P0 · `AVERAGING_DOWN` is deliberately absent from `LOCKED`.** The constitution says it is not a
  parameter, so encoding it as `averagingDown: false` would be the first step toward a config value
  that enables it. Instead the tripwire asserts no key in `LOCKED` matches an averaging-down-shaped
  name.
