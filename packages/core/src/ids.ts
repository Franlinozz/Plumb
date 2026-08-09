/**
 * Signal identifiers.
 *
 * The id format is `SIG-` + 10 characters from the nanoid alphabet. The *entropy source* is
 * injected rather than imported, because this package must be pure: given the same snapshot it
 * must produce a byte-identical `Signal[]`, and a signal carrying a fresh random id every run is
 * not byte-identical to anything.
 *
 * So the caller chooses. `createSeededIdFactory` is deterministic and is what tests and backtests
 * use. `createEntropyIdFactory` takes a random source from the outside — in production `@plumb/ops`
 * passes one backed by `crypto` — so unrelated signals never collide.
 */

/** The nanoid alphabet, so ids are drop-in compatible with anything expecting that shape. */
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
const ID_LENGTH = 10;

export type SignalIdFactory = () => string;

function render(pick: (index: number) => number): string {
  let out = '';
  for (let i = 0; i < ID_LENGTH; i += 1) {
    out += ALPHABET[pick(i) % ALPHABET.length];
  }
  return `SIG-${out}`;
}

/**
 * Deterministic ids from a seed (mulberry32).
 *
 * Not a security primitive and not trying to be — it exists so a replay produces the same ids
 * twice. Two runs with the same seed produce the same sequence, which is the entire point.
 */
export function createSeededIdFactory(seed = 1): SignalIdFactory {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => render(() => Math.floor(next() * ALPHABET.length));
}

/**
 * Ids from an injected random source, e.g. `() => crypto.randomInt(0, 2 ** 32)`.
 * The source is a parameter so this file imports nothing and reads no ambient state.
 */
export function createEntropyIdFactory(randomUint32: () => number): SignalIdFactory {
  return () => render(() => Math.abs(Math.trunc(randomUint32())));
}
