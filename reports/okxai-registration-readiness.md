# OKX.AI registration readiness

Audit time: 2026-08-10T16:05Z  
Competition worktree: `/root/plumb-okxai`  
Branch: `competition/okxai`  
Protected source SHA: `fbd2fd51aec77891ed2378a475baa56c94585bfb`

## Status

| Requirement | Status | Evidence / next gate |
| --- | --- | --- |
| ASP created | GREEN | Plumb ASP `#10746` created at `2026-08-10T15:48:07.476Z`. Existing Assay #8599 remains separate and unchanged. |
| ASP activated | GREEN | Activation submitted the listing for marketplace review. |
| Review state | YELLOW | Submitted and under review. Do not poll or resubmit while this state remains pending. |
| Trading-type eligibility | GREEN | Platform service metadata categorizes Plumb as `TRADING`. |
| Subscription | GREEN | Exactly one agent-to-agent service registered: `Plumb Perpetual Signals`, service id `cc4531b5-b71d-40e8-96f4-f2ce2a569bd4`, 10 USDT/month. |
| 3-day trial | GREEN | Registered `freeTrial=72` hours and displayed as 3 days. |
| ASP heartbeat | GREEN | Official X Layer heartbeat succeeds; `plumb-okxai-a2a.service` sends it every 45 seconds. Existing public `/health` remains healthy. |
| A2A delivery | GREEN | Two active marketplace review subscriptions received confirmed non-executable notices. Sessions, active-only filtering, heartbeat, durable idempotency, restart uncertainty handling, structured logs and dry-run are deployed. |
| Agent Trade Kit installed | GREEN | Local P8 runtime and global CLI/MCP are all current npm release `1.4.2`. |
| Agent Trade Kit demo writes | GREEN | Existing repo evidence records demo placement, attached-stop, fill, idempotency and reconciliation tests. No new write was made during this audit. |
| Competition executor | YELLOW | Existing executor places through Agent Trade Kit CLI, not direct REST. It is demo/P8-oriented and does not yet consume the required immutable `DecisionEvent` or enforce a dedicated competition profile. |
| Net-mode regression | GREEN | Opposite direction on an occupied instrument is vetoed; the live P8 run logs repeated `instrument_occupied` vetoes. |
| Signed reconciliation | GREEN | Reversed same-size positions fail reconciliation; baseline tests pass. |
| Dedicated account configured | YELLOW | The intended Agentic Wallet profile is active and may create Plumb alongside Assay #8599. Competition Trade Kit credentials/profile are still not configured. |
| Hackathon registration | RED | Not started; requires an approved ASP and the platform's irreversible confirmation. |
| Funding requirement | RED | Not verified. Do not fund or move assets during registration preparation. |
| Outstanding manual action | YELLOW | Wait for marketplace approval. Registration cannot begin until approval; its irreversible confirmation still requires the operator. |

## Protected P8 state

- Source branch: `main`, clean, SHA `fbd2fd51aec77891ed2378a475baa56c94585bfb`.
- Deployed version: `0.11.0`, demo mode.
- `plumb-asp.service`: active since 2026-08-10 15:04:23 CEST, zero recorded restarts.
- `plumb-runner.service`: active since 2026-08-10 15:45:22 CEST, zero recorded restarts.
- P8 run 2 baseline: `2026-08-10T13:45:22.983Z`.
- Health and feed verification: healthy; every halt flag false.
- Current runner state at audit: equity 400 USDT, one demo position, cycle 18.
- Protected files/services: `/var/lib/plumb/**`, `/opt/plumb/**`, `/root/plumb/reports/p8-gate.md`, `plumb-asp.service`, `plumb-runner.service`, and the deployed Agent Trade Kit profile/runtime.
- No P8 service, state file, account setting, baseline, or deployed artifact was changed during this audit.

## Baseline verification

- `npm run build`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 568/568 tests.
- Marketplace avatar: exact 440×440 RGB PNG, square corners, no alpha mask, 221,849 bytes; uploaded and attached to Plumb #10746.
- Competition work is isolated from the live tree in `/root/plumb-okxai`.

## Registration and delivery evidence

- ASP id: `10746`.
- Service id: `cc4531b5-b71d-40e8-96f4-f2ce2a569bd4`.
- Created: `2026-08-10T15:48:07.476Z` UTC.
- Activation/review update: `2026-08-10T15:59:16.129Z` UTC.
- Activation response: creation succeeded; approval submission succeeded and returned the under-review state.
- Communication runtime: current release `0.2.3`, ready, daemon and autostart healthy, identity refresh healthy.
- Review delivery: both active inspection subscriptions returned `delivered: true`.
- Persistent daemon: `plumb-okxai-a2a.service`, active with zero restarts at deployment verification.
- Persistent state: `/var/lib/plumb-okxai/asp-delivery.db`, isolated from `/var/lib/plumb/**`.

## Architecture gaps against the emergency specification

1. The current `Signal` plus governor verdict/feed entry is not the requested canonical immutable `DecisionEvent`.
2. The minimum official subscription/session/heartbeat runtime is deployed, but executable on-demand delivery is intentionally disabled until it consumes a canonical approved `DecisionEvent`.
3. The legacy formatter still includes URLs and long prose. The deployed review runtime does not use it; it emits only a validated non-executable notice under 200 characters. Replace the legacy formatter before executable delivery is enabled.
4. The competition adapter does not yet fail closed on every required state, verify all business response codes, or implement the explicit close-to-zero-before-reversal state machine.
5. Persistent open-interest recording is not running; only live reads and limited historical fetching exist.
6. Several requested regression scenarios are covered in substance, but the full named 25-test competition matrix does not exist.
