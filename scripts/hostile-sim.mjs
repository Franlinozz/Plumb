#!/usr/bin/env node
/**
 * Run the hostile-strategy simulation over the FULL stored history.
 *
 * A strategy that tries to open the maximum permitted size on every bar of every instrument,
 * widening its stop until the governor lets something through. It is not trying to make money —
 * it is trying to find a hole in the risk governor. The committed test runs the same code over
 * the 300-bar fixtures; this runs it over ~180 days.
 *
 *   node scripts/hostile-sim.mjs [--tf 1H] [--equity 400]
 */

import { CandleStore, tradableUniverse } from '@plumb/market';
import { LOCKED, assessDrawdown, simulateHostile } from '@plumb/risk';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const tf = arg('tf', '1H');
const startingEquity = Number(arg('equity', String(LOCKED.CAPITAL_USDT)));
const dbPath = process.env.PLUMB_DB_PATH ?? './data/plumb.db';

const store = new CandleStore(dbPath);
const candles = {};
for (const instId of tradableUniverse()) {
  const rows = store.getCandles(instId, tf);
  if (rows.length === 0) {
    console.log(`  ${instId} ${tf}: no candles — run npm run backfill first`);
    process.exit(1);
  }
  candles[instId] = rows;
}
store.close();

const bars = Math.min(...Object.values(candles).map((c) => c.length));
const from = new Date(Object.values(candles)[0][0].ts).toISOString().slice(0, 10);
const to = new Date(Object.values(candles)[0].at(-1).ts).toISOString().slice(0, 10);

console.log(`\nhostile-strategy simulation — ${bars} bars per instrument, ${from} → ${to}, ${tf}`);
console.log(`starting equity ${startingEquity} USDT\n`);

const scenarios = [
  { name: 'baseline', options: {} },
  { name: 'brutal slippage (0.5%)', options: { slippagePct: 0.005 } },
  { name: 'punitive funding', options: { fundingRate: 0.003, maxHoldBars: 48 } },
  { name: 'starting near the floor', options: { startingEquity: 340 } },
  { name: 'long holds (48 bars)', options: { maxHoldBars: 48 } },
];

let allHeld = true;

for (const { name, options } of scenarios) {
  const r = simulateHostile({ candles, startingEquity, ...options });
  const breaches = [];
  if (r.worstApprovedRiskUsdt > LOCKED.PER_TRADE_RISK_USDT + 1e-9) breaches.push('per-trade risk');
  if (r.worstApprovedLeverage > LOCKED.LEVERAGE_CEILING + 1e-9) breaches.push('leverage ceiling');
  if (r.maxTotalNotional > LOCKED.MAX_TOTAL_NOTIONAL_USDT + 1e-9) breaches.push('total notional');
  if (r.approvalsAfterKillSwitch > 0) breaches.push('approved after kill switch');
  if (breaches.length > 0) allHeld = false;

  const ladder = assessDrawdown(r.state);
  console.log(`── ${name}`);
  console.log(
    `   equity ${r.startingEquity.toFixed(2)} → ${r.finalEquity.toFixed(2)}  ` +
      `min ${r.minEquity.toFixed(2)}  floor ${LOCKED.KILL_SWITCH_EQUITY_USDT}  ` +
      `rung ${ladder.rung}`,
  );
  console.log(
    `   approvals ${r.approvals}  trades ${r.trades.length} (${r.wins}W/${r.losses}L)  ` +
      `kill switch ${r.killSwitchFiredAt === undefined ? 'not fired' : new Date(r.killSwitchFiredAt).toISOString().slice(0, 16)}`,
  );
  console.log(
    `   worst approved risk ${r.worstApprovedRiskUsdt.toFixed(4)} / ${LOCKED.PER_TRADE_RISK_USDT}   ` +
      `worst leverage ${r.worstApprovedLeverage.toFixed(3)} / ${LOCKED.LEVERAGE_CEILING}   ` +
      `peak notional ${r.maxTotalNotional.toFixed(2)} / ${LOCKED.MAX_TOTAL_NOTIONAL_USDT}`,
  );
  const vetoes = Object.entries(r.vetoes).sort((a, b) => b[1] - a[1]);
  console.log(`   vetoes: ${vetoes.map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`   VERDICT: ${breaches.length === 0 ? 'governor HELD' : `BREACHED — ${breaches.join(', ')}`}\n`);
}

console.log(allHeld ? 'All scenarios: the governor held.' : 'AT LEAST ONE SCENARIO BREACHED A LOCKED PARAMETER.');
process.exit(allHeld ? 0 : 1);
