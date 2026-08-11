/**
 * The CLI-backed Agent Trade Kit client.
 *
 * Spawns the `okx` binary with `--demo --json` on every call. `assertDemo` runs at construction,
 * so a live client cannot be built by accident (guardrail 10).
 *
 * **GOTCHA — IPv6 egress.** This VPS resolves OKX over IPv6 by default, and the demo API key's IP
 * whitelist holds the IPv4 address. Every call therefore returned `401 ... your IP
 * 2a02:c207:... is not included in your API key's IP whitelist`, which reads like an auth problem
 * and is a routing one. `NODE_OPTIONS=--dns-result-order=ipv4first` is forced on every spawn.
 */

import { execFile } from 'node:child_process';

import { AtkError, DEFAULT_BIN, DEFAULT_RETRY, assertDemo, classifyError, withRetry } from './atk.js';
import type {
  AtkClient,
  CliClientOptions,
  OrderRef,
  PlaceOrderRequest,
  RetryPolicy,
  VenueBalance,
  VenueFill,
  VenueOrder,
  VenuePosition,
} from './atk.js';
import type { CompetitionFeeRates, CompetitionInstrumentMetadata } from './competition.js';

/**
 * Credentials the Trade Kit binary must NEVER inherit from our environment.
 *
 * **GOTCHA (16).** The CLI prefers `OKX_API_KEY`/`OKX_API_SECRET`/`OKX_API_PASSPHRASE` from the
 * environment over its own `config.toml` profile. Systemd's `EnvironmentFile=` pointed at the
 * whole secrets file, so the LIVE triplet reached the process that places orders, and every demo
 * call signed with live keys and came back `401 Invalid Sign` — an auth error that is really a
 * guardrail-10 breach wearing a disguise. Deployment hygiene is not enough: strip them here, so
 * the live keys cannot reach the venue binary however the parent process was started.
 */
export const FORBIDDEN_CHILD_ENV = Object.freeze([
  'OKX_API_KEY',
  'OKX_API_SECRET',
  'OKX_API_PASSPHRASE',
] as const);

