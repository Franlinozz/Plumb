import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCandles } from '@plumb/market';
import { afterAll, describe, expect, it } from 'vitest';

import { runBacktest } from './engine.js';
import { PERMISSIVE_CONFIG, permissiveStrategy } from './testkit.js';
import {
  accrueFunding,
  buildFundingModel,
  conservativeRateFrom,
  describeFundingModel,
  fundingAt,
} from './funding_model.js';
import {
  HOLDOUT_DAYS,
  HoldoutViolation,
  assertDevelopmentOnly,
  clampToDevelopment,
  holdoutAuditLog,
  partition,
  requestHoldoutAccess,
} from './holdout.js';
import {
  bullOnlyVerdict,
  classifyHistory,
  regimeAt,
  regimeRuns,
  regimeShares,
} from './regimes.js';

const DAY = 86_400_000;
const T1 = Date.parse('2026-08-01T00:00:00Z');
const T0 = T1 - 900 * DAY;

const temps: string[] = [];
const tempFile = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'plumb-holdout-'));
  temps.push(dir);
  return join(dir, name);
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('the holdout partition', () => {
  const split = partition(T0, T1);

  it('reserves the most recent 90 days', () => {
    expect(HOLDOUT_DAYS).toBe(90);
    expect(split.holdoutDays).toBe(90);
    expect(split.holdoutTo).toBe(T1);
    expect(split.holdoutFrom).toBe(T1 - 90 * DAY);
    expect(split.developmentTo).toBe(split.holdoutFrom);
    expect(split.developmentFrom).toBe(T0);
  });

  it('leaves no overlap between development and holdout', () => {
    expect(split.developmentTo).toBeLessThanOrEqual(split.holdoutFrom);
    expect(split.holdoutFrom - split.developmentTo).toBe(0);
  });

  it('is deterministic — the same bounds always give the same split', () => {
    expect(JSON.stringify(partition(T0, T1))).toBe(JSON.stringify(partition(T0, T1)));
  });

  it('refuses to partition a dataset too short to hold one', () => {
    expect(() => partition(T1 - 30 * DAY, T1)).toThrow(HoldoutViolation);
  });
});

describe('the holdout GUARD', () => {
  const split = partition(T0, T1);

  it('allows a window entirely inside development', () => {
    expect(() =>
      assertDevelopmentOnly({ fromTs: T0, toTs: split.developmentTo }, split),
    ).not.toThrow();
  });

  it('THROWS on a window that reaches into the holdout, by even one millisecond', () => {
    expect(() =>
      assertDevelopmentOnly({ fromTs: T0, toTs: split.developmentTo + 1 }, split),
    ).toThrow(HoldoutViolation);
    expect(() => assertDevelopmentOnly({ fromTs: T0, toTs: T1 }, split)).toThrow(/holdout/);
  });

  it('has no tolerance parameter — a tolerance is how a holdout leaks', () => {
    // The signature takes a window and a split. There is nowhere to pass slack.
    expect(assertDevelopmentOnly.length).toBeLessThanOrEqual(3);
  });

  it('clamps an over-reaching request back to development', () => {
    const clamped = clampToDevelopment({ fromTs: T0 - DAY, toTs: T1 }, split);
    expect(clamped.fromTs).toBe(split.developmentFrom);
    expect(clamped.toTs).toBe(split.developmentTo);
    expect(() => assertDevelopmentOnly(clamped, split)).not.toThrow();
  });

  it('THE NORMAL BACKTEST PATH CANNOT READ HOLDOUT DATA', () => {
    // A backtest is run through the clamp, so even a caller asking for everything gets only
    // development data. This is the assertion the phase requires.
    const candles = { 'BTC-USDT-SWAP': fixtureCandles('BTC-USDT-SWAP', '1H') } as const;
    const series = candles['BTC-USDT-SWAP'];
    const dataFrom = series[0]?.ts ?? 0;
    const dataTo = series.at(-1)?.ts ?? 0;
    const tight = partition(dataFrom, dataTo, 3); // fixtures span ~12 days; reserve 3

    const asked = { fromTs: dataFrom, toTs: dataTo };
    const allowed = clampToDevelopment(asked, tight);
    const result = runBacktest({
      candles,
      lookbackBars: 120,
      modules: [permissiveStrategy],
      strategyConfig: PERMISSIVE_CONFIG,
      ...allowed,
    });

    expect(result.toTs).toBeLessThanOrEqual(tight.developmentTo);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.every((trade) => trade.openedAt <= tight.developmentTo)).toBe(true);
    expect(result.trades.every((trade) => trade.closedAt <= tight.developmentTo)).toBe(true);
    expect(() => assertDevelopmentOnly({ fromTs: result.fromTs, toTs: result.toTs }, tight)).not.toThrow();
  });
});

