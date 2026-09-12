import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CompetitionLedgerStore } from './competition-ledger.js';

describe('CompetitionLedgerStore', () => {
  it('persists signed direction through restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'plumb-competition-ledger-')), 'ledger.db');
    const first = new CompetitionLedgerStore(path);
    first.set({ instrument: 'BTC-USDT-SWAP', signedPosition: -0.3,
      decisionId: 'DEC-SIGNED0001', orderId: 'ORD1', updatedAt: 1 });
    first.close();
    const reopened = new CompetitionLedgerStore(path);
    expect(reopened.get('BTC-USDT-SWAP')?.signedPosition).toBe(-0.3);
    reopened.close();
  });
});