/** Remove the live credential triplet from an environment before spawning the venue binary. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of FORBIDDEN_CHILD_ENV) delete copy[key];
  return copy;
}

const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

function defaultExec(binPath: string) {
  return (args: readonly string[], timeoutMs: number): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        binPath,
        [...args],
        {
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          // The IPv6 gotcha above. Without this every authenticated call 401s.
          env: { ...sanitizeEnv(process.env), NODE_OPTIONS: '--dns-result-order=ipv4first' },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const message = `${stderr || stdout || error.message}`.trim();
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          reject(
            new AtkError(killed ? 'timeout' : classifyError(message, error.code as number | undefined), message, {
              args: args.join(' '),
            }),
          );
        },
      );
    });
}

export class CliAtkClient implements AtkClient {
  readonly demo: boolean;
  /** Runtime brand used by the competition adapter to reject direct-REST implementations. */
  readonly transport = 'agent-trade-kit' as const;
  readonly profileName: string;
  /** Overrides `posSide` on every order. Set from `resolvePosSide` for a net-mode account. */
  posSideOverride: 'long' | 'short' | 'net' | undefined;
  private readonly exec: (args: readonly string[], timeoutMs: number) => Promise<string>;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly profile: string | undefined;

  readonly calls: string[] = [];

  constructor(options: CliClientOptions = {}) {
    assertDemo(options);
    this.demo = options.demo ?? true;
    this.exec = options.exec ?? defaultExec(options.binPath ?? DEFAULT_BIN);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.profile = options.profile;
    this.profileName = options.profile ?? '';
  }

  private async run(args: readonly string[]): Promise<unknown> {
    const full = [...args, '--json'];
    if (this.demo) full.push('--demo');
    if (this.profile !== undefined) full.push('--profile', this.profile);
    this.calls.push(full.join(' '));

    const stdout = await withRetry(
      () => this.exec(full, this.timeoutMs),
      this.retry,
      this.sleep,
      this.random,
    );
    const text = stdout.trim();
    if (text.length === 0) return [];
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AtkError('malformed', `could not parse CLI output as JSON: ${text.slice(0, 200)}`);
    }
  }

  private async rows(args: readonly string[]): Promise<readonly Record<string, unknown>[]> {
    const parsed = await this.run(args);
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (parsed !== null && typeof parsed === 'object') return [parsed as Record<string, unknown>];
    return [];
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderRef> {
    const args = [
      'swap',
      'place',
      '--instId',
      request.instId,
      '--side',
      request.side,
      '--ordType',
      request.ordType,
      '--sz',
      String(request.sz),
      '--posSide',
      this.posSideOverride ?? request.posSide,
      '--tdMode',
      request.tdMode ?? 'cross',
      '--clOrdId',
      request.clOrdId,
    ];
    if (request.px !== undefined) args.push('--px', String(request.px));
    if (request.reduceOnly === true) args.push('--reduceOnly');
    if (request.slTriggerPx !== undefined) {
      args.push('--slTriggerPx', String(request.slTriggerPx));
      // GOTCHA (found against the real demo venue): a NEGATIVE option value is parsed as another
      // flag — `--slOrdPx -1` fails with "argument is ambiguous". The `=` form is required, and
      // -1 is the documented way to say "market order when the stop triggers".
      args.push(`--slOrdPx=${String(request.slOrdPx ?? -1)}`);
    }

    const rows = await this.rows(args);
    const row = rows[0] ?? {};
    const ordId = String(row['ordId'] ?? '');
    if (ordId === '') throw new AtkError('malformed', `place returned no ordId: ${JSON.stringify(row)}`);
    return {
      ordId,
      // The venue echoes the clOrdId back. The caller compares it to what was SENT.
      clOrdId: String(row['clOrdId'] ?? request.clOrdId),
      instId: request.instId,
    };
  }

  async cancelOrder(instId: string, ordId: string): Promise<void> {
    await this.run(['swap', 'cancel', instId, '--ordId', ordId]);
  }

  async amendOrder(instId: string, ordId: string, changes: { sz?: number; px?: number }): Promise<void> {
    const args = ['swap', 'amend', '--instId', instId, '--ordId', ordId];
    if (changes.sz !== undefined) args.push('--sz', String(changes.sz));
    if (changes.px !== undefined) args.push('--px', String(changes.px));
    await this.run(args);
  }

  async getOrder(
    instId: string,
    params: { ordId?: string; clOrdId?: string },
  ): Promise<VenueOrder | undefined> {
    const args = ['swap', 'get', '--instId', instId];
    if (params.ordId !== undefined) args.push('--ordId', params.ordId);
    if (params.clOrdId !== undefined) args.push('--clOrdId', params.clOrdId);
    try {
      const rows = await this.rows(args);
      const row = rows[0];
      if (row === undefined || row['ordId'] === undefined) return undefined;
      return toOrder(row);
    } catch (error) {
      // "not found" is an ANSWER, not a failure — it is how idempotency asks its question.
      if (error instanceof AtkError && (error.kind === 'not_found' || error.kind === 'rejected')) {
        return undefined;
      }
      throw error;
    }
  }

  async getOpenOrders(instId?: string): Promise<readonly VenueOrder[]> {
    const args = ['swap', 'orders'];
    if (instId !== undefined) args.push('--instId', instId);
    return (await this.rows(args)).map(toOrder);
  }

  async getPositions(instId?: string): Promise<readonly VenuePosition[]> {
    const args = ['swap', 'positions'];
    if (instId !== undefined) args.push('--instId', instId);
    return (await this.rows(args)).map((row) => ({
      instId: String(row['instId'] ?? ''),
      posSide: (String(row['posSide'] ?? 'net') as VenuePosition['posSide']),
      pos: num(row['pos']),
      avgPx: num(row['avgPx']),
      upl: num(row['upl']),
    }));
  }

  async getFills(instId?: string): Promise<readonly VenueFill[]> {
    const args = ['swap', 'fills'];
    if (instId !== undefined) args.push('--instId', instId);
    return (await this.rows(args)).map((row) => ({
      instId: String(row['instId'] ?? ''),
      ordId: String(row['ordId'] ?? ''),
      clOrdId: String(row['clOrdId'] ?? ''),
      side: (String(row['side'] ?? 'buy') as 'buy' | 'sell'),
      fillSz: num(row['fillSz']),
      fillPx: num(row['fillPx']),
      fee: num(row['fee']),
      ts: num(row['ts'] ?? row['fillTime']),
    }));
  }

  async getBalance(): Promise<readonly VenueBalance[]> {
    const rows = await this.rows(['account', 'balance']);
    const details = (rows[0]?.['details'] ?? []) as Array<Record<string, unknown>>;
    return details.map((d) => ({
      ccy: String(d['ccy'] ?? ''),
      eq: num(d['eq'] ?? d['cashBal']),
      availEq: num(d['availBal'] ?? d['availEq']),
    }));
  }

  async closePosition(instId: string, mgnMode: 'cross' | 'isolated' = 'cross'): Promise<void> {
    await this.run(['swap', 'close', '--instId', instId, '--mgnMode', mgnMode]);
  }

  /**
   * Account configuration — the account LEVEL and the POSITION MODE, both of which decide whether
   * an order is even possible.
   *
   * Learned against the real demo venue: `acctLv: "1"` is Spot mode, in which perpetual swaps
   * cannot be traded AT ALL — every place returns `51010 "You can't complete this request under
   * your current account mode"`, which reads like a parameter problem and is an account setting.
   */
  async getAccountConfig(): Promise<{
    readonly acctLv: string;
    readonly posMode: string;
    readonly canTradeSwaps: boolean;
    /**
     * The account this key actually controls. Reported so a caller can refuse to write to the
     * wrong account — with several OKX accounts and sub-accounts in play, "the key authenticates"
     * and "the key is the one we meant" are different questions, and only the second one matters
     * before an order.
     */
    readonly uid: string;
  }> {
    const rows = await this.rows(['account', 'config']);
    const row = rows[0] ?? {};
    const acctLv = String(row['acctLv'] ?? '');
    return {
      acctLv,
      uid: String(row['uid'] ?? ''),
      posMode: String(row['posMode'] ?? ''),
      // Level 1 is Spot mode. Anything from 2 (single-currency margin) upward can hold a swap.
      canTradeSwaps: acctLv !== '' && acctLv !== '1',
    };
  }

  /** `net_mode` accounts must send `posSide: net`; `long_short_mode` accounts send long/short. */
  async resolvePosSide(requested: 'long' | 'short'): Promise<'long' | 'short' | 'net'> {
    const config = await this.getAccountConfig();
    return config.posMode === 'net_mode' ? 'net' : requested;
  }

  /** Current instrument metadata, queried immediately before a competition write. */
  async getInstrumentMetadata(instId: import('@plumb/core').Instrument): Promise<CompetitionInstrumentMetadata> {
    const rows = await this.rows(['market', 'instruments', '--instType', 'SWAP', '--instId', instId]);
    const row = rows.find((candidate) => String(candidate['instId'] ?? '') === instId) ?? rows[0] ?? {};
    const metadata = {
      ctVal: num(row['ctVal']),
      ctMult: num(row['ctMult'] ?? 1),
      minSz: num(row['minSz']),
      lotSz: num(row['lotSz']),
      state: String(row['state'] ?? ''),
    };
    if (metadata.ctVal <= 0 || metadata.ctMult <= 0 || metadata.minSz <= 0 || metadata.lotSz <= 0) {
      throw new AtkError('malformed', `instrument metadata is incomplete for ${instId}`);
    }
    return metadata;
  }

  /** Fee rates are returned as signed rates by some OKX account modes; costs use magnitudes. */
  async getFeeRates(instId: import('@plumb/core').Instrument): Promise<CompetitionFeeRates> {
    const rows = await this.rows(['account', 'fees', '--instType', 'SWAP', '--instId', instId]);
    const row = rows[0] ?? {};
    const maker = Math.abs(num(row['maker'] ?? row['makerU']));
    const taker = Math.abs(num(row['taker'] ?? row['takerU']));
    if (maker === 0 && taker === 0) throw new AtkError('malformed', `fee rates are missing for ${instId}`);
    return { maker, taker };
  }

  async getLastPrice(instId: import('@plumb/core').Instrument): Promise<number> {
    const rows = await this.rows(['market', 'ticker', instId]);
    const last = num(rows[0]?.['last']);
    if (last <= 0) throw new AtkError('malformed', `ticker returned no usable last price for ${instId}`);
    return last;
  }

  async getLeverage(instId: import('@plumb/core').Instrument): Promise<number> {
    const rows = await this.rows(['swap', 'get-leverage', '--instId', instId, '--mgnMode', 'cross']);
    const leverage = num(rows[0]?.['lever']);
    if (leverage <= 0) throw new AtkError('malformed', `leverage is missing for ${instId}`);
    return leverage;
  }

  async getMaxAvailableSize(instId: import('@plumb/core').Instrument): Promise<{ readonly buy: number; readonly sell: number }> {
    const rows = await this.rows(['account', 'max-avail-size', '--instId', instId, '--tdMode', 'cross']);
    const row = rows[0] ?? {};
    const buy = num(row['availBuy']);
    const sell = num(row['availSell']);
    if (buy < 0 || sell < 0) throw new AtkError('malformed', `maximum available size is invalid for ${instId}`);
    return { buy, sell };
  }
}

