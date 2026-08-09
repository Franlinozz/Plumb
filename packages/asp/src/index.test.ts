import { describe, expect, it } from 'vitest';

import { ASP_PACKAGE } from './index.js';

describe('@plumb/asp', () => {
  it('publishes, and publishes exactly one subscription service', () => {
    expect(ASP_PACKAGE.responsibility).toBe('publish');
    // More than one and the earliest-created becomes the scoring basis; deleting one
    // mid-competition forfeits eligibility. One, created once, is the only safe number.
    expect(ASP_PACKAGE.subscriptionServiceCount).toBe(1);
  });

  it('advertises only the locked instruments', () => {
    expect(ASP_PACKAGE.instruments).toEqual([
      'BTC-USDT-SWAP',
      'ETH-USDT-SWAP',
      'SOL-USDT-SWAP',
    ]);
  });
});
