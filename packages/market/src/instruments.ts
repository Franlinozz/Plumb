/**
 * Instrument specifications — contract value, minimum order size, lot size, tick size.
 *
 * These are what turn a NOTIONAL (USDT) into a SIZE (contracts), which is the arithmetic
 * `@plumb/risk` performs to size a position. Getting `ctVal` wrong is a 100× position-size error
 * on BTC, so the numbers are recorded from the live exchange rather than typed from memory, and
 * a test pins them.
 *
 * Recorded 2026-08-09 from the public `/api/v5/public/instruments` endpoint (no auth).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isInstrument, type Instrument } from '@plumb/core';

import { FIXTURES_DIR } from './fixtures.js';

export interface InstrumentSpec {
  readonly instId: Instrument;
  /** Value of ONE contract, in the base currency. BTC 0.01, ETH 0.1, SOL 1. */
  readonly ctVal: number;
  readonly ctValCcy: string;
  readonly ctMult: number;
  /** Smallest order the exchange will accept, in contracts. */
  readonly minSz: number;
  /** Order size must be a whole multiple of this, in contracts. */
  readonly lotSz: number;
  /** Price increment. */
  readonly tickSz: number;
  readonly settleCcy: string;
  readonly state: string;
}

function load(): Readonly<Record<Instrument, InstrumentSpec>> {
  const raw = readFileSync(join(FIXTURES_DIR, 'instruments.json'), 'utf8');
  const envelope = JSON.parse(raw) as { data: ReadonlyArray<Record<string, string>> };
  const out: Partial<Record<Instrument, InstrumentSpec>> = {};
  for (const row of envelope.data) {
    const instId = row['instId'] ?? '';
    if (!isInstrument(instId)) continue;
    out[instId] = Object.freeze({
      instId,
      ctVal: Number(row['ctVal']),
      ctValCcy: row['ctValCcy'] ?? '',
      ctMult: Number(row['ctMult'] ?? '1'),
      minSz: Number(row['minSz']),
      lotSz: Number(row['lotSz']),
      tickSz: Number(row['tickSz']),
      settleCcy: row['settleCcy'] ?? '',
      state: row['state'] ?? '',
    });
  }
  return Object.freeze(out as Record<Instrument, InstrumentSpec>);
}

export const INSTRUMENT_SPECS = load();

export function specFor(instId: Instrument): InstrumentSpec {
  const spec = INSTRUMENT_SPECS[instId];
  if (spec === undefined) throw new RangeError(`no instrument spec recorded for ${instId}`);
  return spec;
}

/** Notional (USDT) → whole contracts, rounded DOWN to the lot size. */
export function notionalToContracts(
  notionalUsdt: number,
  price: number,
  spec: InstrumentSpec,
): number {
  if (price <= 0 || spec.ctVal <= 0 || spec.lotSz <= 0) return 0;
  const raw = notionalUsdt / (price * spec.ctVal * spec.ctMult);
  // DOWN, always. Rounding up would push the realised risk above the budget, and the whole
  // point of sizing from the stop is that the budget is never exceeded.
  const lots = Math.floor(raw / spec.lotSz);
  return roundToLot(lots * spec.lotSz, spec.lotSz);
}

/** Contracts → notional (USDT). */
export function contractsToNotional(
  contracts: number,
  price: number,
  spec: InstrumentSpec,
): number {
  return contracts * price * spec.ctVal * spec.ctMult;
}

/**
 * Snap to the lot grid without floating-point dust.
 *
 * `0.1 + 0.2 !== 0.3`, and a size of `0.30000000000000004` contracts is rejected by the exchange
 * for reasons that read as a mystery in a log. Lot sizes are decimal, so the rounding is done in
 * integer lot units and then scaled back.
 */
export function roundToLot(size: number, lotSz: number): number {
  if (lotSz <= 0) return size;
  const decimals = decimalsOf(lotSz);
  return Number((Math.round(size / lotSz) * lotSz).toFixed(decimals));
}

function decimalsOf(step: number): number {
  const text = step.toString();
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}
