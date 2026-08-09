# Plumb

**Every signal, measured before it's sent.**

A disciplined, risk-first perpetual-futures signal service — a Trading Agent Service Provider for
the OKX.AI Hackathon Season 1 (Trading), by Xyndicate.

Plumb publishes every signal with its rationale **before any order exists**, then executes only what
it published. Strategy proposes, a deterministic risk governor disposes, and the executor obeys the
published ledger — so every fill is joinable to the signal that caused it.

> **Status: Phase 0.** Scaffold and constitution only. No strategy edge is claimed, no backtest has
> been run, and no live keys exist. See [PLUMB.md](./PLUMB.md) for the full vision and
> [FEATURES.md](./FEATURES.md) for what actually works today.

## Layout

```
packages/
  core       locked parameters, domain types, time + money primitives
  market     market data ingest (OKX public endpoints)
  strategy   signal generation — cannot place orders
  risk       deterministic risk governor — may veto any signal
  backtest   historical replay + honest metrics
  executor   OKX Agent Trade Kit execution, brackets, reconciliation
  asp        subscription feed + published signal ledger
  ops        alerts, daily review, health
```

## Getting started

```bash
npm install
npm run build       # tsc -b, topological across workspaces
npm run typecheck   # full re-check, includes test files
npm test            # vitest, PLUMB_MODE=fake, zero network, zero spend
```

`PLUMB_MODE=fake` is the default everywhere. Copy `.env.example` to `.env` for local overrides;
`.env` is gitignored and must never contain a real key before Phase 9.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | `tsc -b` across all workspaces in dependency order |
| `npm run typecheck` | `tsc -b --force` — full re-check including `*.test.ts` |
| `npm test` | Vitest across all workspaces |
| `npm run backtest` | Historical replay (Phase 6) |
| `npm run paper` | Paper-trading loop (Phase 8) |

## Documents

| File | What it is |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | The build constitution — locked parameters, guardrails, gotchas. Read first. |
| [PLUMB.md](./PLUMB.md) | Vision: signal primacy, why risk-first, the subscription business |
| [FEATURES.md](./FEATURES.md) | Capability × package × surface × test |
| [RUNBOOK.md](./RUNBOOK.md) | Operations (stub until Phase 10) |
| [SECURITY.md](./SECURITY.md) | Key handling and blast radius |
| [CHANGELOG.md](./CHANGELOG.md) | Keep a Changelog |

## License

MIT — see [LICENSE](./LICENSE).
