#!/usr/bin/env node
/**
 * Probe the regime classifier against the synthetic specs, so the fixtures used in tests are
 * VERIFIED to produce the label they claim rather than assumed to.
 *
 *   node scripts/probe-regimes.mjs
 */

import { classifyRegime } from '@plumb/strategy';
import { REGIME_SPECS, snapshotOf, syntheticCandles } from '@plumb/strategy/testkit';

console.log('\nspec              → label            confidence   ADX   atrRatio  bwPct');
console.log('-'.repeat(76));

for (const [name, spec] of Object.entries(REGIME_SPECS)) {
  const snapshot = snapshotOf(syntheticCandles(spec));
  const r = classifyRegime(snapshot, '1H');
  const i = r.inputs;
  const mark = r.label === name ? ' ' : '✗';
  console.log(
    `${mark} ${name.padEnd(16)}→ ${r.label.padEnd(16)} ${r.confidence.toFixed(3).padStart(6)}` +
      `${(i.adx ?? NaN).toFixed(1).padStart(8)}${(i.atrRatio ?? NaN).toFixed(2).padStart(10)}` +
      `${(i.bandwidthPercentile ?? NaN).toFixed(2).padStart(8)}`,
  );
  if (r.label !== name) console.log(`    reasons: ${r.reasons.join(' | ')}`);
}

// Hunt for a genuinely ambiguous market — ADX inside the dead zone between the ranging
// ceiling (20) and the trending floor (25), with nothing else to break the tie.
console.log('\nsearching for an ambiguous (unclear) market...');
let found = 0;
for (let seed = 1; seed <= 400 && found < 5; seed += 1) {
  for (const drift of [0.0006, 0.0008, 0.001, 0.0012]) {
    const spec = {
      bars: 200,
      startPrice: 100,
      drift,
      amplitude: 0.006,
      period: 13,
      noise: 0.002,
      barRange: 0.006,
      seed,
    };
    const r = classifyRegime(snapshotOf(syntheticCandles(spec)), '1H');
    if (r.label === 'unclear' && (r.inputs.adx ?? 0) > 0) {
      console.log(
        `  seed ${seed} drift ${drift} → unclear (ADX ${r.inputs.adx.toFixed(1)}, ` +
          `bwPct ${r.inputs.bandwidthPercentile.toFixed(2)}, atrRatio ${r.inputs.atrRatio.toFixed(2)})`,
      );
      found += 1;
      break;
    }
  }
}
if (found === 0) console.log('  none found — the dead zone may be unreachable, which is a finding');
