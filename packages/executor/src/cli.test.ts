import { signEligibility, type EligibilitySummary } from '@plumb/core';
import { describe, expect, it } from 'vitest';

import { AtkError } from './atk.js';
import { CliAtkClient, FORBIDDEN_CHILD_ENV, sanitizeEnv } from './cli.js';
import {
  DemoOverrideRefused,
  assertEligibleOrDemo,
  demoOverrideApplies,
} from './demo-override.js';
import { NotEligibleError } from './runner.js';

/** A CLI client whose process spawn is replaced by a recorder. */
function recording(responses: Record<string, unknown> | ((args: readonly string[]) => unknown)) {
  const calls: string[][] = [];
  const client = new CliAtkClient({
    demo: true,
    exec: async (args) => {
      calls.push([...args]);
      const payload = typeof responses === 'function' ? responses(args) : responses[args[1] ?? ''];
      return JSON.stringify(payload ?? []);
    },
  });
  return { client, calls };
}

describe('CLI argument construction', () => {
  it('always passes --json and --demo', async () => {
    const { client, calls } = recording({ positions: [] });
    await client.getPositions();
    expect(calls[0]).toContain('--json');
    expect(calls[0]).toContain('--demo');
  });

  it('sends a NEGATIVE option value in `=` form', async () => {
    // Found against the real venue: `--slOrdPx -1` fails with "argument is ambiguous" because the
    // parser reads -1 as another flag. This is the fix, and it must not regress.
    const { client, calls } = recording(() => [{ ordId: 'ORD1', clOrdId: 'SIGabc' }]);
    await client.placeOrder({
      instId: 'BTC-USDT-SWAP',
      side: 'buy',
      posSide: 'long',
      ordType: 'market',
      sz: 0.1,
      clOrdId: 'SIGabc',
      tpTriggerPx: 68_000,
      slTriggerPx: 64_000,
    });
    const args = calls[0] as string[];
    expect(args).toContain('--slOrdPx=-1');
    expect(args).toContain('--tpOrdPx=-1');
    expect(args).not.toContain('--slOrdPx');
    expect(args).not.toContain('--tpOrdPx');
    expect(args[args.indexOf('--tpTriggerPx') + 1]).toBe('68000');
    expect(args[args.indexOf('--slTriggerPx') + 1]).toBe('64000');
  });

  it('sends the clOrdId exactly as given', async () => {
    const { client, calls } = recording(() => [{ ordId: 'ORD1', clOrdId: 'SIGabcDEF' }]);
    await client.placeOrder({
      instId: 'BTC-USDT-SWAP',
      side: 'buy',
      posSide: 'long',
      ordType: 'market',
      sz: 0.1,
      clOrdId: 'SIGabcDEF',
    });
    const args = calls[0] as string[];
    expect(args[args.indexOf('--clOrdId') + 1]).toBe('SIGabcDEF');
  });

  it('overrides posSide for a net-mode account', async () => {
    const { client, calls } = recording(() => [{ ordId: 'ORD1', clOrdId: 'X' }]);
    client.posSideOverride = 'net';
    await client.placeOrder({
      instId: 'BTC-USDT-SWAP',
      side: 'buy',
      posSide: 'long',
      ordType: 'market',
      sz: 0.1,
      clOrdId: 'X',
    });
    const args = calls[0] as string[];
    expect(args[args.indexOf('--posSide') + 1]).toBe('net');
  });

  it('reads the account level and knows Spot mode cannot trade swaps', async () => {
    const spot = recording({ config: [{ acctLv: '1', posMode: 'net_mode' }] });
    expect(await spot.client.getAccountConfig()).toEqual({
      acctLv: '1',
      posMode: 'net_mode',
      canTradeSwaps: false,
      uid: '',
    });

    // The uid is surfaced so a caller can refuse to write to the wrong account. Absent rather
    // than guessed when the venue does not report it.
    const identified = recording({ config: [{ acctLv: '2', posMode: 'net_mode', uid: 'test-uid' }] });
    expect((await identified.client.getAccountConfig()).uid).toBe('test-uid');

    const margin = recording({ config: [{ acctLv: '2', posMode: 'long_short_mode' }] });
    const config = await margin.client.getAccountConfig();
    expect(config.canTradeSwaps).toBe(true);
    expect(await margin.client.resolvePosSide('long')).toBe('long');

    const net = recording({ config: [{ acctLv: '3', posMode: 'net_mode' }] });
    expect(await net.client.resolvePosSide('short')).toBe('net');
  });

  it('queries current competition metadata, fee rates, and last price through the CLI', async () => {
    const { client, calls } = recording((args) => {
      if (args[0] === 'market' && args[1] === 'instruments') {
        return [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctMult: '1', minSz: '0.01',
          lotSz: '0.01', tickSz: '0.1', state: 'live' }];
      }
      if (args[0] === 'account' && args[1] === 'fees') return [{ maker: '-0.0002', taker: '-0.0005' }];
      if (args[0] === 'market' && args[1] === 'ticker') return [{ last: '65000' }];
      if (args[0] === 'swap' && args[1] === 'get-leverage') return [{ lever: '2' }];
      if (args[0] === 'account' && args[1] === 'max-avail-size') return [{ availBuy: '4.2', availSell: '3.8' }];
      return [];
    });
    await expect(client.getInstrumentMetadata('BTC-USDT-SWAP')).resolves.toMatchObject({
      ctVal: 0.01, tickSz: 0.1, state: 'live',
    });
    await expect(client.getFeeRates('BTC-USDT-SWAP')).resolves.toEqual({ maker: 0.0002, taker: 0.0005 });
    await expect(client.getLastPrice('BTC-USDT-SWAP')).resolves.toBe(65_000);
    await expect(client.getLeverage('BTC-USDT-SWAP')).resolves.toBe(2);
    await expect(client.getMaxAvailableSize('BTC-USDT-SWAP')).resolves.toEqual({ buy: 4.2, sell: 3.8 });
    const feeCall = calls.find((call) => call[0] === 'account' && call[1] === 'fees');
    expect(feeCall).toEqual(expect.arrayContaining(['--instType', 'SWAP']));
    expect(feeCall).not.toContain('--instId');
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ['market', 'instruments'], ['account', 'fees'], ['market', 'ticker'],
      ['swap', 'get-leverage'], ['account', 'max-avail-size'],
    ]);
  });

  it('treats a not-found order as an ANSWER, not a failure', async () => {
    const client = new CliAtkClient({
      demo: true,
      exec: async () => {
        throw new AtkError('not_found', 'order does not exist');
      },
    });
    // This is how idempotency asks "has this signal already been placed?".
    await expect(client.getOrder('BTC-USDT-SWAP', { clOrdId: 'X' })).resolves.toBeUndefined();
  });

  it('surfaces a malformed response rather than guessing', async () => {
    const client = new CliAtkClient({ demo: true, exec: async () => 'not json at all' });
    await expect(client.getPositions()).rejects.toThrow(AtkError);
  });

  it('refuses to construct a live client', () => {
    expect(() => new CliAtkClient({ demo: false })).toThrow(AtkError);
    expect(() => new CliAtkClient({ demo: false })).toThrow(/demo-only/);
  });
});

