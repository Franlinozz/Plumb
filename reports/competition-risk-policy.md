# Competition risk policy

Audit time: 2026-08-10T17:27Z UTC

## Status: YELLOW — policy specified, competition implementation incomplete

- Starting capital target: approximately 300–310 USDT.
- Initial risk per trade: 0.75%; normal ceiling: 1.00%, defined as loss at stop.
- Concurrent stop-risk ceiling: 2.00%.
- Soft daily loss: 3.00%.
- Stop initiating trades near 24 USDT competition drawdown.
- Emergency loss budget: approximately 30 USDT.
- Leverage ceiling: 3x.
- Martingale, revenge trading, averaging down, forced trades and widening/removing stops are
  prohibited.
- Every position needs a verified protective stop and deterministic sizing from
  `notional = riskUsd / stopDistancePct`.

These competition values are not deployed and must not mutate P8's locked 400-USDT policy. They
belong only in the isolated competition governor after the canonical DecisionEvent exists.
