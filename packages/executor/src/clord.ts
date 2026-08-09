/**
 * Client order ids.
 *
 * The signal id IS the idempotency key — that is what makes a fill traceable to the signal that
 * caused it, which is the property the whole system exists to guarantee.
 *
 * **Gotcha:** OKX accepts only letters and digits in `clOrdId`, 1–32 characters. Our signal ids
 * look like `SIG-abcDEF_ghi`, which contains a hyphen and can contain an underscore (the nanoid
 * alphabet includes both). Sending one verbatim is rejected by the venue with a message that
 * reads as a mystery. So the id is sanitised on the way out, and the mapping is stored so a fill
 * can always be walked back to its signal.
 */

const MAX_LENGTH = 32;

/** `SIG-abc_DEF-gh` → `SIGabcDEFgh`. Letters and digits only, never longer than 32. */
export function toClOrdId(signalId: string): string {
  const cleaned = signalId.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length === 0) {
    throw new RangeError(`signal id "${signalId}" contains no alphanumeric characters`);
  }
  return cleaned.slice(0, MAX_LENGTH);
}

/** True when a venue clOrdId corresponds to this signal id. */
export function matchesSignal(clOrdId: string, signalId: string): boolean {
  return clOrdId === toClOrdId(signalId);
}

/**
 * Resolve a venue clOrdId back to a signal id, given the ids we know about.
 *
 * Sanitising is lossy, so the reverse direction is a LOOKUP, never a computation. An unmatched
 * clOrdId is exactly the reconciliation alarm — it means a fill exists that we cannot attribute.
 */
export function resolveSignalId(clOrdId: string, knownSignalIds: Iterable<string>): string | undefined {
  for (const signalId of knownSignalIds) {
    if (toClOrdId(signalId) === clOrdId) return signalId;
  }
  return undefined;
}

/** Close orders get a distinct id so an exit is never mistaken for a duplicate entry. */
export function toCloseClOrdId(signalId: string): string {
  return toClOrdId(`X${signalId}`);
}
