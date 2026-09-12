import Database from 'better-sqlite3';

import type { Instrument } from '@plumb/core';

export interface CompetitionLedgerPosition {
  readonly instrument: Instrument;
  readonly signedPosition: number;
  readonly decisionId: string;
  readonly orderId: string;
  readonly updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS competition_positions (
  instrument TEXT PRIMARY KEY,
  signed_position REAL NOT NULL,
  decision_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class CompetitionLedgerStore {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
  }

  get(instrument: Instrument): CompetitionLedgerPosition | undefined {
    const row = this.db.prepare<[string], {
      instrument: Instrument; signed_position: number; decision_id: string; order_id: string; updated_at: number;
    }>('SELECT * FROM competition_positions WHERE instrument=?').get(instrument);
    return row === undefined ? undefined : {
      instrument: row.instrument, signedPosition: row.signed_position, decisionId: row.decision_id,
      orderId: row.order_id, updatedAt: row.updated_at,
    };
  }

  set(position: CompetitionLedgerPosition): void {
    this.db.prepare(`
      INSERT INTO competition_positions(instrument,signed_position,decision_id,order_id,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(instrument) DO UPDATE SET signed_position=excluded.signed_position,
        decision_id=excluded.decision_id,order_id=excluded.order_id,updated_at=excluded.updated_at
    `).run(position.instrument, position.signedPosition, position.decisionId, position.orderId, position.updatedAt);
  }

  close(): void { this.db.close(); }
}
