import { describe, expect, it } from 'vitest';

import { applyPortfolioRules, signalQuality } from './portfolio.js';
import type { SignalDraft } from './signal.js';
import { DEFAULT_STRATEGY_CONFIG, EMPTY_STATE, type EngineState } from './types.js';

const NOW = Date.parse('2026-08-01T01:00:00Z');

function draft(overrides: Partial<SignalDraft> = {}): SignalDraft {
  return {
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    intent: 'open',
    entry: { type: 'market', price: 100 },
    stop: { price: 98, distancePct: 0.02, basis: 'atr' },
    takeProfit: [{ price: 104, rMultiple: 2 }],
    timeframe: '1H',
    strategyId: 'trend_ema',
    regime: 'trending_up',
    inputs: { adx: 30, regimeConfidence: 0.6 },
    invalidation: { maxHoldBars: 48, conditions: ['x'] },
    expiresAt: NOW + 7_200_000,
    version: '1.0.0',
    ...overrides,
  };
}

const config = DEFAULT_STRATEGY_CONFIG.portfolio;

describe('signalQuality', () => {
  it('rises with regime confidence, trend strength and reward', () => {
    const weak = draft({ inputs: { adx: 10, regimeConfidence: 0.2 } });
    const strong = draft({ inputs: { adx: 45, regimeConfidence: 0.95 } });
    expect(signalQuality(strong)).toBeGreaterThan(signalQuality(weak));
    expect(signalQuality(weak)).toBeGreaterThanOrEqual(0);
    expect(signalQuality(strong)).toBeLessThanOrEqual(1);
  });

  it('copes with a signal that carries no adx input', () => {
    expect(Number.isFinite(signalQuality(draft({ inputs: { regimeConfidence: 0.5 } })))).toBe(true);
  });
});

describe('correlated exposure', () => {
  it('caps three simultaneous longs across BTC, ETH and SOL at the configured N', () => {
    const drafts = [
      draft({ instId: 'BTC-USDT-SWAP', inputs: { adx: 20, regimeConfidence: 0.4 } }),
      draft({ instId: 'ETH-USDT-SWAP', inputs: { adx: 45, regimeConfidence: 0.95 } }),
      draft({ instId: 'SOL-USDT-SWAP', inputs: { adx: 30, regimeConfidence: 0.6 } }),
    ];
    const result = applyPortfolioRules(drafts, EMPTY_STATE, config);

    // Default N is 1 — three correlated longs are one bet wearing three hats.
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.instId).toBe('ETH-USDT-SWAP'); // the highest quality
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped.every((d) => d.code === 'correlated_cap')).toBe(true);
  });

  it('honours a higher cap when configured', () => {
    const drafts = (['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'] as const).map((instId) =>
      draft({ instId }),
    );
    expect(applyPortfolioRules(drafts, EMPTY_STATE, { maxCorrelatedPerCycle: 2 }).selected).toHaveLength(2);
    expect(applyPortfolioRules(drafts, EMPTY_STATE, { maxCorrelatedPerCycle: 3 }).selected).toHaveLength(3);
  });

  it('caps each direction separately — a long and a short are not the same bet', () => {
    const result = applyPortfolioRules(
      [
        draft({ instId: 'BTC-USDT-SWAP', side: 'long' }),
        draft({ instId: 'ETH-USDT-SWAP', side: 'long' }),
        draft({ instId: 'SOL-USDT-SWAP', side: 'short', regime: 'trending_down' }),
      ],
      EMPTY_STATE,
      config,
    );
    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((d) => d.side))).toEqual(new Set(['long', 'short']));
  });

  it('is deterministic when two signals score identically', () => {
    const drafts = [
      draft({ instId: 'ETH-USDT-SWAP', strategyId: 'trend_ema' }),
      draft({ instId: 'BTC-USDT-SWAP', strategyId: 'breakout_range' }),
    ];
    const once = applyPortfolioRules(drafts, EMPTY_STATE, config).selected;
    const twice = applyPortfolioRules([...drafts].reverse(), EMPTY_STATE, config).selected;
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe('existing positions', () => {
  const stateWithLongBtc: EngineState = {
    openPositions: [
      {
        instId: 'BTC-USDT-SWAP',
        side: 'long',
        notional: 200,
        openedAt: NOW - 3_600_000,
        signalId: 'SIG-aaaaaaaaaa',
      },
    ],
    lastSignalAt: {},
  };

  it('never adds to a direction already open — the averaging-down prohibition', () => {
    const result = applyPortfolioRules([draft()], stateWithLongBtc, config);
    expect(result.selected).toEqual([]);
    expect(result.dropped[0]?.code).toBe('position_already_open');
  });

  it('allows a different instrument while one is open', () => {
    const result = applyPortfolioRules([draft({ instId: 'ETH-USDT-SWAP' })], stateWithLongBtc, config);
    expect(result.selected).toHaveLength(1);
  });

  it('allows the opposite side on the same instrument — that is a reversal, not an add', () => {
    // Whether a reversal is permitted at all is @plumb/risk's call, not the portfolio's.
    const result = applyPortfolioRules(
      [draft({ side: 'short', regime: 'trending_down' })],
      stateWithLongBtc,
      config,
    );
    expect(result.selected).toHaveLength(1);
  });
});

describe('one signal per instrument per cycle', () => {
  it('keeps only the strongest when two strategies agree on the same instrument', () => {
    const result = applyPortfolioRules(
      [
        draft({ strategyId: 'trend_ema', inputs: { adx: 20, regimeConfidence: 0.4 } }),
        draft({ strategyId: 'breakout_range', inputs: { adx: 45, regimeConfidence: 0.95 } }),
      ],
      EMPTY_STATE,
      config,
    );
    // Agreement is corroboration, not a reason to enter twice.
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.strategyId).toBe('breakout_range');
    expect(result.dropped[0]?.code).toBe('one_signal_per_instrument');
    expect(result.dropped[0]?.strategyId).toBe('trend_ema');
  });
});

describe('every drop is explained', () => {
  it('carries a code, a message, the strategy and its score', () => {
    const result = applyPortfolioRules(
      [
        draft({ instId: 'BTC-USDT-SWAP' }),
        draft({ instId: 'ETH-USDT-SWAP' }),
        draft({ instId: 'SOL-USDT-SWAP' }),
      ],
      EMPTY_STATE,
      config,
    );
    for (const drop of result.dropped) {
      expect(drop.message.length).toBeGreaterThan(10);
      expect(drop.strategyId.length).toBeGreaterThan(0);
      expect(Number.isFinite(drop.score)).toBe(true);
    }
  });

  it('accounts for every input — nothing vanishes silently', () => {
    const drafts = [
      draft({ instId: 'BTC-USDT-SWAP' }),
      draft({ instId: 'ETH-USDT-SWAP' }),
      draft({ instId: 'SOL-USDT-SWAP' }),
      draft({ instId: 'BTC-USDT-SWAP', strategyId: 'breakout_range' }),
    ];
    const result = applyPortfolioRules(drafts, EMPTY_STATE, config);
    expect(result.selected.length + result.dropped.length).toBe(drafts.length);
  });
});
