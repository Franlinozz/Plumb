#!/usr/bin/env node
/**
 * Persistent public-market recorder for competition research.
 *
 * No credentials, account calls, or order path exist here. Each invocation records one bounded
 * round and exits; systemd supplies scheduling and retry. SQLite's composite primary key makes a
 * repeated invocation safe after crashes or timer overlap.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  MarketObservationStore,
  OkxPublicClient,
  specFor,
  tradableUniverse,
} from '@plumb/market';

const DB_PATH = process.env.PLUMB_COMPETITION_MARKET_DB ?? '/var/lib/plumb-okxai/market-observations.db';
const EVENT_NAME = process.env.PLUMB_MARKET_RECORDER_EVENT ?? 'competition_market_recorded';
const client = new OkxPublicClient();
mkdirSync(dirname(DB_PATH), { recursive: true });
const store = new MarketObservationStore(DB_PATH);

const write = (kind, instrument, sourceTs, payload, timeframe) =>
  store.put({ kind, instrument, sourceTs, recordedAt: Date.now(), payload, ...(timeframe === undefined ? {} : { timeframe }) });

let inserted = 0;
try {
  for (const instrument of tradableUniverse()) {
    const [ticker, book, trades, mark, index, funding, oi] = await Promise.all([
      client.ticker(instrument),
      client.orderBook(instrument, 20),
      client.trades(instrument, 100),
      client.markPrice(instrument),
      client.indexTicker(instrument),
      client.fundingRate(instrument),
      client.openInterest(instrument),
    ]);

    inserted += Number(write('ticker', instrument, ticker.ts, ticker));
    for (const trade of trades) inserted += Number(store.putTrade(trade));
    const bestAsk = book.asks[0]?.price;
    const bestBid = book.bids[0]?.price;
    if (!Number.isFinite(bestAsk) || !Number.isFinite(bestBid)) {
      throw new Error(`order book for ${instrument} has no finite best prices`);
    }
    const midPx = (bestAsk + bestBid) / 2;
    inserted += Number(write('order_book', instrument, book.ts, {
      ...book,
      midPx,
      spreadBps: ((bestAsk - bestBid) / midPx) * 10_000,
    }));
    inserted += Number(write('mark_price', instrument, mark.ts, mark));
    inserted += Number(write('index_price', instrument, index.ts, index));
    inserted += Number(write('funding', instrument, funding.ts, funding));
    inserted += Number(write('open_interest', instrument, oi.ts, oi));

    // Metadata is source-stamped at process time because OKX instrument rows have no timestamp.
    const metadataAt = Date.now();
    inserted += Number(write('instrument_metadata', instrument, metadataAt, specFor(instrument)));

    for (const timeframe of ['1m', '1H', '4H']) {
      const candles = await client.candles(instrument, timeframe, { limit: 2 });
      for (const candle of candles) inserted += Number(write('candle', instrument, candle.ts, candle, timeframe));
    }
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: EVENT_NAME,
    inserted,
    total: store.count(),
    trades: store.tradeCount(),
    instruments: tradableUniverse().length,
    requests: client.stats.requests,
  }));
} finally {
  store.close();
}
