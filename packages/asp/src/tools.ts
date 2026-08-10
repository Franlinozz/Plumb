/**
 * MCP tools for agent consumers.
 *
 * All four are FREE. The subscription is the commercial surface, and free discovery is what drives
 * it: an agent evaluating Plumb should be able to read the track record and the risk parameters
 * without paying, because those are exactly the things that should decide whether it subscribes.
 *
 * No x402 paid tooling is registered. The current docs make subscription billing the clean path
 * for continuous signal delivery, and adding a per-call paid tool alongside it would create a
 * second commercial surface with no benefit — see the P6 deviations.
 */

import { DERIVED, LOCKED } from '@plumb/core';

import type { FeedStore } from './feed.js';
import { PLUMB_SERVICE } from './subscription.js';
import { buildTrackRecord } from './track_record.js';

export const TOOL_NAMES = Object.freeze([
  'plumb_recent_signals',
  'plumb_track_record',
  'plumb_signal_detail',
  'plumb_risk_disclosure',
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  readonly free: true;
  readonly inputSchema: Record<string, unknown>;
}

export const TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  {
    name: 'plumb_recent_signals',
    description:
      'The most recent published trading signals, each with the exact indicator readings that ' +
      'produced it and a plain-language explanation. Free.',
    free: true,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many signals to return (1-200, default 25)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'plumb_track_record',
    description:
      'Live performance computed from the trade ledger: closed trades, win rate, net PnL, current ' +
      'and maximum drawdown, distance to the kill switch. Losing periods included. Free.',
    free: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'plumb_signal_detail',
    description:
      'One published signal in full: entry, stop, targets, regime, the indicator inputs that fired ' +
      'it, its rationale, and its position in the hash chain. Free.',
    free: true,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The signal id, e.g. SIG-abc123defg' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'plumb_risk_disclosure',
    description:
      'The risk parameters Plumb trades under, verbatim from the constants the running system uses. ' +
      'Free.',
    free: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

export interface ToolContext {
  readonly store: FeedStore;
  readonly now: () => number;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly data: unknown;
}

/** Dispatch. Unknown names and bad arguments produce a structured refusal, never a throw. */
export function callTool(name: string, args: Record<string, unknown>, context: ToolContext): ToolResult {
  switch (name) {
    case 'plumb_recent_signals': {
      const raw = Number(args['limit'] ?? 25);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.floor(raw)), 200) : 25;
      return { ok: true, data: { signals: context.store.recent(limit), headHash: context.store.headHash() } };
    }
    case 'plumb_track_record':
      return { ok: true, data: buildTrackRecord(context.store, context.now()) };
    case 'plumb_signal_detail': {
      const id = typeof args['id'] === 'string' ? args['id'] : '';
      if (id === '') {
        return { ok: false, data: { error: 'invalid_request', message: 'id is required', example: { id: 'SIG-abc123defg' } } };
      }
      const entry = context.store.get(id);
      if (entry === undefined) {
        return { ok: false, data: { error: 'not_found', message: `no published signal with id ${id}` } };
      }
      return { ok: true, data: entry };
    }
    case 'plumb_risk_disclosure':
      return {
        ok: true,
        data: {
          startingCapitalUsdt: LOCKED.CAPITAL_USDT,
          perTradeRiskUsdt: LOCKED.PER_TRADE_RISK_USDT,
          perTradeRiskPct: DERIVED.perTradeRiskFraction * 100,
          leverageCeiling: LOCKED.LEVERAGE_CEILING,
          maxConcurrentPositions: LOCKED.MAX_CONCURRENT_POSITIONS,
          maxTotalNotionalUsdt: LOCKED.MAX_TOTAL_NOTIONAL_USDT,
          dailyLossLimitUsdt: LOCKED.DAILY_LOSS_LIMIT_USDT,
          killSwitchEquityUsdt: LOCKED.KILL_SWITCH_EQUITY_USDT,
          instruments: LOCKED.INSTRUMENTS,
          accountingBasis: LOCKED.ACCOUNTING_BASIS,
          averagingDown: 'prohibited — there is no configuration value that enables it',
          everyPositionHasAStopBeforeItOpens: true,
          subscription: {
            priceUsdtPerMonth: PLUMB_SERVICE.priceUsdtPerMonth,
            freeTrialDays: PLUMB_SERVICE.freeTrialDays,
          },
          disclaimer:
            'These are the parameters the running system enforces, not targets. Most individual ' +
            'signals lose. Past results do not predict future results.',
        },
      };
    default:
      return {
        ok: false,
        data: { error: 'unknown_tool', message: `no tool named ${name}`, available: [...TOOL_NAMES] },
      };
  }
}
