import { describe, expect, it } from 'vitest';

import { EXECUTOR_PACKAGE } from './index.js';

describe('@plumb/executor', () => {
  it('takes its input from the published feed, not from strategy', () => {
    expect(EXECUTOR_PACKAGE.readsFrom).toBe('@plumb/asp');
  });

  it('acts only on approved signals, and only with a stop already attached', () => {
    expect(EXECUTOR_PACKAGE.requiresVerdict).toBe('approved');
    expect(EXECUTOR_PACKAGE.requiresStopBeforeOpen).toBe(true);
  });

  it('halts on an unmatched fill', () => {
    expect(EXECUTOR_PACKAGE.haltsOnUnmatchedFill).toBe(true);
  });

  it('books against the Agent Trade Kit — manual orders do not count', () => {
    expect(EXECUTOR_PACKAGE.accountingBasis).toBe('agent-trade-kit');
  });
});
