/**
 * THE PRE-EMISSION GATE.
 *
 * Every signal from every strategy passes through here before it leaves the package. Rejections
 * are structured — a code, a message and the numbers — because "the gate dropped it" is not an
 * answer anyone can act on at 3am.
 *
 * The order matters. A degraded snapshot rejects EVERYTHING before any other check runs: if the
 * data is stale, nothing computed from it means anything, including the reasons we might give for
 * a more specific rejection.
 */

import { isInstrument } from '@plumb/core';
import { isTradeable, type MarketSnapshot } from '@plumb/market';

import { assertNoSizing, stopIsOnCorrectSide, type SignalDraft } from '@plumb/core';
import type { EngineState, RegimeAssessment, StrategyConfig } from './types.js';

export type GateRejectionCode =
  | 'snapshot_degraded'
  | 'instrument_not_locked'
  | 'strategy_disabled'
  | 'stop_missing'
  | 'stop_wrong_side'
  | 'stop_distance_zero'
  | 'stop_too_tight'
  | 'stop_too_wide'
  | 'regime_unclear'
  | 'regime_low_confidence'
  | 'signal_stale'
  | 'duplicate_cooldown'
  | 'conflicting_sides'
  | 'sizing_leak';

export interface GateRejection {
  readonly code: GateRejectionCode;
  readonly message: string;
  readonly strategyId: string;
  readonly instId: string;
  readonly side: 'long' | 'short';
  readonly details: Readonly<Record<string, number | string>>;
}

export interface GateConflict {
  readonly instId: string;
  readonly strategyIds: readonly string[];
  readonly message: string;
}

export interface GateResult {
  readonly passed: readonly SignalDraft[];
  readonly rejected: readonly GateRejection[];
  readonly conflicts: readonly GateConflict[];
}

export function cooldownKey(draft: SignalDraft): string {
  return `${draft.instId}|${draft.side}|${draft.strategyId}`;
}

export interface GateInput {
  readonly drafts: readonly SignalDraft[];
  readonly snapshot: MarketSnapshot;
  readonly regime: RegimeAssessment;
  readonly state: EngineState;
  readonly config: StrategyConfig;
  readonly now: number;
}