describe('the demo-only eligibility override', () => {
  const failing: EligibilitySummary = {
    label: 'breakout_range',
    eligible: false,
    failedOn: ['P(ruin)', 'outlier independence'],
    criteria: [{ name: 'P(ruin)', passed: false, actual: '6.16%' }],
    tradeCount: 30,
    profitFactor: 1.19,
    totalReturnUsdt: 14.41,
    maxDrawdownPct: 7.8,
    probabilityOfRuin: 0.0616,
    p5Equity: 334.32,
    criteriaUsed: { killSwitchEquity: 335 },
    evaluatedAt: 1,
  };

  it('applies ONLY when the mode is demo AND the venue is demo', () => {
    expect(demoOverrideApplies({ mode: 'demo', venueIsDemo: true, reason: 'r' })).toBe(true);
    expect(demoOverrideApplies({ mode: 'demo', venueIsDemo: false, reason: 'r' })).toBe(false);
    expect(demoOverrideApplies({ mode: 'live', venueIsDemo: true, reason: 'r' })).toBe(false);
    expect(demoOverrideApplies({ mode: undefined, venueIsDemo: true, reason: 'r' })).toBe(false);
    expect(demoOverrideApplies({ mode: 'fake', venueIsDemo: true, reason: 'r' })).toBe(false);
  });

  it('CANNOT apply in live mode — the failing record still refuses', () => {
    for (const mode of ['live', 'fake', undefined, 'DEMO', 'demo ']) {
      expect(() =>
        assertEligibleOrDemo(failing, signEligibility(failing), {
          mode,
          venueIsDemo: true,
          reason: 'trying it on',
        }),
      ).toThrow(NotEligibleError);
    }
  });

  it('CANNOT apply against a non-demo venue, even in demo mode', () => {
    expect(() =>
      assertEligibleOrDemo(failing, signEligibility(failing), {
        mode: 'demo',
        venueIsDemo: false,
        reason: 'trying it on',
      }),
    ).toThrow(DemoOverrideRefused);
  });

  it('overrides a failing record in demo mode, and says loudly that it did', () => {
    const result = assertEligibleOrDemo(failing, signEligibility(failing), {
      mode: 'demo',
      venueIsDemo: true,
      reason: 'P5B venue verification',
    });
    expect(result.overridden).toBe(true);
    expect(result.note).toContain('DEMO OVERRIDE');
    expect(result.note).toContain('P5B venue verification');
  });

  it('does not claim an override when the record genuinely passes', () => {
    const passing = { ...failing, eligible: true, failedOn: [] };
    const result = assertEligibleOrDemo(passing, signEligibility(passing), {
      mode: 'demo',
      venueIsDemo: true,
      reason: 'r',
    });
    expect(result.overridden).toBe(false);
    expect(result.note).toContain('genuine');
  });

  it('is the ONLY bypass — a live-mode caller gets the unmodified assertEligible', () => {
    const passing = { ...failing, eligible: true, failedOn: [] };
    expect(() =>
      assertEligibleOrDemo(passing, signEligibility(passing), { mode: 'live', venueIsDemo: false, reason: 'r' }),
    ).not.toThrow();
    // ...but a forged one still fails in live mode.
    expect(() =>
      assertEligibleOrDemo({ ...passing, tradeCount: 999 }, signEligibility(passing), {
        mode: 'live',
        venueIsDemo: false,
        reason: 'r',
      }),
    ).toThrow(/signature/);
  });
});