function toOrder(row: Record<string, unknown>): VenueOrder {
  // GOTCHA (found against the real demo venue): an ATTACHED stop does NOT appear in the
  // top-level `slTriggerPx` — that field stays empty. It lives in `attachAlgoOrds[0]` as a linked
  // algo order with its own `attachAlgoId`. Reading only the top level reports "no stop attached"
  // for an order that is perfectly well protected, which would make guardrail 3 unverifiable at
  // the venue — exactly the check that must not be wrong.
  const attached = Array.isArray(row['attachAlgoOrds'])
    ? ((row['attachAlgoOrds'] as unknown[])[0] as Record<string, unknown> | undefined)
    : undefined;
  const slTriggerPx = num(row['slTriggerPx']) || num(attached?.['slTriggerPx']);
  return {
    ordId: String(row['ordId'] ?? ''),
    clOrdId: String(row['clOrdId'] ?? ''),
    instId: String(row['instId'] ?? ''),
    state: (String(row['state'] ?? 'live') as VenueOrder['state']),
    side: (String(row['side'] ?? 'buy') as 'buy' | 'sell'),
    sz: num(row['sz']),
    avgPx: num(row['avgPx'] ?? row['px']),
    ts: num(row['cTime'] ?? row['uTime'] ?? row['ts']),
    ...(slTriggerPx > 0 ? { slTriggerPx } : {}),
    ...(attached?.['attachAlgoId'] === undefined || attached['attachAlgoId'] === ''
      ? {}
      : { attachAlgoId: String(attached['attachAlgoId']) }),
  };
}
