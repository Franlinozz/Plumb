import type { Signal } from '@plumb/core';
import { describe, expect, it } from 'vitest';

import { evaluate, type RiskSnapshot, type Verdict, type VetoCode } from './governor.js';
import { DEFAULT_RISK_CONFIG, LOCKED } from './params.js';
import { initialState, type GovernorState, type OpenPosition } from './state.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');

export function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'SIG-abcdefghij',
    ts: NOW,
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    intent: 'open',
    entry: { type: 'market', price: 65_000 },
    stop: { price: 64_350, distancePct: 0.01, basis: 'atr' },
    takeProfit: [{ price: 65_975, rMultiple: 1.5 }],
    timeframe: '1H',
    strategyId: 'trend_ema',
    regime: 'trending_up',
    inputs: { adx: 31 },
    invalidation: { maxHoldBars: 8, conditions: ['ADX falls'] },
    expiresAt: NOW + 7_200_000,
    version: '1.0.0',
    ...overrides,
  };
}

export function snapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    instId: 'BTC-USDT-SWAP',
    ts: NOW,
    degraded: false,
    degradedFields: [],
    last: 65_000,
    funding: { current: 0.00001 },
    ...overrides,
  };
}

export function position(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    instId: 'ETH-USDT-SWAP',
    side: 'long',
    contracts: 1,
    notionalUsdt: 192,
    entryPrice: 1_920,
    stopPrice: 1_881,
    openedAt: NOW - 3_600_000,
    signalId: 'SIG-existing00',
    ...overrides,
  };
}

function state(overrides: Partial<GovernorState> = {}): GovernorState {
  return { ...initialState(NOW), ...overrides };
}

function expectVeto(verdict: Verdict, code: VetoCode): void {
  expect(verdict.approved).toBe(false);
  if (verdict.approved) return;
  expect(verdict.code).toBe(code);
  expect(verdict.reason.length).toBeGreaterThan(10);
}

describe('the governor approves a clean signal', () => {
  it('sizes it and returns the drawdown assessment', () => {
    const verdict = evaluate(signal(), state(), snapshot(), NOW);
    expect(verdict.approved).toBe(true);
    if (!verdict.approved) return;
    expect(verdict.signalId).toBe('SIG-abcdefghij');
    expect(verdict.sizing.contracts).toBeGreaterThan(0);
    expect(verdict.sizing.actualRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT);
    expect(verdict.drawdown.rung).toBe('clear');
    expect(verdict.state.lastSignalAt).toBe(NOW);
  });
});

