import { describe, expect, it } from 'vitest';

import { MARKET_PACKAGE, tradableUniverse } from './index.js';

describe('@plumb/market', () => {
  it('is wired to the locked instrument universe and nothing wider', () => {
    expect(MARKET_PACKAGE.responsibility).toBe('ingest');
    expect(tradableUniverse()).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']);
  });

  it('runs in fake mode by default', () => {
    expect(process.env['PLUMB_MODE']).toBe('fake');
  });
});
