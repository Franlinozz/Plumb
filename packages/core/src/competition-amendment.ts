/**
 * Operator-authorised competition amendment — 2026-08-18.
 *
 * This does not make a failed strategy eligible. It only narrows the maximum damage and timing of
 * the first qualifying trade if a genuinely eligible DecisionEvent is later produced. Keeping
 * these values in core lets both the producer and the executor independently enforce them.
 */
export const COMPETITION_V2_AMENDMENT = Object.freeze({
  authorisedAt: Date.parse('2026-08-18T09:37:18Z'),
  earliestEntryAt: Date.parse('2026-08-19T20:15:00Z'),
  latestEntryAt: Date.parse('2026-08-23T00:00:00Z'),
  competitionEndsAt: Date.parse('2026-08-25T04:00:00Z'),
  instrument: 'ETH-USDT-SWAP' as const,
  maxLiveEntries: 1,
  maxStopRiskUsd: 0.25,
  maxPlannedLossUsd: 0.35,
  maxNotionalUsd: 40,
  maxPositionPct: 10,
});

/**
 * Operator-authorised emergency participation exception — 2026-08-20.
 *
 * This is deliberately narrower than V2. It permits one minimum-venue-lot entry without claiming
 * a calibrated expected edge or a passing independent holdout. It does not waive the governor,
 * live market confirmation, publication-before-execution, attached exits, ATK-only transport,
 * reconciliation, or the decision-specific live-money confirmation.
 */
export const EMERGENCY_PARTICIPATION_AMENDMENT = Object.freeze({
  authorisedAt: Date.parse('2026-08-20T22:02:49Z'),
  latestEntryAt: COMPETITION_V2_AMENDMENT.latestEntryAt,
  competitionEndsAt: COMPETITION_V2_AMENDMENT.competitionEndsAt,
  instrument: COMPETITION_V2_AMENDMENT.instrument,
  strategyId: 'emergency_participation',
  strategyVersion: '1.0.0',
  approvalBasis: 'operator-emergency-participation' as const,
  maxLiveEntries: 1,
  exactVenueMinimumLot: true,
  maxStopRiskUsd: 0.05,
  maxPlannedLossUsd: 0.08,
  maxValidityMs: 30 * 60_000,
  minStopDistancePct: 0.01,
  minClosedFourHourAdx: 25,
  minAbsPriceChangePct24h: 0.001,
  minOpenInterestChangePct24h: 0.001,
  minOneHourRsi: 25,
  maxOneHourRsi: 75,
});

/**
 * Operator-authorised evidence-limited second-entry amendment — 2026-08-21.
 *
 * The frozen v3 candidate passed development but has no unused independent holdout. This amendment
 * records that limitation instead of manufacturing calibrated edge. It permits at most one
 * additional BTC, ETH or SOL entry while retaining every publication, reconciliation, protection,
 * Agent Trade Kit and decision-specific confirmation gate.
 */
