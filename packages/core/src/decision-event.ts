import { z } from 'zod';

import { INSTRUMENTS } from './locked.js';

const finite = z.number().finite();
const positive = finite.positive();

/** Competition candidates must clear friction by a meaningful margin, not a rounding error. */
export const MIN_EXPECTED_EDGE_COST_MULTIPLE = 3;

/**
 * The immutable hand-off shared by the competition signal publisher and executor.
 * Neither consumer may infer direction, size, risk or prices independently.
 */
export const DecisionEventSchema = z
  .object({
    decisionId: z.string().regex(/^DEC-[A-Za-z0-9_-]{10,48}$/),
    strategyVersion: z.string().min(1).max(80),
    createdAt: finite,
    validUntil: finite,
    instrument: z.enum(INSTRUMENTS),
    direction: z.enum(['long', 'short']),
    entryLow: positive,
    entryHigh: positive,
    /** Closed-bar strategy reference; entry bands may be intentionally asymmetric. */
    referencePrice: positive.optional(),
    stopPrice: positive,
    takeProfit: positive,
    positionPct: positive.max(100),
    leverage: positive.min(1).max(3),
    riskUsd: positive,
    /** Immutable venue quantity/notional approved before publication. */
    approvedContracts: positive.optional(),
    approvedNotionalUsd: positive.optional(),
    expectedCostBps: finite.nonnegative(),
    expectedEdgeBps: finite.nonnegative(),
    approvalBasis: z.enum([
      'calibrated-edge',
      'operator-deadline-contingency-v1',
      'operator-final-window-contingency-v2',
      'operator-emergency-participation',
      'operator-evidence-limited-v3',
    ]).optional(),
    governorApproved: z.boolean(),
    venuePositionBefore: finite,
    ledgerPositionBefore: finite,
    reconciliationVersion: z.string().min(1).max(80),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.validUntil <= event.createdAt) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'must be later than createdAt' });
    }
    if (event.entryHigh < event.entryLow) {
      ctx.addIssue({ code: 'custom', path: ['entryHigh'], message: 'must be at least entryLow' });
    }
    if (event.referencePrice !== undefined &&
        (event.referencePrice < event.entryLow || event.referencePrice > event.entryHigh)) {
      ctx.addIssue({ code: 'custom', path: ['referencePrice'], message: 'must be inside the entry range' });
    }
    if ((event.approvedContracts === undefined) !== (event.approvedNotionalUsd === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['approvedContracts'],
        message: 'approved contracts and notional must be present together' });
    }
    const stopCorrect =
      event.direction === 'long' ? event.stopPrice < event.entryLow : event.stopPrice > event.entryHigh;
    if (!stopCorrect) {
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'must be on the losing side of entry' });
    }
    const targetCorrect =
      event.direction === 'long' ? event.takeProfit > event.entryHigh : event.takeProfit < event.entryLow;
    if (!targetCorrect) {
      ctx.addIssue({ code: 'custom', path: ['takeProfit'], message: 'must be on the profitable side of entry' });
    }
  });

export type DecisionEvent = Readonly<z.infer<typeof DecisionEventSchema>>;

export class DecisionEventRejected extends Error {
  constructor(readonly reason: string) {
    super(`DecisionEvent rejected: ${reason}`);
    this.name = 'DecisionEventRejected';
  }
}

/** Parse, enforce the final approval/cost gate, then freeze the exact shared object. */
export function finalizeDecisionEvent(candidate: unknown): DecisionEvent {
  const event = DecisionEventSchema.parse(candidate);
  if (event.governorApproved !== true) throw new DecisionEventRejected('governorApproved is not true');
  const emergency = event.approvalBasis === 'operator-emergency-participation';
  const deadlineContingency = event.approvalBasis === 'operator-deadline-contingency-v1';
  const finalWindowContingency = event.approvalBasis === 'operator-final-window-contingency-v2';
  const evidenceLimitedV3 = event.approvalBasis === 'operator-evidence-limited-v3';
  if (emergency) {
    if (event.strategyVersion !== 'emergency_participation@1.0.0' || event.expectedEdgeBps !== 0) {
      throw new DecisionEventRejected('emergency participation basis is malformed or overstates expected edge');
    }
  } else if (deadlineContingency) {
    if (event.strategyVersion !== 'deadline_contingency@1.0.0' || event.expectedEdgeBps !== 0) {
      throw new DecisionEventRejected('deadline contingency basis is malformed or overstates expected edge');
    }
  } else if (finalWindowContingency) {
    if (event.strategyVersion !== 'final_window_contingency@2.0.0' || event.expectedEdgeBps !== 0) {
      throw new DecisionEventRejected('final-window contingency basis is malformed or overstates expected edge');
    }
    if (event.referencePrice === undefined || event.approvedContracts === undefined ||
        event.approvedNotionalUsd === undefined) {
      throw new DecisionEventRejected('final-window contingency lacks immutable reference and size');
    }
  } else if (evidenceLimitedV3) {
    if (event.strategyVersion !== 'competition_trend_pullback@3.0.0' || event.expectedEdgeBps !== 0) {
      throw new DecisionEventRejected('evidence-limited v3 basis is malformed or overstates expected edge');
    }
  } else if (event.expectedEdgeBps < event.expectedCostBps * MIN_EXPECTED_EDGE_COST_MULTIPLE) {
    throw new DecisionEventRejected(
      `expected edge is below ${MIN_EXPECTED_EDGE_COST_MULTIPLE}x estimated trading friction`,
    );
  }
  return Object.freeze({ ...event });
}

/** Signed reconciliation: equal magnitude in the wrong direction is a hard mismatch. */
export function decisionPositionsReconciled(event: DecisionEvent, tolerance = 1e-9): boolean {
  return Math.abs(event.venuePositionBefore - event.ledgerPositionBefore) <= tolerance;
}
