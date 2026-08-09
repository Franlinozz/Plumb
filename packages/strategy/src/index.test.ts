import { describe, expect, it } from 'vitest';

import { STRATEGY_PACKAGE } from './index.js';

describe('@plumb/strategy', () => {
  it('proposes and cannot place orders', () => {
    expect(STRATEGY_PACKAGE.responsibility).toBe('propose');
    expect(STRATEGY_PACKAGE.canPlaceOrders).toBe(false);
  });

  it('proposes only within the locked universe', () => {
    expect(STRATEGY_PACKAGE.universe).toEqual([
      'BTC-USDT-SWAP',
      'ETH-USDT-SWAP',
      'SOL-USDT-SWAP',
    ]);
  });
});
