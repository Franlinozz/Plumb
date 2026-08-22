# Competition second-entry gate — BTC / ETH / SOL

Recorded: 2026-08-21T15:37Z UTC
Status: **UNATTENDED AUTO-ENTRY ARMED / NOT TRIGGERED / NO SECOND ORDER**

## Decision now

**NO ENTRY.** Both instruments are in strong closed-4H uptrends, but neither emits the frozen
`competition_trend_pullback@3.0.0` signal and neither has confirming short-horizon participation.
Buying either instrument at market now would chase a news- and liquidation-driven expansion.

| Input | BTC-USDT-SWAP | SOL-USDT-SWAP |
| --- | ---: | ---: |
| Last | 77,641.1 | 91.72 |
| 24h change | +7.49% | +5.36% |
| Closed-4H RSI | 94.05 | 88.25 |
| Closed-4H ADX | 59.90 | 58.23 |
| Closed-1H RSI | 68.46 | 66.46 |
| Closed-1H MACD histogram | -14.42, falling | -0.0455, still negative |
| 1h OI change | -0.60% | -0.33% |
| 4h OI change | -1.04% | +0.34% |
| 24h OI change | +0.67% | -4.95% |
| Funding | +0.0100% | +0.0100% |
| Frozen v3 signal | none | none |

BTC is the better candidate because 24h OI remains positive and its spread is materially tighter.
Its immediate 1h/4h OI contraction still rejects a long. SOL's negative 24h OI makes its rally
consistent with deleveraging/short covering and is the stronger veto.

## Frozen trigger — do not tune from competition-period outcomes

The existing v3 candidate was declared before replay and passed development but has no unused
independent holdout. Its exact long trigger remains:

1. fully closed 4H EMA20 above EMA50, ADX at least 25, and +DI above -DI;
2. previous closed 1H close at/below EMA20;
3. next closed 1H close back above EMA20 and above the prior 1H high;
4. 1H RSI 50–68;
5. MACD histogram positive and improving;
6. volume at least 80% of the preceding 20-bar mean;
7. price direction confirmed by OI growth greater than 0.1% over 1h, 4h and 24h;
8. fresh account/market state, signed reconciliation and normal governor approval.

At this snapshot BTC fails conditions 2, 3, 4, 5, 6 and short-horizon OI. SOL fails conditions 2,
5, 6, 1h OI and 24h OI. `scripts/competition-v3-monitor.mjs <instrument>` now reports every gate
without publishing or trading.

## Practical watch zones — observations, not orders

- **BTC pullback watch:** the dynamic 1H EMA20 is approximately 75,588. A qualifying sequence is a
  closed-bar pullback to that moving area followed by the frozen reclaim trigger. Do not enter from
  an intrabar touch. The recent 79,603 high is resistance, not a reason to chase.
- **SOL pullback watch:** the dynamic 1H EMA20 is approximately 89.84. Require the same closed-bar
  reclaim and full OI recovery. The recent 93.41 high is resistance.
- A breakout is not a substitute. A breakout above the 24h high is considered only if a 4H close
  holds above it and a later 1H retest independently satisfies the frozen trigger.

## Authorised damage envelope for one additional entry

The operator explicitly authorised this evidence-limited amendment at 2026-08-21T15:24:00Z. This
authorises the bounded policy, not an unconditional market order: a newly generated immutable
DecisionEvent and complete A2A acknowledgement remain mandatory. On 2026-08-21 the operator added
a one-shot unattended authorization for this exact second-entry amendment, replacing only its
per-decision confirmation step.

- Instruments: BTC-USDT-SWAP, ETH-USDT-SWAP or SOL-USDT-SWAP; first qualifying instrument wins.
- Strategy: only `competition_trend_pullback@3.0.0`; no discretionary direction.
- Additional successful entries: one maximum; never open more than one of BTC, ETH or SOL.
- Every candidate instrument must be signed-flat; no same-instrument add, reversal or stop change.
- Actual stop risk: at most 1.50 USDT.
- Stop plus all estimated friction: at most 1.75 USDT.
- Notional: at most 85 USDT and at most 21% of current equity.
- Leverage: 1x–3x venue setting; exposure is controlled by notional and stop risk.
- Full estimated friction includes 5 bp taker entry, 5 bp taker exit, live spread, conservative
  slippage and expected funding.
- First attached target must project at least 2.00 USDT **net** after full friction; target and stop
  must be verified natively after entry.
- Maximum event age at execution: 30 minutes.
- Latest possible entry: 2026-08-23T16:00:00Z; hard competition exit no later than
  2026-08-25T03:30:00Z.
- Any unresolved halt, stale data, account uncertainty, missing metadata/protection, pending order,
  ledger mismatch or duplicate decision fails closed.

