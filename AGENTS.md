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

## COMPETITION STATUS — Season 1 REGISTERED (2026-08-10)

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

Plumb was created as a new Trading ASP, approved, and irreversibly registered for Season 1 with the
dedicated CeFi competition UID on 2026-08-10. The registration response returned
`registered: true`. The UID is intentionally not stored in this repository. Competition trading
must remain disabled until the dedicated Trade Kit profile, funding, canonical DecisionEvent and
competition-only execution gates pass.

**Nothing else in this constitution changes.** The LOCKED PARAMETERS stay exactly as they are —
they are sound risk discipline for a real signal service, not competition-specific tuning — and
every guardrail still holds. The competition rules above remain in force as design constraints
because they are what a future entry will be judged against, and because "one subscription service,
created once, never deleted" is already asserted in `@plumb/asp`.

**ASP identity (decided):** Plumb registers as a NEW ASP agent under the existing
**archonaudit@gmail.com** profile, alongside Assay #8599 — not by reusing #8599, whose
earliest-created service is a résumé scan and would become the scoring basis. That profile is also
already the active `onchainos` session.

## DATA PARTITION — fixed 2026-08-10, never re-drawn

Recorded here because a holdout that can be re-drawn is not a holdout.

| | |
| --- | --- |
| Full history | **2023-08-09 → 2026-08-10** (1,097–1,100 days per instrument) |
| Per instrument | 15m 105,300 bars · 1H 26,400 · 4H 6,600 — BTC, ETH and SOL identical, zero gaps, zero duplicates |
| **DEVELOPMENT** | 2023-08-09 → **2026-05-12** (everything except the last 90 days). Iterate here. |
| **HOLDOUT** | **2026-05-12 → 2026-08-10** (the most recent 90 days). WRITE-PROTECTED. |
| Real funding | 293 settlements per instrument, **2026-05-04 → 2026-08-10 (97 days only)** |
| Modelled funding | **~91% of the 3-year window** — charged as a cost in both directions, disclosed per run |

`assertDevelopmentOnly` throws if a backtest window reaches past the development boundary, and
reading the holdout needs an operator token plus an audit record. **The holdout is touched ONCE, at
the very end, on the single best development config.** If it fails there, it fails. There is no
second look and no "one more variant".

Note the awkward consequence of OKX's 97-day funding retention: the real-funding window sits almost
entirely INSIDE the holdout. Development-set funding is therefore ~100% modelled, and any config
whose edge depends on funding is being evaluated against a conservative constant rather than the
real series. That is a limitation of the data, stated rather than worked around.

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
11. **OKX egress may resolve IPv6 while an API whitelist holds IPv4.** Presents as a 401 auth
    failure; is actually routing. Force `--dns-result-order=ipv4first` AND whitelist both addresses.
12. **Trade Kit CLI: `--slOrdPx=-1` requires the `=` form** — the space form parses `-1` as a flag.
    `-1` means market-on-trigger, so without this no bracketed order can be placed at all.
13. **Account level must be 2+ to trade swaps.** `acctLv 1` (Spot) returns `sCode 51010` on every
    swap placement regardless of `posSide`. Verify on BOTH demo and live sub-accounts before funding.
14. **An ATTACHED stop is NOT in the order's top-level `slTriggerPx`** — that field stays empty. It
    lives in `attachAlgoOrds[0]` with its own `attachAlgoId`. Reading only the top level reports
    "no stop attached" for a perfectly protected order, making guardrail 3 unverifiable at the venue.
15. **A venue-initiated `swap close` produces a fill with an EMPTY `clOrdId`** — unattributable by
    construction, so reconciliation flags it. The normal close path must therefore be a REDUCE-ONLY
    order carrying `toCloseClOrdId`, not `swap close`; the blunt `swap close` is for the emergency
    naked-position path only, and reconciliation must be scoped with `sinceTs`.
16. **The Trade Kit CLI prefers `OKX_API_KEY`/`_SECRET`/`_PASSPHRASE` from the environment over its
    own `config.toml` profile.** Systemd's `EnvironmentFile=` pointed at the whole secrets file, so
    the LIVE triplet reached the process that places orders and every demo call came back
    `401 Invalid Sign` — a guardrail-10 breach disguised as an auth error. Two defences, both
    required: the unit reads an ALLOWLISTED `runner.env`, and `sanitizeEnv` strips the triplet from
    every spawned child regardless of how the parent was started.
