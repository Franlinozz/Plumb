import { describe, expect, it } from 'vitest';

import { OPS_PACKAGE, PIPELINE } from './index.js';

describe('@plumb/ops', () => {
  it('orders the pipeline publish-before-execute (guardrail 2)', () => {
    expect(PIPELINE).toEqual([
      '@plumb/market',
      '@plumb/strategy',
      '@plumb/risk',
      '@plumb/asp',
      '@plumb/executor',
    ]);
    expect(PIPELINE.indexOf('@plumb/asp')).toBeLessThan(PIPELINE.indexOf('@plumb/executor'));
  });

  it('vets every signal before it is published', () => {
    expect(PIPELINE.indexOf('@plumb/risk')).toBeLessThan(PIPELINE.indexOf('@plumb/asp'));
  });

  it('keeps the two clocks distinct and named', () => {
    expect(OPS_PACKAGE.accountingTimezone).toBe('UTC');
    expect(OPS_PACKAGE.competitionTimezone).toBe('UTC+8');
    expect(OPS_PACKAGE.dailyLossLimitUsdt).toBe(20);
  });
});
