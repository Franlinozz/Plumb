import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'scripts/competition-v2-monitor.mjs'), 'utf8');

describe('the automated competition monitor is read-only by construction', () => {
  it('has no executor, A2A, account, credential, child-process, or order path', () => {
    for (const forbidden of [
      '@plumb/executor',
      '@plumb/asp',
      'child_process',
      'spawn',
      'execFile',
      'onchainos',
      'okx swap',
      'placeOrder',
      'process.env',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('prints an unconditional non-eligibility blocker', () => {
    expect(source).toContain('executionEligible: false');
    expect(source).toContain('protected holdout remains failed');
  });
});