17. **Boot-time venue calls must not precede the supervision loop.** `resolvePosSide` and
    `recoverPendingIntents` ran at module top level, so under a venue outage the process blocked
    before the interval was armed: `systemctl is-active` said `active` while no watchdog ran, no
    status was written and no alert fired — silent for ten minutes, then a start-limit death.
    Bootstrap is now retried inside the cycle and the timer is armed before the first tick.
18. **The daily roll must only move forward.** Keying purely off "the UTC day key changed" meant a
    backward clock step across midnight (NTP correction, VM snapshot restore) zeroed
    `realisedPnlToday` and cleared the `dailyLimit` halt — re-arming trading on a day whose loss
    budget was already spent.
19. **On a `net_mode` account, an opposing order CLOSES; it does not open.** The governor's
    averaging-down rule only matched the *same* direction, so a short on an open long was
    approved — and reduced the long instead of opening a second position. Ledger 2 positions,
    venue 1 net figure, reconciliation halted the paper run 29 minutes in. One position per
    instrument, either direction (veto `instrument_occupied`). A new-position order must never be
    allowed to act as a close.
20. **A test can assert the bug.** `governor.test.ts` 6c said "the OPPOSITE direction on the same
    instrument is not averaging down" and asserted `approved === true` — a green test sitting
    directly on top of gotcha 19 for as long as it existed. When a live fault contradicts a
    passing test, suspect the test first. 564 green tests proved only that the code did what the
    tests said, not what was safe.
21. **Reconciler bookkeeping cannot be keyed on `instId` alone.** Deleting the venue entry on
    first match made every second recorded position on that instrument a phantom `missing_fill`,
    turning one fault into two and pointing the diagnosis the wrong way. And comparing
    `Math.abs(venue.pos)` ignored direction, so a fully reversed position of the right size
    reconciled clean.
22. **The journal is empty by design; the logs are in `/var/log/plumb/`.** Units use
    `StandardOutput=append:`, so `journalctl -u plumb-runner` shows two start lines and nothing
    else. An empty journal is not a dead bot. Compounding it: **systemd prints local CEST, the
    application logs UTC** — a two-hour offset that made a pre-existing halt look reboot-caused.

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

- **P7 · The runner does NOT read `secrets.env`; it reads an allowlisted `runner.env`.** The phase
  assumed one environment file. Two are required, because the Trade Kit CLI prefers the live
  `OKX_API_*` triplet from the environment over its own demo profile — so a single wide
  `EnvironmentFile` put live credentials into the order-placing process. The allowlist denies new
  secrets by default rather than blocking known-bad ones.
- **P7 · The reboot drill is partially deferred to the operator.** Boot configuration is verified
  (`systemd-analyze verify` clean, both units enabled, ordering correct, cold start passes) but no
  kernel reboot was performed: the agent runs on this host, and the host carries three live listed
  ASPs. Called out explicitly in `reports/drills.md` rather than quietly marked done.
- **P7 · The stale-data drill shares the venue-outage drill.** On this host the market feed and the
  trading venue are the same origin, so the isolated case — data frozen while the venue is
  reachable — cannot be produced live. Covered by unit tests over `assess()` and recorded as such.
- **P7 · The network outage was scoped per-unit, not host-wide.** `IPAddressDeny=any` on
  `plumb-runner.service` alone. A host-wide block would have cut egress for ASSAY, Occestra and
  Sigil, all listed and taking real sales.
- **OKX.AI delivery · runtime help overrides the pasted reference script.** The installed current
  identity CLI requires `heartbeat --chain-index 196`, not the older reference script's agent-id
  form. The isolated delivery daemon uses the installed interface and cross-checks the official
  active fan-out with provider status before sending anything.
- **Competition amendment · the operator authorised narrower first-trade risk in writing on
  2026-08-18.** This does not revive or replace the failed protected-holdout candidate. Any future
  eligible event is additionally limited to ETH, one entry, 0.25 USDT stop risk, 0.35 USDT total
  planned loss, 40 USDT notional and 10% position, inside 2026-08-19T20:15Z–2026-08-23T00:00Z.
- **A2A documentation drift · Trading Signal v1.2 replaced V1.1 by 2026-08-18.** Executable
  perpetual messages now use `【Futures】`, a Market/Reference Price pair, one specific price, fixed
  field order and at most 200 characters. Decision correlation stays in the immutable publication
  record and Agent Trade Kit `clOrdId`; adding an undocumented text field would break the grammar.
