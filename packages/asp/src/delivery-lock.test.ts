import { mkdirSync, mkdtempSync, rmdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireDeliveryLock } from './delivery-lock.js';

describe('A2A delivery lock', () => {
  it('is exclusive and becomes available after its owner releases it', () => {
    const base = mkdtempSync(join(tmpdir(), 'plumb-a2a-lock-'));
    const lock = join(base, 'deliver.lock');
    const release = acquireDeliveryLock(lock);
    expect(() => acquireDeliveryLock(lock, { timeoutMs: 5, pollMs: 1 }))
      .toThrow('timed out waiting for the exclusive A2A delivery lock');
    release();
    const releaseAgain = acquireDeliveryLock(lock, { timeoutMs: 5, pollMs: 1 });
    releaseAgain();
    rmdirSync(base);
  });

  it('quarantines only a lock older than the explicit stale threshold', () => {
    const base = mkdtempSync(join(tmpdir(), 'plumb-a2a-stale-'));
    const lock = join(base, 'deliver.lock');
    mkdirSync(lock);
    utimesSync(lock, new Date(0), new Date(0));
    const release = acquireDeliveryLock(lock, { staleMs: 1, timeoutMs: 10, pollMs: 1 });
    release();
    rmdirSync(base);
  });
});
