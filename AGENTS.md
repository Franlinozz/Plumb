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
- **P0 · `AVERAGING_DOWN` is deliberately absent from `LOCKED`.** The constitution says it is not a
  parameter, so encoding it as `averagingDown: false` would be the first step toward a config value
  that enables it. Instead the tripwire asserts no key in `LOCKED` matches an averaging-down-shaped
  name.