- **Emergency participation · the operator explicitly authorised the amendment on 2026-08-20.**
  Exactly one ETH minimum-venue-lot entry may bypass only the independent-holdout and calibrated-
  edge requirements, with `expectedEdgeBps: 0` recorded honestly. Closed-4H trend/ADX, matching
  24H price and OI participation, moderate 1H RSI, the governor, exact A2A publication, ATK-only
  execution, attached exits, signed reconciliation and decision-specific live confirmation remain
  mandatory. Maximum stop risk is 0.05 USDT and maximum planned loss is 0.08 USDT.
- **Emergency OI boundary · hourly OI must be sampled at or before the rolling boundary.** The
  first implementation selected the first observation after `now − 24H`, silently shortened the
  window and reversed the sign during the 2026-08-20 qualifying interval. A shared tested helper
  now fails closed without a boundary-reaching sample, and both monitors and preparation use it.
- **Unattended second entry · the operator explicitly authorised one-shot automation on
  2026-08-21, expanding the universe to ETH on 2026-08-22.** Only a frozen
  `competition_trend_pullback@3.0.0` BTC/ETH/SOL DecisionEvent may use
  it, within the separately recorded second-entry time/damage envelope. The state claim is durable
  before A2A publication; publication must fully acknowledge before Agent Trade Kit execution; any
  crash or uncertainty blocks every automatic retry and raises Discord. All other live writes keep
  decision-specific confirmation. The unit reads a UID-only allowlist, never `secrets.env`.
- **Native TP/SL exits need explicit ledger reconciliation.** OKX closes an attached OCO with a
  new venue order/client-order ID, so an entry-only ledger can remain non-zero while the account is
  flat. Accept flat only after Agent Trade Kit proves the exact entry, TP/SL algo, opposite fill,
  direction/size and closed-position record; otherwise fail closed. This first occurred when
  `DEC-ydBHBkzgyA` hit TP on 2026-08-21.
- **The second-entry hard exit is an authorised risk reduction, not a new signal.** At or after
  2026-08-25T03:30Z, only the exact fully-published BTC/ETH/SOL DecisionEvent may be closed. The close
  uses a separately persisted deterministic intent and an Agent Trade Kit reduce-only market order;
  it must verify order, fill, signed-flat venue and ledger. A pending/uncertain intent is queried,
  never resubmitted blindly.

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
- **P5B · THREE REAL VENUE FINDINGS the mock could not have produced.**
  1. **IPv6 egress vs an IPv4 whitelist.** This VPS resolves OKX over IPv6; the demo key's IP
     whitelist holds the IPv4 address, so every authenticated call returned
     `401 … your IP 2a02:c207:… is not included in your API key's IP whitelist` — which reads as an
     auth failure and is a routing one. Fixed by forcing `NODE_OPTIONS=--dns-result-order=ipv4first`
     on every CLI spawn.
  2. **A negative option value is parsed as another flag.** `--slOrdPx -1` fails with
     "argument is ambiguous"; the `=` form (`--slOrdPx=-1`) is required. -1 is how you say
     "market order when the stop triggers", so without this NO bracketed order can be placed.
  3. **🔴 The demo account is `acctLv: 1` (SPOT MODE) — perpetual swaps cannot be traded at all.**
     Every `swap place` returns `sCode 51010 "You can't complete this request under your current
     account mode"`, with `posSide: long` AND with `posSide: net`, and `account max-avail-size`
     fails the same way. The Trade Kit CLI has no command to change it (only `set-position-mode`).
     **OPERATOR ACTION: switch the DEMO account to Single-currency margin or higher in the OKX UI.**
     Read paths (balance, positions, fills, config, order lookup) all work today.
- **P5B · The client is now account-mode aware.** `getAccountConfig()` reports `acctLv`/`posMode`
  and whether swaps are tradeable at all; `resolvePosSide()` returns `net` for a `net_mode` account,
  because sending long/short to one is a different rejection with the same error code.
- **P5B · The demo eligibility override is the only bypass in the system**, and is built so it
  cannot apply in live mode: it requires `PLUMB_MODE=demo` (passed IN, never read from ambient env)
  AND a venue reporting `demo === true`, with no force flag and no default. Six tests pin that,
  including that a live-mode caller gets the unmodified `assertEligible`.
