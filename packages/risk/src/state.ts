/**
 * PERSISTED governor state.
 *
 * Guardrail 6: a crash or restart never resets a counter. Every mutation is written BEFORE it is
 * acted upon, and loading state on boot restores every halt flag — **a killed system stays killed
 * across restarts, always**. A kill switch that a restart clears is not a kill switch.
 *
 * `better-sqlite3` is synchronous, so this is a thin synchronous layer with no async wrappers
 * pretending otherwise (AGENTS.md gotcha 4).
 */

import Database from 'better-sqlite3';
import { utcDayKey, type Instrument } from '@plumb/core';

import { LOCKED } from './params.js';

export type HaltFlag =
  | 'killSwitch'
  | 'dailyLimit'
  | 'manual'
  | 'dataStale'
  | 'reconcileMismatch';

export const HALT_FLAGS: readonly HaltFlag[] = Object.freeze([
  'killSwitch',
  'dailyLimit',
  'manual',
  'dataStale',
  'reconcileMismatch',
]);

export interface OpenPosition {
  readonly instId: Instrument;
  readonly side: 'long' | 'short';
  readonly contracts: number;
  readonly notionalUsdt: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly openedAt: number;
  readonly signalId: string;
}

export interface GovernorState {
  readonly equity: number;
  readonly peakEquity: number;
  readonly startingEquity: number;
  readonly realisedPnlToday: number;
  /** UTC day key (`YYYY-MM-DD`) the daily counter belongs to. */
  readonly dailyResetAtUtc: string;
  readonly openPositions: readonly OpenPosition[];
  readonly totalNotional: number;
  readonly haltFlags: Readonly<Record<HaltFlag, boolean>>;
  readonly haltReason: string | undefined;
  readonly haltedAt: number | undefined;
  readonly consecutiveLosses: number;
  readonly lastSignalAt: number | undefined;
}

export function initialState(nowMs: number, startingEquity: number = LOCKED.CAPITAL_USDT): GovernorState {
  return {
    equity: startingEquity,
    peakEquity: startingEquity,
    startingEquity,
    realisedPnlToday: 0,
    dailyResetAtUtc: utcDayKey(nowMs),
    openPositions: [],
    totalNotional: 0,
    haltFlags: {
      killSwitch: false,
      dailyLimit: false,
      manual: false,
      dataStale: false,
      reconcileMismatch: false,
    },
    haltReason: undefined,
    haltedAt: undefined,
    consecutiveLosses: 0,
    lastSignalAt: undefined,
  };
}

export function anyHaltSet(state: GovernorState): HaltFlag | undefined {
  return HALT_FLAGS.find((flag) => state.haltFlags[flag]);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS governor_state (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT    NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS governor_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  reason  TEXT    NOT NULL,
  actor   TEXT,
  payload TEXT
);
`;

export interface AuditRecord {
  readonly ts: number;
  readonly kind: string;
  readonly reason: string;
  readonly actor: string | undefined;
  readonly payload: Readonly<Record<string, unknown>> | undefined;
}

export class GovernorStore {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(SCHEMA);
  }

  /** Load persisted state, or seed it. Halt flags come back exactly as they were left. */
  load(nowMs: number, startingEquity: number = LOCKED.CAPITAL_USDT): GovernorState {
    const row = this.db
      .prepare<[], { payload: string }>('SELECT payload FROM governor_state WHERE id = 1')
      .get();
    if (row === undefined) {
      const seeded = initialState(nowMs, startingEquity);
      this.save(seeded, nowMs);
      return seeded;
    }
    return JSON.parse(row.payload) as GovernorState;
  }

  /**
   * Persist. Called BEFORE the decision it records is acted upon, so a crash between the two
   * leaves the system more cautious than the world, never less.
   */
  save(state: GovernorState, nowMs: number): void {
    this.db
      .prepare('INSERT INTO governor_state (id, payload, updated) VALUES (1, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated = excluded.updated')
      .run(JSON.stringify(state), nowMs);
  }

  appendAudit(record: AuditRecord): void {
    this.db
      .prepare('INSERT INTO governor_audit (ts, kind, reason, actor, payload) VALUES (?, ?, ?, ?, ?)')
      .run(
        record.ts,
        record.kind,
        record.reason,
        record.actor ?? null,
        record.payload === undefined ? null : JSON.stringify(record.payload),
      );
  }

  audit(limit = 100): readonly AuditRecord[] {
    const rows = this.db
      .prepare('SELECT ts, kind, reason, actor, payload FROM governor_audit ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{
      ts: number;
      kind: string;
      reason: string;
      actor: string | null;
      payload: string | null;
    }>;
    return rows.map((row) => ({
      ts: row.ts,
      kind: row.kind,
      reason: row.reason,
      actor: row.actor ?? undefined,
      payload: row.payload === null ? undefined : (JSON.parse(row.payload) as Record<string, unknown>),
    }));
  }

  close(): void {
    this.db.close();
  }
}

/** Roll the daily counter when the UTC day changes. Explicit, never implicit (gotcha 8). */
export function rollDailyIfNeeded(state: GovernorState, nowMs: number): GovernorState {
  const today = utcDayKey(nowMs);
  if (today === state.dailyResetAtUtc) return state;
  return {
    ...state,
    realisedPnlToday: 0,
    dailyResetAtUtc: today,
    // The daily halt is the ONLY flag a new day clears. The kill switch is permanent, and a
    // manual halt is the operator's to lift.
    haltFlags: { ...state.haltFlags, dailyLimit: false },
    ...(state.haltFlags.dailyLimit && anyHaltSetExcept(state, 'dailyLimit') === undefined
      ? { haltReason: undefined, haltedAt: undefined }
      : {}),
  };
}

function anyHaltSetExcept(state: GovernorState, except: HaltFlag): HaltFlag | undefined {
  return HALT_FLAGS.find((flag) => flag !== except && state.haltFlags[flag]);
}

export function withHalt(
  state: GovernorState,
  flag: HaltFlag,
  reason: string,
  nowMs: number,
): GovernorState {
  return {
    ...state,
    haltFlags: { ...state.haltFlags, [flag]: true },
    haltReason: reason,
    haltedAt: nowMs,
  };
}
