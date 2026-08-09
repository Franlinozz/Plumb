/**
 * Time primitives.
 *
 * Two clocks exist in this system and confusing them is a money bug:
 *
 *  - **UTC** — every internal accounting boundary. The daily loss limit resets at the UTC
 *    day boundary, drawdown windows are UTC, ledger timestamps are UTC.
 *  - **UTC+8** — the competition clock. Registration and competition start/end are quoted
 *    in UTC+8 and nothing else in this system is.
 *
 * Every conversion between them goes through a function in this file, so a reader can always
 * see which clock a number belongs to. Nothing here reads the ambient system timezone —
 * `process.env.TZ` cannot change any result.
 */

/** The competition clock's fixed offset from UTC, in minutes. UTC+8 has no DST. */
export const COMPETITION_UTC_OFFSET_MINUTES = 8 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * A wall-clock reading on the competition clock (UTC+8), converted to the UTC instant it
 * names. `month` is 1-based, unlike `Date`.
 *
 * @example utc8ToUtcMs(2026, 8, 11, 12) === Date.parse('2026-08-11T04:00:00Z')
 */
export function utc8ToUtcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  return asIfUtc - COMPETITION_UTC_OFFSET_MINUTES * MS_PER_MINUTE;
}

/** The calendar reading a UTC instant has on the competition clock. `month` is 1-based. */
export function utcMsToUtc8Parts(ms: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const shifted = new Date(ms + COMPETITION_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/**
 * Start of the **UTC** day containing `ms`. This is the boundary the daily loss limit resets
 * on — deliberately UTC, not the competition clock, because it governs our own accounting.
 */
export function utcDayStartMs(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

/** `YYYY-MM-DD` on the UTC clock. The key a daily counter is stored under. */
export function utcDayKey(ms: number): string {
  return new Date(utcDayStartMs(ms)).toISOString().slice(0, 10);
}

/** True when the two instants fall in the same UTC day — i.e. share a daily-loss budget. */
export function isSameUtcDay(a: number, b: number): boolean {
  return utcDayStartMs(a) === utcDayStartMs(b);
}

/** ISO-8601 in UTC, always with a `Z`. The only string form used in logs and the ledger. */
export function toUtcIso(ms: number): string {
  return new Date(ms).toISOString();
}