- **P5 · THE ATK `--demo` SESSION IS BLOCKED ON A DEMO API KEY — not run.** Demo mode requires a
  SEPARATE demo key (okx.com/account/my-api?go-demo-trading=1); the key we hold is a LIVE
  sub-account key and guardrail 10 forbids touching it before P9. `npm run demo-session` therefore
  runs the full loop against **real live market data with a SIMULATED venue**: every snapshot,
  every strategy decision, every governor verdict and every reconciliation is real; only the order
  fills are mocked. This is stated in the script header and in the checkpoint rather than papered
  over. **Operator action: create a demo API key** and the same script runs unchanged.
- **P5 · `clOrdId` must be stripped of non-alphanumerics.** OKX accepts letters and digits only,
  1–32 chars, but our signal ids are `SIG-abc_DEF` — a hyphen and possibly an underscore from the
  nanoid alphabet. Sending one verbatim is rejected with an opaque message. `toClOrdId` sanitises,
  and because that is lossy the reverse direction is a LOOKUP over known signal ids, never a
  computation. An unresolvable clOrdId is precisely the reconciliation alarm.
- **P5 · The eligibility lock lives in `@plumb/core`.** `executor` must verify a backtest
  eligibility record, and importing `@plumb/backtest` to reach the type would give the executor a
  transitive path to strategy internals. `signEligibility`/`verifyEligibility` moved to core;
  backtest delegates to them, so producer and consumer cannot drift apart. **All five P4
  configurations fail this lock, so nothing can currently be run live — which is correct.**
- **P5 · A tight-stopped permissive strategy never reaches placement**, for the same reason the P3
  hostile sim found: `MAX_TOTAL_NOTIONAL` (800) binds before the 3× leverage ceiling on 400 equity.
  At 1.5×ATR on 1H the demanded notional is ~1,700 and every bar is vetoed. The demo session widens
  the stop to 6×ATR to produce order flow. This is the governor working, not a defect.
- **P5 · Intent is persisted BEFORE the order is placed**, with `synchronous = FULL`. Placing first
  and recording after loses a real position on a crash, which is the failure that cannot be
  repaired; recording first can only ever leave an orphan intent, which boot-time recovery resolves
  against the venue.
- **P4B/E · THE POOLED OOS CURVE IS A CONCATENATION, NOT AN ACCOUNT.** `runWalkForward` stitches
  ~47 independent 20-day OOS windows, each of which `runBacktest` starts fresh at 400 USDT with its
  own kill switch. The combined curve then sums the deltas, so cumulative equity can run far below
  335 — hence pooled max drawdowns of 35–250% and P(ruin) of 72–100%. **A continuously-traded
  account would have hit the kill switch and stopped.** The meaningful floor check is the
  PER-WINDOW `minEquity`, which is what the gate's `drawdown floor` criterion actually uses. Pooled
  drawdown and pooled P(ruin) overstate what a real account would experience and should be read as
  a severity ranking, not as a forecast.
- **P4B/D · `oi_divergence` is STRUCTURALLY UNEVALUABLE: no historical open-interest series exists.**
  P1 fetched OI live but never persisted it, and OKX's rubik OI-history endpoint is capped at ~1,440
  recent points — nowhere near three years. The measurement table therefore used VOLUME as an
  order-flow proxy, which answers a different question (how much traded, not whether positions were
  opened or closed). The strategy fired 0 times because `snapshot.openInterest.history` is empty in
  replay. **Storing an OI series is a prerequisite before this candidate means anything.**
- **P4B/D · `funding_skew` fires 0 times on the DEVELOPMENT set** even after the standalone fix,
  because the only real funding history OKX retains (from 2026-05-04) lies almost entirely inside
  the holdout, which ends the development set 8 days later. It fires 305 times over the full
  3 years precisely because that window is mostly holdout. **A funding strategy cannot be developed
  against this data.**
- **P4B/D · `session_bias` confirmed the arithmetic it was built to test.** The hour-of-day table
  found exactly one hour surviving regime segmentation on all three instruments — 08:00 UTC, a
  funding-settlement hour, +3.16/+3.33/+4.65bp. That is a REAL measured effect and it is smaller
  than the 10bp round-trip taker fee. Backtested: 1,495 trades, profit factor 0.754, −1,232.89 USDT.
  **A real edge below transaction costs is not an edge.** Retired.
