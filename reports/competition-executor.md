# Competition executor

Audit time: 2026-08-10T17:27Z UTC

## Status: YELLOW — implemented and testable, but no live write is authorized

`AgentTradeKitCompetitionExecutor` now consumes the same canonical immutable `DecisionEvent` as
the on-demand A2A publisher. The default command is preview-only. A write additionally requires
the dedicated Agent Trade Kit profile, exact publication acknowledgement for every active
subscriber, and a decision-specific live-money confirmation.

Implemented gates:

- exact account UID, account level, `net_mode`, venue positions and pending orders;
- current metadata, fees, ticker, leverage, max size, equity and available margin;
- signed venue/ledger/Event reconciliation, including wrong-direction failure;
- close/reduce to verified signed zero before reversal;
- Agent Trade Kit runtime brand and `competition` profile enforcement; direct REST rejected;
- durable intent, publication and signed-position ledgers with restart-fail-closed behaviour;
- order, fill, attached-stop and signed-position verification after writes;
- emergency reduce-only handling when a protective stop is absent;
- 1% per-trade risk, 2% concurrent stop risk, 3% daily loss, 24 USDT drawdown stop,
  30 USDT loss budget, and 3x leverage ceiling.

Remaining blockers before the first live trade:

- no strategy configuration has passed the evidence gate, so no genuine approved DecisionEvent
  currently exists;
- the CLI metadata/fee/leverage preflight must complete reliably against the live profile (one
  read-only metadata probe hung and was terminated; no write command ran);
- the first real event needs an end-to-end dry-run publication preview and operator review;
- the operator must provide the exact decision-specific live-money confirmation immediately
  before execution.

The former compliance-only live-order script has been replaced with a fail-closed tombstone. It
cannot choose a direction or invoke an order method. This prevents an unrelated minimum-size trade
from being mistaken for a competition-valid signal-derived trade.

P8 must not be repointed, restarted or reused as the competition executor.
