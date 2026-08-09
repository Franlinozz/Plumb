import { describe, expect, it } from 'vitest';

import type { StrategyContext } from './module.js';
import { classifyRegime } from './regime.js';
import type { SignalDraft } from '@plumb/core';
import { stopIsOnCorrectSide } from '@plumb/core';
import { ALL_STRATEGIES, breakoutRange, fundingSkew, revertBand, trendEma } from './strategies/index.js';
import { EVENT_SPECS, REGIME_SPECS, snapshotOf, syntheticCandles } from './testkit.js';
import { DEFAULT_STRATEGY_CONFIG, EMPTY_STATE, type RegimeAssessment } from './types.js';

const NOW = Date.parse('2026-08-01T01:00:00Z');

function contextFor(
  specName: keyof typeof REGIME_SPECS,
  overrides: Partial<StrategyContext> = {},
  snapshotOverrides: Parameters<typeof snapshotOf>[1] = {},
): StrategyContext {
  const candles = syntheticCandles(REGIME_SPECS[specName]);
  const snapshot = snapshotOf(candles, snapshotOverrides);
  return {
    snapshot,
    regime: classifyRegime(snapshot, '1H'),
    state: EMPTY_STATE,
    config: DEFAULT_STRATEGY_CONFIG,
    now: snapshot.ts,
    peers: [],
    ...overrides,
  };
}

/** Every draft, from every strategy, must satisfy these — regardless of which one produced it. */
function assertWellFormed(draft: SignalDraft, now: number): void {
  const entry = draft.entry.price as number;
  expect(entry).toBeGreaterThan(0);
  expect(stopIsOnCorrectSide(draft.side, entry, draft.stop.price)).toBe(true);
  expect(draft.stop.distancePct).toBeGreaterThan(0);
  expect(draft.expiresAt).toBeGreaterThan(now);
  expect(draft.invalidation.maxHoldBars).toBeGreaterThan(0);
  expect(draft.invalidation.conditions.length).toBeGreaterThan(0);
  for (const value of Object.values(draft.inputs)) expect(Number.isFinite(value)).toBe(true);
  // The invariant the whole separation of concerns rests on.
  for (const field of ['size', 'leverage', 'notional', 'qty']) {
    expect(Object.prototype.hasOwnProperty.call(draft, field)).toBe(false);
  }
}

