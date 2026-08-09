import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { assessDrawdown, updatePeak } from './drawdown.js';
import { LOCKED, assertLockedParameters } from './params.js';
import {
  GovernorStore,
  HALT_FLAGS,
  anyHaltSet,
  initialState,
  rollDailyIfNeeded,
  withHalt,
  type GovernorState,
} from './state.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');
const tempDirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-risk-'));
  tempDirs.push(dir);
  return join(dir, 'risk.db');
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('the second tripwire', () => {
  it('accepts the constitution as written', () => {
    expect(() => assertLockedParameters()).not.toThrow();
  });

  it('reads the locked values from core rather than redefining them', () => {
    expect(LOCKED.CAPITAL_USDT).toBe(400);
    expect(LOCKED.KILL_SWITCH_EQUITY_USDT).toBe(335);
    expect(LOCKED.PER_TRADE_RISK_USDT).toBe(4);
    expect(LOCKED.LEVERAGE_CEILING).toBe(3);
    expect(LOCKED.MAX_CONCURRENT_POSITIONS).toBe(2);
    expect(LOCKED.MAX_TOTAL_NOTIONAL_USDT).toBe(800);
    expect(LOCKED.CAPITAL_USDT - LOCKED.MAX_LOSS_USDT).toBe(LOCKED.KILL_SWITCH_EQUITY_USDT);
  });
});

describe('persisted state', () => {
  it('seeds a fresh store from the locked capital', () => {
    const store = new GovernorStore();
    const state = store.load(NOW);
    expect(state.equity).toBe(400);
    expect(state.peakEquity).toBe(400);
    expect(state.startingEquity).toBe(400);
    expect(anyHaltSet(state)).toBeUndefined();
    store.close();
  });

  it('A KILLED SYSTEM STAYS KILLED ACROSS A RESTART', () => {
    const path = tempDb();

    const first = new GovernorStore(path);
    const killed = withHalt(first.load(NOW), 'killSwitch', 'equity 330 <= 335', NOW);
    first.save(killed, NOW);
    first.close(); // simulated process death

    const second = new GovernorStore(path);
    const restored = second.load(NOW + 86_400_000);
    expect(restored.haltFlags.killSwitch).toBe(true);
    expect(restored.haltReason).toBe('equity 330 <= 335');
    expect(restored.haltedAt).toBe(NOW);
    expect(anyHaltSet(restored)).toBe('killSwitch');
    second.close();
  });

  it('restores every counter, not just the flags', () => {
    const path = tempDb();
    const first = new GovernorStore(path);
    const state: GovernorState = {
      ...first.load(NOW),
      equity: 372.5,
      peakEquity: 411,
      realisedPnlToday: -12.25,
      consecutiveLosses: 3,
      totalNotional: 240,
    };
    first.save(state, NOW);
    first.close();

    const second = new GovernorStore(path);
    const restored = second.load(NOW);
    expect(restored.equity).toBe(372.5);
    expect(restored.peakEquity).toBe(411);
    expect(restored.realisedPnlToday).toBe(-12.25);
    expect(restored.consecutiveLosses).toBe(3);
    expect(restored.totalNotional).toBe(240);
    second.close();
  });

  it('records an audit trail', () => {
    const store = new GovernorStore();
    store.appendAudit({ ts: NOW, kind: 'halt', reason: 'kill switch', actor: 'system', payload: { equity: 330 } });
    store.appendAudit({ ts: NOW + 1, kind: 'rearm', reason: 'reviewed', actor: 'francis', payload: undefined });
    const audit = store.audit();
    expect(audit).toHaveLength(2);
    expect(audit[0]?.kind).toBe('rearm'); // newest first
    expect(audit[1]?.payload).toEqual({ equity: 330 });
    store.close();
  });
});

