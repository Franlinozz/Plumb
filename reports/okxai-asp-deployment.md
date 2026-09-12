# Plumb OKX.AI ASP deployment

Deployment time: 2026-08-10T16:05Z UTC  
Worktree: `/root/plumb-okxai`  
Branch: `competition/okxai`

## Marketplace identity

| Field | Value |
| --- | --- |
| ASP | Plumb `#10746` |
| Created | `2026-08-10T15:48:07.476Z` UTC |
| Service | Plumb Perpetual Signals |
| Service id | `cc4531b5-b71d-40e8-96f4-f2ce2a569bd4` |
| Type | Agent-to-agent subscription |
| Price | 10 USDT/month |
| Trial | 72 hours / 3 days |
| Category | Trading |
| Review | Submitted; approval pending |
| Avatar | 440×440 RGB PNG, square corners, 221,849 bytes |

Listing validation passed without findings before creation. Activation submitted the listing for
review. Review state must not be polled or resubmitted while pending.

## Delivery runtime

`plumb-okxai-a2a.service` is a new isolated systemd service. It does not import the P8 runner, read
venue credentials, place orders, or write under `/var/lib/plumb`.

Implemented controls:

- current official communication runtime, daemon, autostart and identity refresh are healthy;
- official X Layer heartbeat every 45 seconds;
- active subscription discovery every 60 seconds;
- provider status cross-check before delivery;
- communication-session creation for each new active subscription;
- expired, inactive, missing or uncertain subscriptions fail closed;
- SQLite delivery ledger with write-ahead logging;
- `pending` deliveries become `uncertain` after restart and are never replayed automatically;
- one durable `subscription-welcome-v1` notice per subscription;
- structured JSON logs with no credential or request-body logging;
- dry-run and one-shot modes;
- graceful network/auth/business-response handling.

The fallback notice is non-executable and below 200 characters. Executable signal delivery remains
disabled until a canonical immutable DecisionEvent passes the governor, cost, evidence and
reconciliation gates. The current Trading Signal v1.2 formatter is implemented and the obsolete
V1.1 executable grammar is rejected.

## Review smoke test

Two active marketplace inspection subscriptions were discovered immediately after submission.
Their official communication sessions were created, and both deliveries returned business-level
confirmation (`ok: true`, `delivered: true`). The persistent ledger was then seeded with those
acknowledgements. The daemon subsequently recreated the sessions and suppressed both duplicate
deliveries as already delivered.

## Verification

- Communication readiness: PASS, current release `0.2.3`.
- Unit validation: PASS.
- Daemon active: PASS, zero restarts at verification.
- Protected `plumb-asp.service`: active.
- Protected `plumb-runner.service`: active.
- Typecheck: PASS.
- Repository tests: PASS.
- P8 files, state, units and account profile: unchanged.
