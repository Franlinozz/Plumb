# RUNBOOK.md

> **Stub — filled in Phase 10.** Nothing in this file is operational yet. Do not follow it.

The runbook is written last on purpose: it documents the system that actually shipped, not the one
that was planned. It will cover, at minimum:

## Deploy
- Host, process supervision, `EnvironmentFile` layout, rebuild + restart sequence.

## Arm / disarm
- Funding the sub-account once (400 USDT) and confirming Principal Base.
- Arming live keys (Phase 9 — they do not exist before then).
- Disarming: how to go flat and halt without deleting the subscription service.

## The kill switch
- What trips it (equity ≤ 335 USDT), what it does (flat everything, halt permanently), and the
  manual re-arm procedure. Re-arming is a human decision, never an automated one.

## Daily checks
- Reconciliation report: every fill matched to a signal ID; any orphan is a page.
- Risk governor state: daily loss, peak equity, drawdown, halt flags — read from persistence,
  never recomputed from memory.
- ASP liveness: the subscription service is online and subscribable. Downtime is a scoring risk.

## Incidents
- Orphan fill. Exchange rejects. Stop not placed. ASP unreachable. Restart mid-position.
- Rule reminder: **never delete the subscription service** — deleting it mid-competition forfeits
  eligibility outright.

## Timezone
- Competition clock is **UTC+8**; internal accounting is **UTC**. Every conversion is explicit.