describe('live credentials never reach the venue binary (gotcha 16)', () => {
  it('strips the live OKX triplet from a spawned environment', () => {
    const cleaned = sanitizeEnv({
      OKX_API_KEY: 'live-key',
      OKX_API_SECRET: 'live-secret',
      OKX_API_PASSPHRASE: 'live-pass',
      ANTHROPIC_API_KEY: 'keep-me',
      PATH: '/usr/bin',
    });
    expect(cleaned['OKX_API_KEY']).toBeUndefined();
    expect(cleaned['OKX_API_SECRET']).toBeUndefined();
    expect(cleaned['OKX_API_PASSPHRASE']).toBeUndefined();
    // Only the live triplet goes. Everything else the child needs survives.
    expect(cleaned['ANTHROPIC_API_KEY']).toBe('keep-me');
    expect(cleaned['PATH']).toBe('/usr/bin');
  });

  it('does not mutate the environment it was handed', () => {
    const original: NodeJS.ProcessEnv = { OKX_API_KEY: 'live-key' };
    sanitizeEnv(original);
    expect(original['OKX_API_KEY']).toBe('live-key');
  });

  it('names exactly the three credential variables the CLI reads', () => {
    expect([...FORBIDDEN_CHILD_ENV]).toEqual(['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE']);
  });
});