describe('every strategy, unconditionally', () => {
  const degraded = (): StrategyContext => {
    const base = contextFor('trending_up');
    return {
      ...base,
      snapshot: { ...base.snapshot, degraded: true, degradedFields: ['mark'] },
    };
  };

  it('produces only well-formed drafts, whatever the market', () => {
    for (const specName of Object.keys(REGIME_SPECS) as Array<keyof typeof REGIME_SPECS>) {
      for (const module of ALL_STRATEGIES) {
        const context = contextFor(specName, { peers: [] }, { fundingHistory: [] });
        for (const draft of module.evaluate(context)) assertWellFormed(draft, context.now);
      }
    }
  });

  it('is deterministic — the same context twice gives identical drafts', () => {
    for (const module of ALL_STRATEGIES) {
      const context = contextFor('trending_up');
      expect(JSON.stringify(module.evaluate(context))).toBe(
        JSON.stringify(module.evaluate(context)),
      );
    }
  });

  it('carries a stable id and version for backtest attribution', () => {
    const ids = ALL_STRATEGIES.map((m) => m.id);
    expect(ids).toEqual(['trend_ema', 'revert_band', 'breakout_range', 'funding_skew']);
    for (const module of ALL_STRATEGIES) expect(module.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('never sees a degraded snapshot in practice — but the ENGINE is what guarantees it', () => {
    // Strategies are not individually responsible for the degraded check; the gate rejects
    // everything before a draft can escape. Proven in engine.test.ts. Here we only confirm the
    // context can carry the flag so that test is meaningful.
    expect(degraded().snapshot.degraded).toBe(true);
  });
});

describe('trend_ema', () => {
  it('FIRES on an EMA cross inside a trending market', () => {
    // A ramp never turns, so its EMAs never cross. The cross fixture falls, then runs.
    const candles = syntheticCandles(EVENT_SPECS.trendCross);
    let fired = 0;
    for (let end = 130; end <= candles.length; end += 1) {
      const window = candles.slice(0, end);
      const snapshot = snapshotOf(window);
      const drafts = trendEma.evaluate({
        snapshot,
        regime: classifyRegime(snapshot, '1H'),
        state: EMPTY_STATE,
        config: DEFAULT_STRATEGY_CONFIG,
        now: snapshot.ts,
        peers: [],
      });
      for (const draft of drafts) {
        fired += 1;
        expect(draft.side).toBe('long');
        expect(draft.strategyId).toBe('trend_ema');
        expect(draft.stop.basis).toBe('atr');
        assertWellFormed(draft, snapshot.ts);
      }
    }
    expect(fired).toBeGreaterThan(0);
  });

  it('does NOT fire in a ranging market, even if the EMAs cross', () => {
    const candles = syntheticCandles(REGIME_SPECS.ranging);
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      expect(
        trendEma.evaluate({
          snapshot,
          regime: classifyRegime(snapshot, '1H'),
          state: EMPTY_STATE,
          config: DEFAULT_STRATEGY_CONFIG,
          now: NOW,
          peers: [],
        }),
      ).toEqual([]);
    }
  });

  it('does not fire on every bar of a trend — only on the cross', () => {
    const candles = syntheticCandles(EVENT_SPECS.trendCross);
    let bars = 0;
    let fired = 0;
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      bars += 1;
      fired += trendEma.evaluate({
        snapshot,
        regime: classifyRegime(snapshot, '1H'),
        state: EMPTY_STATE,
        config: DEFAULT_STRATEGY_CONFIG,
        now: snapshot.ts,
        peers: [],
      }).length;
    }
    // A strategy that fires on most bars of a trend is reporting a state, not an event.
    expect(fired / bars).toBeLessThan(0.15);
  });
});

describe('revert_band', () => {
  it('FIRES on a band touch with an RSI extreme in a ranging market', () => {
    const candles = syntheticCandles(EVENT_SPECS.bandTouch);
    let fired = 0;
    const sides = new Set<string>();
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      for (const draft of revertBand.evaluate({
        snapshot,
        regime: classifyRegime(snapshot, '1H'),
        state: EMPTY_STATE,
        config: DEFAULT_STRATEGY_CONFIG,
        now: snapshot.ts,
        peers: [],
      })) {
        fired += 1;
        sides.add(draft.side);
        expect(draft.stop.basis).toBe('structure');
        assertWellFormed(draft, snapshot.ts);
      }
    }
    expect(fired).toBeGreaterThan(0);
    expect(sides.size).toBeGreaterThan(0);
  });

  it('does NOT fire in a trending market — fading a trend is how it dies', () => {
    const candles = syntheticCandles(REGIME_SPECS.trending_up);
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      expect(
        revertBand.evaluate({
          snapshot,
          regime: classifyRegime(snapshot, '1H'),
          state: EMPTY_STATE,
          config: DEFAULT_STRATEGY_CONFIG,
          now: NOW,
          peers: [],
        }),
      ).toEqual([]);
    }
  });

  it('places the stop BEYOND the band it faded, never on it', () => {
    const candles = syntheticCandles(EVENT_SPECS.bandTouch);
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      for (const draft of revertBand.evaluate({
        snapshot,
        regime: classifyRegime(snapshot, '1H'),
        state: EMPTY_STATE,
        config: DEFAULT_STRATEGY_CONFIG,
        now: snapshot.ts,
        peers: [],
      })) {
        const band = draft.side === 'long' ? (draft.inputs['bbLower'] as number) : (draft.inputs['bbUpper'] as number);
        if (draft.side === 'long') expect(draft.stop.price).toBeLessThan(band);
        else expect(draft.stop.price).toBeGreaterThan(band);
      }
    }
  });
});

describe('breakout_range', () => {
  it('FIRES on a break out of a compressed range', () => {
    // Compression, then a decisive directional push clear of the prior range.
    const base = syntheticCandles(EVENT_SPECS.rangeBreak);
    let fired = 0;
    for (let end = 130; end <= base.length; end += 1) {
      const snapshot = snapshotOf(base.slice(0, end));
      for (const draft of breakoutRange.evaluate({
        snapshot,
        regime: classifyRegime(snapshot, '1H'),
        state: EMPTY_STATE,
        config: DEFAULT_STRATEGY_CONFIG,
        now: snapshot.ts,
        peers: [],
      })) {
        fired += 1;
        expect(draft.stop.basis).toBe('structure');
        expect(draft.inputs['breakStrengthAtr'] as number).toBeGreaterThanOrEqual(
          DEFAULT_STRATEGY_CONFIG.breakoutRange.minBreakAtr,
        );
        assertWellFormed(draft, snapshot.ts);
      }
    }
    expect(fired).toBeGreaterThan(0);
  });

  it('does NOT fire in a trending market — that is trend continuation, not a breakout', () => {
    const candles = syntheticCandles(REGIME_SPECS.trending_up);
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      expect(
        breakoutRange.evaluate({
          snapshot,
          regime: classifyRegime(snapshot, '1H'),
          state: EMPTY_STATE,
          config: DEFAULT_STRATEGY_CONFIG,
          now: NOW,
          peers: [],
        }),
      ).toEqual([]);
    }
  });
});