export const SECOND_ENTRY_AMENDMENT = Object.freeze({
  authorisedAt: Date.parse('2026-08-21T15:24:00Z'),
  unattendedExecutionAuthorisedAt: Date.parse('2026-08-21T21:43:00Z'),
  universeExpandedAt: Date.parse('2026-08-22T08:30:32Z'),
  damageEnvelopeExpandedAt: Date.parse('2026-08-22T18:21:33Z'),
  finalPayoffExpandedAt: Date.parse('2026-08-22T19:35:45Z'),
  latestEntryAt: Date.parse('2026-08-23T16:00:00Z'),
  hardExitAt: Date.parse('2026-08-25T03:30:00Z'),
  competitionEndsAt: COMPETITION_V2_AMENDMENT.competitionEndsAt,
  instruments: Object.freeze(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'] as const),
  strategyId: 'competition_trend_pullback',
  strategyVersion: '3.0.0',
  approvalBasis: 'operator-evidence-limited-v3' as const,
  priorLiveEntryCount: 1,
  maxTotalLiveEntries: 2,
  maxStopRiskUsd: 4,
  maxPlannedLossUsd: 4.35,
  maxNotionalUsd: 200,
  maxPositionPct: 50,
  minProjectedNetTargetUsd: 5.5,
  maxValidityMs: 30 * 60_000,
  minOpenInterestChangePct: 0.001,
  maxEntryToleranceBps: 10,
});

/**
 * Operator-authorised post-cutoff contest contingency — 2026-08-23.
 *
 * This does not claim a measured edge and never races the frozen v3 path. It can use the same
 * single additional-entry allowance only after v3's personal cutoff, on ETH or SOL, under a
 * deterministic closed-bar trend/recovery rule and the unchanged maximum-normal-risk envelope.
 */
export const DEADLINE_CONTINGENCY_AMENDMENT = Object.freeze({
  authorisedAt: Date.parse('2026-08-23T06:51:33Z'),
  unattendedExecutionAuthorisedAt: Date.parse('2026-08-23T06:51:33Z'),
  earliestEntryAt: SECOND_ENTRY_AMENDMENT.latestEntryAt,
  latestEntryAt: Date.parse('2026-08-24T04:00:00Z'),
  hardExitAt: SECOND_ENTRY_AMENDMENT.hardExitAt,
  competitionEndsAt: SECOND_ENTRY_AMENDMENT.competitionEndsAt,
  instruments: Object.freeze(['ETH-USDT-SWAP', 'SOL-USDT-SWAP'] as const),
  strategyId: 'deadline_contingency',
  strategyVersion: '1.0.0',
  approvalBasis: 'operator-deadline-contingency-v1' as const,
  priorLiveEntryCount: SECOND_ENTRY_AMENDMENT.priorLiveEntryCount,
  maxTotalLiveEntries: SECOND_ENTRY_AMENDMENT.maxTotalLiveEntries,
  maxStopRiskUsd: SECOND_ENTRY_AMENDMENT.maxStopRiskUsd,
  maxPlannedLossUsd: SECOND_ENTRY_AMENDMENT.maxPlannedLossUsd,
  maxNotionalUsd: SECOND_ENTRY_AMENDMENT.maxNotionalUsd,
  maxPositionPct: SECOND_ENTRY_AMENDMENT.maxPositionPct,
  minProjectedNetTargetUsd: SECOND_ENTRY_AMENDMENT.minProjectedNetTargetUsd,
  maxValidityMs: SECOND_ENTRY_AMENDMENT.maxValidityMs,
  maxEntryToleranceBps: SECOND_ENTRY_AMENDMENT.maxEntryToleranceBps,
  stopDistancePct: 0.02,
  takeProfitR: 1.5,
  minClosedFourHourAdx: 25,
  minVolumeRatio: 0.8,
  longRsiMin: 45,
  longRsiMax: 68,
  shortRsiMin: 32,
  shortRsiMax: 55,
  minOneHourOiChangePct: -0.01,
  minFourHourOiChangePct: -0.03,
  minTwentyFourHourOiChangePct: -0.05,
  maxOpposingPriceChangePct24h: 0.005,
  maxSpreadBps: 2,
  maxAbsFundingRate: 0.001,
});

/**
 * Operator-authorised final-window contingency V2 — 2026-08-24.
 *
 * V1 remains immutable and closed. V2 reopens only its existing ETH/SOL, one-additional-entry
 * allowance through 00:00 UTC on the final competition day. It changes no signal, OI, cost,
 * publication, execution, reconciliation, stop, target, notional or loss gate.
 */
export const FINAL_WINDOW_CONTINGENCY_AMENDMENT = Object.freeze({
  ...DEADLINE_CONTINGENCY_AMENDMENT,
  authorisedAt: Date.parse('2026-08-24T06:42:00Z'),
  unattendedExecutionAuthorisedAt: Date.parse('2026-08-24T06:42:00Z'),
  earliestEntryAt: Date.parse('2026-08-24T06:42:00Z'),
  latestEntryAt: Date.parse('2026-08-25T00:00:00Z'),
  strategyId: 'final_window_contingency',
  strategyVersion: '2.0.0',
  approvalBasis: 'operator-final-window-contingency-v2' as const,
});