- **P4B/D · `dispersion` was NOT BUILT.** The spread architecture (pairId, MAX_CONCURRENT counting a
  spread as one, the correlation veto special-cased for a hedge leg without becoming a hole in the
  governor, two-leg atomicity, a stop on the spread, the risk budget split across the pair) is a
  change spanning strategy, risk and executor with a test owed for each invariant. Shipping a
  version that can half-open would be strictly worse than not shipping it.
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
- **Competition one-shot · distinguish a candidate rejection from post-write uncertainty.** The
  systemd unit evaluates BTC and then SOL with sequential `ExecStart=` commands. A public-check or
  private-preflight rejection before the durable one-shot claim and before every external write must
  log/alert and exit successfully so the other authorised instrument is still evaluated. Once the
  claim exists, every failure remains terminal `uncertain` and nonzero: never continue to the other
  instrument and never retry automatically after a possibly completed publication or order.
- **Competition payoff amendment · size for the prize-zone objective without relaxing evidence.**
  On 2026-08-22 the operator raised only the one-shot second-entry caps to 3.00 USDT stop risk,
  3.25 USDT planned loss, 150 USDT notional, 37% position and a 4.00 USDT minimum projected net
  target. At 409.97 USDT equity the stop cap is about 0.73%, inside the original 0.75% mandate.
  The frozen trigger, one-entry count, 3x ceiling, A2A-first ordering and all failure gates remain.
- **Final payoff ceiling · “6 USDT” means gross, not a 6 USDT stop.** On 2026-08-22 the operator
  authorised the maximum normal-risk form: 4.00 USDT stop risk, 4.35 USDT planned loss, 200 USDT
  notional, 50% position and 5.50 USDT minimum projected net. A literal 6 USDT net at the frozen
  1.5R first target would require more than 1% account risk after costs, so it remains forbidden.
- **Competition research · the replay engine originally omitted take-profit exits.** Stops,
  timeouts and flattening were modeled, but the first attached venue target was not. The corrected
  engine now closes at TP with exit friction and pessimistically assigns the stop when one candle
  touches both. A like-for-like v3 re-audit fell from +141.42/PF 1.90 to +15.22/PF 1.12 and failed
  its frozen robustness conditions (negative second half and negative without its best three).
  The isolated competition auto-entry timer was therefore paused fail-closed; P8 stayed active.
- **Competition research · frequency was not a free improvement.** Three predeclared attempts to
  make the trigger easier all failed on development data after realistic costs: 15m continuation
  -166.54/PF 0.924; broad 1H continuation -350.76/PF 0.824; final 4H-trend/1H-reclaim candidate
  -212.12/PF 0.731. None read the protected holdout or competition period, none was armed, and no
  further candidate may be derived from those failures during this competition.
- **TP-aware v3 prize option · operator explicitly accepted the corrected evidence failure on
  2026-08-23 at 06:05 UTC.** The written authorization `AUTHORIZE TP-AWARE V3 PRIZE-OPTION` permits
  re-arming only the existing one-shot BTC/ETH/SOL v3 workflow through its unchanged
  2026-08-23T16:00:00Z personal cutoff. It does not make v3 evidence-approved, relax any trigger,
  permit a fallback strategy, or expand the previously authorised $4.00 stop-risk / $4.35 planned-
  loss / $200 notional / 50% position / $5.50 minimum projected-net envelope.
- **Deadline contingency v1 · authorised, implemented, then paused on new adverse evidence on
  2026-08-23.** The operator authorised a separate ETH/SOL post-v3-cutoff contest-risk path with
  the same one-additional-entry and damage envelope. Its exact frozen development-only audit then
  produced 722 OOS trades, -244.77 USDT, PF 0.846, 42.94% wins and 19/47 profitable windows; both
  instruments lost. Because that material result was unknown at authorization time, the deploy
  unit remains uninstalled and the contingency cannot trade without a fresh written decision that
  explicitly accepts the measured negative expectancy. V3 remains active through 16:00 UTC.
- **Deadline contingency v1 · negative expectancy explicitly accepted and timer armed on
  2026-08-23 at 07:49 UTC.** The operator supplied
  `ACCEPT MEASURED NEGATIVE EXPECTANCY — ARM DEADLINE CONTINGENCY V1` after receiving the frozen
  audit. This is a contest-utility exception, not evidence approval. The reviewed systemd timer is
  enabled, the pre-cutoff smoke returned `waiting_for_v3_cutoff` for ETH and SOL, the v3 timer is
  still active/enabled, and the shared one-shot state remained absent. The contingency cannot
  evaluate before 16:00 UTC and retains the frozen one-entry, A2A-first, Agent Trade Kit-only and
  $4.35 maximum-planned-loss bounds.
