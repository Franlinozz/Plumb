# Plumb

**Every signal, measured before it's sent.**

Plumb is a risk-first autonomous perpetual-futures research and execution system. It observes
BTC-USDT-SWAP, ETH-USDT-SWAP and SOL-USDT-SWAP, produces deterministic strategy signals, subjects
them to a persisted risk governor, publishes approved signals before execution, and reconciles
every venue fill back to the signal that caused it.

## Current status

The OKX.AI Season 1 competition is complete. Its implementation and audit history have been merged
into `main`; the former `competition/okxai` branch is historical.

The execution machinery is built and tested, but **autonomous live trading is not armed**. The
competition candidates did not pass their protected evidence gates after realistic fees, slippage
and funding. Plumb is now in forward-research mode: collect untouched public observations, evaluate
a small number of frozen hypotheses, shadow-trade qualifying signals, and promote a strategy only
after it passes a predeclared forward gate. This is an evidence boundary, not a missing switch.

See [POST_COMPETITION.md](./POST_COMPETITION.md) for the active roadmap and
[`reports/competition-autonomy-audit.md`](./reports/competition-autonomy-audit.md) for the final
competition state.

## Architecture

```text
OKX public market data
        ↓
deterministic strategy proposals (no order capability)
        ↓
signal, portfolio and transaction-cost gates
        ↓
persisted deterministic risk governor
        ↓
hash-chained public signal ledger
        ↓
OKX Agent Trade Kit executor (eligible live configurations only)
        ↓
fill/position reconciliation → halt on uncertainty
        ↓
watchdog, Discord/webhook alerts and public track record
```

| Package | Responsibility |
| --- | --- |
| `@plumb/core` | Locked limits, domain types and time primitives |
| `@plumb/market` | Public OKX data, indicators and durable observations |
| `@plumb/strategy` | Pure signal generation; cannot reach an order path |
| `@plumb/risk` | Sizing, vetoes, drawdown controls and persisted halt state |
| `@plumb/backtest` | Cost-aware replay, walk-forward analysis and evidence gates |
| `@plumb/asp` | Published feed, subscription delivery and track record |
| `@plumb/executor` | Bracketed placement, idempotency and reconciliation |
| `@plumb/ops` | Watchdog, alerts, reviews, backups and health |

## Safety invariants

- Strategy proposes; only the executor can place an order.
- Publish before execute: an unpublished signal cannot become a fill.
- Every position opens with an attached stop.
- Models may produce labels and prose, never order prices, size, leverage, stops or targets.
- Ambiguous venue writes are reconciled by deterministic client ID and are never blindly retried.
- An unmatched fill, state drift or uncertain position halts trading.
- Averaging down is prohibited and there is at most one position per instrument.
- Exchange access uses a trade-only sub-account key with withdrawals disabled.

The complete constitution and immutable limits are in [AGENTS.md](./AGENTS.md).

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Tests default to deterministic fixtures and make no paid model or authenticated venue calls.

## Forward observation

Start or continue the untouched post-competition dataset with public endpoints only:

```bash
npm run forward:record
```

The default database is `data/forward-observations.db`. Duplicate samples are idempotent and a
currently forming candle may only advance to its final closed form. For continuous collection, use
`deploy/plumb-forward-recorder.service` with `deploy/plumb-forward-recorder.timer` after reviewing
their paths. No API key, account access or order capability is present in this recorder.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run snapshot` | Inspect current public market snapshots |
| `npm run forward:record` | Append one bounded round of forward observations |
| `npm run backfill -- --days 180 --tf 15m,1H` | Backfill research candles |
| `npm run backtest` | Run the cost-aware historical evaluation |
| `npm run replay -- --tf 1H` | Replay signals over stored history |
| `npm run hostile` | Attack the risk governor with an adversarial strategy |
| `npm run demo-session` | Exercise the end-to-end fake execution path |

## Documentation

- [POST_COMPETITION.md](./POST_COMPETITION.md) — active roadmap and promotion gates
- [PLUMB.md](./PLUMB.md) — product thesis and public track-record model
- [FEATURES.md](./FEATURES.md) — shipped capabilities and their proving tests
- [RUNBOOK.md](./RUNBOOK.md) — operational and incident procedures
- [SECURITY.md](./SECURITY.md) — trust boundaries and key handling
- `reports/` — immutable competition research and incident evidence

## License

MIT — see [LICENSE](./LICENSE).
