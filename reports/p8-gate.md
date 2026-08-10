# Phase 8 — the 21-day paper run and its gate

> ## RUN 1 IS VOID — read this before any number below
>
> **Run 1** started 2026-08-10T12:33:41Z and **halted 2026-08-10T13:02:47Z, 29 minutes in.** It
> measured nothing and is not gradeable. Cause: the governor approved a short on an already-open
> long, which on this `net_mode` account reduced the long rather than opening a second position;
> reconciliation caught the resulting ledger-vs-venue divergence and halted, exactly as designed.
> Fixed by veto `instrument_occupied` (see CHANGELOG *Unreleased*, AGENTS.md gotchas 19–21).
> State archived at `/var/lib/plumb/archive-p8run1-20260810-132719/`.
>
> The halt is **evidence for criterion 4, not against it**: an unaccounted position was detected
> within one cycle and stopped trading without human involvement. What run 1 cannot supply is 21
> days of it.
>
> **The criteria below are unchanged and were still written before any number existed.** They
> were not touched in response to this failure — only the run clock was reset.

**Run 2 started `<pending — see the operator action in the session notes>`. Gate readable 21 days
after that stamp.**

**Run 1 (VOID): started 2026-08-10T12:33:41Z, halted 2026-08-10T13:02:47Z.**

The criteria below are written **now, before the run has produced any numbers**, for the same
reason the P4 eligibility thresholds were: a bar set after seeing the result is not a bar. Nothing
in this file may be edited while the run is in progress. If a criterion turns out to be wrong, it
is recorded as failed and the reasoning is argued in the open, not amended.

## What this run measures, and what it does not

**Not an edge.** Ten strategy configurations were tested against three years of development data in
Phase 4B and **none passed the eligibility gate**. Nothing Plumb can currently trade has evidence
behind it. This run therefore uses the demo-only eligibility override on a permissive
configuration, and it cannot and does not tell us whether Plumb makes money.

**The machinery.** Nine of the ten criteria are about whether the system can be trusted to run
unattended with real money: uptime, reconciliation, stops, parameter discipline, recovery. Those
need answering regardless of whether a configuration ever passes, and they can only be answered by
running.

Read the criteria in that light. A pass here means *the plumbing holds*. It does not mean *go
live* — see the note at the end.

## The ten criteria

| # | Criterion | Threshold | Evidence |
| --- | --- | --- | --- |
| 1 | **Uptime** | ASP reachable ≥ 99% of the 21 days; no unplanned gap > 1h | `/health` polling, `systemctl` restart counts |
| 2 | **No naked position, ever** | Zero. Not "rare" — zero. | `NakedPositionError` count in the ledger; every fill traced to a bracket |
| 3 | **Reconciliation clean** | Every fill after the baseline traces to a published signal | daily `reconcile_mismatch` count = 0 |
| 4 | **Publish-before-execute holds** | 100% of orders reference a published feed entry | `publish_gate` is structural; ledger cross-check |
| 5 | **No LOCKED parameter breached** | Zero breaches of risk, leverage, concurrency, notional | governor audit; `locked.test.ts` fingerprint unchanged |
| 6 | **Restart recovery** | Every restart recovers state; no duplicated order | `boot_recovery` records; intent store |
| 7 | **Feed integrity** | Hash chain intact end to end | `/feed/verify` |
| 8 | **Alerting worked** | Every halt produced an alert; no silent halt | alert log vs. halt-flag transitions |
| 9 | **Daily review produced every day** | 21 of 21, none fabricated | `/var/lib/plumb/reviews/` |
| 10 | **Kill switch never needed — and would have worked** | Equity never ≤ 335; a live demo test of the switch passes at the end | governor state; final drill |

Criterion 10 is deliberately two-sided. "The kill switch never fired" is not evidence that it
works; it is evidence that it was not called. The switch is tested explicitly at the end of the run.

## What a failure means

A failed criterion does **not** get the threshold lowered. It gets fixed, and the clock restarts
for however long is needed to re-observe the fixed behaviour. Phase 7's drills already demonstrated
the failure mode this guards against: three defects were invisible to 564 unit tests because they
were properties of the running system, not of any component.

## The gate does not authorise live trading on its own

Passing all ten means the machinery is sound. **Phase 9 additionally requires a configuration with
a signed eligibility record**, and at the time of writing none exists — 0 of 10 configurations
passed on three years of development data, and the 90-day holdout has never been read.

So there are two independent locks on live money, and this run only opens one of them:

1. **Machinery** — this gate. Opens 2026-08-31 at the earliest.
2. **Evidence** — a strategy that survives the P4 eligibility gate. Currently **not met**, with no
   date, and it will not be met by loosening the gate.

Live trading requires both. Funding the account before both are met would be spending real money to
find out something the evidence already says.
