# Competition executor

Audit time: 2026-08-10T17:27Z UTC

## Status: RED — do not enable competition trading

The existing executor uses the OKX Agent Trade Kit CLI and does not place through direct REST, but
it belongs to the demo/P8 architecture. A canonical immutable `DecisionEvent` and a fail-closed
delivery formatter now exist, but a dedicated `AgentTradeKitCompetitionExecutor` does not yet
consume them.

Blocking gaps:

- dedicated `competition` Trade Kit profile exists and is verified, while `default_profile=demo`
  remains deliberately unchanged;
- no pre-write verification of the registered account, position mode, positions, pending orders,
  instrument metadata and fees as one competition gate;
- no explicit close-to-signed-zero-before-reversal net-mode state machine;
- no durable competition order intent/ack/fill/reconciliation ledger;
- no hard adapter-level rejection of direct-REST competition writes;
- no proof that the A2A delivery and order reference the same decision id;
- no complete post-write business-code, order, fill, attached-stop and signed-position verification.

The former compliance-only live-order script has been replaced with a fail-closed tombstone. It
cannot choose a direction or invoke an order method. This prevents an unrelated minimum-size trade
from being mistaken for a competition-valid signal-derived trade.

P8 must not be repointed, restarted or reused as the competition executor.
