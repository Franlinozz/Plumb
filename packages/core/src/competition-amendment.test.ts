import { describe, expect, it } from 'vitest';

import { COMPETITION_V2_AMENDMENT } from './competition-amendment.js';

describe('operator-authorised competition v2 amendment', () => {
  it('pins the one-entry damage envelope and time boundaries against silent drift', () => {
    expect(COMPETITION_V2_AMENDMENT).toEqual({
      authorisedAt: Date.parse('2026-08-18T09:37:18Z'),
      earliestEntryAt: Date.parse('2026-08-19T20:15:00Z'),
      latestEntryAt: Date.parse('2026-08-23T00:00:00Z'),
      competitionEndsAt: Date.parse('2026-08-25T04:00:00Z'),
      instrument: 'ETH-USDT-SWAP',
      maxLiveEntries: 1,
      maxStopRiskUsd: 0.25,
      maxPlannedLossUsd: 0.35,
      maxNotionalUsd: 40,
      maxPositionPct: 10,
    });
    expect(COMPETITION_V2_AMENDMENT.authorisedAt)
      .toBeLessThan(COMPETITION_V2_AMENDMENT.earliestEntryAt);
    expect(COMPETITION_V2_AMENDMENT.earliestEntryAt)
      .toBeLessThan(COMPETITION_V2_AMENDMENT.latestEntryAt);
    expect(COMPETITION_V2_AMENDMENT.latestEntryAt)
      .toBeLessThan(COMPETITION_V2_AMENDMENT.competitionEndsAt);
  });
});
