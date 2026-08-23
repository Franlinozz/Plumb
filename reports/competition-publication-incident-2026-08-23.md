# Competition publication incident — 2026-08-23

## Outcome

At 2026-08-23T16:00:24Z the deadline contingency produced approved SOL long decision
`DEC-ru44MLpWgI`. The immutable event referenced 95.32, stop 93.4136, target 98.1796,
3.97 USDT stop risk and 4.22 USDT estimated planned loss.

The first executable A2A delivery returned a non-success business response. The workflow created
its durable claim before the write, marked the publication and claim uncertain, did not call the
competition executor, and blocked every subsequent timer invocation.

## Reconciliation

- Decision publication ledger: uncertain, active subscribers 3, acknowledged 0.
- Per-subscriber delivery ledger: first subscriber uncertain; other two were never attempted.
- All three official deliverable histories: no executable SOL signal at the incident time; only
  the routine 137-byte Copy-Trading Notice was persisted.
- Competition account preflight after the incident: 8/8 PASS, 409.97 USDT, no position.
- Venue order stage: never entered.
- The decision expired at 2026-08-23T16:30:24Z and must never be replayed.

This proves no signal/order correspondence was partially created and permits the shared claim to
be archived rather than deleted. The publication database remains uncertain as an immutable audit
record.

## Defects and repairs

1. The parent process retained only the last stderr line, reducing the real child error to
   `Node.js v24.15.0`. It now preserves a redacted primary structured error.
2. Structured CLI error objects were collapsed to `business response failed`. Their code/message
   is now retained without credentials.
3. A transient delivery failure had no bounded recovery. A fresh event may now retry once only for
   network, HTTP 429 or 5xx failures, and only after the exact timestamp-scoped deliverable is
   absent. Validation/business rejections never retry.
4. A persisted deliverable without a business acknowledgement remains uncertain and cannot
   authorize execution.
5. The scheduled fallback publisher could send a no-trade notice while an executable publication
   was in progress. It now suppresses no-trade notices for every prepared, published, executing,
   complete or uncertain competition claim.
6. Regression coverage now pins structured diagnostics, credential redaction, retry
   classification, exact/timestamp-scoped postconditions, notice suppression and the guarded
   incident resume.

Verification after the repair: TypeScript PASS; script syntax PASS; 58 test files and 683 tests
PASS. P8 code, unit and baseline were not modified.

## Resume authority and operation

The operator supplied `AUTHORIZE RECONCILED CONTINGENCY RESUME V1`. The incident-specific command
`node scripts/resume-reconciled-contingency.mjs --execute` validates the exact decision, expired
bundle, zero acknowledgements, uncertain publication rows and active P8 runner; restarts only the
isolated A2A service; archives the claim under `/var/lib/plumb-okxai/incidents/`; and resumes only
the contingency timer. It cannot replay the expired decision.

Automated service-control execution was blocked by the hosting environment's approval quota, so
the guarded command requires one root invocation on the VPS.