describe('the UTC daily roll', () => {
  it('clears the daily counter and the daily halt at the UTC day boundary', () => {
    const halted = withHalt(
      { ...initialState(NOW), realisedPnlToday: -20 },
      'dailyLimit',
      'daily limit',
      NOW,
    );
    expect(halted.dailyResetAtUtc).toBe('2026-08-09');

    const sameDay = rollDailyIfNeeded(halted, Date.parse('2026-08-09T23:59:59Z'));
    expect(sameDay.realisedPnlToday).toBe(-20);
    expect(sameDay.haltFlags.dailyLimit).toBe(true);

    const nextDay = rollDailyIfNeeded(halted, Date.parse('2026-08-10T00:00:00Z'));
    expect(nextDay.realisedPnlToday).toBe(0);
    expect(nextDay.dailyResetAtUtc).toBe('2026-08-10');
    expect(nextDay.haltFlags.dailyLimit).toBe(false);
    expect(nextDay.haltReason).toBeUndefined();
  });

  it('rolls on the UTC boundary, NOT the UTC+8 competition boundary', () => {
    // 2026-08-10 00:00 UTC+8 is 2026-08-09 16:00 UTC — still the same UTC accounting day.
    // Confusing the two would reset the daily loss limit eight hours early, every day.
    const halted = { ...initialState(NOW), realisedPnlToday: -20 };
    const atUtc8Midnight = rollDailyIfNeeded(halted, Date.parse('2026-08-09T16:00:00Z'));
    expect(atUtc8Midnight.realisedPnlToday).toBe(-20);
    expect(atUtc8Midnight.dailyResetAtUtc).toBe('2026-08-09');

    const atUtcMidnight = rollDailyIfNeeded(halted, Date.parse('2026-08-10T00:00:00Z'));
    expect(atUtcMidnight.realisedPnlToday).toBe(0);
  });

  it('a new UTC day does NOT clear the kill switch', () => {
    const killed = withHalt(initialState(NOW), 'killSwitch', 'blown', NOW);
    const nextDay = rollDailyIfNeeded(killed, Date.parse('2026-08-10T00:00:00Z'));
    expect(nextDay.haltFlags.killSwitch).toBe(true);
    expect(anyHaltSet(nextDay)).toBe('killSwitch');
  });

  it('a new UTC day does NOT clear a manual halt', () => {
    const paused = withHalt(initialState(NOW), 'manual', 'operator', NOW);
    expect(rollDailyIfNeeded(paused, Date.parse('2026-08-10T00:00:00Z')).haltFlags.manual).toBe(true);
  });
});

describe('the drawdown ladder', () => {
  const at = (equity: number): GovernorState => ({
    ...initialState(NOW),
    equity,
    peakEquity: 400,
    startingEquity: 400,
  });

  it('steps at each threshold', () => {
    expect(assessDrawdown(at(400)).rung).toBe('clear');
    expect(assessDrawdown(at(393)).rung).toBe('clear'); // -1.75%
    expect(assessDrawdown(at(392)).rung).toBe('watch'); // -2%
    expect(assessDrawdown(at(380)).rung).toBe('reduced_risk'); // -5%
    expect(assessDrawdown(at(368)).rung).toBe('reduced_concurrency'); // -8%
    expect(assessDrawdown(at(352)).rung).toBe('no_new_positions'); // -12%
    expect(assessDrawdown(at(335)).rung).toBe('kill');
    expect(assessDrawdown(at(300)).rung).toBe('kill');
  });

  it('halves risk at -5% and caps concurrency at -8%', () => {
    expect(assessDrawdown(at(392)).riskBudgetUsdt).toBe(4);
    expect(assessDrawdown(at(380)).riskBudgetUsdt).toBe(2);
    expect(assessDrawdown(at(380)).maxConcurrent).toBe(2);
    expect(assessDrawdown(at(368)).maxConcurrent).toBe(1);
    expect(assessDrawdown(at(352)).allowsNewPositions).toBe(false);
    expect(assessDrawdown(at(335)).allowsNewPositions).toBe(false);
  });

  it('every rung carries a reason', () => {
    for (const equity of [400, 392, 380, 368, 352, 330]) {
      expect(assessDrawdown(at(equity)).reason.length).toBeGreaterThan(10);
    }
  });

  it('unwinds ONLY on realised gains — the peak never moves on unrealised profit', () => {
    let state = at(380);
    expect(assessDrawdown(state).rung).toBe('reduced_risk');

    // Realised recovery: equity rises, ladder unwinds.
    state = updatePeak(state, 396);
    expect(assessDrawdown(state).rung).toBe('clear');
    expect(state.peakEquity).toBe(400); // below the old peak, so the peak is unchanged

    // A new high raises the peak.
    state = updatePeak(state, 420);
    expect(state.peakEquity).toBe(420);
    // ...and the ladder now measures against the NEW peak, so the same equity is a drawdown.
    expect(assessDrawdown(updatePeak(state, 396)).rung).toBe('reduced_risk');
  });

  it('never reports a negative drawdown', () => {
    expect(assessDrawdown(updatePeak(at(400), 500)).drawdownPct).toBe(0);
  });
});

describe('halt flags', () => {
  it('names all five', () => {
    expect([...HALT_FLAGS].sort()).toEqual([
      'dailyLimit',
      'dataStale',
      'killSwitch',
      'manual',
      'reconcileMismatch',
    ]);
  });

  it('anyHaltSet finds the first set flag, in declaration order', () => {
    expect(anyHaltSet(initialState(NOW))).toBeUndefined();
    expect(anyHaltSet(withHalt(initialState(NOW), 'dataStale', 'r', NOW))).toBe('dataStale');
    const both = withHalt(withHalt(initialState(NOW), 'dataStale', 'r', NOW), 'killSwitch', 'r', NOW);
    expect(anyHaltSet(both)).toBe('killSwitch');
  });
});
