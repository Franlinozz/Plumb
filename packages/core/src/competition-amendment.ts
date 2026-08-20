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
