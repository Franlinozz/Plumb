# P8 run 2 lifecycle audit

Audit time: 2026-08-11T09:20Z UTC

## Finding: lifecycle management exists but is not wired into the runner

`packages/executor/src/lifecycle.ts` correctly defines invalidation, `maxHoldBars`, breakeven stop
tightening, and tests. The deployed loop source, `scripts/run-cycle-loop.mjs`, does not import or
call `manage()`. Its persisted open-position record also lacks `openedAtBar` and `maxHoldBars`, so
the existing lifecycle function cannot be invoked from restored state without an explicit state
migration.

Observed effect: P8 run 2 holds one demo position and repeatedly vetoes subsequent candidates with
`instrument_occupied`. The runner and watchdog are alive and all halt flags remain false, but the
run is not exercising repeated entry/exit cycles as originally intended.

## Safety decision

P8 run 2 was not restarted, redeployed, rebaselined, flattened, or mutated. Its state, strategy,
governor, reconciler, systemd units, and protected report remain untouched.

Fixing this correctly requires a new isolated run with:

- persisted lifecycle fields and a backwards-compatible migration;
- reduce-only, signal-attributed close intents through Agent Trade Kit;
- post-close order/fill/signed-position reconciliation;
- state removal only after the venue confirms the close;
- restart tests around close acknowledgement and ledger persistence.

Until then, P8 run 2 is valid evidence for uptime, veto behaviour, recovery and reconciliation, but
not for strategy turnover or max-hold exit behaviour.