describe('veto precedence — first failure wins, in this exact order', () => {
  it('1. any halt flag beats everything else', () => {
    // Equity is also below the kill switch and the daily limit is blown; the HALT is reported.
    const halted = state({
      haltFlags: { killSwitch: false, dailyLimit: false, manual: true, dataStale: false, reconcileMismatch: false },
      haltReason: 'operator paused',
      haltedAt: NOW - 1000,
      equity: 300,
      realisedPnlToday: -50,
    });
    expectVeto(evaluate(signal(), halted, snapshot(), NOW), 'halted');
  });

  it('1b. a kill-switch flag reports as kill_switch and is permanent', () => {
    const killed = state({
      haltFlags: { killSwitch: true, dailyLimit: false, manual: false, dataStale: false, reconcileMismatch: false },
    });
    expectVeto(evaluate(signal(), killed, snapshot(), NOW), 'kill_switch');
  });

  it('2. kill switch fires at the threshold, sets the flag and demands a flatten', () => {
    const verdict = evaluate(signal(), state({ equity: 335 }), snapshot(), NOW);
    expectVeto(verdict, 'kill_switch');
    if (verdict.approved) return;
    expect(verdict.flatten).toBe(true);
    expect(verdict.state.haltFlags.killSwitch).toBe(true);
    expect(verdict.state.haltedAt).toBe(NOW);
  });

  it('2b. kill switch boundary: 335.01 passes, 335 and 334.99 do not', () => {
    // Peak is pinned to equity so the drawdown ladder cannot answer first — this isolates the
    // kill-switch threshold itself.
    const at = (equity: number): GovernorState =>
      state({ equity, peakEquity: equity, startingEquity: equity });
    expect(evaluate(signal(), at(335.01), snapshot(), NOW).approved).toBe(true);
    expectVeto(evaluate(signal(), at(335), snapshot(), NOW), 'kill_switch');
    expectVeto(evaluate(signal(), at(334.99), snapshot(), NOW), 'kill_switch');
  });

  it('2c. from a 400 peak the LADDER stops new trades long before the kill switch is reached', () => {
    // Equity 335.01 is a 16.2% drawdown from 400, so the -12% rung answers first. The kill
    // switch is the floor of last resort, not the mechanism that usually stops the bleeding —
    // reaching it at all should require an open position moving against us, not new entries.
    expectVeto(
      evaluate(signal(), state({ equity: 335.01, peakEquity: 400, startingEquity: 400 }), snapshot(), NOW),
      'no_new_positions',
    );
  });

  it('3. daily loss limit halts, flattens, and reports the UTC day', () => {
    const verdict = evaluate(signal(), state({ realisedPnlToday: -20 }), snapshot(), NOW);
    expectVeto(verdict, 'daily_loss_limit');
    if (verdict.approved) return;
    expect(verdict.flatten).toBe(true);
    expect(verdict.state.haltFlags.dailyLimit).toBe(true);
    expect(verdict.reason).toContain('2026-08-09');
  });

  it('3b. daily limit boundary: -19.99 passes, -20 does not', () => {
    expect(evaluate(signal(), state({ realisedPnlToday: -19.99 }), snapshot(), NOW).approved).toBe(true);
    expectVeto(evaluate(signal(), state({ realisedPnlToday: -20 }), snapshot(), NOW), 'daily_loss_limit');
  });

  it('4. max concurrent positions', () => {
    const full = state({
      openPositions: [position({ instId: 'ETH-USDT-SWAP' }), position({ instId: 'SOL-USDT-SWAP' })],
      totalNotional: 384,
    });
    expectVeto(evaluate(signal(), full, snapshot(), NOW), 'max_concurrent');
  });

  it('5. max total notional', () => {
    const heavy = state({
      openPositions: [position({ instId: 'ETH-USDT-SWAP', side: 'short', notionalUsdt: 780 })],
      totalNotional: 780,
    });
    expectVeto(evaluate(signal(), heavy, snapshot(), NOW), 'max_total_notional');
  });

  it('6. AVERAGING DOWN — same instrument, same direction', () => {
    const open = state({
      openPositions: [position({ instId: 'BTC-USDT-SWAP', side: 'long' })],
      totalNotional: 192,
    });
    expectVeto(evaluate(signal({ side: 'long' }), open, snapshot(), NOW), 'averaging_down');
  });

  it('6b. averaging down is vetoed however the signal is dressed up', () => {
    const open = state({
      openPositions: [position({ instId: 'BTC-USDT-SWAP', side: 'long', signalId: 'SIG-first00000' })],
      totalNotional: 192,
    });
    // A different strategy, a different id, a different stop — still adding to the same bet.
    for (const strategyId of ['trend_ema', 'revert_band', 'breakout_range', 'funding_skew']) {
      expectVeto(
        evaluate(signal({ strategyId, id: 'SIG-zzzzzzzzzz', stop: { price: 63_000, distancePct: 0.03, basis: 'structure' } }), open, snapshot(), NOW),
        'averaging_down',
      );
    }
  });

  it('6c. the OPPOSITE direction on the same instrument is not averaging down', () => {
    const open = state({
      openPositions: [position({ instId: 'BTC-USDT-SWAP', side: 'short', notionalUsdt: 100 })],
      totalNotional: 100,
    });
    const verdict = evaluate(signal({ side: 'long' }), open, snapshot(), NOW);
    expect(verdict.approved).toBe(true);
  });

  it('7. correlated exposure across instruments in the same direction', () => {
    const correlated = state({
      openPositions: [position({ instId: 'ETH-USDT-SWAP', side: 'long', notionalUsdt: 400 })],
      totalNotional: 400,
    });
    expectVeto(
      evaluate(signal({ side: 'long' }), correlated, snapshot(), NOW, {
        ...DEFAULT_RISK_CONFIG,
        correlatedNotionalCapUsdt: 450,
      }),
      'correlated_exposure',
    );
  });

  it('8. below minimum order size', () => {
    // Tiny equity → the 3x-capped notional cannot buy one lot of BTC.
    // A 65% stop demands only ~6.15 USDT of notional, which is less than one BTC lot
    // (0.01 contracts x 0.01 BTC x 65,000 = 6.50). Rejected outright rather than traded at a
    // size that cannot honour its stop.
    expectVeto(
      evaluate(
        signal({ stop: { price: 22_750, distancePct: 0.65, basis: 'atr' } }),
        state({ equity: 400, peakEquity: 400, startingEquity: 400 }),
        snapshot(),
        NOW,
      ),
      'below_minimum_size',
    );
  });

  it('10. funding cost above its share of the risk budget', () => {
    // Extreme funding over a long hold.
    expectVeto(
      evaluate(
        signal({ invalidation: { maxHoldBars: 240, conditions: [] } }),
        state(),
        snapshot({ funding: { current: 0.003 } }),
        NOW,
      ),
      'funding_cost',
    );
  });

  it('10b. a funding CREDIT never vetoes', () => {
    const verdict = evaluate(
      signal({ side: 'short', invalidation: { maxHoldBars: 240, conditions: [] } }),
      state(),
      snapshot({ funding: { current: 0.003 } }),
      NOW,
    );
    expect(verdict.approved).toBe(true);
  });

  it('11. degraded snapshot — redundant with the P2 gate, kept for defence in depth', () => {
    expectVeto(
      evaluate(signal(), state(), snapshot({ degraded: true, degradedFields: ['mark'] }), NOW),
      'snapshot_degraded',
    );
  });

  it('rejects an instrument outside the locked set', () => {
    expectVeto(
      evaluate(signal({ instId: 'DOGE-USDT-SWAP' as never }), state(), snapshot(), NOW),
      'instrument_not_locked',
    );
  });

  it('every veto carries a code, a reason and the numbers', () => {
    const verdict = evaluate(signal(), state({ equity: 300 }), snapshot(), NOW);
    expect(verdict.approved).toBe(false);
    if (verdict.approved) return;
    expect(verdict.code.length).toBeGreaterThan(0);
    expect(Object.keys(verdict.details).length).toBeGreaterThan(0);
  });
});

describe('the drawdown ladder governs the governor', () => {
  const drawdownState = (equity: number): GovernorState =>
    state({ equity, peakEquity: 400, startingEquity: 400 });

  it('halves the risk budget at −5%', () => {
    const verdict = evaluate(signal(), drawdownState(378), snapshot(), NOW);
    expect(verdict.approved).toBe(true);
    if (!verdict.approved) return;
    expect(verdict.drawdown.rung).toBe('reduced_risk');
    expect(verdict.sizing.actualRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT / 2 + 1e-9);
  });

  it('drops concurrency to 1 at −8%', () => {
    const withOne = { ...drawdownState(365), openPositions: [position()], totalNotional: 192 };
    expectVeto(evaluate(signal(), withOne, snapshot(), NOW), 'max_concurrent');
  });

  it('stops new positions entirely at −12%', () => {
    expectVeto(evaluate(signal(), drawdownState(350), snapshot(), NOW), 'no_new_positions');
  });
});
