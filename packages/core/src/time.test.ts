import { describe, expect, it } from 'vitest';

import {
  COMPETITION_UTC_OFFSET_MINUTES,
  isSameUtcDay,
  toUtcIso,
  utc8ToUtcMs,
  utcDayKey,
  utcDayStartMs,
  utcMsToUtc8Parts,
} from './time.js';

describe('the two clocks', () => {
  it('converts a competition (UTC+8) wall-clock reading to the right UTC instant', () => {
    // The Season 1 boundaries, read off okx.ai/hackathon in UTC+8.
    expect(utc8ToUtcMs(2026, 8, 11, 12, 0, 0)).toBe(Date.parse('2026-08-11T04:00:00Z'));
    expect(utc8ToUtcMs(2026, 8, 25, 12, 0, 0)).toBe(Date.parse('2026-08-25T04:00:00Z'));
    expect(toUtcIso(utc8ToUtcMs(2026, 8, 11, 12))).toBe('2026-08-11T04:00:00.000Z');
  });

  it('handles a UTC+8 reading that falls on the previous UTC day', () => {
    // 04:00 on the 11th in UTC+8 is 20:00 on the 10th in UTC — the case an implicit
    // conversion silently gets wrong, moving a trade into the wrong daily bucket.
    expect(utc8ToUtcMs(2026, 8, 11, 4, 0, 0)).toBe(Date.parse('2026-08-10T20:00:00Z'));
    expect(utcDayKey(utc8ToUtcMs(2026, 8, 11, 4))).toBe('2026-08-10');
  });

  it('round-trips a UTC instant back to competition-clock parts', () => {
    const ms = Date.parse('2026-08-11T04:00:00Z');
    expect(utcMsToUtc8Parts(ms)).toEqual({
      year: 2026,
      month: 8,
      day: 11,
      hour: 12,
      minute: 0,
      second: 0,
    });
  });

  it('pins the offset at +8h with no daylight saving', () => {
    expect(COMPETITION_UTC_OFFSET_MINUTES).toBe(480);
    // Same offset in January and July — UTC+8 does not observe DST, so a seasonal
    // conversion bug is impossible by construction.
    const winter = utc8ToUtcMs(2026, 1, 15, 12);
    const summer = utc8ToUtcMs(2026, 7, 15, 12);
    expect(Date.parse('2026-01-15T04:00:00Z')).toBe(winter);
    expect(Date.parse('2026-07-15T04:00:00Z')).toBe(summer);
  });

  it('buckets by UTC day, which is what the daily loss limit resets on', () => {
    const lateOn9th = Date.parse('2026-08-09T23:59:59.999Z');
    const earlyOn10th = Date.parse('2026-08-10T00:00:00.000Z');

    expect(utcDayStartMs(lateOn9th)).toBe(Date.parse('2026-08-09T00:00:00Z'));
    expect(utcDayKey(lateOn9th)).toBe('2026-08-09');
    expect(utcDayKey(earlyOn10th)).toBe('2026-08-10');
    expect(isSameUtcDay(lateOn9th, earlyOn10th)).toBe(false);
    expect(isSameUtcDay(earlyOn10th, earlyOn10th + 3_600_000)).toBe(true);
  });

  it('ignores the ambient system timezone', () => {
    const before = process.env['TZ'];
    try {
      process.env['TZ'] = 'Asia/Kolkata';
      expect(utc8ToUtcMs(2026, 8, 11, 12)).toBe(Date.parse('2026-08-11T04:00:00Z'));
      expect(utcDayKey(Date.parse('2026-08-09T23:00:00Z'))).toBe('2026-08-09');
    } finally {
      if (before === undefined) delete process.env['TZ'];
      else process.env['TZ'] = before;
    }
  });
});
