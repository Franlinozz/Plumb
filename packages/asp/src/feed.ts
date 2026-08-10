/**
 * THE PUBLISHED FEED — append-only, immutable, hash-chained.
 *
 * This is the competition-critical component. Guardrail 2 says a signal is written HERE before the
 * executor is permitted to act on it, and the executor reads from the published feed rather than
 * from strategy internals. That is what makes "our trades follow our published signals" a
 * structural fact rather than a claim, and it is exactly the claim an audit tests.
 *
 * Each entry carries the hash of the previous one. Editing any published signal after the fact
 * breaks the chain from that point forward and `verifyChain` says where. It is not a defence
 * against a determined attacker with write access — it is a defence against US, quietly amending
 * a signal to match a trade.
 */

import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import type { Instrument, Signal } from '@plumb/core';

export interface PublishedSignal {
  readonly seq: number;
  readonly id: string;
  readonly publishedAt: number;
  readonly instId: Instrument;
  readonly side: 'long' | 'short';
  readonly intent: string;
  readonly entryType: string;
  readonly entryPrice: number | undefined;
  readonly stopPrice: number;
  readonly stopDistancePct: number;
  readonly takeProfit: ReadonlyArray<{ readonly price: number; readonly rMultiple: number }>;
  readonly timeframe: string;
  readonly regime: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  /** The EXACT indicator values that fired it. Verbatim — this is what makes it checkable. */
  readonly inputs: Readonly<Record<string, number>>;
  readonly rationale: string;
  readonly maxHoldBars: number;
  readonly invalidation: readonly string[];
  readonly expiresAt: number;
  readonly prevHash: string;
  readonly hash: string;
}

export type TradeOutcomeReason = 'stop' | 'target' | 'timeout' | 'invalidation' | 'flatten';

