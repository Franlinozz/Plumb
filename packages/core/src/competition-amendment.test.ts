import { describe, expect, it } from 'vitest';

import {
  COMPETITION_V2_AMENDMENT,
  DEADLINE_CONTINGENCY_AMENDMENT,
  SECOND_ENTRY_AMENDMENT,
} from './competition-amendment.js';

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

describe('operator-authorised evidence-limited second-entry amendment', () => {
  it('pins a narrower one-additional-entry envelope without claiming holdout evidence', () => {
    expect(SECOND_ENTRY_AMENDMENT).toMatchObject({
      authorisedAt: Date.parse('2026-08-21T15:24:00Z'),
      unattendedExecutionAuthorisedAt: Date.parse('2026-08-21T21:43:00Z'),
      universeExpandedAt: Date.parse('2026-08-22T08:30:32Z'),
      damageEnvelopeExpandedAt: Date.parse('2026-08-22T18:21:33Z'),
      finalPayoffExpandedAt: Date.parse('2026-08-22T19:35:45Z'),
      latestEntryAt: Date.parse('2026-08-23T16:00:00Z'),
      hardExitAt: Date.parse('2026-08-25T03:30:00Z'),
      competitionEndsAt: Date.parse('2026-08-25T04:00:00Z'),
      instruments: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'],
      strategyId: 'competition_trend_pullback',
      strategyVersion: '3.0.0',
      approvalBasis: 'operator-evidence-limited-v3',
      priorLiveEntryCount: 1,
      maxTotalLiveEntries: 2,
      maxStopRiskUsd: 4,
      maxPlannedLossUsd: 4.35,
      maxNotionalUsd: 200,
      maxPositionPct: 50,
      minProjectedNetTargetUsd: 5.5,
      maxValidityMs: 1_800_000,
      minOpenInterestChangePct: 0.001,
      maxEntryToleranceBps: 10,
    });
    expect(SECOND_ENTRY_AMENDMENT.latestEntryAt).toBeLessThan(SECOND_ENTRY_AMENDMENT.hardExitAt);
    expect(SECOND_ENTRY_AMENDMENT.hardExitAt).toBeLessThan(SECOND_ENTRY_AMENDMENT.competitionEndsAt);
  });
});

describe('operator-authorised deadline contingency', () => {
  it('starts only when v3 closes and reuses, rather than expands, the one-entry risk envelope', () => {
    expect(DEADLINE_CONTINGENCY_AMENDMENT).toMatchObject({
      authorisedAt: Date.parse('2026-08-23T06:51:33Z'),
      earliestEntryAt: SECOND_ENTRY_AMENDMENT.latestEntryAt,
      latestEntryAt: Date.parse('2026-08-24T04:00:00Z'),
      hardExitAt: SECOND_ENTRY_AMENDMENT.hardExitAt,
      instruments: ['ETH-USDT-SWAP', 'SOL-USDT-SWAP'],
      strategyId: 'deadline_contingency',
      strategyVersion: '1.0.0',
      approvalBasis: 'operator-deadline-contingency-v1',
      priorLiveEntryCount: 1,
      maxTotalLiveEntries: 2,
      maxStopRiskUsd: 4,
      maxPlannedLossUsd: 4.35,
      maxNotionalUsd: 200,
      maxPositionPct: 50,
      minProjectedNetTargetUsd: 5.5,
    });
    expect(DEADLINE_CONTINGENCY_AMENDMENT.earliestEntryAt)
      .toBe(SECOND_ENTRY_AMENDMENT.latestEntryAt);
    expect(DEADLINE_CONTINGENCY_AMENDMENT.latestEntryAt)
      .toBeLessThan(DEADLINE_CONTINGENCY_AMENDMENT.hardExitAt);
  });
});
