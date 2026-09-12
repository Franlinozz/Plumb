# Competition candidate — protected holdout protocol

Status: **CONSUMED — FINAL FAIL; MUST NOT REOPEN**

The single permitted evaluation ran at 2026-08-18T09:04:40Z. It produced 14 trades, −15.45 USDT
net, profit factor 0.49, and −22.46 USDT after removing its best trade. The candidate failed the
net-PnL, profit-factor and outlier-independence criteria. `competition-candidate-holdout.md` is the
authoritative result. No relaxation, rerun or replacement candidate is permitted under this frozen
protocol.

The protected 90-day holdout may be read exactly once, for `aligned-default` only, after the
development artifact says both `defaultEligible: true` and `holdoutPermitted: true`. The durable
audit log must be empty before access. A configured operator token and a separately supplied
matching token are mandatory. Failed authentication does not open the database or append an audit
record.

## Frozen evaluation

- Strategy: `vol_expansion@1.1.0`
- Configuration hash: `7ceee41a072da808af0e32a05d7b0808e6bc348a7b31107b3b21cabc05318563`
- Instruments: BTC-USDT-SWAP, ETH-USDT-SWAP, SOL-USDT-SWAP
- Window: the single contiguous protected interval recorded in the development artifact
- Costs, governor and starting capital: unchanged locked backtest defaults
- No parameter search, instrument removal, neighbour comparison or second look is permitted

The holdout validates the frozen underlying strategy across its declared universe. The first-live
policy is narrower and was frozen from development before holdout access: only ETH-USDT-SWAP may
produce the first DecisionEvent, and it additionally requires a fully closed 4H ADX ≥25 with
EMA20/EMA50 aligned, plus same-direction 24-hour price/OI confirmation. In development that exact
ETH subset had 14 trades, +45.52 USDT net, PF 2.60, and +25.53 USDT after removing its best trade.
BTC and SOL exact subsets were negative and are ineligible for the first trade.

## PASS requires every condition

1. At least 12 closed trades. This floor was chosen before access; the development cadence implies
   roughly 16 trades in 90 days, while a smaller result is too weak to promote.
2. Net PnL greater than 0 USDT and profit factor greater than 1.00 after modeled fees, slippage and
   funding.
3. Maximum drawdown no greater than 20% and minimum equity strictly above the locked 335 USDT kill
   floor.
4. The result remains positive after removing its single best trade.
5. No kill-switch or daily-loss trigger.
6. Every trade opens and closes inside the protected interval, and no trade exceeds the frozen
   maximum holding period.

Any failure leaves the competition strategy gate RED. The holdout is not reopened, the criteria
are not relaxed, and another candidate is not substituted during this competition.
