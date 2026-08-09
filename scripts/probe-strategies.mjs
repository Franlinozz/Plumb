#!/usr/bin/env node
/**
 * Probe each strategy against the event fixtures, so a test that says "fires here" is backed by
 * a market that verifiably contains the event.
 *
 *   node scripts/probe-strategies.mjs
 */

import {
  DEFAULT_STRATEGY_CONFIG,
  EMPTY_STATE,
  classifyRegime,
  breakoutRange,
  revertBand,
  trendEma,
} from '@plumb/strategy';
import { EVENT_SPECS, REGIME_SPECS, snapshotOf, syntheticCandles } from '@plumb/strategy/testkit';

function walk(module, candles) {
  let fired = 0;
  let bars = 0;
  const sides = new Set();
  const regimes = new Map();
  for (let end = 130; end <= candles.length; end += 1) {
    const snapshot = snapshotOf(candles.slice(0, end));
    const regime = classifyRegime(snapshot, '1H');
    bars += 1;
    regimes.set(regime.label, (regimes.get(regime.label) ?? 0) + 1);
    const drafts = module.evaluate({
      snapshot,
      regime,
      state: EMPTY_STATE,
      config: DEFAULT_STRATEGY_CONFIG,
      now: snapshot.ts,
      peers: [],
    });
    fired += drafts.length;
    for (const d of drafts) sides.add(d.side);
  }
  return { fired, bars, sides: [...sides].sort(), regimes };
}

const CASES = [
  ['trend_ema', trendEma, EVENT_SPECS.trendCross],
  ['revert_band', revertBand, EVENT_SPECS.bandTouch],
  ['breakout_range', breakoutRange, EVENT_SPECS.rangeBreak],
];

console.log('\nevent fixtures — does the strategy find its event?\n');
for (const [name, module, spec] of CASES) {
  const r = walk(module, syntheticCandles(spec));
  const regimes = [...r.regimes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(
    `  ${name.padEnd(16)} fired ${String(r.fired).padStart(4)} / ${r.bars} bars  ` +
      `(${((r.fired / r.bars) * 100).toFixed(1)}%)  sides [${r.sides.join(',')}]`,
  );
  console.log(`      regimes seen: ${regimes}`);
}

console.log('\nnegative controls — the strategy must stay silent\n');
const NEGATIVE = [
  ['trend_ema on ranging', trendEma, REGIME_SPECS.ranging],
  ['revert_band on trending', revertBand, REGIME_SPECS.trending_up],
  ['breakout_range on trending', breakoutRange, REGIME_SPECS.trending_up],
];
for (const [name, module, spec] of NEGATIVE) {
  const r = walk(module, syntheticCandles(spec));
  console.log(`  ${name.padEnd(30)} fired ${r.fired} (want 0)`);
}
