# Competition executor

Audit time: 2026-08-10T17:27Z UTC

## Status: RED — do not enable competition trading

The existing executor uses the OKX Agent Trade Kit CLI and does not place through direct REST, but
it belongs to the demo/P8 architecture. It is not yet a dedicated
`AgentTradeKitCompetitionExecutor` and does not consume the required canonical immutable
DecisionEvent.

Blocking gaps:

- no dedicated `competition` Trade Kit profile;
- no pre-write verification of the registered account, position mode, positions, pending orders,
  instrument metadata and fees as one competition gate;
- no explicit close-to-signed-zero-before-reversal net-mode state machine;
- no durable competition order intent/ack/fill/reconciliation ledger;
- no hard adapter-level rejection of direct-REST competition writes;
- no proof that the A2A delivery and order reference the same decision id;
- no complete post-write business-code, order, fill, attached-stop and signed-position verification.

P8 must not be repointed, restarted or reused as the competition executor.
