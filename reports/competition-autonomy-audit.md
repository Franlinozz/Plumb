# Competition autonomy audit — 2026-08-24

## Outcome

**Autonomous live entry: RED / disabled.** The competition entry timer is disabled and inactive.
It must not be re-enabled while an executable `onchainos agent deliver` can exit zero without an
explicit `{ ok: true, delivered: true }` acknowledgement.

**Manual decision-specific entry: YELLOW.** Manual approval is preferable, but it does not bypass
publication. A live order may proceed only after the exact immutable DecisionEvent is acknowledged
for every currently active subscription, followed by a fresh venue/risk preflight and the exact
`CONFIRM LIVE <decisionId>` confirmation.

**Current exposure: GREEN.** The dedicated competition account is signed-flat with no pending
orders. The competition ledger records ETH as flat after its attributable native take-profit exit.
There are no pending competition order intents.

## Runtime state checked

- Branch/worktree: `competition/okxai`; P8 deployment is a separate `/opt/plumb` tree.
- Competition UID/profile: exact dedicated UID verified; account level 2; `net_mode`; read + trade
  only; no withdrawal permission observed.
- Trade Kit: competition is isolated on 1.4.4 at
  `/root/.plumb/atk-competition/node_modules/.bin/okx`. P8 remains pinned to its separate 1.4.2
  binary and was not restarted or redeployed.
- BTC/ETH/SOL metadata, fees, last price, leverage, max size and USDT balance parsed successfully
  through the isolated competition adapter.
- ASP #10746: active/listed, online, one A2A service, three active subscriptions, heartbeats
  succeeding on chain index 196.
- `plumb-okxai-a2a.service`, `plumb-asp.service`, and `plumb-runner.service`: active.
- `plumb-okxai-deadline-contingency.timer`: disabled and inactive, including at boot.

## Defects found and corrected in the competition worktree

1. Trade Kit writes inherited the read retry policy. A timed-out order could therefore be submitted
   more than once. All write commands are now single-attempt; ambiguous outcomes reconcile by
   deterministic `clOrdId` and are never resent automatically.
2. A rejected order lookup was previously converted to “order absent.” Only a genuine not-found
   result is now treated as absence.
3. An ambiguous entry write was marked failed. It now remains pending unless the exact venue order
   is recovered by `clOrdId`, blocking later automatic entry.
4. Exit-zero business failures and empty write acknowledgements could be accepted. Writes now
   inspect row/envelope business codes and require a non-empty acknowledgement.
5. Missing/malformed order, position, fill, balance, fee and maximum-size fields could become
   harmless-looking defaults. Critical fields now fail closed.
6. Entry verification checked only for the presence of protection. It now verifies exact order id,
   client id, instrument, side, size, stop and take-profit prices, final filled state, exact fill and
   signed venue position.
7. Partial entries could remain open after reconciliation failure. Any observed partial or
   unverifiable exposure is now reduced to zero and the reduce order/fill is verified.
8. Ambiguous emergency-reduce and reversal-close writes now reconcile by deterministic `clOrdId`
   without resubmission.
9. Startup did not block on unresolved pending entry intents. It now refuses execution until manual
   venue reconciliation resolves them.
10. Final-window automation did not run native-exit reconciliation or its hard time-stop after an
    entry claim existed. Both lifecycle paths now run on subsequent cycles, with uncertain states
    alerted and never retried blindly.
11. The competition adapter shared P8's pinned Trade Kit executable. It now selects a physically
    separate competition installation, preventing a competition upgrade from changing P8.
12. Executable A2A publication previously accepted a silent exit-zero result. It now requires an
    explicit business acknowledgement and records silence as uncertain with zero delivered.

## Remaining blockers and compliance risks

### 1. Executable A2A receipt — RED

The two most recent candidate publications are correctly recorded as `uncertain`, with zero of
three active subscriptions acknowledged. The current Onchain OS 4.4.10 `deliver` command exposes no
JSON flag and can return no output. There is no supported remote receipt command that proves the
exact text reached every active subscriber. An order must not follow this state.

### 2. Signal/service-description alignment — RED for contingency entries

The listed service says signals are generated only after strategy and transaction-cost checks pass.
The final-window contingency explicitly records expected edge as zero and uses an operator evidence
exception. Sending another such signal risks repeating the platform's “activity not aligned with
signals/service” concern. A future competition order should come only from a genuinely approved
cost-gated strategy event, not from the deadline contingency.

### 3. Optional Trade Kit builder attribution — YELLOW

Trade Kit 1.4.4 adds optional `--aiBuilderCode` support. No official Plumb-specific builder code was
found in repository state, registration output, profile configuration, or current hackathon material.
No value is guessed. Orders remain attributable through the required Agent Trade Kit path and exact
client/order ids; add this field only if OKX supplies the assigned code.

### 4. P8 protected-run mismatch — RED but isolated

P8 remains running, healthy at the process/HTTP level, and untouched. Its own fail-closed state is
`manual=true` and `reconcileMismatch=true`. The read-only reconciliation report shows the ledger
records BTC-USDT-SWAP short 0.3 while the demo venue is flat. P8 therefore rejects new signals and
repeatedly requests a watchdog flatten against an already-flat venue. This is not competition
exposure and must be repaired only through a separately authorized P8 reconciliation procedure.

## Verification

- Full suite: **704/704 tests passing** (60/60 files).
- TypeScript typecheck: passing.
- Production build: passing.
- Production dependency audit: zero known vulnerabilities.
- Repository diff check: passing.
- The sandbox-only run could not bind ephemeral localhost ports; the unchanged HTTP tests passed
  when rerun with local socket permission. No threshold or test was weakened.

## Required operating procedure

1. Keep autonomous live-entry timers disabled.
2. Generate one new immutable, genuinely cost-gated DecisionEvent only if the strategy approves it.
3. Preview the exact A2A text and order together.
4. Publish once. Require explicit acknowledgement for every active subscription; an unclear result
   remains uncertain and is never resent automatically.
5. Re-read UID, account mode, positions, open orders, metadata, fees, leverage, balance, signed ledger,
   pending intents and halt state.
6. Ask for `CONFIRM LIVE <decisionId>` only after steps 2–5 pass.
7. Execute once through Agent Trade Kit, then verify business code, exact order, exact attached TP/SL,
   fill, signed position and ledger. Any uncertainty fails closed.
