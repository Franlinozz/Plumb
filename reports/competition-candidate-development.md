# Competition candidate — development robustness

Generated 2026-08-17T18:44:17.504Z · protected holdout subsequently opened exactly once and **FAILED**

Decision candidate: `aligned-default` · development gate: **PASS** · stability: **PASS** · final protected holdout: **FAIL**

| Variant | Eligible | Trades | PF | Net USDT | P(ruin) | Config hash |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| aligned-default | PASS | 121 | 1.999 | 215.50 | 0.12% | `7ceee41a072da808…` |
| compression-0.20 | PASS | 96 | 2.403 | 213.78 | 0.02% | `083acf1ce4b04ef9…` |
| compression-0.30 | PASS | 147 | 1.560 | 160.31 | 1.41% | `e00eef004b083f62…` |
| range-16 | PASS | 140 | 1.562 | 166.17 | 1.70% | `c365f5ff79c2f09c…` |
| range-24 | PASS | 115 | 2.084 | 197.44 | 0.04% | `5ca1c5e2872e8a06…` |
| break-0.40 | PASS | 144 | 1.504 | 150.82 | 2.10% | `e1457bd4f2f72d24…` |
| break-0.60 | PASS | 112 | 2.094 | 212.99 | 0.09% | `8d74b8bf6146ac20…` |

## Default diagnostics

- Profitable windows: 27/47 (57.4%)
- First half net: 168.06 USDT
- Second half net: 47.43 USDT
- Net without best three trades: 149.90 USDT
- BTC-USDT-SWAP: 42 trades, 32.39 USDT, PF 1.433
- ETH-USDT-SWAP: 39 trades, 108.46 USDT, PF 2.611
- SOL-USDT-SWAP: 40 trades, 74.65 USDT, PF 2.015

## Gross-edge calibration (5th percentile circular-block bootstrap)

| Instrument | Samples | Gross mean | 50% haircut edge | Analytical 95% lower |
| --- | ---: | ---: | ---: | ---: |
| BTC-USDT-SWAP | 11 | 73.33 bps | 36.67 bps | -157.83 bps |
| ETH-USDT-SWAP | 14 | 220.64 bps | 110.32 bps | -59.21 bps |
| SOL-USDT-SWAP | 19 | -7.70 bps | 0.00 bps | -209.59 bps |

Closed-4H-confirmed subset: 44 trades, 38.52 USDT net. Only fully closed 4H bars available before entry are used.

The default is frozen before this run. Neighbours may veto instability; they cannot replace it.
