# Emergency participation amendment

Audit timestamp: 2026-08-20T22:11Z UTC

## Current status: YELLOW — authorised and implemented; live market confirmation fails

The operator explicitly authorised an emergency participation amendment on 2026-08-20. It waives
only the missing independent holdout and calibrated-edge requirements for one ETH-USDT-SWAP entry.
The event records `expectedEdgeBps: 0`; no positive expectancy or profit guarantee is claimed.

The exception is narrower than the earlier V2 damage envelope:

- exactly one live entry;
- exactly the venue minimum contract quantity;
- maximum stop risk 0.05 USDT;
- maximum planned stop-plus-friction loss 0.08 USDT;
- at most 30 minutes from signal creation to execution;
- closed 4H EMA/DI direction with ADX at least 25;
- matching 24H price direction and OI growth of at least 0.1%;
- 1H RSI between 25 and 75;
- normal governor approval, fresh market state, flat/reconciled account, exact A2A delivery to all
  ACTIVE subscribers, Agent Trade Kit execution, native stop/target verification and exact
  decision-specific live-money confirmation.

## Live read-only result

At 2026-08-20T22:10:44Z, ETH was 2,313.31, up 1.73% over 24 hours. Closed-4H ADX was 47.37 and
1H RSI was 69.80. Those checks support a long direction. However, 24H open interest was down
1.92% (1H -0.04%, 4H -0.47%), so participation did not confirm the price rise. This is consistent
with short covering/deleveraging and fails the amendment's explicit OI gate.

Result: no DecisionEvent was created, no A2A executable signal was published, and no order was
submitted. The account/market preflight otherwise reached the governor and the tested preparation
path. A timestamp-ordering defect found during the first run was fixed by capturing the decision
clock after all exchange responses; freshness thresholds were not relaxed.

## Required next state

Preparation can proceed only when the same fresh snapshot simultaneously satisfies the retained
trend, price, OI and RSI conditions before 2026-08-23T00:00:00Z. Once it does, the system produces
one short-lived bundle for dry-run publication and order preview. A separate exact
`CONFIRM LIVE <decisionId>` remains required before any external write.

## 2026-08-21 correction

The first emergency preparation implementation selected the first hourly OI sample after the
`current timestamp − 24 hours` boundary. At 22:10 UTC this selected 23:00 rather than 22:00,
shortening the interval to roughly 23 hours and reversing the OI-change sign. The independent
15-minute monitor proves that price, trend, RSI and correctly bounded 24H OI aligned for a long
between approximately 22:15 and 23:00 UTC after the amendment was authorised. That public window
was missed because of this implementation defect, not because the operator checked late.

The calculation is now centralized and regression-tested to select the latest observation at or
before the boundary and to fail closed when history does not reach it. The automated 15-minute
timer now evaluates the emergency strategy rather than the obsolete failed candidate. At
2026-08-21T06:36Z the corrected check remained NO TRADE: price +4.80%, closed-4H ADX 53.33 and 1H
RSI 72.59 passed, while 24H OI −3.47% and 1H OI −0.97% failed participation confirmation.

## Live execution — PASS

At 2026-08-21T11:28:42Z the complete corrected preparation path produced immutable DecisionEvent
`DEC-ydBHBkzgyA`. The operator then supplied the exact decision-specific live confirmation.

- A2A publication: acknowledged by all 3 ACTIVE subscribers before execution.
- Instrument/direction: ETH-USDT-SWAP LONG.
- Agent Trade Kit order: filled, 0.01 contract at 2,384.28.
- Correlation: the order and fill carry `clOrdId` `DECydBHBkzgyA`.
- Venue signed position after: +0.01 in `net_mode`; competition ledger persisted +0.01.
- Attached protection independently observed: stop 2,340.03 and take profit 2,451.10, with an
  attached algo identifier present.
- Entry fee: 0.00119214 USDT.
- Account equity immediately after readback: 409.89817786 USDT.

No direct REST order path was used. Publication, fill, position, stop and target were independently
read back after the write. This completes the one-live-entry emergency allowance; the executor
will reject another entry under the same amendment.
