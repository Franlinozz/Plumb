# RUNBOOK.md

**This is the operator's document. It is written for a tired human at 3am.**

Every procedure below has been executed at least once on the real host. Where something has *not*
been verified, it says so.

---

# THE TWO RULES

## 1. NO TOP-UPS. EVER. FOR ANY REASON.

**Do not add money to the competition account. Not after a drawdown, not "just to be safe", not
100 USDT, not 10.**

Principal Base rises the moment you deposit and **never falls again**. PnL% is measured against it.
A 100 USDT top-up after a 60 USDT loss does not rescue the run — it permanently raises the
denominator and damages the score for the rest of the competition. **It cannot be undone.**

The account is funded **once**, with 400 USDT, at registration. If it drops, that is the answer the
run is producing. Let it produce it.

## 2. NO MANUAL TRADES. THE ACTION IS ALWAYS "HALT".

Manual orders do not go through Agent Trade Kit, do not correspond to a published signal, and put
**eligibility itself** at risk — trades "clearly unrelated to the delivered signals" can void the
ranking outright.

If you want out, you halt. You do not trade.

```bash
systemctl stop plumb-runner                 # stops new risk immediately
node /opt/plumb/scripts/flatten.mjs         # closes open positions, attributably
```

**The single exception** is a naked position — a position with no stop. That is the one case where
you close manually at the venue, immediately, and investigate afterwards. See the incident page.

---

# DAILY CHECKS — five minutes, same time each day

Do these in order. Anything that is not "as expected" goes to the matching incident page.

```bash
curl -s https://plumb.assayed.xyz/health | jq
systemctl is-active plumb-asp plumb-runner
curl -s https://plumb.assayed.xyz/feed/verify | jq
cat /var/lib/plumb/reviews/$(date -u -d yesterday +%F).md
grep -c '"level":"critical"' /var/log/plumb/runner.log
```

> **THE JOURNAL IS EMPTY, AND THAT IS CORRECT.** Both units set
> `StandardOutput=append:/var/log/plumb/runner.log`, so `journalctl -u plumb-runner` shows only
> the two systemd start lines and **nothing** about what the bot is doing. Do not read an empty
> journal as a dead bot — it has misled one reviewer already. Application logs are
> newline-delimited JSON in `/var/log/plumb/runner.log` (and `asp.log`), rotated daily, 21 kept.
>
> Also note the two clocks: **systemd/journal print local time (CEST, UTC+2); every application
> log line and every timestamp in the databases is UTC.** A reboot logged at 15:04 CEST is
> 13:04Z in `runner.log`. Line them up before concluding an event was caused by another.

| # | Check | Expected | If not |
| --- | --- | --- | --- |
| 1 | `/health` responds | `ok: true` | → *ASP offline* |
| 2 | Both units active | `active`, `active` | → *VPS or unit failure* |
| 3 | **Equity, and distance from 335** | equity > 335, comfortably | → *approaching kill switch* |
| 4 | Open positions **and their stops** | every position has a stop at the venue | → **naked position** |
| 5 | Reconciliation | `reconcileMismatch: false` | → *reconciliation mismatch* |
| 6 | Uptime since last check | no unexplained restart | → check `NRestarts` |
| 7 | Overnight alerts | none, or all explained | read each one |
| 8 | The daily review | exists, and reads sanely | → review job failed |
| 9 | **ASP still listed and subscribable** | listed, subscribable | → **highest priority** |
| 10 | **Subscription service still exists** | exists, unchanged | → see below |

**Check 10 is the one that ends the competition if you get it wrong.** Deleting the subscription
service forfeits eligibility outright. There is deliberately no code path in Plumb that can delete
it — `refuseDeletion()` always throws — so the only way it disappears is a human doing it in the
dashboard. Do not.

Check 4 has a subtlety worth remembering at 3am: **an attached stop is not in the order's top-level
`slTriggerPx`**, which stays empty. It lives in `attachAlgoOrds[0]`. Reading only the top level
reports "no stop" for a perfectly protected position.

---

# INCIDENT PROCEDURES

## Kill switch fired (equity ≤ 335 USDT)

Everything is flat and trading is halted permanently.

```
Is the position flat at the venue?
├── YES → STOP HERE. Do not re-arm. The run is over.
└── NO  → close manually at the venue NOW, then stop here.
```

**Do not re-arm during the competition.** The switch fired because the account lost 65 USDT of 400.
Re-arming is a decision to lose more, taken at the worst possible moment for judgement. It is not
cleared by a new day, a restart, or the watchdog — `WATCHDOG_CAN_REARM` is `false` and a test pins
it. Preserve the state; it is the record of what happened.

## Daily loss limit hit (−20 USDT on the day)

**This is expected behaviour. Take no action.**

