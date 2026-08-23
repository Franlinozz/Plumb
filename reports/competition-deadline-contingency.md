# Competition deadline contingency v1

Generated 2026-08-23 UTC. This is an audit record, not a profit claim.

## Status: RED / PAUSED — implemented, tested, not installed or armed

The operator supplied `AUTHORIZE DEADLINE CONTINGENCY V1` after receiving the proposed bounds.
The path was implemented as a distinct post-v3-cutoff strategy and measured once on development
data before installation. That frozen measurement produced material adverse evidence, so the live
timer was not installed and no signal, publication or order was created.

The existing v3 timer remains active and retains exclusive authority through
2026-08-23T16:00:00Z.

## Frozen operational scope

- Entry window: 2026-08-23T16:00:00Z through 2026-08-24T04:00:00Z.
- Universe: ETH-USDT-SWAP and SOL-USDT-SWAP only; BTC excluded.
- Shared durable state claim: `/var/lib/plumb-okxai/second-entry-auto.json`. A v3 claim and a
  contingency claim cannot coexist.
- Exactly one additional competition entry in total, including any v3 entry.
- Maximum stop risk 4.00 USDT; maximum planned loss 4.35 USDT; maximum notional 200 USDT;
  maximum position 50%; minimum projected net target 5.50 USDT.
- Fixed 2% stop and 1.5R target. Hard exit remains 2026-08-25T03:30:00Z.
- Expected edge is recorded honestly as zero under approval basis
  `operator-deadline-contingency-v1`.
- A2A publication must fully acknowledge before Agent Trade Kit execution. Native TP/SL,
  idempotency, signed reconciliation, account identity, net mode, cost and governor checks remain.

## Deterministic signal rule

The rule uses fully closed 1H bars and UTC-aligned 4H bars reconstructed from them. It requires:

1. 4H EMA20/EMA50 and directional movement agreement, ADX at least 25.
2. A 1H close on the trend side of EMA20 and beyond the prior close.
3. RSI 45–68 long or 32–55 short.
4. MACD histogram improving in the trade direction; it need not have crossed zero.
5. Volume at least 80% of the preceding 20-bar mean.
6. No severe OI unwind, no 24H price move more than 0.5% against the proposed direction,
   spread at most 2 bps and absolute funding at most 10 bps.

These rules were frozen before the audit below and were not changed after seeing it.

## Development-only audit

Source artifact: `reports/competition-deadline-contingency-development.json`.

| Measure | Result |
| --- | ---: |
| OOS trades | 722 |
| Signals emitted | 734 |
| Net PnL | -244.77 USDT |
| Profit factor | 0.846 |
| Win rate | 42.94% |
| Profitable windows | 19 / 47 |
| ETH | 308 trades, -117.42 USDT, PF 0.821 |
| SOL | 414 trades, -127.35 USDT, PF 0.863 |

Protected holdout read: **no**. Competition-period data used: **no**. The live-only OI/spread
vetoes cannot be reproduced over the development history and therefore do not repair or validate
this result.

## Verification and deployment decision

- TypeScript compilation: PASS.
- Focused contingency/publication/executor/time-stop tests: 52/52 PASS.
- Full repository suite: 57 files / 678 tests PASS.
- Public monitor smoke test: PASS; ETH and SOL both red at 2026-08-23T07:12Z.
- A latent A2A gate defect was corrected: explicitly authorised zero-edge v3 and contingency
  events now reach the formatter, while ordinary uncalibrated events still fail the cost gate.
- Systemd contingency service/timer installed: **NO**.
- Live contingency signal published: **NO**.
- Live contingency order placed: **NO**.

The negative audit was not known when the operator first authorised the contingency. Installation
therefore requires a fresh written decision explicitly accepting this measured negative expectancy;
deadline pressure alone does not convert it into evidence.
