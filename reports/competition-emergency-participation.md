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
