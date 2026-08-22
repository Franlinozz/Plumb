# Competition executor

Audit time: 2026-08-21T15:37Z UTC

## Status: YELLOW — first entry protected; one-shot second-entry automation armed, no signal

Read-only competition preflight passed 8/8 checks: dedicated profile authentication and registered
UID binding, account level 2, `net_mode`, read+trade without withdrawal, 409.90 USDT in Trading,
empty Funding account, and no open positions. BTC, ETH and SOL cross leverage settings are 3x.

`AgentTradeKitCompetitionExecutor` consumes the exact canonical immutable `DecisionEvent` used by
the on-demand A2A publisher. The default command is preview-only. A write additionally requires
the dedicated Agent Trade Kit profile, exact acknowledgement by every active subscriber, and a
decision-specific live-money confirmation.

Live status update (2026-08-21T11:31Z): decision `DEC-ydBHBkzgyA` was acknowledged by all three
ACTIVE A2A subscriptions, then filled through the dedicated Agent Trade Kit competition profile at
the venue minimum 0.01 ETH-USDT-SWAP contract. Independent readback confirmed the attributable
fill, signed +0.01 net position, and attached stop/target. The original one-entry allowance is
consumed. A separately recorded evidence-limited amendment now permits at most one qualifying
BTC/ETH/SOL v3 entry under narrower explicit gates.

Implemented gates:

- exact account UID, account level, `net_mode`, venue positions and pending orders;
- current metadata, SWAP-wide Lv1 fees, ticker, leverage, max size, equity and available margin;
- signed venue/ledger/Event reconciliation, including wrong-direction failure;
- close/reduce to verified signed zero before reversal;
- Agent Trade Kit runtime brand and `competition` profile enforcement; direct REST rejected;
- durable intent, publication and signed-position ledgers with restart-fail-closed behaviour;
- order, fill, native attached-stop, native attached-take-profit and signed-position verification;
- emergency reduce-only handling of the exact observed signed quantity when either attached exit
  is absent (including partial fills, without over-closing into a reversal);
- canonical expected edge >= 3x estimated full friction;
- 1% per-trade risk, 2% concurrent stop risk, 3% daily loss, 24 USDT drawdown stop,
  30 USDT loss budget, and 3x leverage ceiling.
- independently enforced first-entry amendment: ETH only, one live entry, at most 0.25 USDT stop
  risk, 0.35 USDT stop-plus-friction planned loss, 40 USDT notional and 10% position;
- authorised entry window 2026-08-19T20:15Z through 2026-08-23T00:00Z, leaving recovery time
  before the competition closes.
- independently enforced second-entry amendment: exact frozen v3 strategy and approval basis,
  exactly one prior placed entry, BTC, ETH or SOL only, signed-flat target, no increase/reversal, at
  most 4.00 USDT stop risk, 4.35 USDT planned loss, 200 USDT notional, 50% position, and at least
  5.50 USDT projected net at the live first target;
- current venue tick-size parsing plus full BTC/ETH/SOL signed reconciliation and existing-position
  bracket verification in the read-only preparation path.

Compatibility correction completed during this audit: Agent Trade Kit 1.4.2/OKX rejects a SWAP
fee request carrying `--instId`; the adapter now uses the documented SWAP-wide request verified
against the live read-only competition profile. No order was placed.

Remaining blocker before the authorised second live trade:

- frozen v3 has not emitted a current qualifying BTC/ETH/SOL signal; rehearsals at
  2026-08-21T15:37Z correctly produced no DecisionEvent;
- a current frozen-v3 BTC/ETH/SOL setup must pass every closed-bar, OI, account, cost, governor and
  reconciliation gate. The installed one-shot service rehearsal passed at 2026-08-21T22:11Z and
  correctly stopped before private preparation because no public signal existed.

The recorded unattended authorization applies only to the evidence-limited second entry. The
worker persists its one-shot claim before publication, requires every ACTIVE subscriber to
acknowledge before Agent Trade Kit execution, and makes any uncertain state terminal for automatic
retry. All other live writes retain exact decision-specific confirmation.

The original ETH entry reached its attached take-profit on 2026-08-21 at 2454.44. OKX reports
+0.067501361 USDT realized after fees/funding and a signed-flat account. The new exit reconciler
requires matching entry intent, native TP/SL algo, opposite fill, direction/size and closed-position
history before changing the isolated signed ledger; this proof passed and the ledger is now flat.

The approved second-entry hard exit is also implemented in `@plumb/executor`. At or after
2026-08-25T03:30:00Z the existing 15-minute worker will close only a still-open exact BTC/ETH/SOL
DecisionEvent through a persisted deterministic reduce-only Agent Trade Kit intent, then verify its
order, fill, signed-flat position and ledger. It cannot open or reverse a position.

The compliance-only order script remains a fail-closed tombstone. P8 is not repointed, restarted,
or reused as the competition executor.

## Autonomous-path audit — 2026-08-22T07:30Z UTC

The complete repository suite passed: 52 files and 658 tests. The installed timer/unit match the
repository architecture and a live no-order smoke cycle evaluated BTC and SOL, left the durable
one-shot state absent, and left the competition account signed-flat. The subsequent account
preflight passed 8/8 with 409.97 USDT in Trading, no Funding balance, `net_mode`, the registered UID,
and read+trade permissions without withdrawal.

One availability defect was found and fixed. Because systemd runs BTC and SOL as sequential
`ExecStart=` commands, a BTC public-check error or private-preflight rejection previously returned
nonzero and prevented SOL evaluation even though no state had been claimed and no external write
had occurred. Pre-write candidate rejection now alerts, records an explicit `*_no_write` event and
returns success so the other authorised instrument is checked. Failures after the durable claim
remain terminal `uncertain`, nonzero and ineligible for automatic retry. This did not expose funds;
it could only have caused a valid SOL opportunity to be missed.

Agent Trade Kit 1.4.2 remains pinned operationally for this competition path. Version 1.4.4 is
available, but the current binary already executed and reconciled the successful ETH entry/exit and
the global binary is also resolved dynamically by protected P8. A deadline-period global upgrade
would create more regression risk than it removes; upgrade only in an isolated profile/runtime with
the complete fault suite rerun.

At 2026-08-22T08:30:32Z the operator expanded the second-entry candidate universe to include ETH
after the first ETH position had reached TP and strict reconciliation proved the account flat. The
single-additional-entry limit and all damage, timing, publication, protection and no-retry controls
are unchanged. Evaluation order is BTC, ETH, then SOL; the first fully qualifying event wins.

At 2026-08-22T18:21:33Z the operator expanded only the second-entry damage/payoff envelope in
response to a copied +0.90 USDT / +0.29% rank-40 threshold. Stop risk is capped at 3.00 USDT
(approximately 0.73% of current equity), planned loss at 3.25 USDT, notional at 150 USDT, position
at 37%, and projected first-target net must be at least 4.00 USDT. Signal gates, one-shot count,
leverage ceiling, publication-first execution and every fail-closed control are unchanged.

At 2026-08-22T19:35:45Z the final operator payoff amendment superseded only those second-entry
caps: 4.00 USDT stop risk (about 0.98% of current equity), 4.35 USDT planned loss, 200 USDT
notional, 50% position and at least 5.50 USDT projected net. This represents approximately 6 USDT
gross at the frozen 1.5R target while remaining under the original 1% normal risk ceiling.
