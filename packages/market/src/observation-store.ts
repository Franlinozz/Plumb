import Database from 'better-sqlite3';

import type { Instrument } from '@plumb/core';
import type { MarketTrade } from './types.js';

export type ObservationKind =
  | 'ticker'
  | 'mark_price'
  | 'index_price'
  | 'funding'
  | 'open_interest'
  | 'order_book'
  | 'candle'
  | 'instrument_metadata';

export interface MarketObservation {
  readonly kind: ObservationKind;
  readonly instrument: Instrument;
  readonly sourceTs: number;
  readonly recordedAt: number;
  readonly timeframe?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS market_observations (
  kind        TEXT    NOT NULL,
  instrument  TEXT    NOT NULL,
  source_ts   INTEGER NOT NULL,
  timeframe   TEXT    NOT NULL DEFAULT '',
  recorded_at INTEGER NOT NULL,
  payload     TEXT    NOT NULL,
  PRIMARY KEY (kind, instrument, source_ts, timeframe)
);
CREATE INDEX IF NOT EXISTS market_observations_recorded
  ON market_observations(recorded_at);
CREATE TABLE IF NOT EXISTS market_trades (
  instrument  TEXT    NOT NULL,
  trade_id    TEXT    NOT NULL,
  source_ts   INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  price       REAL    NOT NULL,
  size        REAL    NOT NULL,
  side        TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  payload     TEXT    NOT NULL,
  PRIMARY KEY (instrument, trade_id)
);
CREATE INDEX IF NOT EXISTS market_trades_recorded
  ON market_trades(recorded_at);
`;

/** Durable, restart-safe storage for public OKX observations. Duplicate samples are ignored. */
export class MarketObservationStore {
  private readonly db: Database.Database;
  private readonly insert;
  private readonly finalizeCandle;
  private readonly insertTrade;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO market_observations
        (kind, instrument, source_ts, timeframe, recorded_at, payload)
      VALUES
        (@kind, @instrument, @sourceTs, @timeframe, @recordedAt, @payload)
    `);
    // OKX returns the currently-forming candle on every poll. The recorder may therefore see the
    // same source timestamp first with confirm=0/closed=false and later with confirm=1/closed=true.
    // Preserve immutable observations generally, but allow that one monotonic lifecycle change so
    // research never remains pinned to the first partial OHLCV sample.
    this.finalizeCandle = this.db.prepare(`
      UPDATE market_observations
      SET recorded_at = @recordedAt, payload = @payload
      WHERE kind = 'candle'
        AND instrument = @instrument
        AND source_ts = @sourceTs
        AND timeframe = @timeframe
        AND COALESCE(json_extract(payload, '$.closed'), 0) = 0
        AND json_extract(@payload, '$.closed') = 1
    `);
    this.insertTrade = this.db.prepare(`
      INSERT OR IGNORE INTO market_trades
        (instrument, trade_id, source_ts, recorded_at, price, size, side, payload)
      VALUES
        (@instrument, @tradeId, @sourceTs, @recordedAt, @price, @size, @side, @payload)
    `);
  }

  putTrade(trade: MarketTrade, recordedAt = Date.now()): boolean {
    if (!Number.isFinite(trade.ts) || !Number.isFinite(recordedAt)) {
      throw new TypeError('trade timestamps must be finite UTC epoch milliseconds');
    }
    const result = this.insertTrade.run({
      instrument: trade.instId,
      tradeId: trade.tradeId,
      sourceTs: trade.ts,
      recordedAt,
      price: trade.price,
      size: trade.size,
      side: trade.side,
      payload: JSON.stringify(trade),
    });
    return result.changes === 1;
  }

  put(observation: MarketObservation): boolean {
    if (!Number.isFinite(observation.sourceTs) || !Number.isFinite(observation.recordedAt)) {
      throw new TypeError('observation timestamps must be finite UTC epoch milliseconds');
    }
    const row = {
      kind: observation.kind,
      instrument: observation.instrument,
      sourceTs: observation.sourceTs,
      timeframe: observation.timeframe ?? '',
      recordedAt: observation.recordedAt,
      payload: JSON.stringify(observation.payload),
    };
    if (observation.kind === 'candle' && this.finalizeCandle.run(row).changes === 1) return true;
    const result = this.insert.run(row);
    return result.changes === 1;
  }

  count(): number {
    const row = this.db.prepare<[], { count: number }>('SELECT count(*) AS count FROM market_observations').get();
    return row?.count ?? 0;
  }

  tradeCount(): number {
    const row = this.db.prepare<[], { count: number }>('SELECT count(*) AS count FROM market_trades').get();
    return row?.count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
