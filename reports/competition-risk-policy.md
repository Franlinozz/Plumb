# Competition risk policy

Audit time: 2026-08-21T15:37Z UTC

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

## Operator-authorised evidence-limited second-entry amendment

The operator authorised one additional entry at 2026-08-21T15:24:00Z while explicitly retaining
the evidence limitation: frozen v3 passed development but has no unused independent holdout. This
does not permit discretionarily choosing a direction or chasing price.

| Limit | Value |
| --- | ---: |
| Instrument | BTC-USDT-SWAP or SOL-USDT-SWAP; first qualifying one only |
| Strategy | `competition_trend_pullback@3.0.0` only |
| Prior successful entries | exactly 1 |
| Total successful entries | 2 maximum |
| Stop risk | 4.00 USDT maximum |
| Stop + full estimated friction | 4.35 USDT maximum |
| Notional | 200 USDT maximum |
| Position | 50% maximum |
| Projected first-target net | 5.50 USDT minimum |
| Event validity | 30 minutes maximum |
| Latest entry | 2026-08-23T16:00:00Z |
| Hard competition exit | 2026-08-25T03:30:00Z |

The existing ETH position may not be increased, reversed or have its protection weakened. The
second instrument must be signed-flat at both venue and ledger. Combined stop risk remains subject
to the original 2% account cap. On 2026-08-21 the operator separately authorised one-shot
unattended execution for this exact amendment. That exception cannot apply to another strategy,
instrument, additional entry or live action; any uncertain state blocks automatic retry.
