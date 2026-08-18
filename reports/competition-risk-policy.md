# Competition risk policy

Audit time: 2026-08-18T16:25Z UTC

## Status: YELLOW — first-trade caps implemented; eligible alpha remains absent

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

## Operator-authorised first-trade amendment

The operator authorised a narrower capital-preservation envelope on 2026-08-18. It only reduces
risk; it does not turn the failed protected holdout green and cannot bypass signal, governor,
publication, cost, reconciliation or decision-specific live-confirmation gates.

| Limit | Value |
| --- | ---: |
| Instrument | ETH-USDT-SWAP only |
| Successful live entries | 1 maximum |
| Stop risk | 0.25 USDT maximum |
| Stop + full estimated friction | 0.35 USDT maximum |
| Notional | 40 USDT maximum |
| Position | 10% maximum |
| Earliest entry | 2026-08-19T20:15:00Z |
| Latest entry | 2026-08-23T00:00:00Z |

Leverage remains a venue margin setting between 1x and the locked 3x ceiling. Exposure is bounded
by notional and stop loss; a lower notional does not require a fictional sub-1x leverage setting.
