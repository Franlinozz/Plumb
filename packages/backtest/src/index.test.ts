import { describe, expect, it } from 'vitest';

import { BACKTEST_PACKAGE } from './index.js';

describe('@plumb/backtest', () => {
  it('claims no results, because none have been produced', () => {
    // Guardrail 8. This stays false until a real replay over real historical data has run
    // and its output is committed alongside the code that produced it.
    expect(BACKTEST_PACKAGE.resultsAvailable).toBe(false);
  });

  it('replays through the same governor and equity the live system uses', () => {
    expect(BACKTEST_PACKAGE.governedBy).toBe('@plumb/risk');
    expect(BACKTEST_PACKAGE.startingEquityUsdt).toBe(400);
    expect(BACKTEST_PACKAGE.strategyUnderTest).toBe('@plumb/strategy');
  });
});
