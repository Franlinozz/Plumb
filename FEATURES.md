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
| Fixture recording | — | `npm run record-fixtures` | manual, once per phase |
| Live snapshot inspection | — | `npm run snapshot` | manual eyeball check |
| Historical backfill | — | `npm run backfill -- --days 180 --tf 15m,1H` | `history.test.ts` |
| Indicator divergence vs OKX Agent Trade Kit | — | `npm run divergence` | manual, findings in AGENTS.md |

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Scaffold + constitution | ✅ shipped |
| 1 | `@plumb/market` — data, indicators, snapshot, watchdog, cache, history | ✅ shipped |
| 2–10 | Not yet written | — |

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

## Not yet built

Recorded so that nothing looks accidentally missing:

- `@plumb/strategy` — signal generation. Placeholder only. **No edge is claimed.**
- `@plumb/risk` — risk governor. Placeholder only; the locked limits exist but nothing enforces them yet.
- `@plumb/backtest` — replay + metrics. Placeholder only. **No backtest has been run.**
- `@plumb/executor` — Agent Trade Kit execution + reconciliation. Placeholder only.
- `@plumb/asp` — subscription feed + published ledger. Placeholder only.
- `@plumb/ops` — alerts, daily review, health. Placeholder only.