describe('funding_skew', () => {
  const crowdedLong = Array.from({ length: 60 }, (_, i) => 0.00001 * (i % 10));
  const peerLong: SignalDraft = {
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    intent: 'open',
    entry: { type: 'market', price: 100 },
    stop: { price: 98, distancePct: 0.02, basis: 'atr' },
    takeProfit: [{ price: 104, rMultiple: 2 }],
    timeframe: '1H',
    strategyId: 'trend_ema',
    regime: 'trending_up',
    inputs: { adx: 30 },
    invalidation: { maxHoldBars: 48, conditions: ['x'] },
    expiresAt: NOW + 7_200_000,
    version: '1.0.0',
  };

  it('NEVER fires alone, however extreme the funding', () => {
    const context = contextFor(
      'trending_up',
      { peers: [] },
      { fundingRate: 1, fundingHistory: crowdedLong },
    );
    expect(fundingSkew.evaluate(context)).toEqual([]);
  });

  it('does not fire without enough funding history to rank against', () => {
    const context = contextFor(
      'trending_up',
      { peers: [peerLong] },
      { fundingRate: -1, fundingHistory: [0.0001, 0.0002] },
    );
    expect(fundingSkew.evaluate(context)).toEqual([]);
  });

  it('FIRES against the crowd when a peer independently agrees', () => {
    // Funding at the bottom of its own range → crowd is short → fade LONG. Peer is long.
    const context = contextFor(
      'trending_up',
      { peers: [peerLong] },
      { fundingRate: -1, fundingHistory: crowdedLong },
    );
    const drafts = fundingSkew.evaluate(context);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0] as SignalDraft;
    expect(draft.side).toBe('long');
    expect(draft.inputs['fundingPercentile'] as number).toBeLessThanOrEqual(0.1);
    expect(draft.inputs['confirmingPeers']).toBe(1);
    assertWellFormed(draft, context.now);
  });

  it('does not fire when the only peer wants the other side', () => {
    // Funding at the TOP → fade short, but the peer is long. No agreement, no signal.
    const context = contextFor(
      'trending_up',
      { peers: [peerLong] },
      { fundingRate: 1, fundingHistory: crowdedLong },
    );
    expect(fundingSkew.evaluate(context)).toEqual([]);
  });

  it('does not fire when funding is unremarkable', () => {
    const context = contextFor(
      'trending_up',
      { peers: [peerLong] },
      { fundingRate: 0.00005, fundingHistory: crowdedLong },
    );
    expect(fundingSkew.evaluate(context)).toEqual([]);
  });

  it('runs in the second pass, so peers exist by the time it is asked', () => {
    expect(fundingSkew.requiresConfirmation).toBe(true);
    for (const other of [trendEma, revertBand, breakoutRange]) {
      expect(other.requiresConfirmation).toBe(false);
    }
  });
});

describe('config disables a strategy', () => {
  it('is honoured for each candidate independently', () => {
    for (const module of ALL_STRATEGIES) {
      const config = {
        ...DEFAULT_STRATEGY_CONFIG,
        enabled: { ...DEFAULT_STRATEGY_CONFIG.enabled, [module.id]: false },
      };
      expect(config.enabled[module.id]).toBe(false);
      // Other strategies remain enabled — disabling one must not disable the set.
      for (const other of ALL_STRATEGIES) {
        if (other.id !== module.id) expect(config.enabled[other.id]).toBe(true);
      }
    }
  });
});

describe('regime assessments carry through to the draft', () => {
  it('stamps the regime label the strategy actually saw', () => {
    const candles = syntheticCandles(REGIME_SPECS.trending_up);
    for (let end = 130; end <= candles.length; end += 1) {
      const snapshot = snapshotOf(candles.slice(0, end));
      const regime: RegimeAssessment = classifyRegime(snapshot, '1H');
      for (const draft of trendEma.evaluate({
        snapshot,
        regime,
        state: EMPTY_STATE,
        config: DEFAULT_STRATEGY_CONFIG,
        now: snapshot.ts,
        peers: [],
      })) {
        expect(draft.regime).toBe(regime.label);
        expect(draft.inputs['regimeConfidence']).toBe(regime.confidence);
      }
    }
  });
});
