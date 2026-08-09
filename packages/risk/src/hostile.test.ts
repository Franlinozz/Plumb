import { fixtureCandles } from '@plumb/market';
import { describe, expect, it } from 'vitest';

import { LOCKED } from './params.js';
import { simulateHostile, type SimOptions } from './simulate.js';

/**
 * THE HOSTILE-STRATEGY SIMULATION.
 *
 * Real recorded market history, driven by a strategy that tries to open the maximum permitted
 * size on every bar of every instrument with the tightest stop that will pass. The governor must
 * survive it: **no approval may breach a locked parameter, and the account must not run past the
 * kill switch.**
 *
 * This runs on the committed 300-bar fixtures so it is reproducible anywhere.
 * `npm run hostile` runs the same code over the full 180-day history.
 */

function candles() {
  return {
    'BTC-USDT-SWAP': fixtureCandles('BTC-USDT-SWAP', '1H'),
    'ETH-USDT-SWAP': fixtureCandles('ETH-USDT-SWAP', '1H'),
    'SOL-USDT-SWAP': fixtureCandles('SOL-USDT-SWAP', '1H'),
  };
}

function run(overrides: Partial<SimOptions> = {}) {
  return simulateHostile({ candles: candles(), ...overrides });
}

describe('the governor survives a hostile strategy', () => {
  const result = run();

  it('actually exercised the approval path — otherwise it proves nothing', () => {
    expect(result.bars).toBeGreaterThan(250);
    expect(result.approvals).toBeGreaterThan(20);
    expect(result.trades.length).toBeGreaterThan(20);
  });

  it('NEVER let an approved position exceed the per-trade risk budget', () => {
    expect(result.worstApprovedRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT + 1e-9);
  });

  it('NEVER let an approved position exceed the leverage ceiling', () => {
    expect(result.worstApprovedLeverage).toBeLessThanOrEqual(LOCKED.LEVERAGE_CEILING + 1e-9);
  });

  it('NEVER let the book exceed the total notional cap', () => {
    expect(result.maxTotalNotional).toBeLessThanOrEqual(LOCKED.MAX_TOTAL_NOTIONAL_USDT + 1e-9);
  });

  it('NEVER held more than the permitted number of positions', () => {
    expect(result.state.openPositions.length).toBeLessThanOrEqual(LOCKED.MAX_CONCURRENT_POSITIONS);
  });

  it('approved NOTHING after the kill switch fired', () => {
    expect(result.approvalsAfterKillSwitch).toBe(0);
  });

  it('kept the account above the kill switch, or halted at it', () => {
    if (result.killSwitchFiredAt === undefined) {
      // The ladder did its job: the account never reached the floor.
      expect(result.minEquity).toBeGreaterThan(LOCKED.KILL_SWITCH_EQUITY_USDT);
    } else {
      // It reached the floor, and the floor held: halted, flat, and permanently.
      expect(result.state.haltFlags.killSwitch).toBe(true);
      expect(result.state.openPositions).toEqual([]);
    }
  });

  it('vetoed far more than it approved — the hostile strategy is mostly refused', () => {
    const vetoTotal = Object.values(result.vetoes).reduce((a, b) => a + b, 0);
    expect(vetoTotal).toBeGreaterThan(result.approvals);
    // And the refusals are the ones we would expect from a maximum-size-every-bar strategy.
    expect(Object.keys(result.vetoes)).toContain('max_concurrent');
  });

  it('holds under a far more adverse slippage assumption', () => {
    const brutal = run({ slippagePct: 0.005, stopDistancePct: 0.0015 });
    expect(brutal.worstApprovedRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT + 1e-9);
    expect(brutal.worstApprovedLeverage).toBeLessThanOrEqual(LOCKED.LEVERAGE_CEILING + 1e-9);
    expect(brutal.approvalsAfterKillSwitch).toBe(0);
  });

  it('holds when funding is punitive', () => {
    const expensive = run({ fundingRate: 0.003, maxHoldBars: 48 });
    expect(expensive.worstApprovedRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT + 1e-9);
    expect(expensive.approvalsAfterKillSwitch).toBe(0);
  });

  it('holds from a starting equity already near the floor', () => {
    const nearFloor = run({ startingEquity: 340 });
    expect(nearFloor.approvalsAfterKillSwitch).toBe(0);
    expect(nearFloor.worstApprovedRiskUsdt).toBeLessThanOrEqual(LOCKED.PER_TRADE_RISK_USDT + 1e-9);
    if (nearFloor.killSwitchFiredAt !== undefined) {
      expect(nearFloor.state.haltFlags.killSwitch).toBe(true);
    }
  });

  it('the kill switch bounds NEW RISK, and equity can undershoot it by about one trade', () => {
    // Honest physics, verified on 180 days of real history (`npm run hostile`): starting at 340,
    // equity reached 331.17 — BELOW the 335 floor — because a position was already open and its
    // stop filled with slippage. The switch cannot un-take a trade that is already on.
    //
    // What the switch DOES guarantee: it fires, it flattens, and nothing new is approved after.
    // Starting from the locked 400 the ladder keeps this far away — the baseline run bottomed at
    // 370.74, never within 35 USDT of the floor.
    const nearFloor = run({ startingEquity: 340 });
    if (nearFloor.killSwitchFiredAt !== undefined) {
      expect(nearFloor.state.haltFlags.killSwitch).toBe(true);
      expect(nearFloor.state.openPositions).toEqual([]);
      expect(nearFloor.approvalsAfterKillSwitch).toBe(0);
      // The undershoot is bounded by one full per-trade risk plus a slippage allowance.
      const bound = LOCKED.KILL_SWITCH_EQUITY_USDT - LOCKED.PER_TRADE_RISK_USDT * 2;
      expect(nearFloor.minEquity).toBeGreaterThan(bound);
    }
  });

  it('from the LOCKED starting capital, never comes close to the floor', () => {
    // The ladder is what does the work; the kill switch is the backstop behind it.
    expect(result.minEquity).toBeGreaterThan(LOCKED.KILL_SWITCH_EQUITY_USDT);
  });

  it('is deterministic — the same history twice gives the same outcome', () => {
    const a = run();
    const b = run();
    expect(a.finalEquity).toBe(b.finalEquity);
    expect(a.approvals).toBe(b.approvals);
    expect(a.trades.length).toBe(b.trades.length);
  });
});
