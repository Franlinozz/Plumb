# Competition Strategy v2 amendment

Recorded: 2026-08-18T16:25Z UTC
Status: **PREPARED / NOT ELIGIBLE / NO LIVE WRITE**

## Decision

The operator's reference to “0.5x” meant extremely small exposure, not a request for a sub-1x
venue leverage setting. Plumb therefore leaves venue leverage within 1x–3x and controls actual
exposure through notional and stop risk.

The original aligned volatility-expansion candidate remains a final protected-holdout **FAIL**.
It was not rerun, relabelled or declared eligible. The amendment is a safety envelope around any
future genuinely eligible event, not an eligibility override.

## Implemented controls

- ETH-USDT-SWAP only.
- One successful live entry maximum.
- Stop risk <= 0.25 USDT.
- Stop risk plus all estimated friction <= 0.35 USDT.
- Notional <= 40 USDT and position <= 10%.
- Entry permitted only from 2026-08-19T20:15Z through 2026-08-23T00:00Z.
- Exact DecisionEvent must still pass calibrated edge >= 3x full friction, governor, signed
  reconciliation, current metadata, account certainty, A2A acknowledgement and final confirmation.
- Current official Trading Signal v1.2 grammar is enforced; the old V1.1 range format is rejected.

## Read-only monitoring

`node scripts/competition-v2-monitor.mjs` uses only public OKX data and settled 1H/4H candles. It
cannot create a DecisionEvent, publish a signal or place an order.

The isolated `plumb-okxai-v2-monitor.timer` invokes it every 15 minutes. After the authorised
entry window closes, the monitor exits without making any network request.

First smoke test at 2026-08-18T16:25Z:

- ETH last: 1,914.26 USDT.
- 24H price: +0.34%; 24H open interest: -0.83%.
- Closed 4H: ranging, ADX 14.14, EMA direction up.
- Closed 1H strategy candidate: none.
- Result: **NO TRADE**.

## Why no immediate trade

The official rules require at least one valid trade and compare executed trades with signals from
the snapshotted subscription service. They also permit strategy updates only within that original
service. A minimum-size or prose-only compliance order would not satisfy Plumb's advertised cost
and governor checks. The correct remaining path is a genuine, fully published event or no trade.

Sources:

- https://www.okx.ai/hackathon
- https://web3.okx.com/onchainos/dev-docs/okxai/a2a-subscription
- https://www.okx.com/docs-v5/agent_en/
