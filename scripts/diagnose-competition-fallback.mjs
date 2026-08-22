#!/usr/bin/env node
/** Development-only emission diagnostics; never reads account state or protected data. */

import { CandleStore, snapshotFromCandles, tradableUniverse } from '@plumb/market';
import {
  COMPETITION_INTRADAY_CONTINUATION_ID,
  DEFAULT_STRATEGY_CONFIG,
  competitionIntradayContinuation,
  createSeededIdFactory,
  runCycle,
} from '@plumb/strategy';
import { DEFAULT_COSTS, runBacktest } from '@plumb/backtest';

const DEVELOPMENT_END = Date.parse('2026-05-12T00:00:00Z');
const FROM = DEVELOPMENT_END - 90 * 86_400_000;
const store = new CandleStore(process.env.PLUMB_DB_PATH ?? './data/plumb.db');
const config = Object.freeze({
  ...DEFAULT_STRATEGY_CONFIG,
  enabled: Object.freeze({ [COMPETITION_INTRADAY_CONTINUATION_ID]: true }),
  lookbackBars: 300,
  regime: Object.freeze({ ...DEFAULT_STRATEGY_CONFIG.regime, trendAdxMin: 18, rangeAdxMax: 18 }),
  stops: Object.freeze({ minDistancePct: 0.015, maxDistancePct: 0.02 }),
  gate: Object.freeze({ minRegimeConfidence: 0, cooldownMs: 0 }),
  trendEma: Object.freeze({ ...DEFAULT_STRATEGY_CONFIG.trendEma, timeframe: '15m' }),
  takeProfitR: Object.freeze([2]), maxHoldBars: 96, expiryBars: 1,
});
const result = {};
const replayCandles = {};
for (const instrument of tradableUniverse()) {
  const all = store.getCandles(instrument, '15m').filter((bar) => bar.ts <= DEVELOPMENT_END);
  replayCandles[instrument] = all;
  const start = all.findIndex((bar) => bar.ts >= FROM);
  const counters = { cycles: 0, drafts: 0, signals: 0, rejected: {} };
  for (let index = Math.max(300, start); index < all.length; index += 1) {
    const window = all.slice(index - 299, index + 1);
    const current = window.at(-1);
    if (current === undefined) continue;
    const snapshot = snapshotFromCandles({ now: current.ts, instId: instrument,
      candles: [{ tf: '15m', ohlcv: window }] });
    const cycle = runCycle(snapshot, { now: current.ts, newId: createSeededIdFactory(index),
      config, modules: [competitionIntradayContinuation], regimeTimeframe: '15m' });
    counters.cycles += 1;
    counters.drafts += cycle.draftCount;
    counters.signals += cycle.signals.length;
    for (const rejection of cycle.rejected) {
      counters.rejected[rejection.code] = (counters.rejected[rejection.code] ?? 0) + 1;
    }
  }
  result[instrument] = counters;
}
store.close();
const replay = runBacktest({ candles: replayCandles, timeframe: '15m', lookbackBars: 300,
  fromTs: FROM, toTs: DEVELOPMENT_END, startingEquity: 400, strategyConfig: config,
  modules: [competitionIntradayContinuation], costs: DEFAULT_COSTS, seed: 20260823 });
console.log(JSON.stringify({ scope: 'last-90-development-days', from: new Date(FROM).toISOString(),
  to: new Date(DEVELOPMENT_END).toISOString(), result,
  replay: { trades: replay.trades.length, signalsEmitted: replay.signalsEmitted,
    governorVetoes: replay.governorVetoes, gateRejections: replay.gateRejections } }, null, 2));
