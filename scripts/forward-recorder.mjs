#!/usr/bin/env node
/** Post-competition public observation recorder. No credentials or order path. */

process.env.PLUMB_COMPETITION_MARKET_DB = process.env.PLUMB_FORWARD_DB ??
  new URL('../data/forward-observations.db', import.meta.url).pathname;
process.env.PLUMB_MARKET_RECORDER_EVENT = 'forward_market_recorded';

await import('./competition-market-recorder.mjs');
