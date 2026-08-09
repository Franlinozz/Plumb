/**
 * Cross-instrument coordination, applied BEFORE risk sees anything.
 *
 * BTC, ETH and SOL are highly correlated. Three simultaneous long signals across them are not
 * three ideas — they are one bet wearing three hats, and sizing each to a full risk budget
 * quietly triples the real exposure. So same-direction signals across instruments are ranked and
 * only the top N survive (default 1).
 *
 * This is a portfolio decision, not a risk decision, which is why it happens here: `@plumb/risk`
 * enforces hard limits on what IS emitted, and cannot know that three signals were siblings.
 */

import type { SignalDraft } from './signal.js';
import type { EngineState, PortfolioConfig } from './types.js';

export type PortfolioDropCode =
  | 'correlated_cap'
  | 'position_already_open'
  | 'one_signal_per_instrument';

export interface PortfolioDrop {
  readonly code: PortfolioDropCode;
  readonly message: string;
  readonly strategyId: string;
  readonly instId: string;
  readonly side: 'long' | 'short';
  readonly score: number;
}

export interface PortfolioResult {
  readonly selected: readonly SignalDraft[];
  readonly dropped: readonly PortfolioDrop[];
}

/**
 * Signal quality, used only for ranking siblings against each other.
 *
 * Deliberately crude and deliberately transparent: regime confidence, trend strength and the
 * reward-to-risk of the first take-profit. It is not a probability and is never presented as one.
 */
export function signalQuality(draft: SignalDraft): number {
  const confidence = numeric(draft.inputs['regimeConfidence']) ?? 0;
  const adx = numeric(draft.inputs['adx']) ?? 0;
  const adxScore = Math.min(adx / 50, 1);
  const firstTp = draft.takeProfit?.[0]?.rMultiple ?? 1;
  const rewardScore = Math.min(firstTp / 3, 1);
  return 0.5 * confidence + 0.3 * adxScore + 0.2 * rewardScore;
}

function numeric(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

export function applyPortfolioRules(
  drafts: readonly SignalDraft[],
  state: EngineState,
  config: PortfolioConfig,
): PortfolioResult {
  const dropped: PortfolioDrop[] = [];
  const drop = (draft: SignalDraft, code: PortfolioDropCode, message: string): void => {
    dropped.push({
      code,
      message,
      strategyId: draft.strategyId,
      instId: draft.instId,
      side: draft.side,
      score: signalQuality(draft),
    });
  };

  // 1. Never add to a direction we are already in. State is passed in, never read.
  //    (@plumb/risk vetoes this too — defence in depth on the averaging-down prohibition.)
  const open = new Set(state.openPositions.map((p) => `${p.instId}|${p.side}`));
  const notAlreadyOpen = drafts.filter((draft) => {
    if (open.has(`${draft.instId}|${draft.side}`)) {
      drop(draft, 'position_already_open', 'a position in this direction is already open');
      return false;
    }
    return true;
  });

  // 2. At most one signal per instrument per cycle — two strategies agreeing is corroboration,
  //    not a reason to enter twice. Highest quality wins; ties break on strategyId so the
  //    outcome is deterministic rather than dependent on evaluation order.
  const byInstrument = new Map<string, SignalDraft[]>();
  for (const draft of notAlreadyOpen) {
    const bucket = byInstrument.get(draft.instId);
    if (bucket === undefined) byInstrument.set(draft.instId, [draft]);
    else bucket.push(draft);
  }

  const perInstrument: SignalDraft[] = [];
  for (const bucket of byInstrument.values()) {
    const ranked = rank(bucket);
    const winner = ranked[0];
    if (winner === undefined) continue;
    perInstrument.push(winner);
    for (const loser of ranked.slice(1)) {
      drop(
        loser,
        'one_signal_per_instrument',
        `a higher-quality signal (${winner.strategyId}) already covers this instrument`,
      );
    }
  }

  // 3. The correlation cap, across instruments, per direction.
  const selected: SignalDraft[] = [];
  for (const side of ['long', 'short'] as const) {
    const sameDirection = rank(perInstrument.filter((d) => d.side === side));
    selected.push(...sameDirection.slice(0, config.maxCorrelatedPerCycle));
    for (const loser of sameDirection.slice(config.maxCorrelatedPerCycle)) {
      drop(
        loser,
        'correlated_cap',
        `correlated ${side} signals capped at ${config.maxCorrelatedPerCycle} per cycle`,
      );
    }
  }

  selected.sort((a, b) => a.instId.localeCompare(b.instId) || a.strategyId.localeCompare(b.strategyId));
  return { selected, dropped };
}

function rank(drafts: readonly SignalDraft[]): readonly SignalDraft[] {
  return [...drafts].sort((a, b) => {
    const delta = signalQuality(b) - signalQuality(a);
    if (delta !== 0) return delta;
    return a.strategyId.localeCompare(b.strategyId);
  });
}
