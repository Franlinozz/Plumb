import Database from 'better-sqlite3';

import type { DecisionEvent } from '@plumb/core';

export type PublicationStatus = 'pending' | 'delivered' | 'uncertain';

export interface DecisionPublication {
  readonly decisionId: string;
  readonly eventJson: string;
  readonly signalText: string;
  readonly status: PublicationStatus;
  readonly activeCount: number;
  readonly deliveredCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decision_publications (
  decision_id     TEXT PRIMARY KEY,
  event_json      TEXT NOT NULL,
  signal_text     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('pending','delivered','uncertain')),
  active_count    INTEGER NOT NULL,
  delivered_count INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  error           TEXT
);
`;

interface Row {
  decision_id: string;
  event_json: string;
  signal_text: string;
  status: PublicationStatus;
  active_count: number;
  delivered_count: number;
  created_at: string;
  updated_at: string;
  error: string | null;
}

const canonical = (event: DecisionEvent): string => JSON.stringify(event);

export class DecisionPublicationStore {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
    this.db
      .prepare("UPDATE decision_publications SET status='uncertain', updated_at=?, error='restart before all delivery acknowledgements' WHERE status='pending'")
      .run(new Date().toISOString());
  }

  begin(event: DecisionEvent, signalText: string, activeCount: number, now: string): void {
    if (activeCount < 1) throw new Error('cannot publish an executable decision without an active subscriber');
    const existing = this.get(event.decisionId);
    const eventJson = canonical(event);
    if (existing !== undefined) {
      if (existing.eventJson !== eventJson || existing.signalText !== signalText) {
        throw new Error(`decisionId collision with different immutable content: ${event.decisionId}`);
      }
      throw new Error(`duplicate decisionId: ${event.decisionId}`);
    }
    this.db.prepare(`
      INSERT INTO decision_publications
        (decision_id,event_json,signal_text,status,active_count,delivered_count,created_at,updated_at,error)
      VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, NULL)
    `).run(event.decisionId, eventJson, signalText, activeCount, now, now);
  }

  finish(decisionId: string, deliveredCount: number, now: string): void {
    const publication = this.get(decisionId);
    if (publication === undefined) throw new Error(`publication not found: ${decisionId}`);
    if (deliveredCount !== publication.activeCount) {
      this.uncertain(decisionId, deliveredCount, 'not every active subscriber acknowledged delivery', now);
      return;
    }
    this.db.prepare("UPDATE decision_publications SET status='delivered', delivered_count=?, updated_at=?, error=NULL WHERE decision_id=?")
      .run(deliveredCount, now, decisionId);
  }

  uncertain(decisionId: string, deliveredCount: number, error: string, now: string): void {
    this.db.prepare("UPDATE decision_publications SET status='uncertain', delivered_count=?, updated_at=?, error=? WHERE decision_id=?")
      .run(deliveredCount, now, error.slice(0, 500), decisionId);
  }

  get(decisionId: string): DecisionPublication | undefined {
    const row = this.db.prepare<[string], Row>('SELECT * FROM decision_publications WHERE decision_id=?').get(decisionId);
    return row === undefined ? undefined : {
      decisionId: row.decision_id,
      eventJson: row.event_json,
      signalText: row.signal_text,
      status: row.status,
      activeCount: row.active_count,
      deliveredCount: row.delivered_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error ?? undefined,
    };
  }

  isFullyDelivered(event: DecisionEvent): boolean {
    const publication = this.get(event.decisionId);
    return publication !== undefined &&
      publication.eventJson === canonical(event) &&
      publication.status === 'delivered' &&
      publication.activeCount > 0 &&
      publication.deliveredCount === publication.activeCount;
  }

  close(): void {
    this.db.close();
  }
}