Trading stops for the remainder of the UTC day and resumes automatically at 00:00 UTC. That is
08:00 competition time (UTC+8) — **not** midnight on the leaderboard. Go back to bed.

The limit clears only on a **forward** day roll. A backward clock step never clears it.

## Reconciliation mismatch

A fill does not trace to a published signal. Trading has already halted automatically.

```
Read the issue list:  node /opt/plumb/scripts/reconcile-report.mjs
│
├── unmatched_fill with an EMPTY clOrdId
│     → a `swap close` was used somewhere. Unattributable by construction.
│       Was it you? If yes: note it, re-baseline, resume.
│
├── unmatched_fill with a clOrdId not in the ledger
│     → a fill from BEFORE this ledger existed, or a manual order.
│       If manual: this is an eligibility risk. Document it now.
│
└── size_drift (we record X, venue reports Y)
      → the venue is the truth. Reconcile state to the venue, never the reverse.
```

**Investigate before any re-arm.** The halt is doing its job; the danger is clearing it to make the
alert stop.

## Venue outage

Halt is automatic after 5 consecutive venue failures.

**Plumb deliberately does NOT flatten here** — a close order cannot be placed through a venue that
cannot be reached, so flattening would be a promise it cannot keep. It halts to stop *new* risk and
hands you the open book.

```
Confirm there are no naked positions (check the venue directly, not our state).
├── Venue reachable from elsewhere? → our egress. Check the VPS network.
└── Venue down for everyone?        → wait. Positions keep their venue-side stops.
```

Note: escalation takes ~15 minutes at the production cycle interval, not 5 — each failed attempt
costs about two minutes, so five failures is a count, not a duration.

## VPS unreachable

```
1. Check the EXTERNAL heartbeat first — it pings outward, so it knows things
   the box cannot report about itself.
2. Then the provider's status page.
3. Then SSH.
```

If the box is genuinely down: positions retain their venue-side stops. That is the entire reason
every position is bracketed before it opens. **Do not panic-trade from your phone** — see rule 2.

## ASP delisted or offline — HIGHEST PRIORITY

Eligibility depends on the ASP being online and subscribable for the whole period. This outranks
every other incident including a losing position.

```
curl -s https://plumb.assayed.xyz/health
systemctl status plumb-asp caddy
```

The ASP is read-only and holds no trading credentials, so restarting it is always safe:
`systemctl restart plumb-asp`. If Caddy is the problem, `caddy validate --config /etc/caddy/Caddyfile`
before reloading — this box also serves three other live ASPs.

## A naked position — THE ONE EXCEPTION TO RULE 2

A position with no stop. This is the gravest failure state in the system.

```
1. CLOSE IT MANUALLY AT THE VENUE. Right now. Before reading further.
2. Then: systemctl stop plumb-runner
3. Then: find out why. NakedPositionError should have fired and closed it
   automatically — if it did not, that is a second bug on top of the first.
```

Yes, this is a manual trade. It is the only one permitted, and closing an unprotected position is
defensible to any reviewer in a way that leaving it open is not.

---

# THE FINAL 48 HOURS — decided in advance, on purpose

Unrealised PnL on open positions counts toward the final figure. That makes the last day the moment
of maximum temptation, which is exactly why the policy is written here, now, and not then.

**The policy: stop opening new positions 24 hours before the close. Let existing positions run to
their stops or targets. Do not close early to "lock in", and do not open a last position to "catch
up".**

```bash
# 24 hours before close — halt new entries, leave open positions managed
systemctl stop plumb-runner
```

Stopping the runner stops new entries. Open positions keep their venue-side brackets and resolve on
their own terms.

The reasoning: ranks 4–40 all pay the same 500 USDT. The objective is **maximum probability of
finishing valid**, not maximum return. A last-minute position is a large variance bet on a payoff
that is flat across 37 places.

If the operator overrides this, that is their call — but write down the new policy *before* the
final 48 hours begin, not during them.

---

# ARM / DISARM

## Current state: NOT ARMED

Live credentials do not exist in any running process. Guardrail 10 holds. Everything running is
demo, and two independent defences keep it that way:

- the units read an **allowlisted** `/root/.plumb/runner.env`, which omits the live `OKX_API_*`
  triplet by construction
- `sanitizeEnv` strips that triplet from every child process regardless of how the parent started

Both exist because the Trade Kit CLI prefers those variables from the environment over its own
config profile — pointing `EnvironmentFile=` at the full secrets file put live credentials into the
order-placing process, and it surfaced only as `401 Invalid Sign`.

## Arming (Phase 9) requires BOTH locks open

1. **Machinery** — the 21-day paper-run gate, `reports/p8-gate.md`. Earliest 2026-08-31.
2. **Evidence** — a configuration with a signed eligibility record. **Currently none exists.** Ten
   configurations were tested on three years of development data and all ten failed.

Live trading requires both. Neither is opened by lowering a threshold.

When both are open:

