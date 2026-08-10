# RUNBOOK.md

Operational from Phase 7. Everything below has been executed on the real host at least once; the
drill results are in `reports/drills.md`. Live trading is still not armed — see **Arm / disarm**.

## The host

| What | Where |
| --- | --- |
| VPS | `62.171.182.75` — **shared** with the ASSAY, Occestra and Sigil ASPs. Nothing here may take the box down. |
| Code (built, running) | `/opt/plumb` |
| Code (source, edited) | `/root/plumb` — build here, then `rsync` to `/opt/plumb`. Never edit `/opt` directly. |
| State | `/var/lib/plumb` — `feed.db`, `governor.db`, `intents.db`, `status.json`, `reviews/` |
| Logs | `/var/log/plumb/{asp,runner}.log`, rotated daily, 21 kept |
| Backups | `/var/backups/plumb/<timestamp>/` |
| Secrets | `/root/.plumb/secrets.env` (operator's copy, chmod 600) and `/root/.plumb/runner.env` (allowlisted subset the services read) |
| Trade Kit config | `/root/.okx/config.toml`, demo profile |
| Public surface | `https://plumb.assayed.xyz` → Caddy → `127.0.0.1:8432` |

Ports: only 22, 80 and 443 are open (ufw). Every service port is bound to loopback and reached
through Caddy.

### The two units

- `plumb-asp.service` — the read-only public surface. Never places an order, never reads a trading
  credential. `Restart=always`, 5s.
- `plumb-runner.service` — the cycle loop. `Restart=always`, 15s, and `StartLimitBurst=4` per 600s
  so a genuine crash-loop stops rather than hammering the venue.

```bash
# rebuild and redeploy
cd /root/plumb && npm run build && npx vitest run
rsync -a --delete --exclude node_modules --exclude .git --exclude data --exclude reports \
      /root/plumb/ /opt/plumb/ && cd /opt/plumb && npm install --omit=dev
systemctl restart plumb-asp plumb-runner
```

**`StartLimit*` are `[Unit]` directives.** In `[Service]` systemd silently ignores them and the
crash-loop limiter is not armed. Check with `systemd-analyze verify` after any unit edit.

## Secrets: why the runner does not read `secrets.env`

The Trade Kit CLI prefers `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE` from the
environment over its own config profile. Pointing `EnvironmentFile=` at the whole secrets file put
the **live** credentials into the process that places orders — a guardrail-10 breach that surfaced
only as `401 Invalid Sign`.

So `runner.env` is generated from `secrets.env` by an **allowlist**, and `sanitizeEnv` strips the
live triplet from every spawned child regardless. Two defences, because deployment hygiene alone is
a convention and conventions decay. If you add a secret the services need, add it to the allowlist
in the generator — never widen the `EnvironmentFile`.

## Arm / disarm

**Live keys do not exist yet (guardrail 10).** Everything running is demo. Arming is Phase 9:

1. Fund the sub-account with 400 USDT **once**. It is never topped up — that is what makes the
   drawdown numbers mean anything.
2. Confirm account level ≥ 2, otherwise every swap placement returns `sCode 51010`.
3. Add the live credentials, switch `PLUMB_MODE=live`, and remove the demo eligibility override —
   in live mode a configuration cannot trade without a signed eligibility record, and no
   configuration has one.

**Disarm** (go flat and stop, without touching the subscription):

```bash
systemctl stop plumb-runner        # stops new risk immediately
node /opt/plumb/scripts/flatten.mjs # closes open positions reduce-only
```

Leave `plumb-asp` running. **Never delete the subscription service** — deletion forfeits
eligibility outright, and there is deliberately no code path that can do it.

## The kill switch

Trips at equity ≤ **335 USDT**: flattens everything and halts permanently. It is not re-armed by a
new day, by a restart, or by the watchdog — `WATCHDOG_CAN_REARM` is `false` and a test pins it.
Re-arming is a human decision, taken deliberately, by editing the governor state.

The daily loss limit (20 USDT) *is* cleared by a new UTC day — but only **forwards**. A backward
clock step never clears it, because that would re-arm trading on a day whose budget was spent.

## Daily checks

```bash
curl -s https://plumb.assayed.xyz/health              # ok, mode, lastCycleAt, halt flags
curl -s https://plumb.assayed.xyz/feed/verify         # hash chain intact
cat /var/lib/plumb/reviews/$(date -u -d yesterday +%F).md
```

1. **Halt flags** — any flag set is an incident until explained. `reconcileMismatch` means a fill
   does not trace to a published signal.
2. **`lastCycleAt`** — more than 15 minutes old with positions open is a page.
3. **Reconciliation** — every fill matched to a signal ID.
4. **ASP liveness** — downtime is a scoring risk.

The daily review runs from `scripts/daily-review.mjs` and derives every number from the log, the
feed and the governor state. It is prose, and it is allowed to say the day was uneventful.

## Incidents

| Symptom | What it means | Action |
| --- | --- | --- |
| `bootstrap_failed` | The runner is up but cannot reach the venue. Nothing trades; it retries each cycle. | Check egress. It self-heals. |
| `venue_unreachable` (5+ failures) | Halted. **Deliberately does not flatten** — a close order cannot be placed through an unreachable venue either. | Restore connectivity, then reconcile before re-arming. |
| `reconcile_mismatch` | A fill does not trace to a published signal. | Halted already. Reconcile by hand against the venue before anything else. |
| `data_stale` | Market data older than 10 minutes. Flattens if positions are open. | Stale data must never look like a quiet market. |
| `runner_stalled` | No cycle for 15 minutes. Flattens if positions are open. | Check for a blocked child process. |
| `database or disk is full` | SQLite refuses the write loudly; the database stays readable and consistent. | Free space. In-memory state may be ahead of disk — reconcile. |
| Naked position | A fill with no stop. | The gravest failure. Flatten immediately, then find out why. |

**Restart mid-position is safe and tested**: `SIGKILL` during a cycle leaves the position intact,
the runner restarts within 15s and recovers pending intents without duplicating an order.

## Backup and restore

```bash
node /opt/plumb/scripts/backup.mjs          # VACUUM INTO, safe on live WAL databases
```

Restore verification compares **content hashes**, not file sizes — a same-size corrupt file is
exactly the case a size check misses. Verified by restoring onto a clean directory and confirming a
planted single-byte change is detected.

## Timezone

Competition clock is **UTC+8**; internal accounting is **UTC**. Every conversion is explicit. The
daily loss limit resets at 00:00 **UTC**, which is 08:00 competition time — not midnight on the
leaderboard.
