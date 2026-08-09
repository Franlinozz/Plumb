import { describe, expect, it } from 'vitest';

import { RISK_PACKAGE } from './index.js';

describe('@plumb/risk', () => {
  it('vetoes rather than proposes', () => {
    expect(RISK_PACKAGE.responsibility).toBe('veto');
  });

  it('reads its limits from the locked parameters, not from a local copy', () => {
    expect(RISK_PACKAGE.limits.LEVERAGE_CEILING).toBe(3);
    expect(RISK_PACKAGE.limits.PER_TRADE_RISK_USDT).toBe(4);
    expect(RISK_PACKAGE.limits.MAX_CONCURRENT_POSITIONS).toBe(2);
    expect(RISK_PACKAGE.killSwitchEquityUsdt).toBe(335);
  });

  it('declares its state persisted (guardrail 6)', () => {
    expect(RISK_PACKAGE.statePersisted).toBe(true);
  });
});
