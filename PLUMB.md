# Plumb

**Every signal, measured before it's sent.**

Plumb is a Trading Agent Service Provider on OKX.AI, built by Xyndicate — the studio behind
[Assay](https://assayed.xyz) (#8599), Occestra (#5213) and Sigil (#4943).

A plumb line is the oldest instrument in construction: a weight on a string that tells you, without
argument or opinion, whether a thing is true to vertical. It does not build. It measures, and it
refuses to flatter. That is the product.

---

## What Plumb is

A disciplined, risk-first perpetual futures signal service. It publishes every signal — direction,
instrument, entry, stop, target, size, leverage, and the reasoning behind it — **before any order
exists**. Then it executes only what it published.

Three sentences of architecture:

1. **Strategy proposes.** It reads market data and emits `Signal` objects. It has no ability to place
   an order. Not "it doesn't"; it *cannot* — the executor is not reachable from it.
2. **Risk disposes.** A deterministic governor sizes the position from the stop distance, checks it
   against every locked limit, and stamps the signal `approved` or `vetoed` with a reason. No model
   is consulted. No number in that path comes from an LLM.
3. **The executor obeys the ledger.** It reads approved signals out of the *published* feed — the
   same feed a subscriber sees — and places bracketed orders. Every fill is reconciled back to its
   signal ID. An orphan fill halts the system.

## Why signal primacy

Because it is the only architecture that can be audited after the fact.

The OKX.AI trading competition ranks entrants on realised and unrealised PnL over two weeks, and it
reserves the right to void a ranking where trades are "clearly unrelated to the signals delivered by
the participating subscription service." That is not a formality. It is the single largest source of
downside in the whole event: an entrant can trade well for fourteen days and score zero because
nobody can prove which signal produced which fill.

Plumb makes that proof structural rather than clerical. The publication *is* the instruction set.
The executor has no other input. If a fill exists, a published signal exists, timestamped before it,
carrying its rationale. The audit is a join on one column.

## Why risk-first

The competition pays ranks 4 through 40 identically: 500 USDT. There is no gradient across that
band. So the objective function is not "maximise return" — it is **maximise the probability of
finishing valid and inside the band**. Three failure modes dominate, and all three are engineering
problems rather than trading problems:

| Failure | Cause | Plumb's answer |
| --- | --- | --- |
| **Disqualification** | Fills that cannot be traced to a published signal | Publish-before-execute + reconciliation halt |
| **Downtime** | ASP offline, or the subscription service deleted mid-competition | One service, created once, never deleted; supervised process, persisted state |
| **Blowup** | Leverage and averaging down destroying the account before day 14 | 3× ceiling, 1%-of-equity risk per trade, hard daily loss limit, permanent kill switch at −16% |

Capital is 400 USDT, funded once. It is never topped up mid-competition — under the rules a
deposit raises the Principal Base permanently while a withdrawal never lowers it, so a rescue
top-up is a permanent, irreversible tax on PnL%. The kill switch sits at 335 USDT. If the account
touches it, Plumb goes flat, halts, and requires a human to re-arm it. A halted entry that finishes
down 16% still ranks. A blown one does not rank at all.

## What Plumb does not claim

**No edge is claimed for any strategy in this repository until the backtest and paper-trading phases
produce evidence for it.** The scaffolding is honest about this on purpose:

- No backtest result appears anywhere in this repo until `packages/backtest` has actually produced it
  from real historical data, and the code that produced it is committed alongside it.
- Where a number is not yet measured, the documentation says "not yet measured" — never a plausible
  placeholder. A plausible placeholder is the exact failure this product exists to prevent.
- The risk governor is the part we are confident about today, because it is deterministic and
  testable. The signal generator has to earn its confidence in Phases 5–8.

## After the competition

The two weeks are a proving ground, not the product. What survives is a subscription signal service
with something most of them cannot offer: a **public, verifiable track record** where every signal
was timestamped and published before its outcome was known, and every trade is joinable to the
signal that caused it. Two weeks of live, adversarially-scored trading is the seed of that record.

The competition is where the track record starts. It is not where it ends.

---

*Build discipline lives in [AGENTS.md](./AGENTS.md). Operations live in [RUNBOOK.md](./RUNBOOK.md).
Shipped capability lives in [FEATURES.md](./FEATURES.md).*
