/**
 * IDEMPOTENCY.
 *
 * Every order carries its signal id as the client order id. Before placing, the venue is asked
 * whether an order with that id already exists — so a retried signal never opens a second
 * position.
 *
 * Intent is PERSISTED BEFORE the order is placed. A crash between the two is therefore
 * recoverable: on boot, any intent without a confirmed order is reconciled against the venue
 * rather than assumed lost. The alternative — placing first and recording after — loses a real
 * position on a crash, which is the failure that cannot be repaired.
 */

import Database from 'better-sqlite3';

export type IntentStatus = 'pending' | 'placed' | 'failed' | 'abandoned';

export interface OrderIntent {
  readonly signalId: string;
  readonly clOrdId: string;
  readonly instId: string;
  readonly side: 'buy' | 'sell';
  readonly posSide: 'long' | 'short';
  readonly sz: number;
  readonly stopPrice: number;
  readonly status: IntentStatus;
  readonly ordId: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly note: string | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS order_intents (
  cl_ord_id  TEXT PRIMARY KEY,
  signal_id  TEXT NOT NULL,
  inst_id    TEXT NOT NULL,
  side       TEXT NOT NULL,
  pos_side   TEXT NOT NULL,
  sz         REAL NOT NULL,
  stop_price REAL NOT NULL,
  status     TEXT NOT NULL,
  ord_id     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON order_intents(status);
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  signal_id  TEXT,
  inst_id    TEXT,
  detail     TEXT NOT NULL
);
`;

interface Row {
  cl_ord_id: string;
  signal_id: string;
  inst_id: string;
  side: string;
  pos_side: string;
  sz: number;
  stop_price: number;
  status: string;
  ord_id: string | null;
  created_at: number;
  updated_at: number;
  note: string | null;
}

const toIntent = (row: Row): OrderIntent => ({
  signalId: row.signal_id,
  clOrdId: row.cl_ord_id,
  instId: row.inst_id,
  side: row.side as 'buy' | 'sell',
  posSide: row.pos_side as 'long' | 'short',
  sz: row.sz,
  stopPrice: row.stop_price,
  status: row.status as IntentStatus,
  ordId: row.ord_id ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  note: row.note ?? undefined,
});

export interface LedgerEntry {
  readonly ts: number;
  readonly kind: string;
  readonly signalId: string | undefined;
  readonly instId: string | undefined;
  readonly detail: string;
}

export class IntentStore {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    // FULL, not NORMAL: an intent that is not on disk before the order is placed defeats the
    // entire point of writing it first.
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
  }

  /**
   * Record the intent to place an order. Returns the EXISTING intent if one is already recorded
   * for this client order id — the first line of defence against a replayed signal.
   */
  recordIntent(
    intent: Omit<OrderIntent, 'status' | 'ordId' | 'updatedAt' | 'note'>,
    nowMs: number,
  ): { readonly intent: OrderIntent; readonly alreadyExisted: boolean } {
    const existing = this.get(intent.clOrdId);
    if (existing !== undefined) return { intent: existing, alreadyExisted: true };

    this.db
      .prepare(
        `INSERT INTO order_intents
           (cl_ord_id, signal_id, inst_id, side, pos_side, sz, stop_price, status, ord_id, created_at, updated_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      )
      .run(
        intent.clOrdId,
        intent.signalId,
        intent.instId,
        intent.side,
        intent.posSide,
        intent.sz,
        intent.stopPrice,
        intent.createdAt,
        nowMs,
      );
    return { intent: this.get(intent.clOrdId) as OrderIntent, alreadyExisted: false };
  }

  markPlaced(clOrdId: string, ordId: string, nowMs: number): void {
    this.db
      .prepare("UPDATE order_intents SET status = 'placed', ord_id = ?, updated_at = ? WHERE cl_ord_id = ?")
      .run(ordId, nowMs, clOrdId);
  }

  markFailed(clOrdId: string, note: string, nowMs: number): void {
    this.db
      .prepare("UPDATE order_intents SET status = 'failed', updated_at = ?, note = ? WHERE cl_ord_id = ?")
      .run(nowMs, note, clOrdId);
  }

  markAbandoned(clOrdId: string, note: string, nowMs: number): void {
    this.db
      .prepare("UPDATE order_intents SET status = 'abandoned', updated_at = ?, note = ? WHERE cl_ord_id = ?")
      .run(nowMs, note, clOrdId);
  }

  get(clOrdId: string): OrderIntent | undefined {
    const row = this.db
      .prepare<[string], Row>('SELECT * FROM order_intents WHERE cl_ord_id = ?')
      .get(clOrdId);
    return row === undefined ? undefined : toIntent(row);
  }

  bySignal(signalId: string): readonly OrderIntent[] {
    const rows = this.db
      .prepare('SELECT * FROM order_intents WHERE signal_id = ? ORDER BY created_at')
      .all(signalId) as Row[];
    return rows.map(toIntent);
  }

  /** Intents written but never confirmed — what a crash leaves behind. */
  pending(): readonly OrderIntent[] {
    const rows = this.db
      .prepare("SELECT * FROM order_intents WHERE status = 'pending' ORDER BY created_at")
      .all() as Row[];
    return rows.map(toIntent);
  }

  all(): readonly OrderIntent[] {
    const rows = this.db.prepare('SELECT * FROM order_intents ORDER BY created_at').all() as Row[];
    return rows.map(toIntent);
  }

  append(entry: LedgerEntry): void {
    this.db
      .prepare('INSERT INTO ledger (ts, kind, signal_id, inst_id, detail) VALUES (?, ?, ?, ?, ?)')
      .run(entry.ts, entry.kind, entry.signalId ?? null, entry.instId ?? null, entry.detail);
  }

  ledger(limit = 500): readonly LedgerEntry[] {
    const rows = this.db
      .prepare('SELECT ts, kind, signal_id, inst_id, detail FROM ledger ORDER BY id ASC LIMIT ?')
      .all(limit) as Array<{ ts: number; kind: string; signal_id: string | null; inst_id: string | null; detail: string }>;
    return rows.map((r) => ({
      ts: r.ts,
      kind: r.kind,
      signalId: r.signal_id ?? undefined,
      instId: r.inst_id ?? undefined,
      detail: r.detail,
    }));
  }

  close(): void {
    this.db.close();
  }
}
