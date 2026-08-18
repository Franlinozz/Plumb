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