```
□ 400 USDT ready, and it is money the operator can afford to lose
□ sub-account API key only — trade permission, NO withdrawal permission, IP-allowlisted
□ account level ≥ 2 (level 1 returns sCode 51010 on every swap)
□ accounting basis = Agent Trade Kit, and the operator understands it is IRREVERSIBLE
□ the subscription service exists, is the earliest-created, and will not be deleted
□ kill switch tested live in demo one final time
□ PLUMB_MODE=live, demo eligibility override removed
□ first trade watched end to end: published → approved → bracketed → stop confirmed → reconciled
```

Do not leave the system unattended until one complete round trip has been observed.

---

# THE HOST

| What | Where |
| --- | --- |
| VPS | `62.171.182.75` — **shared** with three live listed ASPs (ASSAY #8599, Occestra #5213, Sigil #4943). Nothing here may take the box down. |
| Source (edit here) | `/root/plumb` |
| Running code | `/opt/plumb` — never edit directly |
| State | `/var/lib/plumb` — `feed.db`, `governor.db`, `intents.db`, `status.json`, `baseline.json`, `reviews/`, `weekly/` |
| Logs | `/var/log/plumb/` — daily rotation, 21 kept |
| Backups | `/var/backups/plumb/<timestamp>/` — nightly 02:17 UTC, verified by content hash |
| Secrets | `/root/.plumb/secrets.env` (operator's), `/root/.plumb/runner.env` (allowlisted, what services read) |
| Public | `https://plumb.assayed.xyz` → Caddy → `127.0.0.1:8432` |

Only ports 22, 80 and 443 are open. Every service port is bound to loopback.

**Units:** `plumb-asp` (read-only public surface), `plumb-runner` (the cycle loop), plus timers for
nightly backup, daily review and the weekly paper-run report.

```bash
# rebuild and redeploy
cd /root/plumb && npm run build && npx vitest run
rsync -a --delete --exclude node_modules --exclude .git --exclude data --exclude reports \
      /root/plumb/ /opt/plumb/ && cd /opt/plumb && npm install --omit=dev
systemctl restart plumb-asp plumb-runner
```

**`StartLimit*` are `[Unit]` directives.** In `[Service]` systemd silently ignores them and the
crash-loop limiter is not armed. Run `systemd-analyze verify` after any unit edit.

## Re-baselining (order matters)

Wiping state while the venue holds a position produces real size drift. The order is:

```
1. systemctl stop plumb-runner
2. node /opt/plumb/scripts/flatten.mjs
3. CONFIRM the venue is flat — query it, do not assume
4. rm /var/lib/plumb/{feed,governor,intents}.db* status.json baseline.json
5. systemctl start plumb-runner
```

`baseline.json` is stamped on first start. Reconciliation never looks at fills before it, because a
fill that predates the ledger can never match a signal in it.

## Backup and restore

```bash
node /opt/plumb/scripts/backup.mjs
```

`VACUUM INTO`, not a file copy — copying a live WAL database gives you a file that opens fine and is
missing the last transactions. Verification compares **content hashes**, not sizes, and the script
restores into a scratch directory and checks before pruning anything, so a run of silent failures
cannot delete the last good copy.

## Known-unverified

**A true kernel reboot has never been performed.** Boot configuration is verified — both units
enabled, ordering correct, `systemd-analyze verify` clean, cold start passes — but the reboot itself
is an operator action, because the agent runs on this host and the host carries three live ASPs.

> **Please run this at a quiet moment, before the run ends:**
> ```bash
> reboot
> # after it returns:
> systemctl is-active plumb-asp plumb-runner caddy
> curl -s https://plumb.assayed.xyz/health
> curl -s https://api.assayed.xyz/health     # ASSAY must also come back
> pm2 list                                   # Archon
> ```

---

# POST-COMPETITION

The competition is two weeks. The asset is permanent.

1. **The ASP stays listed and the subscription stays live.** That is the actual product; the
   competition was a deadline, not the goal.
2. **Publish the full track record** — wins *and* losses — generated from the ledger, never
   hand-written. `buildTrackRecord` computes it from closed trades only, reports `profitFactor` as
   `null` rather than `Infinity` when there are no losses, and scales its own caveat to the sample
   size.
3. **Write the retrospective**: what the governor caught and what it missed, where the backtest was
   right and where it was wrong, and what the next version changes. Be specific about the wrong
   parts — those are the only ones with information in them.
4. **Archive** the ledger, the feed and the equity curve as the verifiable record. The feed's hash
   chain is what makes it evidence rather than a claim.

---

# TIMEZONE

Competition clock is **UTC+8**. Internal accounting is **UTC**. Every conversion is explicit.

The daily loss limit resets at **00:00 UTC = 08:00 competition time**. If you are looking at the
leaderboard at competition midnight wondering why the limit has not cleared, this is why.
