/** Base for everything this package throws, so a caller can catch one type. */
export class MarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * An instId outside the LOCKED instrument set reached the client.
 *
 * This is thrown, never logged-and-skipped: a request for an instrument we are not allowed
 * to trade is a bug in the caller, and swallowing it would let a fourth instrument creep in.
 */
export class UnsupportedInstrumentError extends MarketError {
  constructor(readonly instId: string) {
    super(
      `instrument "${instId}" is not in the locked set — Plumb trades BTC-USDT-SWAP, ` +
        `ETH-USDT-SWAP and SOL-USDT-SWAP only`,
    );
  }
}

/** OKX answered, but with a non-zero business code. */
export class OkxApiError extends MarketError {
  constructor(
    readonly code: string,
    readonly okxMessage: string,
    readonly path: string,
  ) {
    super(`OKX ${path} returned code ${code}: ${okxMessage || '(no message)'}`);
  }
}

/** A non-2xx HTTP status. */
export class OkxHttpError extends MarketError {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`OKX ${path} returned HTTP ${status}`);
  }
}

/** The request exceeded its per-endpoint timeout budget. */
export class OkxTimeoutError extends MarketError {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`OKX ${path} timed out after ${timeoutMs}ms`);
  }
}

/** The transport failed — DNS, connection reset, TLS. */
export class OkxNetworkError extends MarketError {
  constructor(
    readonly path: string,
    readonly reason: unknown,
  ) {
    super(`OKX ${path} failed: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

/** A field was missing or not a finite number where the shape requires one. */
export class OkxParseError extends MarketError {
  constructor(
    readonly path: string,
    readonly field: string,
    readonly raw: unknown,
  ) {
    super(`OKX ${path}: field "${field}" is not a finite number (got ${JSON.stringify(raw)})`);
  }
}
