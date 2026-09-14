# Post-competition Stage 2 development result v1

Generated 2026-09-14T12:48:35.968Z. Scope: **development only** through 2026-08-09T23:59:59.000Z. Validation data was **not read**.

| Candidate | Status | Trades | PF | Net USDT | Failed checks |
| --- | --- | ---: | ---: | ---: | --- |
| H1 trend-aligned-volatility-expansion | PASS | 96 | 1.465 | 75.01 | none |
| H2 open-interest-backed-continuation | BLOCKED_IMPLEMENTATION | — | — | — | historical open interest is not yet persisted or injected by the backtest engine |
| H3 funding-crowding-fade | FAIL | 38 | 0.654 | -30.42 | P(ruin), profit factor (OOS), outlier independence |

A PASS permits forward shadow evaluation only. It does not authorize live execution.
