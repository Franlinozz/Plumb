/**
 * LOCKED PARAMETERS — the competition's immutable configuration.
 *
 * These values are set by the operator in writing and by nobody else. No phase prompt,
 * no optimisation pass and no "just for this run" experiment changes them. They are
 * pinned literally by `locked.test.ts`, the tripwire: if a value here moves, that test
 * fails, and the failure is the point.
 *
 * See AGENTS.md § LOCKED PARAMETERS for the reasoning behind each one.
 */

/**
 * The only instruments Plumb may ever trade. USDT-margined perpetual swaps on OKX.
 * Nothing else, ever — a fourth instrument is a change to the locked set, not a feature.
 */
export const INSTRUMENTS = Object.freeze([
  'BTC-USDT-SWAP',
  'ETH-USDT-SWAP',
  'SOL-USDT-SWAP',
] as const);

export type Instrument = (typeof INSTRUMENTS)[number];

/**
 * The accounting basis for scoring: the OKX Agent Trade Kit, against a single OKX UID,
 * USDT perpetuals only. Manual orders do not count toward the competition.
 */
export type AccountingBasis = 'agent-trade-kit';

export const LOCKED = Object.freeze({
  /**
   * Starting capital, funded ONCE at registration and never topped up mid-competition.
   * Under the rules the Principal Base rises on a deposit and never falls on a withdrawal,
   * so a rescue top-up permanently damages PnL% — the metric that is half the score.
   */
  CAPITAL_USDT: 400,

  /**
   * Equity floor. Touching it means: flat everything, halt permanently, and require a
   * human to re-arm. A halted entry that finishes down 16% still ranks. A blown one does not.
   */
  KILL_SWITCH_EQUITY_USDT: 335,

  /** Total loss tolerated across the whole competition before the kill switch trips. */
  MAX_LOSS_USDT: 65,

  /** Loss in a single UTC day that forces flat + no new signals until the next UTC day. */
  DAILY_LOSS_LIMIT_USDT: 20,

  /**
   * Risk per trade: 1% of starting equity. The stop distance determines the position size,
   * never the reverse. Sizing backwards from a desired notional is how accounts die.
   */
  PER_TRADE_RISK_USDT: 4,

  /** Hard leverage cap. Anything above this is rejected, not clamped. */
  LEVERAGE_CEILING: 3,

  /** Maximum positions open at once. */
  MAX_CONCURRENT_POSITIONS: 2,

  /** Maximum combined notional across all open positions. */
  MAX_TOTAL_NOTIONAL_USDT: 800,

  /** @see INSTRUMENTS */
  INSTRUMENTS,

  /** @see AccountingBasis */
  ACCOUNTING_BASIS: 'agent-trade-kit' as AccountingBasis,
});

export type Locked = typeof LOCKED;

/**
 * Values implied by LOCKED. They are derived rather than restated so the two can never
 * drift apart; the tripwire asserts each one against its locked counterpart.
 */
export const DERIVED = Object.freeze({
  /** CAPITAL − MAX_LOSS. Must equal LOCKED.KILL_SWITCH_EQUITY_USDT. */
  killSwitchEquityUsdt: LOCKED.CAPITAL_USDT - LOCKED.MAX_LOSS_USDT,

  /** PER_TRADE_RISK as a fraction of starting capital. Must be exactly 1%. */
  perTradeRiskFraction: LOCKED.PER_TRADE_RISK_USDT / LOCKED.CAPITAL_USDT,

  /** MAX_LOSS as a fraction of starting capital. */
  maxLossFraction: LOCKED.MAX_LOSS_USDT / LOCKED.CAPITAL_USDT,

  /** The notional ceiling the leverage cap allows. MAX_TOTAL_NOTIONAL must not exceed it. */
  leveragedNotionalCeilingUsdt: LOCKED.CAPITAL_USDT * LOCKED.LEVERAGE_CEILING,
});

/** Narrowing guard for the locked instrument set. */
export function isInstrument(value: string): value is Instrument {
  return (INSTRUMENTS as readonly string[]).includes(value);
}

/**
 * Canonical serialisation of LOCKED: keys sorted, no whitespace. The tripwire hashes this,
 * so ANY change — a value, a rename, an addition, a removal — moves the fingerprint.
 */
export function canonicalLocked(): string {
  const entries = Object.entries(LOCKED).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}