describe('holdout ACCESS requires a token, a reason, and leaves a trail', () => {
  const request = {
    token: 'operator-token',
    configLabel: 'breakout_range',
    configJson: '{"enabled":{"breakout_range":true}}',
    reason: 'final holdout evaluation of the single best development config',
    actor: 'francis',
    now: T1,
  };

  it('REFUSES without a configured token', () => {
    const outcome = requestHoldoutAccess(request, undefined, tempFile('a.log'));
    expect(outcome.granted).toBe(false);
    if (!outcome.granted) expect(outcome.code).toBe('missing_token');
  });

  it('REFUSES a wrong token', () => {
    const outcome = requestHoldoutAccess({ ...request, token: 'guess' }, 'operator-token', tempFile('b.log'));
    expect(outcome.granted).toBe(false);
    if (!outcome.granted) expect(outcome.code).toBe('bad_token');
  });

  it('REFUSES without a reason', () => {
    const outcome = requestHoldoutAccess({ ...request, reason: '  ' }, 'operator-token', tempFile('c.log'));
    expect(outcome.granted).toBe(false);
    if (!outcome.granted) expect(outcome.code).toBe('missing_reason');
  });

  it('GRANTS with a token and a reason, and appends the date, config hash and reason', () => {
    const path = tempFile('d.log');
    const outcome = requestHoldoutAccess(request, 'operator-token', path);
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) return;

    const log = holdoutAuditLog(path);
    expect(log).toHaveLength(1);
    const entry = JSON.parse(log[0] as string) as Record<string, string>;
    expect(entry['configLabel']).toBe('breakout_range');
    expect(entry['configHash']).toBe(outcome.configHash);
    expect(entry['reason']).toContain('final holdout evaluation');
    expect(entry['at']).toContain('2026-08-01');
    expect(entry['actor']).toBe('francis');
  });

  it('REFUSES a second look when the durable audit says the holdout was already used', () => {
    const path = tempFile('e.log');
    const first = requestHoldoutAccess(request, 'operator-token', path);
    const second = requestHoldoutAccess({
      ...request,
      reason: 'just one more variant',
      previouslyUsed: holdoutAuditLog(path).length > 0,
    }, 'operator-token', path);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
    if (!second.granted) expect(second.code).toBe('already_used');
    expect(holdoutAuditLog(path)).toHaveLength(1);
  });

  it('reports an empty log when the holdout has never been read — the healthy state', () => {
    expect(holdoutAuditLog(tempFile('never.log'))).toEqual([]);
  });
});

describe('the funding model', () => {
  const observed = {
    'BTC-USDT-SWAP': [
      { fundingTime: T1 - 3 * DAY, fundingRate: 0.0001 },
      { fundingTime: T1 - 2 * DAY, fundingRate: -0.00005 },
      { fundingTime: T1 - DAY, fundingRate: 0.0003 },
    ],
  } as const;

  it('derives the conservative rate from the 75th percentile of |funding|', () => {
    const { rate, source } = conservativeRateFrom([
      { fundingTime: 1, fundingRate: 0.0001 },
      { fundingTime: 2, fundingRate: -0.0002 },
      { fundingTime: 3, fundingRate: 0.0003 },
      { fundingTime: 4, fundingRate: 0.0004 },
    ]);
    // |rates| sorted: 1e-4, 2e-4, 3e-4, 4e-4 → index floor(0.75*3) = 2 → 3e-4
    expect(rate).toBeCloseTo(0.0003, 12);
    expect(source).toContain('75th percentile');
  });

  it('never defaults to ZERO when there is no data — zero is the most flattering choice', () => {
    const { rate } = conservativeRateFrom([]);
    expect(rate).toBeGreaterThan(0);
  });

  it('uses a REAL settlement where one exists, sign and all', () => {
    const model = buildFundingModel(observed);
    const lookup = fundingAt(model, 'BTC-USDT-SWAP', T1 - 2 * DAY + 1_000);
    expect(lookup.modelled).toBe(false);
    expect(lookup.rate).toBeCloseTo(-0.00005, 12);
  });

  it('MODELS where no settlement exists, and says so', () => {
    const model = buildFundingModel(observed);
    const lookup = fundingAt(model, 'BTC-USDT-SWAP', T1 - 400 * DAY);
    expect(lookup.modelled).toBe(true);
    expect(lookup.rate).toBeGreaterThan(0);
  });

  it('charges a MODELLED settlement against BOTH sides — it can never pay us', () => {
    const model = buildFundingModel(observed);
    const long = accrueFunding(model, 'BTC-USDT-SWAP', 'long', 400, T1 - 400 * DAY, T1 - 399 * DAY);
    const short = accrueFunding(model, 'BTC-USDT-SWAP', 'short', 400, T1 - 400 * DAY, T1 - 399 * DAY);
    expect(long.modelledSettlements).toBeGreaterThan(0);
    expect(long.usdt).toBeGreaterThan(0);
    expect(short.usdt).toBeGreaterThan(0);
    expect(long.usdt).toBeCloseTo(short.usdt, 12);
  });

  it('books a REAL settlement with its sign, so funding sometimes pays us', () => {
    const model = buildFundingModel({
      'BTC-USDT-SWAP': [{ fundingTime: T1 - 10 * DAY, fundingRate: 0.0002 }],
    });
    const long = accrueFunding(model, 'BTC-USDT-SWAP', 'long', 400, T1 - 9 * DAY, T1 - 8 * DAY);
    const short = accrueFunding(model, 'BTC-USDT-SWAP', 'short', 400, T1 - 9 * DAY, T1 - 8 * DAY);
    expect(long.modelledSettlements).toBe(0);
    expect(long.usdt).toBeGreaterThan(0);
    expect(short.usdt).toBeLessThan(0); // the short is PAID
  });

  it('counts settlements every 8h, charging the boundary instants', () => {
    const model = buildFundingModel(observed);
    // Midnight to midnight is 24h = three 8h INTERVALS, but FOUR settlement instants
    // (00:00, 08:00, 16:00, 00:00) because both endpoints land on a boundary. Charging the
    // one at the open instant is the conservative reading and matches the rest of the model.
    const day = accrueFunding(model, 'BTC-USDT-SWAP', 'long', 400, T1 - 5 * DAY, T1 - 4 * DAY);
    expect(day.settlements).toBe(4);

    // Opening one second after a boundary skips it: three settlements over the same day.
    const offset = accrueFunding(model, 'BTC-USDT-SWAP', 'long', 400, T1 - 5 * DAY + 1_000, T1 - 4 * DAY);
    expect(offset.settlements).toBe(3);
  });

  it('describes itself for the report', () => {
    const text = describeFundingModel(buildFundingModel(observed)).join(' ');
    expect(text).toContain('AGAINST the position');
    expect(text).toContain('never a credit');
  });
});

