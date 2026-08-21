# Competition executor

Audit time: 2026-08-21T15:37Z UTC

## Status: YELLOW — implementation ready; strategy approval and live confirmation absent

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
BTC-or-SOL v3 entry under narrower explicit gates.

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
  exactly one prior placed entry, BTC or SOL only, signed-flat target, no increase/reversal, at
  most 1.50 USDT stop risk, 1.75 USDT planned loss, 85 USDT notional, 21% position, and at least
  2.00 USDT projected net at the live first target;
- current venue tick-size parsing plus full BTC/ETH/SOL signed reconciliation and existing-position
  bracket verification in the read-only preparation path.

Compatibility correction completed during this audit: Agent Trade Kit 1.4.2/OKX rejects a SWAP
fee request carrying `--instId`; the adapter now uses the documented SWAP-wide request verified
against the live read-only competition profile. No order was placed.

Remaining blockers before the authorised second live trade:

- frozen v3 has not emitted a current qualifying BTC/SOL signal; rehearsals at
  2026-08-21T15:37Z correctly produced no DecisionEvent;
- a real event needs an end-to-end dry-run publication and order preview;
- the operator must provide the exact decision-specific live-money confirmation immediately
  before execution.

The compliance-only order script remains a fail-closed tombstone. P8 is not repointed, restarted,
or reused as the competition executor.
