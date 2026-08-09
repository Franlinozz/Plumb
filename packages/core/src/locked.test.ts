import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DERIVED, INSTRUMENTS, LOCKED, canonicalLocked, isInstrument } from './locked.js';

/**
 * THE TRIPWIRE.
 *
 * Every locked competition parameter is pinned here literally. If any value in
 * `locked.ts` is edited, added, removed or renamed, this file fails. That is its entire
 * job — it is not a unit test of behaviour, it is a lock on a document.
 *
 * If you are reading this because it just went red: do NOT update the expectation.
 * The locked parameters change only when the operator changes them in writing, and when
 * that happens AGENTS.md changes in the same commit. See AGENTS.md § LOCKED PARAMETERS.
 */

describe('LOCKED — the tripwire', () => {
  it('pins every locked parameter to its exact value', () => {
    expect(LOCKED.CAPITAL_USDT).toBe(400);
    expect(LOCKED.KILL_SWITCH_EQUITY_USDT).toBe(335);
    expect(LOCKED.MAX_LOSS_USDT).toBe(65);
    expect(LOCKED.DAILY_LOSS_LIMIT_USDT).toBe(20);
    expect(LOCKED.PER_TRADE_RISK_USDT).toBe(4);
    expect(LOCKED.LEVERAGE_CEILING).toBe(3);
    expect(LOCKED.MAX_CONCURRENT_POSITIONS).toBe(2);
    expect(LOCKED.MAX_TOTAL_NOTIONAL_USDT).toBe(800);
    expect(LOCKED.ACCOUNTING_BASIS).toBe('agent-trade-kit');
  });

  it('pins the instrument set exactly, in order, with nothing else in it', () => {
    expect(LOCKED.INSTRUMENTS).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']);
    expect(LOCKED.INSTRUMENTS).toHaveLength(3);
    expect(INSTRUMENTS).toBe(LOCKED.INSTRUMENTS);

    // Everything outside the locked set is rejected, including near-misses.
    expect(isInstrument('BTC-USDT-SWAP')).toBe(true);
    expect(isInstrument('DOGE-USDT-SWAP')).toBe(false);
    expect(isInstrument('BTC-USDT')).toBe(false);
    expect(isInstrument('btc-usdt-swap')).toBe(false);
  });

  it('pins the exact key set, so a parameter cannot be quietly added or dropped', () => {
    expect(Object.keys(LOCKED).sort()).toEqual([
      'ACCOUNTING_BASIS',
      'CAPITAL_USDT',
      'DAILY_LOSS_LIMIT_USDT',
      'INSTRUMENTS',
      'KILL_SWITCH_EQUITY_USDT',
      'LEVERAGE_CEILING',
      'MAX_CONCURRENT_POSITIONS',
      'MAX_LOSS_USDT',
      'MAX_TOTAL_NOTIONAL_USDT',
      'PER_TRADE_RISK_USDT',
    ]);
  });

  it('is frozen at runtime, including the instrument array', () => {
    expect(Object.isFrozen(LOCKED)).toBe(true);
    expect(Object.isFrozen(LOCKED.INSTRUMENTS)).toBe(true);
    expect(Object.isFrozen(DERIVED)).toBe(true);

    const mutable = LOCKED as unknown as Record<string, unknown>;
    expect(() => {
      mutable['LEVERAGE_CEILING'] = 20;
    }).toThrow(TypeError);
    expect(() => {
      (LOCKED.INSTRUMENTS as unknown as string[]).push('DOGE-USDT-SWAP');
    }).toThrow(TypeError);

    expect(LOCKED.LEVERAGE_CEILING).toBe(3);
    expect(LOCKED.INSTRUMENTS).toHaveLength(3);
  });

  it('holds the invariants the locked values imply', () => {
    // The kill switch is exactly capital minus the maximum tolerated loss.
    expect(DERIVED.killSwitchEquityUsdt).toBe(LOCKED.KILL_SWITCH_EQUITY_USDT);

    // Per-trade risk is exactly 1% of starting equity.
    expect(DERIVED.perTradeRiskFraction).toBeCloseTo(0.01, 12);

    // Max loss is 16.25% of starting equity.
    expect(DERIVED.maxLossFraction).toBeCloseTo(0.1625, 12);

    // The notional ceiling cannot exceed what the leverage cap permits.
    expect(LOCKED.MAX_TOTAL_NOTIONAL_USDT).toBeLessThanOrEqual(
      DERIVED.leveragedNotionalCeilingUsdt,
    );

    // A single day cannot legally lose more than the whole competition budget,
    // and the daily limit must bite before the kill switch does.
    expect(LOCKED.DAILY_LOSS_LIMIT_USDT).toBeLessThan(LOCKED.MAX_LOSS_USDT);

    // Every concurrent position risking the full per-trade budget must still sit
    // inside the daily loss limit — otherwise the limit is unreachable by design.
    expect(LOCKED.PER_TRADE_RISK_USDT * LOCKED.MAX_CONCURRENT_POSITIONS).toBeLessThanOrEqual(
      LOCKED.DAILY_LOSS_LIMIT_USDT,
    );
  });

  it('has no averaging-down parameter, and no place to put one', () => {
    // AGENTS.md: "Prohibited. Not a parameter. There is no config value that enables it."
    // Encoding it as `averagingDown: false` would be the first step toward a value that
    // can be flipped to true, so the absence itself is what gets tested.
    const forbidden = /averag|scale[\s_-]?in|\bdca\b|add[\s_-]?to[\s_-]?los|martingale|pyramid|double[\s_-]?down|top[\s_-]?up/i;
    const offenders = Object.keys(LOCKED).filter((key) => forbidden.test(key));
    expect(offenders).toEqual([]);
  });

  it('matches the fingerprint of the operator-signed parameter set', () => {
    // A single hash over the canonical form of LOCKED. Any edit at all — value, name,
    // ordering, addition, removal — moves it. Changing this constant is an operator
    // decision recorded in AGENTS.md, never a fix for a red test.
    const fingerprint = createHash('sha256').update(canonicalLocked()).digest('hex');
    expect(fingerprint).toBe('ad08a6287271e7a4c7ec31290a6bd80658a4283b8f5cbf5e1b17395f5156df4a');
  });
});
