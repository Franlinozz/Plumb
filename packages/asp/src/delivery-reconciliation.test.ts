import { describe, expect, it } from 'vitest';

import {
  describeDeliveryCommandFailure,
  exactDeliverableMatches,
  isRetryableDeliveryFailure,
  redactDeliveryDiagnostic,
} from './delivery-reconciliation.js';

describe('A2A delivery failure reconciliation', () => {
  it('preserves structured business errors instead of reducing them to the Node version', () => {
    expect(describeDeliveryCommandFailure({
      command: 'onchainos agent deliver',
      status: 1,
      payload: { ok: false, error: { code: 503, message: 'service unavailable' } },
      stderr: 'Node.js v24.15.0',
    })).toContain('service unavailable');
  });

  it('retries only transport, empty-success, rate-limit, and server failures', () => {
    expect(isRetryableDeliveryFailure({ status: 1, payload: { error: { code: 503 } } })).toBe(true);
    expect(isRetryableDeliveryFailure({ status: 1, stderr: 'connection reset by peer' })).toBe(true);
    expect(isRetryableDeliveryFailure({ status: 0, stderr: '' })).toBe(true);
    expect(isRetryableDeliveryFailure({ status: 1, payload: { error: { code: 422, message: 'invalid signal' } } })).toBe(false);
  });

  it('accepts only an exact persisted signal as the postcondition', () => {
    const records = [
      { path: '/signals/one.txt', savedAt: '2026-08-23T15:59:00Z' },
      { path: '/signals/two.txt', savedAt: '2026-08-23T16:00:01Z' },
    ];
    const files = new Map([
      ['/signals/one.txt', '[Copy-Trading Notice] no trade'],
      ['/signals/two.txt', '【Futures】SOL-USDT-PERP | LONG 3x'],
    ]);
    expect(exactDeliverableMatches(
      records, '【Futures】SOL-USDT-PERP | LONG 3x', (path) => files.get(path),
      Date.parse('2026-08-23T16:00:00Z'),
    ))
      .toBe(true);
    expect(exactDeliverableMatches(records, 'similar but not exact', (path) => files.get(path), 0))
      .toBe(false);
    expect(exactDeliverableMatches(
      records, '[Copy-Trading Notice] no trade', (path) => files.get(path),
      Date.parse('2026-08-23T16:00:00Z'),
    )).toBe(false);
  });

  it('redacts credentials and webhook tokens from diagnostics', () => {
    expect(redactDeliveryDiagnostic('api_key=abc123 https://discord.com/api/webhooks/1/secret-token'))
      .not.toContain('abc123');
    expect(redactDeliveryDiagnostic('api_key=abc123 https://discord.com/api/webhooks/1/secret-token'))
      .not.toContain('secret-token');
  });
});
