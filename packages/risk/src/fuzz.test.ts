import type { Signal } from '@plumb/core';
import { contractsToNotional, specFor } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { evaluate, type RiskSnapshot } from './governor.js';
import { DEFAULT_RISK_CONFIG, LOCKED } from './params.js';
import { assessDrawdown } from './drawdown.js';
import { initialState, type GovernorState, type OpenPosition } from './state.js';

/**
 * THE FUZZ TEST.
 *
 * Ten thousand random signals against random equity states. The specific assertion is narrow and
 * absolute: **no APPROVED signal may ever breach a locked parameter.** Not "usually", not "in the
 * cases we thought of" — the point of fuzzing is the inputs we did not imagine.
 *
 * The generator is seeded, so a failure is reproducible from the printed seed rather than being a
 * ghost that never appears again.
 */

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSTRUMENTS = LOCKED.INSTRUMENTS;
const BASE_PRICE: Record<string, number> = {
  'BTC-USDT-SWAP': 65_000,
  'ETH-USDT-SWAP': 1_920,
  'SOL-USDT-SWAP': 76.8,
};

const NOW = Date.parse('2026-08-09T12:00:00Z');

describe('fuzz: the governor holds under inputs we did not imagine', () => {
  it('never approves a signal that breaches a locked parameter (10,000 cases)', () => {
    const random = prng(20260809);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const between = (lo: number, hi: number): number => lo + random() * (hi - lo);

    let approvals = 0;
    const vetoCodes = new Map<string, number>();

    for (let i = 0; i < 10_000; i += 1) {
      const instId = pick(INSTRUMENTS);
      const spec = specFor(instId);
      const price = (BASE_PRICE[instId] as number) * between(0.4, 2.5);
      const side = random() < 0.5 ? ('long' as const) : ('short' as const);

      // Stop distances from absurdly tight to absurdly wide, plus occasional nonsense.
      const distance = random() < 0.05 ? between(-0.02, 0.0001) : between(0.0001, 0.8);
      const stopPrice = side === 'long' ? price * (1 - distance) : price * (1 + distance);

      // Random book: 0-3 open positions, random sides, instruments and notionals.
      const openCount = Math.floor(random() * 4);
      const openPositions: OpenPosition[] = [];
      for (let p = 0; p < openCount; p += 1) {
        const pInst = pick(INSTRUMENTS);
        openPositions.push({
          instId: pInst,
          side: random() < 0.5 ? 'long' : 'short',
          contracts: between(0.01, 5),
          notionalUsdt: between(0, 900),
          entryPrice: BASE_PRICE[pInst] as number,
          stopPrice: (BASE_PRICE[pInst] as number) * 0.99,
          openedAt: NOW - Math.floor(between(0, 86_400_000)),
          signalId: `SIG-fuzz${String(p).padStart(6, '0')}`,
        });
      }

      const equity = between(200, 900);
      const state: GovernorState = {
        ...initialState(NOW),
        equity,
        peakEquity: Math.max(equity, between(equity, 1_000)),
        realisedPnlToday: between(-40, 20),
        openPositions,
        totalNotional: openPositions.reduce((sum, p) => sum + p.notionalUsdt, 0),
      };

      const signal: Signal = {
        id: `SIG-${String(i).padStart(10, '0')}`.slice(0, 14),
        ts: NOW,
        instId,
        side,
        intent: 'open',
        entry: { type: 'market', price },
        stop: { price: Math.max(stopPrice, 1e-9), distancePct: Math.abs(distance), basis: 'atr' },
        timeframe: pick(['15m', '1H', '4H'] as const),
        strategyId: 'fuzz',
        regime: 'trending_up',
        inputs: {},
        invalidation: { maxHoldBars: Math.max(1, Math.floor(between(1, 300))), conditions: [] },
        expiresAt: NOW + 7_200_000,
        version: '1.0.0',
      };

      const snapshot: RiskSnapshot = {
        instId,
        ts: NOW,
        degraded: random() < 0.05,
        degradedFields: ['mark'],
        last: price,
        funding: { current: between(-0.003, 0.003) },
      };

      const verdict = evaluate(signal, state, snapshot, NOW, DEFAULT_RISK_CONFIG);

      if (!verdict.approved) {
        vetoCodes.set(verdict.code, (vetoCodes.get(verdict.code) ?? 0) + 1);
        continue;
      }
      approvals += 1;

      const { sizing, drawdown } = verdict;
      const context = `case ${i} ${instId} ${side} equity=${equity.toFixed(2)} dist=${distance}`;

      // ── The locked parameters. None of these may EVER be breached by an approval. ────────
      expect(sizing.actualRiskUsdt, `risk budget · ${context}`).toBeLessThanOrEqual(
        LOCKED.PER_TRADE_RISK_USDT + 1e-9,
      );
      expect(sizing.actualRiskUsdt, `ladder budget · ${context}`).toBeLessThanOrEqual(
        drawdown.riskBudgetUsdt + 1e-9,
      );
      expect(sizing.leverage, `leverage · ${context}`).toBeLessThanOrEqual(
        LOCKED.LEVERAGE_CEILING + 1e-9,
      );
      expect(
        state.totalNotional + sizing.notionalUsdt,
        `total notional · ${context}`,
      ).toBeLessThanOrEqual(LOCKED.MAX_TOTAL_NOTIONAL_USDT + 1e-9);
      expect(state.openPositions.length, `concurrency · ${context}`).toBeLessThan(
        Math.min(drawdown.maxConcurrent, LOCKED.MAX_CONCURRENT_POSITIONS),
      );
      expect(equity, `kill switch · ${context}`).toBeGreaterThan(LOCKED.KILL_SWITCH_EQUITY_USDT);
      expect(state.realisedPnlToday, `daily limit · ${context}`).toBeGreaterThan(
        -LOCKED.DAILY_LOSS_LIMIT_USDT,
      );
      expect(snapshot.degraded, `degraded · ${context}`).toBe(false);

      // No approval may add to an existing same-direction position. Ever.
      expect(
        state.openPositions.some((p) => p.instId === instId && p.side === side),
        `averaging down · ${context}`,
      ).toBe(false);

      // The size is real: on the lot grid, at or above the minimum, and consistent.
      expect(sizing.contracts, `minimum size · ${context}`).toBeGreaterThanOrEqual(spec.minSz);
      const lots = sizing.contracts / spec.lotSz;
      expect(Math.abs(lots - Math.round(lots)), `lot grid · ${context}`).toBeLessThan(1e-9);
      expect(sizing.notionalUsdt, `notional consistency · ${context}`).toBeCloseTo(
        contractsToNotional(sizing.contracts, price, spec),
        6,
      );
      // The stop the strategy asked for is the stop that was sized against — never widened.
      expect(sizing.stopDistancePct, `stop untouched · ${context}`).toBeCloseTo(
        Math.abs(price - signal.stop.price) / price,
        10,
      );
    }

    // The fuzz must actually exercise the approval path, or it proves nothing.
    expect(approvals).toBeGreaterThan(200);
    expect(vetoCodes.size).toBeGreaterThan(4);
  });

  it('never approves anything once the kill switch has fired, at any equity', () => {
    const random = prng(7);
    for (let i = 0; i < 500; i += 1) {
      const state: GovernorState = {
        ...initialState(NOW),
        equity: 200 + random() * 800,
        peakEquity: 1_000,
        haltFlags: {
          killSwitch: true,
          dailyLimit: false,
          manual: false,
          dataStale: false,
          reconcileMismatch: false,
        },
      };
      const verdict = evaluate(
        {
          id: 'SIG-abcdefghij',
          ts: NOW,
          instId: 'BTC-USDT-SWAP',
          side: 'long',
          intent: 'open',
          entry: { type: 'market', price: 65_000 },
          stop: { price: 64_350, distancePct: 0.01, basis: 'atr' },
          timeframe: '1H',
          strategyId: 'fuzz',
          regime: 'trending_up',
          inputs: {},
          invalidation: { maxHoldBars: 8, conditions: [] },
          expiresAt: NOW + 7_200_000,
          version: '1.0.0',
        },
        state,
        {
          instId: 'BTC-USDT-SWAP',
          ts: NOW,
          degraded: false,
          degradedFields: [],
          last: 65_000,
          funding: { current: 0 },
        },
        NOW,
      );
      expect(verdict.approved).toBe(false);
      if (!verdict.approved) expect(verdict.code).toBe('kill_switch');
    }
  });

  it('the drawdown ladder is monotonic — more drawdown never permits more risk', () => {
    let previousRisk = Number.POSITIVE_INFINITY;
    let previousConcurrency = Number.POSITIVE_INFINITY;
    for (let equity = 400; equity >= 336; equity -= 1) {
      const assessment = assessDrawdown({
        ...initialState(NOW),
        equity,
        peakEquity: 400,
        startingEquity: 400,
      });
      const effectiveConcurrency = assessment.allowsNewPositions ? assessment.maxConcurrent : 0;
      expect(assessment.riskBudgetUsdt).toBeLessThanOrEqual(previousRisk + 1e-9);
      expect(effectiveConcurrency).toBeLessThanOrEqual(previousConcurrency);
      previousRisk = assessment.riskBudgetUsdt;
      previousConcurrency = effectiveConcurrency;
    }
    expect(previousRisk).toBe(0);
  });
});