With approximately 1.50 USDT structural stop risk, the frozen 1.5R first target is about 2.25 USDT
gross. An entry is rejected unless the live cost calculation still leaves at least 2.00 USDT net.
This is enough to clear the copied current rank-40 threshold (+0.12% / +0.48 USDT) with a buffer,
but it cannot guarantee the cutoff will remain there or that the trade will win.

## Marketplace and competition attribution

The immutable DecisionEvent remains the sole source for both paths. Before any order:

1. format and validate one current OKX perpetual signal, at most 200 characters;
2. deliver that exact decision to every ACTIVE subscriber and require acknowledgements;
3. execute only through the dedicated live Agent Trade Kit profile with the same decision ID;
4. read back business success, order, fill, signed position, stop and target;
5. reconcile the signed venue position with the durable ledger.

No signal may be rewritten after publication, and no trade may be sent merely to change leaderboard
visibility.

## Implemented verification

- `SECOND_ENTRY_AMENDMENT` is shared by producer and executor; any other strategy, instrument,
  timing, entry count or approval basis fails closed.
- `scripts/prepare-second-entry.mjs` is read-only and cannot publish or trade. It verifies the
  dedicated UID/profile, `net_mode`, fees, leverage, balance, pending orders, current metadata,
  signed venue/ledger state across BTC/ETH/SOL, the existing ETH order attribution and its native
  attached stop/take-profit before it can create a private preparation bundle.
- Venue tick size is read from current instrument metadata so protective-price reconciliation
  accepts only legitimate exchange rounding.
- The executor independently rechecks one prior entry, a flat BTC/ETH/SOL target, entry freshness,
  account state, signed reconciliation, costs, live projected target, damage caps and full A2A
  delivery before any Agent Trade Kit write.
- The unattended worker durably claims the one-shot allowance before publication. A crash or
  uncertain publication/execution state is terminal for automation and sends Discord; it never
  retries an order or manufactures a replacement DecisionEvent.
- If a surviving second entry reaches 2026-08-25T03:30:00Z, the same timer invokes the authorised
  hard time-stop. Only the exact fully delivered DecisionEvent can be closed; the executor persists
  a distinct exit intent before an Agent Trade Kit reduce-only market write, then requires the
  exact order, fill, signed-flat venue and ledger acknowledgement. An uncertain intent is never
  blindly resubmitted.
- At 2026-08-21T15:37Z both BTC and SOL rehearsals stopped at `frozen v3 strategy emitted no
  signal`. No bundle, signal or order was created. Existing ETH remained signed +0.01 and its
  venue stop 2340.03 / target 2451.10 were verified against the durable intent.
- A Discord notifier now wraps the public BTC/ETH/SOL monitor every 15 minutes. It sends at most one
  alert per instrument, direction and closed 1H bar only when the frozen signal and all public OI
  participation gates pass. The webhook is stored outside the repository with mode 0600; the
  notifier has no executor, A2A, account or order path. A delivered alert is not trade authority.
- Armed-service rehearsal at 2026-08-21T22:11Z completed successfully for BTC and SOL. Both exited
  before private preparation because the frozen setup was absent. The one-shot state file remains
  absent, proving no allowance was claimed and no publication/order path ran.
- The first ETH position subsequently hit its native TP: entry 2384.28, exit 2454.44 at
  2026-08-21T21:11:46.319Z, and OKX closed-position history reports +0.067501361 USDT realized
  after fees/funding. Agent Trade Kit verified the OCO, exit fill and signed-flat venue; the
  isolated competition ledger was reconciled to zero. The worker now performs this strict
  reconciliation before evaluating BTC/ETH/SOL, so a venue-native exit cannot leave a stale local
  position or silently unblock on weak evidence.

### Universe amendment — 2026-08-22T08:30:32Z UTC

After the first ETH entry reached its native target and strict venue/ledger reconciliation proved
the account flat, the operator explicitly added ETH-USDT-SWAP to the unattended second-entry
candidate universe. This changes only the universe: the worker still permits one additional entry
total, uses the same frozen v3 strategy, publication-first sequence, one-shot claim and damage/time
caps. BTC is checked first, then ETH, then SOL; the first fully qualifying event consumes the single
allowance. Prior ETH profitability is not treated as evidence that the next ETH trade will win.

## Evidence limitation

The v3 development run recorded 53 OOS trades, +141.42 USDT and PF 1.90. Instrument-level results
were BTC +15.89 / PF 1.248 and SOL +37.61 / PF 1.955. Only 12 of 47 windows were profitable and the
result without its best three trades was +8.27. The sole protected holdout had already been consumed
by a different candidate, so v3 is promising but not independently validated. Any live use must say
that plainly; it must never be represented as a passed holdout or a near-certain profit.

Sources:

- https://www.okx.ai/hackathon
- https://web3.okx.com/onchainos/dev-docs/okxai/a2a-subscription
- https://www.bls.gov/schedule/2026/08_sched_list.htm
- https://www.federalreserve.gov/newsevents/2026-august.htm
