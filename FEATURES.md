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
| Locked competition parameters, frozen and tripwired | `@plumb/core` | internal | `packages/core/src/locked.test.ts` |

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Scaffold + constitution | ✅ shipped |
| 1–10 | Not yet written | — |

## Not yet built

Recorded so that nothing looks accidentally missing:

- `@plumb/market` — market data ingest. Placeholder only.
- `@plumb/strategy` — signal generation. Placeholder only. **No edge is claimed.**
- `@plumb/risk` — risk governor. Placeholder only; the locked limits exist but nothing enforces them yet.
- `@plumb/backtest` — replay + metrics. Placeholder only. **No backtest has been run.**
- `@plumb/executor` — Agent Trade Kit execution + reconciliation. Placeholder only.
- `@plumb/asp` — subscription feed + published ledger. Placeholder only.
- `@plumb/ops` — alerts, daily review, health. Placeholder only.
