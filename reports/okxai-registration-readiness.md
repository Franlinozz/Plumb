# OKX.AI registration readiness

Audit time: 2026-08-10T17:27Z

Competition worktree: `/root/plumb-okxai`  
Branch: `competition/okxai`  
Protected source SHA: `fbd2fd51aec77891ed2378a475baa56c94585bfb`

## Status

| Requirement | Status | Evidence / next gate |
| --- | --- | --- |
| ASP created | GREEN | Plumb ASP `#10746` created at `2026-08-10T15:48:07.476Z`. Existing Assay #8599 remains separate and unchanged. |
| ASP activated | GREEN | Activation submitted the listing for marketplace review. |
| Review state | GREEN | Approved; operator reported approval before registration. |
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
| Dedicated account configured | GREEN | `competition` profile written to `/root/.okx/config.toml` (2026-08-10T19:53Z), `demo = false`. **`default_profile` deliberately left as `demo`** — see the warning below. |
| Hackathon registration | GREEN | Irreversible CeFi registration returned `registered: true` on 2026-08-10. UID is masked and not stored in the repo. |
| Funding requirement | GREEN | Verified live: **409.9 USDT** (`eqUsd` 409.445) in the **trading** account, funding account 0.00, account flat. Clears the 300 minimum. |
| Outstanding manual action | GREEN | Done. Verified: `acctLv 2`, `posMode net_mode`, `perm read_only,trade` (no withdrawal), `uid 872498673497072884` matching registration, `mainUid 400998524726203844`, IP allowlist includes both `62.171.182.75` and `2a02:c207:2329:7534::1`. |
| USDT-perp tradability | GREEN | `account max-avail-size --instId BTC-USDT-SWAP --tdMode cross` → availBuy/availSell **409.9**. The account reports `settleCcy USDC` / `settleCcyList [USDC, USDG]`, which does **not** block USDT perpetuals — checked because only USDT perps count. |
| Snapshot readiness | GREEN | `scripts/competition-preflight.mjs`: **8 checks, 0 FAIL, 0 WARN.** |

> **DO NOT RUN `okx config init`.** The wizard reassigns `default_profile` to whatever profile it
> creates. The P8 runner passes `--demo` explicitly on every call, so it would not silently trade
> live — but it would start signing demo calls with the competition credentials and fail with
> `401 Invalid Sign`, killing the paper run. The profile was written directly for this reason, and
> `default_profile = "demo"` is load-bearing. Backup: `/root/.okx/config.toml.bak-20260810-195330`.

> **A 401 through the environment does not mean the key is bad.** Passing `OKX_API_KEY` /
> `_SECRET` / `_PASSPHRASE` as environment variables alongside `--live` returned
> `401 Invalid Sign` with these exact credentials, while the identical values in a
> `--profile competition` entry authenticate first try. The env-override path (gotcha 16) is not a
> reliable way to *test* a credential — use a profile.

## Snapshot deadline

Rules re-fetched live from `https://www.okx.ai/hackathon` on 2026-08-10T18:46Z; they match this
document. The capital snapshot is at competition start, **2026-08-11T04:00Z** (Aug 11 12:00 UTC+8).

What must be true at that moment — **all now verified GREEN**: ≥300 USDT in the bound account, the
ASP online and subscribable, exactly one subscription service. What is **not** due then: the
">= 1 valid trade" requirement, which has the whole two-week period to 2026-08-25T04:00Z. A
finished competition executor was therefore never on the pre-snapshot critical path.

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
- Hackathon registration: accepted with `registered: true`, CeFi accounting basis; identifier intentionally redacted.

## Architecture gaps against the emergency specification

1. The current `Signal` plus governor verdict/feed entry is not the requested canonical immutable `DecisionEvent`.
2. The minimum official subscription/session/heartbeat runtime is deployed, but executable on-demand delivery is intentionally disabled until it consumes a canonical approved `DecisionEvent`.
3. The legacy formatter still includes URLs and long prose. The deployed review runtime does not use it; it emits only a validated non-executable notice under 200 characters. Replace the legacy formatter before executable delivery is enabled.
4. The competition adapter does not yet fail closed on every required state, verify all business response codes, or implement the explicit close-to-zero-before-reversal state machine.
5. Persistent open-interest recording is not running; only live reads and limited historical fetching exist.
6. Several requested regression scenarios are covered in substance, but the full named 25-test competition matrix does not exist.