export function runGate(input: GateInput): GateResult {
  const { drafts, snapshot, regime, state, config, now } = input;
  const rejected: GateRejection[] = [];
  const conflicts: GateConflict[] = [];

  const reject = (
    draft: SignalDraft,
    code: GateRejectionCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {},
  ): void => {
    rejected.push({
      code,
      message,
      strategyId: draft.strategyId,
      instId: draft.instId,
      side: draft.side,
      details,
    });
  };

  // 1. Degraded data rejects everything. Nothing else matters, and nothing else is trustworthy.
  if (snapshot.degraded || !isTradeable(snapshot)) {
    for (const draft of drafts) {
      reject(draft, 'snapshot_degraded', 'snapshot is degraded — no signal may be emitted', {
        degradedFields: snapshot.degradedFields.join(','),
      });
    }
    return { passed: [], rejected, conflicts };
  }

  const survivors: SignalDraft[] = [];

  for (const draft of drafts) {
    if (!isInstrument(draft.instId)) {
      reject(draft, 'instrument_not_locked', 'instrument is outside the locked set');
      continue;
    }
    if (config.enabled[draft.strategyId] === false) {
      reject(draft, 'strategy_disabled', 'strategy is disabled by config');
      continue;
    }

    try {
      assertNoSizing(draft as unknown as Record<string, unknown>);
    } catch {
      reject(draft, 'sizing_leak', 'draft carried a sizing field — sizing belongs to @plumb/risk');
      continue;
    }

    const entryPrice = draft.entry.price;
    if (draft.stop === undefined || !Number.isFinite(draft.stop.price) || draft.stop.price <= 0) {
      reject(draft, 'stop_missing', 'no usable stop price — no stop, no order');
      continue;
    }
    if (entryPrice === undefined || entryPrice <= 0) {
      reject(draft, 'stop_missing', 'no entry price to measure the stop against');
      continue;
    }
    if (!stopIsOnCorrectSide(draft.side, entryPrice, draft.stop.price)) {
      reject(draft, 'stop_wrong_side', 'stop is on the profitable side of entry', {
        entry: entryPrice,
        stop: draft.stop.price,
      });
      continue;
    }

    const distance = draft.stop.distancePct;
    if (!Number.isFinite(distance) || distance === 0) {
      reject(draft, 'stop_distance_zero', 'stop distance is zero');
      continue;
    }
    // A stop inside typical spread + slippage is a guaranteed loss, not a risk limit.
    if (distance < config.stops.minDistancePct) {
      reject(draft, 'stop_too_tight', 'stop sits inside typical spread and slippage', {
        distancePct: distance,
        floor: config.stops.minDistancePct,
      });
      continue;
    }
    // A stop so wide the position size becomes meaningless is not a trade worth taking.
    if (distance > config.stops.maxDistancePct) {
      reject(draft, 'stop_too_wide', 'stop is so wide the position size stops meaning anything', {
        distancePct: distance,
        ceiling: config.stops.maxDistancePct,
      });
      continue;
    }

    if (regime.label === 'unclear') {
      reject(draft, 'regime_unclear', 'regime is unclear — no view, no signal');
      continue;
    }
    if (regime.confidence < config.gate.minRegimeConfidence) {
      reject(draft, 'regime_low_confidence', 'regime confidence below threshold', {
        confidence: regime.confidence,
        floor: config.gate.minRegimeConfidence,
      });
      continue;
    }

    if (draft.expiresAt <= now) {
      reject(draft, 'signal_stale', 'signal expired before it could be emitted', {
        expiresAt: draft.expiresAt,
        now,
      });
      continue;
    }
    // A signal describing an instant before the snapshot it came from is a bug, not a trade.
    if (now < snapshot.ts) {
      reject(draft, 'signal_stale', 'signal timestamp precedes its snapshot', {
        now,
        snapshotTs: snapshot.ts,
      });
      continue;
    }

    const last = state.lastSignalAt[cooldownKey(draft)];
    if (last !== undefined && now - last < config.gate.cooldownMs) {
      reject(draft, 'duplicate_cooldown', 'same instrument, side and strategy inside cooldown', {
        sinceMs: now - last,
        cooldownMs: config.gate.cooldownMs,
      });
      continue;
    }

    survivors.push(draft);
  }

  // Conflicts last, over the drafts that would otherwise have been emitted.
  //
  // Two strategies wanting opposite sides of the same instrument is not a signal to net out and
  // not a contest to award to the higher-scoring one — it is the system telling us it does not
  // know. Both are dropped and the disagreement is recorded.
  const byInstrument = new Map<string, SignalDraft[]>();
  for (const draft of survivors) {
    const bucket = byInstrument.get(draft.instId);
    if (bucket === undefined) byInstrument.set(draft.instId, [draft]);
    else bucket.push(draft);
  }

  const passed: SignalDraft[] = [];
  for (const [instId, bucket] of byInstrument) {
    const hasLong = bucket.some((d) => d.side === 'long');
    const hasShort = bucket.some((d) => d.side === 'short');
    if (hasLong && hasShort) {
      const strategyIds = [...new Set(bucket.map((d) => d.strategyId))].sort();
      conflicts.push({
        instId,
        strategyIds,
        message:
          `opposite sides on ${instId} in one cycle (${strategyIds.join(', ')}) — ` +
          'neither emitted',
      });
      for (const draft of bucket) {
        reject(draft, 'conflicting_sides', 'a peer strategy wanted the opposite side', {
          peers: strategyIds.join(','),
        });
      }
      continue;
    }
    passed.push(...bucket);
  }

  return { passed, rejected, conflicts };
}
