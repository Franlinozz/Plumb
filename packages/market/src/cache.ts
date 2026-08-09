/**
 * The candle store: in-memory tail cache over a SQLite table.
 *
 * Two rules govern it, and both come from the same fact — **a closed candle is immutable**:
 *
 *  1. A closed candle already in the store is NEVER overwritten. If the exchange returns a
 *     different value for a bar we already sealed, that is a data-integrity event worth
 *     surfacing (`skippedImmutable`), not a silent update.
 *  2. History is persisted, so a restart never re-downloads it. Six months of 15m candles is
 *     tens of thousands of rows and hundreds of requests; paying that twice is a bug.
 *
 * `better-sqlite3` is synchronous, so this is a thin synchronous layer with no async wrappers
 * pretending otherwise (AGENTS.md gotcha 4).
 */

import Database from 'better-sqlite3';

import type { Candle, Timeframe } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  inst_id      TEXT    NOT NULL,
  tf           TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  open         REAL    NOT NULL,
  high         REAL    NOT NULL,
  low          REAL    NOT NULL,
  close        REAL    NOT NULL,
  volume       REAL    NOT NULL,
  volume_ccy   REAL    NOT NULL,
  volume_quote REAL    NOT NULL,
  closed       INTEGER NOT NULL,
  PRIMARY KEY (inst_id, tf, ts)
) WITHOUT ROWID;
`;

interface Row {
  readonly ts: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly volume_ccy: number;
  readonly volume_quote: number;
  readonly closed: number;
}

function toCandle(row: Row): Candle {
  return Object.freeze({
    ts: row.ts,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    volumeCcy: row.volume_ccy,
    volumeQuote: row.volume_quote,
    closed: row.closed === 1,
  });
}

export interface PutResult {
  readonly inserted: number;
  /** Rows that existed but were still forming, so the newer version replaced them. */
  readonly updated: number;
  /** Rows already stored as CLOSED. Left untouched — closed candles are immutable. */
  readonly skippedImmutable: number;
}

export interface GetCandlesOptions {
  /** Inclusive lower bound on candle ts. */
  readonly fromTs?: number;
  /** Inclusive upper bound on candle ts. */
  readonly toTs?: number;
  /** Return only finalised bars. */
  readonly closedOnly?: boolean;
  /** Cap the result to the most recent N, still returned oldest-first. */
  readonly limit?: number;
}

/** How many candles per (instrument, timeframe) the memory tier keeps hot. */
const MEMO_TAIL = 400;

export class CandleStore {
  private readonly db: Database.Database;
  private readonly memo = new Map<string, readonly Candle[]>();

  /**
   * @param path a filesystem path, or `':memory:'` for a throwaway store. Tests and
   *   `PLUMB_MODE=fake` use `':memory:'`; nothing in this class reaches the network.
   */
  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  /**
   * Insert candles, honouring immutability. Runs in a single transaction: either the whole
   * batch lands or none of it does, so a crash mid-write cannot leave a half-written page.
   */
  putCandles(instId: string, tf: Timeframe, candles: readonly Candle[]): PutResult {
    const existing = this.db.prepare<[string, string, number], { closed: number }>(
      'SELECT closed FROM candles WHERE inst_id = ? AND tf = ? AND ts = ?',
    );
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO candles
         (inst_id, tf, ts, open, high, low, close, volume, volume_ccy, volume_quote, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let inserted = 0;
    let updated = 0;
    let skippedImmutable = 0;

    this.db.transaction(() => {
      for (const c of candles) {
        const prior = existing.get(instId, tf, c.ts);
        if (prior !== undefined && prior.closed === 1) {
          skippedImmutable += 1;
          continue;
        }
        insert.run(
          instId,
          tf,
          c.ts,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          c.volumeCcy,
          c.volumeQuote,
          c.closed ? 1 : 0,
        );
        if (prior === undefined) inserted += 1;
        else updated += 1;
      }
    })();

    this.memo.delete(key(instId, tf));
    return { inserted, updated, skippedImmutable };
  }

  /** Candles in chronological order. */
  getCandles(instId: string, tf: Timeframe, options: GetCandlesOptions = {}): readonly Candle[] {
    const clauses = ['inst_id = ?', 'tf = ?'];
    const params: (string | number)[] = [instId, tf];
    if (options.fromTs !== undefined) {
      clauses.push('ts >= ?');
      params.push(options.fromTs);
    }
    if (options.toTs !== undefined) {
      clauses.push('ts <= ?');
      params.push(options.toTs);
    }
    if (options.closedOnly === true) clauses.push('closed = 1');

    // Take the newest N in the window, then flip to chronological order.
    const sql =
      `SELECT * FROM candles WHERE ${clauses.join(' AND ')} ORDER BY ts DESC` +
      (options.limit === undefined ? '' : ' LIMIT ?');
    if (options.limit !== undefined) params.push(options.limit);

    const rows = this.db.prepare(sql).all(...params) as Row[];
    return Object.freeze(rows.reverse().map(toCandle));
  }

  /**
   * The most recent `limit` candles, served from memory when possible.
   *
   * This is the hot path — a snapshot is built every cycle and asks for the same tail each
   * time. The memo is invalidated on every write, so it can never serve a stale bar.
   */
  recent(instId: string, tf: Timeframe, limit: number): readonly Candle[] {
    const k = key(instId, tf);
    const cached = this.memo.get(k);
    if (cached !== undefined && cached.length >= limit) {
      return Object.freeze(cached.slice(cached.length - limit));
    }
    const tail = this.getCandles(instId, tf, { limit: Math.max(limit, MEMO_TAIL) });
    this.memo.set(k, tail);
    return tail.length <= limit ? tail : Object.freeze(tail.slice(tail.length - limit));
  }

  newestTs(instId: string, tf: Timeframe): number | undefined {
    return this.scalar('SELECT MAX(ts) AS v FROM candles WHERE inst_id = ? AND tf = ?', instId, tf);
  }

  oldestTs(instId: string, tf: Timeframe): number | undefined {
    return this.scalar('SELECT MIN(ts) AS v FROM candles WHERE inst_id = ? AND tf = ?', instId, tf);
  }

  newestClosedTs(instId: string, tf: Timeframe): number | undefined {
    return this.scalar(
      'SELECT MAX(ts) AS v FROM candles WHERE inst_id = ? AND tf = ? AND closed = 1',
      instId,
      tf,
    );
  }

  count(instId: string, tf: Timeframe): number {
    return (
      this.scalar('SELECT COUNT(*) AS v FROM candles WHERE inst_id = ? AND tf = ?', instId, tf) ?? 0
    );
  }

  /** How many finalised bars sit in `[fromTs, toTs]`. Used to skip already-downloaded pages. */
  countClosedBetween(instId: string, tf: Timeframe, fromTs: number, toTs: number): number {
    const row = this.db
      .prepare<[string, string, number, number], { v: number }>(
        `SELECT COUNT(*) AS v FROM candles
          WHERE inst_id = ? AND tf = ? AND closed = 1 AND ts >= ? AND ts <= ?`,
      )
      .get(instId, tf, fromTs, toTs);
    return row?.v ?? 0;
  }

  hasClosed(instId: string, tf: Timeframe, ts: number): boolean {
    const row = this.db
      .prepare<[string, string, number], { v: number }>(
        'SELECT COUNT(*) AS v FROM candles WHERE inst_id = ? AND tf = ? AND ts = ? AND closed = 1',
      )
      .get(instId, tf, ts);
    return (row?.v ?? 0) > 0;
  }

  /** Row counts per (instrument, timeframe) — what the phase checkpoint reports. */
  inventory(): ReadonlyArray<{
    readonly instId: string;
    readonly tf: string;
    readonly rows: number;
    readonly oldestTs: number;
    readonly newestTs: number;
  }> {
    return this.db
      .prepare(
        `SELECT inst_id AS instId, tf, COUNT(*) AS rows, MIN(ts) AS oldestTs, MAX(ts) AS newestTs
           FROM candles GROUP BY inst_id, tf ORDER BY inst_id, tf`,
      )
      .all() as ReturnType<CandleStore['inventory']>[number][];
  }

  close(): void {
    this.db.close();
  }

  private scalar(sql: string, instId: string, tf: string): number | undefined {
    const row = this.db.prepare<[string, string], { v: number | null }>(sql).get(instId, tf);
    return row?.v ?? undefined;
  }
}

function key(instId: string, tf: string): string {
  return `${instId}|${tf}`;
}