describe('regime segmentation', () => {
  const candles = fixtureCandles('BTC-USDT-SWAP', '1H');

  it('classifies bars from TRAILING data only', () => {
    const classified = classifyHistory(candles, { bullReturnPct: 1, bearReturnPct: -1, lookbackDays: 2 });
    expect(classified.size).toBeGreaterThan(0);
    for (const [ts, period] of classified) {
      // The window ends at the bar and starts before it. Never after.
      expect(period.to).toBe(ts);
      expect(period.from).toBeLessThan(ts);
    }
  });

  it('labels only bull, bear or chop', () => {
    const classified = classifyHistory(candles, { bullReturnPct: 1, bearReturnPct: -1, lookbackDays: 2 });
    for (const period of classified.values()) {
      expect(['bull', 'bear', 'chop']).toContain(period.regime);
    }
  });

  it('shares sum to one', () => {
    const shares = regimeShares(classifyHistory(candles, { bullReturnPct: 1, bearReturnPct: -1, lookbackDays: 2 }));
    expect(shares.bull + shares.bear + shares.chop).toBeCloseTo(1, 10);
  });

  it('collapses into contiguous runs', () => {
    const runs = regimeRuns(classifyHistory(candles, { bullReturnPct: 1, bearReturnPct: -1, lookbackDays: 2 }));
    expect(runs.length).toBeGreaterThan(0);
    for (let i = 1; i < runs.length; i += 1) {
      expect((runs[i] as { regime: string }).regime).not.toBe((runs[i - 1] as { regime: string }).regime);
    }
  });

  it('answers what regime was in force at an instant', () => {
    const classified = classifyHistory(candles, { bullReturnPct: 1, bearReturnPct: -1, lookbackDays: 2 });
    const someTs = [...classified.keys()][10] as number;
    expect(regimeAt(classified, someTs)).toBeDefined();
  });

  it('CALLS OUT a config that only works in a bull market', () => {
    const verdict = bullOnlyVerdict({
      bull: { netPnlUsdt: 50, trades: 20 },
      bear: { netPnlUsdt: -20, trades: 10 },
      chop: { netPnlUsdt: -15, trades: 30 },
    });
    expect(verdict).toContain('PROFITABLE ONLY IN BULL REGIMES');
    expect(verdict).toContain('leveraged long');
  });

  it('calls it out when it has NEVER traded outside a bull market', () => {
    expect(bullOnlyVerdict({ bull: { netPnlUsdt: 50, trades: 20 } })).toContain('never traded outside');
  });

  it('stays quiet for a config that works across regimes', () => {
    expect(
      bullOnlyVerdict({
        bull: { netPnlUsdt: 50, trades: 20 },
        chop: { netPnlUsdt: 12, trades: 30 },
      }),
    ).toBeUndefined();
  });
});
