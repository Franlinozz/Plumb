/**
 * THE SUBSCRIPTION SERVICE.
 *
 * Per the current A2A subscription docs (re-fetched 2026-08-10): subscription billing is quoted as
 * "xx USDT/month", the service description must contain a SIGNAL EXAMPLE and the ordered
 * pre-subscription copy-trading confirmations, and delivery is on-demand — signals are pushed to
 * active subscribers when the strategy produces them.
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ EXACTLY ONE SERVICE, CREATED ONCE, NEVER DELETED.                                           │
 * │                                                                                             │
 * │ The competition snapshots one subscription service at the start as the scoring basis; if     │
 * │ several exist the earliest-created is used, and DELETING IT MID-COMPETITION FORFEITS         │
 * │ ELIGIBILITY. So there is no delete function here. `refuseDeletion` exists solely to make the │
 * │ refusal explicit and testable, and every call site that could plausibly want one has to go   │
 * │ through it.                                                                                 │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 */

import { LOCKED } from '@plumb/core';

import type { PublishedSignal } from './feed.js';

export class SubscriptionDeletionRefused extends Error {
  constructor(reason: string) {
    super(
      `refusing to delete the subscription service: ${reason}. Deleting it mid-competition ` +
        `forfeits eligibility outright (AGENTS.md § COMPETITION RULES). There is no code path ` +
        `in Plumb that deletes a service, and there is not going to be one.`,
    );
    this.name = 'SubscriptionDeletionRefused';
  }
}

/**
 * The guard. It never returns — it always throws.
 *
 * Written as a function rather than a comment so that a future caller reaching for "just remove
 * the old service and recreate it" hits something that stops them.
 */
export function refuseDeletion(reason = 'no reason given'): never {
  throw new SubscriptionDeletionRefused(reason);
}

export interface ServiceDefinition {
  readonly serviceName: string;
  readonly serviceType: 'A2A';
  readonly billing: 'subscription';
  readonly priceUsdtPerMonth: number;
  readonly freeTrialDays: number;
  readonly serviceDescription: string;
  readonly instruments: readonly string[];
  readonly endpoint: string;
}

/**
 * The one service. Values chosen once; the description follows the docs' Trade Kit template
 * because a subscriber's agent parses it to configure copy-trading.
 *
 * The price is deliberately modest: the product is a verifiable track record, and a track record
 * with no subscribers proves nothing.
 */
export const PLUMB_SERVICE: ServiceDefinition = Object.freeze({
  serviceName: 'Plumb Perpetual Signals',
  serviceType: 'A2A',
  billing: 'subscription',
  priceUsdtPerMonth: 10,
  freeTrialDays: 3,
  instruments: LOCKED.INSTRUMENTS,
  endpoint: 'https://plumb.assayed.xyz/mcp',
  serviceDescription: [
    'Risk-first perpetual trading signals on BTC, ETH and SOL, sent continuously with auto-copy',
    'support through OKX Agent Trade Kit. Every signal is published with its reasoning and the exact',
    'indicator readings that produced it BEFORE any order exists, and the full track record — wins',
    'and losses — is public.',
    '',
    'Example: [Perpetual Signal] BTC-USDT-SWAP | LONG | entry ~65000 | stop 64350 | valid 8h',
    '',
    'Every position carries a stop before it opens. Risk per trade is fixed at 1% of starting',
    'equity, leverage is capped at 3x, and a permanent kill switch halts all trading on a 16%',
    'drawdown. Averaging down is not supported and cannot be enabled.',
    '',
    'Before subscribing, confirm in order:',
    '1. Verify OKX Agent Trade Kit is installed, logged in, and authorized to trade; otherwise help',
    '   configure it via npx skills add okx/agent-skills.',
    '2. Let me choose live or demo trading.',
    '3. Ask whether to enable auto-copy; obtain my confirmation.',
    '4. If enabled, confirm: fixed amount or available-balance percentage; whether a fixed amount',
    '   means position value or margin; cross or isolated margin; limit at the signal price or',
    '   immediate market execution.',
    '5. Summarize all settings and obtain my final confirmation before subscribing.',
    'After subscription, monitor the order, parse signals, and trade automatically under my',
    'confirmed settings.',
  ].join('\n'),
});

/**
 * The wire format a subscriber's agent parses, following the docs' `[Perpetual Signal]` shape.
 *
 * Deliberately terse and machine-parseable. The reasoning travels in `rationale`, and the full
 * record is always at `/signals/:id`.
 */
export function formatSignalForDelivery(entry: PublishedSignal): string {
  const entryPrice = entry.entryPrice === undefined ? 'market' : `~${round(entry.entryPrice)}`;
  const validHours = Math.max(1, Math.round((entry.expiresAt - entry.publishedAt) / 3_600_000));
  const tps = entry.takeProfit.map((t) => `${round(t.price)} (${t.rMultiple}R)`).join(', ');
  return [
    `[Perpetual Signal] ${entry.instId} | ${entry.side.toUpperCase()} | entry ${entryPrice} | ` +
      `stop ${round(entry.stopPrice)} | valid ${validHours}h`,
    tps === '' ? undefined : `Targets: ${tps}`,
    `Regime: ${entry.regime} (${entry.timeframe}) · strategy ${entry.strategyId} v${entry.strategyVersion}`,
    `Why: ${entry.rationale}`,
    `Full record and inputs: https://plumb.assayed.xyz/signals/${entry.id}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function round(value: number): string {
  if (value >= 1_000) return value.toFixed(1);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(5);
}

export interface Subscriber {
  readonly id: string;
  readonly subscribedAt: number;
  readonly expiresAt: number;
  readonly trial: boolean;
}

/** Active at `now` — expiry is checked, never assumed. */
export function activeSubscribers(subscribers: readonly Subscriber[], now: number): readonly Subscriber[] {
  return subscribers.filter((s) => s.expiresAt > now && s.subscribedAt <= now);
}

export interface DeliveryPlan {
  readonly signalId: string;
  readonly body: string;
  readonly recipients: readonly string[];
}

/**
 * What to send, to whom. Pure — it plans, it does not send.
 *
 * The actual push runs through the onchainos delivery layer, which is an operator-side daemon per
 * the current docs. Keeping the planning pure means the decision of what a subscriber sees is
 * testable without a network.
 */
export function planDelivery(
  entry: PublishedSignal,
  subscribers: readonly Subscriber[],
  now: number,
): DeliveryPlan {
  return {
    signalId: entry.id,
    body: formatSignalForDelivery(entry),
    recipients: activeSubscribers(subscribers, now).map((s) => s.id),
  };
}