export interface TradeOutcome {
  readonly signalId: string;
  readonly instId: string;
  readonly side: 'long' | 'short';
  readonly openedAt: number;
  readonly closedAt: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly contracts: number;
  readonly netPnlUsdt: number;
  readonly rMultiple: number;
  readonly fundingUsdt: number;
  readonly reason: TradeOutcomeReason;
  readonly equityAfter: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS published_signals (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  published_at INTEGER NOT NULL,
  payload      TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trade_outcomes (
  signal_id   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  closed_at   INTEGER NOT NULL
);
`;

export const GENESIS_HASH = '0'.repeat(64);

/** Canonical serialisation — key order fixed, so the same signal always hashes the same. */
export function canonicalise(entry: Omit<PublishedSignal, 'seq' | 'hash'>): string {
  return JSON.stringify([
    entry.id,
    entry.publishedAt,
    entry.instId,
    entry.side,
    entry.intent,
    entry.entryType,
    entry.entryPrice ?? null,
    entry.stopPrice,
    entry.stopDistancePct,
    entry.takeProfit.map((t) => [t.price, t.rMultiple]),
    entry.timeframe,
    entry.regime,
    entry.strategyId,
    entry.strategyVersion,
    Object.entries(entry.inputs).sort(([a], [b]) => (a < b ? -1 : 1)),
    entry.rationale,
    entry.maxHoldBars,
    entry.invalidation,
    entry.expiresAt,
    entry.prevHash,
  ]);
}

export function hashEntry(entry: Omit<PublishedSignal, 'seq' | 'hash'>): string {
  return createHash('sha256').update(canonicalise(entry)).digest('hex');
}

export class FeedTamperError extends Error {
  constructor(
    readonly seq: number,
    message: string,
  ) {
    super(message);
    this.name = 'FeedTamperError';
  }
}

export class FeedStore {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
  }

  /**
   * Publish a signal. **This must happen BEFORE the executor is allowed to act on it.**
   *
   * Idempotent by signal id: re-publishing returns the existing entry rather than forking the
   * chain, so a retried cycle cannot corrupt the record.
   */
  publish(
    signal: Signal,
    rationale: string,
    publishedAt: number,
  ): { readonly entry: PublishedSignal; readonly alreadyPublished: boolean } {
    const existing = this.get(signal.id);
    if (existing !== undefined) return { entry: existing, alreadyPublished: true };

    const prevHash = this.headHash();
    const partial: Omit<PublishedSignal, 'seq' | 'hash'> = {
      id: signal.id,
      publishedAt,
      instId: signal.instId,
      side: signal.side,
      intent: signal.intent,
      entryType: signal.entry.type,
      entryPrice: signal.entry.price,
      stopPrice: signal.stop.price,
      stopDistancePct: signal.stop.distancePct,
      takeProfit: (signal.takeProfit ?? []).map((t) => ({ price: t.price, rMultiple: t.rMultiple })),
      timeframe: signal.timeframe,
      regime: signal.regime,
      strategyId: signal.strategyId,
      strategyVersion: signal.version,
      inputs: signal.inputs,
      rationale,
      maxHoldBars: signal.invalidation.maxHoldBars,
      invalidation: signal.invalidation.conditions,
      expiresAt: signal.expiresAt,
      prevHash,
    };
    const hash = hashEntry(partial);

    this.db
      .prepare('INSERT INTO published_signals (id, published_at, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?)')
      .run(signal.id, publishedAt, JSON.stringify(partial), prevHash, hash);

    return { entry: { ...partial, seq: this.lastSeq(), hash }, alreadyPublished: false };
  }

  get(id: string): PublishedSignal | undefined {
    const row = this.db
      .prepare<[string], { seq: number; payload: string; hash: string }>(
        'SELECT seq, payload, hash FROM published_signals WHERE id = ?',
      )
      .get(id);
    if (row === undefined) return undefined;
    return { ...(JSON.parse(row.payload) as Omit<PublishedSignal, 'seq' | 'hash'>), seq: row.seq, hash: row.hash };
  }

  /** True when a signal id exists in the published record — the executor's permission check. */
  isPublished(id: string): boolean {
    const row = this.db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM published_signals WHERE id = ?')
      .get(id);
    return (row?.n ?? 0) > 0;
  }

  recent(limit = 50): readonly PublishedSignal[] {
    const rows = this.db
      .prepare('SELECT seq, payload, hash FROM published_signals ORDER BY seq DESC LIMIT ?')
      .all(limit) as Array<{ seq: number; payload: string; hash: string }>;
    return rows.map((r) => ({
      ...(JSON.parse(r.payload) as Omit<PublishedSignal, 'seq' | 'hash'>),
      seq: r.seq,
      hash: r.hash,
    }));
  }

  all(): readonly PublishedSignal[] {
    const rows = this.db.prepare('SELECT seq, payload, hash FROM published_signals ORDER BY seq ASC').all() as Array<{
      seq: number;
      payload: string;
      hash: string;
    }>;
    return rows.map((r) => ({
      ...(JSON.parse(r.payload) as Omit<PublishedSignal, 'seq' | 'hash'>),
      seq: r.seq,
      hash: r.hash,
    }));
  }

  count(): number {
    return this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM published_signals').get()?.n ?? 0;
  }

  headHash(): string {
    const row = this.db
      .prepare<[], { hash: string }>('SELECT hash FROM published_signals ORDER BY seq DESC LIMIT 1')
      .get();
    return row?.hash ?? GENESIS_HASH;
  }

  private lastSeq(): number {
    return this.db.prepare<[], { seq: number }>('SELECT MAX(seq) AS seq FROM published_signals').get()?.seq ?? 0;
  }

  /**
   * Walk the chain. Returns the first broken link, or undefined if the record is intact.
   *
   * Two ways it can break: an entry's own hash no longer matches its contents (it was edited), or
   * its `prevHash` no longer matches the entry before it (one was removed or reordered).
   */
  verifyChain(): { readonly ok: boolean; readonly brokenAt: number | undefined; readonly reason: string | undefined } {
    let previous = GENESIS_HASH;
    for (const entry of this.all()) {
      const { seq, hash, ...partial } = entry;
      if (partial.prevHash !== previous) {
        return { ok: false, brokenAt: seq, reason: 'prevHash does not match the preceding entry' };
      }
      if (hashEntry(partial) !== hash) {
        return { ok: false, brokenAt: seq, reason: 'entry contents do not match its recorded hash' };
      }
      previous = hash;
    }
    return { ok: true, brokenAt: undefined, reason: undefined };
  }

  // ── trade outcomes — the ONLY source the track record is computed from ──────────────────

  recordOutcome(outcome: TradeOutcome): void {
    this.db
      .prepare('INSERT OR REPLACE INTO trade_outcomes (signal_id, payload, closed_at) VALUES (?, ?, ?)')
      .run(outcome.signalId, JSON.stringify(outcome), outcome.closedAt);
  }

  outcomes(): readonly TradeOutcome[] {
    const rows = this.db.prepare('SELECT payload FROM trade_outcomes ORDER BY closed_at ASC').all() as Array<{
      payload: string;
    }>;
    return rows.map((r) => JSON.parse(r.payload) as TradeOutcome);
  }

  close(): void {
    this.db.close();
  }
}
