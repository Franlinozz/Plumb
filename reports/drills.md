# Failure drills — Phase 7

Executed against the real deployment on `62.171.182.75`, 2026-08-10, demo mode, with the runner
holding a live demo position. Each drill was run to a recorded outcome; **five found real defects**,
plus one security breach, all listed with their fixes rather than smoothed over.

Two constraints shaped how the drills were run. This VPS is **shared with three live, listed ASPs**
(ASSAY #8599, Occestra #5213, Sigil #4943), so no drill was allowed to interrupt their egress or
take the box down — the network outage was scoped to the Plumb runner alone using per-unit
`IPAddressDeny`. And the agent executing the drills runs *on* this host, so a true kernel reboot
would terminate the session mid-phase; drill 6 is therefore partially deferred and flagged
explicitly below.

## Results

| # | Drill | Expected | Outcome |
| --- | --- | --- | --- |
| 1 | `SIGKILL` the runner mid-cycle, position open | restart, position intact, no duplicate order | **PASS** |
| 2 | Venue unreachable (network denied to the runner only) | halt, alert, do **not** flatten | **PASS after fix** — found a boot-hang defect |
| 3 | Market data stale | halt, flatten if positions open, alert | **PASS** (shares drill 2's outage; see note) |
| 4 | Disk full under a live database | refuse the write loudly, no corruption | **PASS** |
| 5 | Clock skew, forward and backward | daily limit resets forward only | **FAIL → fixed** — backward jump re-armed a spent budget |
| 6 | Reboot recovery | both units return automatically | **PARTIAL** — found a defect; true reboot deferred to the operator |
| 7 | Restore from snapshot onto a clean directory | identical state, tamper detected | **PASS** |
| 8 | *(unplanned)* Reconciliation vs. a pre-existing venue history | — | **FAIL → fixed** — an unclearable halt, and a flatten that closed nothing |

---

## 1 — Hard kill with an open position

`kill -9` on the runner mid-cycle, one demo position open, no clean shutdown and therefore no
state save.

```
killing pid 3697510 with SIGKILL
auto-restarted: active   restarts=1     (within 15s, per Restart=always/RestartSec=15)
boot_recovery  recovered=0 abandoned=0 stillPending=0
cycle_complete index=1 signals=0 open=1
```

The position survived, no intent was left pending, and the recovery cycle emitted **no** new signal
for the instrument already held — so the restart did not duplicate an order. **PASS.**

## 2 — Venue unreachable

`IPAddressDeny=any` / `IPAddressAllow=localhost` applied to `plumb-runner.service` only, so the
other ASPs on the box kept their egress.

**This drill found a real defect.** `resolvePosSide` and `recoverPendingIntents` ran at module top
level, before the interval was armed. With the venue unreachable the CLI child blocked on the
network and the process never reached its loop:

```
ps: node run-cycle-loop.mjs → okx account config → okx-pilot --domain www.okx.com   (blocked)
systemctl is-active     → active
status.json age         → 87s and climbing, never updated
watchdog runs           → 0
alerts raised           → 0
```

`systemd` was satisfied, the process was "active", and nothing was watching anything. After ~10
minutes of silence it would have died on the start limit. A VPS rebooting during a venue outage
would have produced exactly this: a runner that looks healthy to every check and is inert.

**Fix** (`scripts/run-cycle-loop.mjs`): bootstrap is attempted inside the cycle and retried every
cycle, failure is loud rather than fatal, and the interval is armed *before* the first tick.
Re-run under the same outage:

```
bootstrap_failed  message="Command failed: .../okx account config --json --demo"
[URGENT] venue unreachable at start-up
cycle_failed      venueFailures=1
status.json age   4s          runner=active
```

The runner now stays observable, alerts, counts venue failures toward the watchdog, and recovers by
itself when the venue returns — verified by lifting the outage.

The watchdog then escalates to `venue_unreachable` at 5 consecutive failures and **halts without
flattening**, which is correct and deliberate: a close order cannot be placed through a venue that
cannot be reached, so flattening would be a lie. Halting stops new risk and hands the open book to
the operator.

Escalation observed live:

```
[CRITICAL] venue unreachable        (at 5 consecutive failures)
halt flags: manual=true
watchdog_flatten during the outage: 0        ← the point of the drill
```

**Measured caveat worth keeping.** Each failed venue attempt costs ~2 minutes (3 attempts × 30s
timeout plus backoff), which is longer than the 120s cycle interval, so consecutive failures do not
arrive one per cycle. Escalation to `venue_unreachable` took ~15 minutes at the production interval
rather than the ~10 the threshold implies. The threshold is a count, not a duration, and the two are
not interchangeable — worth remembering before reading `maxVenueFailures: 5` as "five minutes".

**Recovery.** Lifting the outage restored normal cycles, and the halt flags set during it survived:
every subsequent signal was vetoed with code `halted` until an operator cleared it. The watchdog can
halt and cannot re-arm, and this is what that looks like from outside.

## 3 — Stale market data

On this host the market feed and the trading venue are the same origin, so a network outage starves
both: the same drill produces `data_stale` alongside `venue_unreachable`. Behaviour observed under
the drill-2 outage matched the design — data older than 10 minutes raises `data_stale`, sets the
`dataStale` halt flag, and flattens when positions are open, because stale data must never be
mistaken for a quiet market.

The isolated case — market feed frozen while the venue stays reachable — cannot be produced on this
host without also cutting the venue, and is covered by unit tests over `assess()` rather than by a
live drill. Recorded here rather than claimed as a live result.

## 4 — Disk full under a live database

A 1 MB tmpfs was mounted, a `GovernorStore` opened on it, the filesystem filled to the last byte,
and 200 saves attempted.

```
BASELINE_SAVE                 ok, equity 400
DISK_FULL                     after 0 extra blocks
SAVE_UNDER_FULL_DISK          threw: YES -> database or disk is full
DB_READABLE_AFTER_FULL_DISK   true, equity 400
```

SQLite refused the write loudly and the database remained readable and consistent at the last
committed value — no partial write, no corruption, no silent data loss. The runner surfaces the
throw as `cycle_failed`, which counts toward the watchdog.

One consequence to keep in mind, recorded in the runbook: after a disk-full event the in-memory
position state can be ahead of what is on disk, so reconcile before trusting either.

## 5 — Clock skew

Forward and backward steps against a day that had already breached the 20 USDT daily loss limit and
halted.

**This drill found a real defect.** The daily roll keyed purely off "the UTC day key changed":

```
BASELINE                   pnlToday=  -20  dailyLimitHalt= true
FORWARD_26H                pnlToday=    0  dailyLimitHalt= false     ← correct
BACKWARD_20H (prev day)    pnlToday=    0  dailyLimitHalt= false     ← WRONG
```

A backward clock step across UTC midnight — an NTP correction, a VM restored from a snapshot —
zeroed the day's realised loss and cleared the `dailyLimit` halt, re-arming trading on a day whose
entire loss budget was already spent.

**Fix** (`packages/risk/src/state.ts`): the day only rolls forward. Keys are ISO `YYYY-MM-DD` and
compare lexicographically, so refusing a backward roll is one comparison. The cost of being wrong
in this direction is one day of unnecessarily conservative limits; the cost in the other direction
is trading a budget that was already gone.

```
BACKWARD_20H (post-fix)    pnlToday=  -20  dailyLimitHalt= true
FORWARD_26H  (post-fix)    pnlToday=    0  dailyLimitHalt= false
```

Five tests pin it, including that a new day never clears the kill switch.

## 6 — Reboot recovery

**This drill found a real defect.** `systemd-analyze verify`:

```
plumb-runner.service:20: Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.
plumb-asp.service:22:    Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring.
```

`StartLimit*` are `[Unit]` directives. Sitting in `[Service]` they were silently ignored, so the
crash-loop limiter that the whole unattended design leans on **was never armed** — a runner failing
at boot would have restarted forever every 15 seconds. Both units were corrected and
`RequiresMountsFor=/var/lib/plumb` added so the runner cannot start before its state directory is
present. `systemd-analyze verify` is now clean.

Verified without a reboot: both units `enabled`; ordering `After=network-online.target`, with the
runner also after the ASP; a cold start with `status.json` deleted brings both up and serves
`/health` over HTTPS within 8 seconds.

> **OPERATOR ACTION REQUIRED — the one item Phase 7 could not close.**
> A true kernel reboot has **not** been performed. The agent runs on this host, so rebooting would
> terminate the session mid-phase, and the box also carries three live listed ASPs.
> Please run, at a quiet moment, and confirm all four services return:
> ```bash
> reboot
> # after it comes back:
> systemctl is-active plumb-asp plumb-runner caddy
> curl -s https://plumb.assayed.xyz/health
> curl -s https://api.assayed.xyz/health          # ASSAY
> pm2 list                                        # Archon
> ```
> This should be done **before** the 21-day paper run reaches its end, not after.

## 7 — Restore from snapshot onto a clean directory

`VACUUM INTO` against the live WAL databases while the runner held them, then restored into an
empty directory — the rebuilt-VPS case.

```
BACKUP    feed.db 24576 sha 34c19337caaf | governor.db 16384 sha 1a0a351fbab2 | intents.db 24576 sha 66a18e9a40f5
VERIFY    feed.db identical | governor.db identical | intents.db identical
READABLE  feed.db true | governor.db true | intents.db true
TAMPER_DETECTED true
```

Verification compares **content hashes**, not file sizes, and the drill proves it by planting a
single-byte change in a restored file and confirming the check fails. A verification that cannot
fail is not a verification.

This is now `scripts/backup.mjs`, on a nightly timer at 02:17 UTC. It restores and verifies every
run *before* pruning old backups, so a run of silent failures cannot quietly delete the last good
copy.

## 8 — Unplanned: reconciliation against a ledger that did not exist yet

Not on the drill list, found by running the drills. `reconcileMismatch` latched permanently and
could not be cleared, on a system that was behaving correctly:

```
unmatched_fill | fill … (clOrdId "",              buy  0.34) matches no signal in the ledger
unmatched_fill | fill … (clOrdId "SIG6NogRjfTDK", sell 0.34) matches no signal in the ledger
… 8 issues, none of them clearable
```

Every one was a **P5B-era fill** — manual venue-verification orders from an earlier phase, plus the
empty-`clOrdId` fills that `swap close` produces by construction (gotcha 15). Reconciliation ran on
a rolling 24-hour window, so it kept judging fills from before this ledger existed against signals
that were never in it. The verdict was true about the venue and useless about the run, and a halt
that cannot be cleared is a halt nobody reads.

**Fix**: the window now starts at the later of "24 hours ago" and `baseline.json`, stamped when the
ledger is created. Fills before the baseline are out of scope by construction rather than by
exception. Recreating the state directory starts a new baseline — which is precisely what beginning
a measured run means.

A second finding came out of clearing it: `scripts/flatten.mjs` read `intent.signalId` where the
field is `intent.positionSignalId`, so it matched nothing, closed nothing, and **reported success**.
The script now reports an unmatched intent as a failure. A flatten that silently closes nothing is
the worst defect that script can have.

Order matters when re-baselining, and getting it wrong produced real size drift (recorded 0.35,
venue 0.7). The correct sequence is now in the runbook: **flatten → confirm the venue is flat →
wipe state → start**.

## Baseline for Phase 8

```
baseline.json  {"baselineAt": 1786365221827}
status.json    haltFlags all false · reconcileMismatch false · equity 400 · open 1 · mode demo
```

---

## What the drills changed

Three defects, all of them invisible to the test suite because all three were about the system
rather than its components:

1. **The runner could be "active" and inert.** Boot-time venue calls preceded the supervision loop.
2. **The crash-loop limiter was never armed.** A systemd directive in the wrong section.
3. **A backward clock step re-armed a spent loss budget.** The daily roll had no direction.
4. **Reconciliation judged fills from before its own ledger**, latching an unclearable halt.
5. **`flatten.mjs` closed nothing and reported success**, on a field-name mismatch.

And one that was not a defect but a breach: the runner unit's `EnvironmentFile` handed the **live**
OKX credentials to the process that places orders, which surfaced only as `401 Invalid Sign`.

None of these were visible to 564 passing unit tests, because none of them were about a component.
They were about a system: process start-up order, a systemd section header, a clock moving the wrong
way, a time window that predated the thing it was checking, and a deployment convention. That is the
argument for running drills rather than reasoning about them.
