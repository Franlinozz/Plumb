/**
 * A DEMO-ONLY eligibility override.
 *
 * No P4 configuration passed the gate, so `assertEligible` refuses everything — correctly. But the
 * P5B session has to place real orders against the demo venue to verify the venue's behaviour, and
 * that verification is not a trading decision.
 *
 * So the override exists, and it is built to be **physically incapable of applying in live mode**:
 *
 *   1. it requires `PLUMB_MODE=demo` — passed in, never read from the ambient environment here;
 *   2. it requires the client to report `demo === true`;
 *   3. it refuses if either is absent, with no default and no "force" flag.
 *
 * A test asserts every one of those. This is the only bypass in the system and it is deliberately
 * the most constrained thing in it.
 */

import type { EligibilitySummary } from '@plumb/core';

import { NotEligibleError, assertEligible } from './runner.js';

export interface OverrideContext {
  /** The resolved `PLUMB_MODE`. Passed IN — this module reads no environment. */
  readonly mode: string | undefined;
  /** Must be a demo venue. A live client can never satisfy this. */
  readonly venueIsDemo: boolean;
  readonly reason: string;
}

export class DemoOverrideRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoOverrideRefused';
  }
}

/** True only when BOTH conditions hold. There is no third way to get here. */
export function demoOverrideApplies(context: OverrideContext): boolean {
  return context.mode === 'demo' && context.venueIsDemo === true;
}

/**
 * Eligibility check with the demo escape hatch.
 *
 * In every mode except `demo`, this is exactly `assertEligible` — the override cannot widen it.
 */
export function assertEligibleOrDemo(
  summary: EligibilitySummary | undefined,
  signature: string | undefined,
  context: OverrideContext,
): { readonly overridden: boolean; readonly note: string } {
  if (!demoOverrideApplies(context)) {
    if (context.mode === 'demo' && !context.venueIsDemo) {
      throw new DemoOverrideRefused(
        'PLUMB_MODE=demo but the venue does not report itself as demo — refusing to override',
      );
    }
    assertEligible(summary, signature);
    return { overridden: false, note: 'genuine eligibility record' };
  }

  // Demo path. Still record WHY, so a ledger reader never wonders how this traded.
  try {
    assertEligible(summary, signature);
    return { overridden: false, note: 'genuine eligibility record (demo mode, override not needed)' };
  } catch (error) {
    const because = error instanceof NotEligibleError ? error.message : String(error);
    return {
      overridden: true,
      note: `DEMO OVERRIDE — not eligible (${because}); permitted only because PLUMB_MODE=demo and the venue is demo. Reason: ${context.reason}`,
    };
  }
}
