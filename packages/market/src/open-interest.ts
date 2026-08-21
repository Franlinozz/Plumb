import type { OpenInterest, OpenInterestHistoryEntry } from './types.js';

/**
 * Change over a completed rolling window using the latest hourly observation at or BEFORE the
 * boundary. Selecting the first observation after the boundary silently shortens a 24H window to
 * roughly 23H and can reverse the sign when OI moves sharply inside that hour.
 */
export function openInterestChangeOverWindow(
  current: OpenInterest,
  history: readonly OpenInterestHistoryEntry[],
  windowMs: number,
  maxBoundaryLagMs = 3_600_000,
): number {
  if (!Number.isFinite(current.oi) || current.oi <= 0 || !Number.isFinite(current.ts) ||
      !Number.isFinite(windowMs) || windowMs <= 0) return Number.NaN;
  const boundary = current.ts - windowMs;
  const base = [...history]
    .filter((row) => row.ts <= boundary && row.oi > 0)
    .sort((a, b) => b.ts - a.ts)[0];
  if (base === undefined || boundary - base.ts > maxBoundaryLagMs) return Number.NaN;
  return current.oi / base.oi - 1;
}
