import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');

describe('the retired compliance-only path', () => {
  it('cannot import an order placement capability or construct a direction', () => {
    const source = readFileSync(join(root, 'scripts', 'competition-compliance-trade.mjs'), 'utf8');
    expect(source).not.toContain('placeBracket');
    expect(source).not.toContain('placeOrder');
    expect(source).not.toContain("argv.has('--short')");
    expect(source).toContain('COMPLIANCE_TRADE_DISABLED');
  });

  it('does not store the registered UID in competition scripts', () => {
    for (const name of ['competition-compliance-trade.mjs', 'competition-preflight.mjs']) {
      const source = readFileSync(join(root, 'scripts', name), 'utf8');
      expect(source).not.toMatch(/\b\d{18}\b/);
    }
  });
});
