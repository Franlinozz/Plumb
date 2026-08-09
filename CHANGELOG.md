# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Franlinozz/Plumb/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Franlinozz/Plumb/releases/tag/v0.1.0
