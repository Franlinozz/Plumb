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
