// What time of day it is in the world.
//
// `SMSG_LOGIN_SET_TIME_SPEED` arrives once, just after entering the world, and is the only thing
// that says so. The clock then runs on its own: the packet carries how fast, and the server does
// not send it again.

import { PacketReader } from "../protocol/PacketReader.js";

/** Half-minutes in a game day, which is the unit every light band's key times are in. */
export const DAY_HALF_MINUTES = 2880;
/** Minutes in a game day. */
const DAY_MINUTES = 1440;

export interface GameTime {
  /** Minutes since midnight, fractional as the clock runs. */
  minuteOfDay: number;
  /** Game minutes per real second. The server's 1/60 default runs at ordinary wall-clock speed. */
  minutesPerSecond: number;
  /** Day of the week the packet reported, 0 = Sunday. Kept because nothing else carries it. */
  weekday: number;
  /** Realm calendar date from the same packed word; absent only for WowTime sentinel fields. */
  date?: { year: number; month: number; day: number };
}

/**
 * Decodes the packed calendar the core sends.
 *
 * `secsToTimeBitFields` packs a whole date into one word: minute in bits 0-5, hour in 6-10,
 * weekday in 11-13, day of month in 14-19, month in 20-23 and the five-bit year in 24-28.
 * Player.cpp sends the same GameTime::GetWowTime() used by CalendarHandler.cpp, so retaining the
 * date gives stock FrameXML its realm day before a calendar snapshot is requested.
 */
export function parseLoginSetTimeSpeed(payload: Uint8Array): GameTime {
  const reader = new PacketReader(payload);
  const packed = reader.u32();
  const speed = reader.remaining >= 4 ? reader.f32() : 1 / 60;
  const minute = packed & 0x3f;
  const hour = (packed >> 6) & 0x1f;
  const weekday = (packed >> 11) & 0x07;
  const day = (packed >> 14) & 0x3f;
  const month = (packed >> 20) & 0x0f;
  const year = (packed >>> 24) & 0x1f;
  const candidate = year < 31 && month < 12 && day < 31
    ? { year: 2000 + year, month: month + 1, day: day + 1 } : undefined;
  const verified = candidate && new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day));
  const date = candidate && verified
    && verified.getUTCFullYear() === candidate.year
    && verified.getUTCMonth() + 1 === candidate.month
    && verified.getUTCDate() === candidate.day ? candidate : undefined;
  return {
    minuteOfDay: (hour % 24) * 60 + (minute % 60),
    // A zero or a nonsense speed would freeze the sky or spin it; the core's own value is 1/60.
    minutesPerSecond: Number.isFinite(speed) && speed > 0 && speed < 60 ? speed : 1 / 60,
    weekday,
    ...(date ? { date } : {}),
  };
}

/** The same clock `elapsedSeconds` later. */
export function advanceGameTime(time: GameTime, elapsedSeconds: number): GameTime {
  const totalMinutes = time.minuteOfDay + time.minutesPerSecond * elapsedSeconds;
  const days = Math.floor(totalMinutes / DAY_MINUTES);
  const minuteOfDay = ((totalMinutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  if (days === 0) return { ...time, minuteOfDay };
  const weekday = ((time.weekday + days) % 7 + 7) % 7;
  if (!time.date) return { ...time, minuteOfDay, weekday };
  const date = new Date(Date.UTC(time.date.year, time.date.month - 1, time.date.day + days));
  return {
    ...time, minuteOfDay,
    date: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    weekday,
  };
}

/** The time of day in the half-minutes the light bands are keyed on. */
export function halfMinuteOfDay(time: GameTime): number {
  return (time.minuteOfDay * 2) % DAY_HALF_MINUTES;
}

/** `HH:MM`, for the diagnostics window. */
export function formatGameTime(time: GameTime): string {
  const minutes = Math.floor(time.minuteOfDay);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
