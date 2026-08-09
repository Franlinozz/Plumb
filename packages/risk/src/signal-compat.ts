/**
 * Re-exports so `governor.ts` reads cleanly, and the one bar-duration table this package needs.
 *
 * `@plumb/risk` deliberately does NOT depend on `@plumb/strategy`: the governor's job is to veto
 * signals, and if reaching the `Signal` type required importing the thing that produces them,
 * `@plumb/executor` would gain a transitive path back to strategy internals. The type lives in
 * `@plumb/core` for exactly that reason.
 */

import { TIMEFRAME_MS } from '@plumb/market';
import type { SignalTimeframe } from '@plumb/core';

export { LOCKED } from '@plumb/core';
export type { Signal } from '@plumb/core';

/** Bar durations for the timeframes a signal may carry. Sourced from `@plumb/market`. */
export const TIMEFRAME_MS_FOR_SIGNAL: Readonly<Record<SignalTimeframe, number>> = TIMEFRAME_MS;
