import { describe, expect, it } from 'vitest';

import { coveredBy, flatten } from './flatten.js';
import { rearm } from './rearm.js';
import { GovernorStore, initialState, withHalt, type GovernorState, type OpenPosition } from './state.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');
const TOKEN = 'operator-token-9f3a';

function position(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    instId: 'BTC-USDT-SWAP',
    side: 'long',
    contracts: 0.61,
    notionalUsdt: 396.5,
    entryPrice: 65_000,
    stopPrice: 64_350,
    openedAt: NOW - 3_600_000,
    signalId: 'SIG-aaaaaaaaaa',
    ...overrides,
  };
}

function stateWith(...positions: OpenPosition[]): GovernorState {
  return {
    ...initialState(NOW),
    openPositions: positions,
    totalNotional: positions.reduce((sum, p) => sum + p.notionalUsdt, 0),
  };
}

describe('flatten', () => {
  it('produces one urgent market close per open position, on the opposite side', () => {
    const state = stateWith(
      position({ instId: 'BTC-USDT-SWAP', side: 'long', signalId: 'SIG-aaaaaaaaaa' }),
      position({ instId: 'ETH-USDT-SWAP', side: 'short', signalId: 'SIG-bbbbbbbbbb', contracts: 2 }),
    );
    const result = flatten(state, 'kill_switch', NOW);

    expect(result.intents).toHaveLength(2);
    const [btc, eth] = result.intents;
    expect(btc?.instId).toBe('BTC-USDT-SWAP');
    expect(btc?.side).toBe('short'); // closing a long
    expect(eth?.side).toBe('long'); // closing a short
    for (const intent of result.intents) {
      expect(intent.kind).toBe('close');
      expect(intent.urgent).toBe(true);
      expect(intent.orderType).toBe('market');
      expect(intent.reason).toBe('kill_switch');
      expect(intent.issuedAt).toBe(NOW);
    }
  });

  it('closes the FULL position size', () => {
    const result = flatten(stateWith(position({ contracts: 1.37 })), 'manual', NOW);
    expect(result.intents[0]?.contracts).toBe(1.37);
  });

  it('IS IDEMPOTENT — calling it twice does not double-close', () => {
    const state = stateWith(
      position({ signalId: 'SIG-aaaaaaaaaa' }),
      position({ instId: 'ETH-USDT-SWAP', signalId: 'SIG-bbbbbbbbbb' }),
    );

    const first = flatten(state, 'kill_switch', NOW);
    expect(first.intents).toHaveLength(2);

    const covered = coveredBy(first);
    const second = flatten(state, 'manual', NOW + 1_000, covered);
    expect(second.intents).toEqual([]);
    expect(second.alreadyClosing).toEqual(['SIG-aaaaaaaaaa', 'SIG-bbbbbbbbbb']);
  });

  it('still closes a position that appeared AFTER the first flatten', () => {
    const first = flatten(stateWith(position({ signalId: 'SIG-aaaaaaaaaa' })), 'kill_switch', NOW);
    const covered = coveredBy(first);

    const later = stateWith(
      position({ signalId: 'SIG-aaaaaaaaaa' }),
      position({ instId: 'SOL-USDT-SWAP', signalId: 'SIG-cccccccccc' }),
    );
    const second = flatten(later, 'kill_switch', NOW + 5_000, covered);
    expect(second.intents).toHaveLength(1);
    expect(second.intents[0]?.positionSignalId).toBe('SIG-cccccccccc');
  });

  it('returns nothing when the book is already flat', () => {
    const result = flatten(initialState(NOW), 'daily_limit', NOW);
    expect(result.intents).toEqual([]);
    expect(result.alreadyClosing).toEqual([]);
  });

  it('depends on nothing but the persisted state — it works if strategy is broken', () => {
    // The path OUT must not depend on the path IN. flatten() reads only state and a clock.
    const result = flatten(stateWith(position()), 'reconcile_mismatch', NOW);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]?.reason).toBe('reconcile_mismatch');
  });
});

describe('manual re-arm', () => {
  const killed = withHalt(initialState(NOW), 'killSwitch', 'equity 330', NOW);

  it('FAILS without a token', () => {
    const outcome = rearm(killed, { token: undefined, reason: 'reviewed', actor: 'francis' }, TOKEN, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('missing_token');
  });

  it('FAILS with the wrong token, and records the attempt', () => {
    const store = new GovernorStore();
    const outcome = rearm(killed, { token: 'guess', reason: 'reviewed', actor: 'mallory' }, TOKEN, NOW, store);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('bad_token');

    const audit = store.audit();
    expect(audit[0]?.kind).toBe('rearm_denied');
    expect(audit[0]?.actor).toBe('mallory');
    store.close();
  });

  it('FAILS when no token is configured at all', () => {
    const outcome = rearm(killed, { token: 'anything', reason: 'r', actor: 'a' }, undefined, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('missing_token');
  });

  it('FAILS without a reason — an unexplained re-arm is an unexplained loss later', () => {
    const outcome = rearm(killed, { token: TOKEN, reason: '   ', actor: 'francis' }, TOKEN, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('missing_reason');
  });

  it('FAILS when nothing is halted', () => {
    const outcome = rearm(initialState(NOW), { token: TOKEN, reason: 'why not', actor: 'francis' }, TOKEN, NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('not_halted');
  });

  it('SUCCEEDS with the token and a reason, and writes an audit record', () => {
    const store = new GovernorStore();
    const outcome = rearm(
      killed,
      { token: TOKEN, reason: 'reviewed the blowup, cause understood, sizing reduced', actor: 'francis' },
      TOKEN,
      NOW + 60_000,
      store,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.cleared).toEqual(['killSwitch']);
    expect(outcome.state.haltFlags.killSwitch).toBe(false);
    expect(outcome.state.haltReason).toBeUndefined();
    expect(outcome.state.haltedAt).toBeUndefined();

    const audit = store.audit();
    expect(audit[0]?.kind).toBe('rearm');
    expect(audit[0]?.actor).toBe('francis');
    expect(audit[0]?.ts).toBe(NOW + 60_000);
    expect(audit[0]?.reason).toContain('cause understood');
    store.close();
  });

  it('can clear one flag while leaving another set', () => {
    const both = withHalt(killed, 'manual', 'operator paused too', NOW);
    const outcome = rearm(
      both,
      { token: TOKEN, reason: 'clearing only the daily halt', actor: 'francis', flags: ['manual'] },
      TOKEN,
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.haltFlags.manual).toBe(false);
    // The kill switch survives — it is not cleared as a side effect of clearing something else.
    expect(outcome.state.haltFlags.killSwitch).toBe(true);
    expect(outcome.state.haltReason).toBeDefined();
  });

  it('the system cannot re-arm itself — there is no automatic path', () => {
    // Every route into rearm() requires a token the code does not possess. This asserts the
    // absence of a default: passing the state's own contents as a token must fail.
    for (const attempt of [killed.haltReason, String(killed.haltedAt), '', 'true']) {
      expect(rearm(killed, { token: attempt, reason: 'auto', actor: 'system' }, TOKEN, NOW).ok).toBe(false);
    }
  });
});
