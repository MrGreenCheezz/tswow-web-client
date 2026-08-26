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
  /** Game minutes per real second. The server's own default is 1/60, i.e. an hour in a minute. */
  minutesPerSecond: number;
  /** Day of the week the packet reported, 0 = Sunday. Kept because nothing else carries it. */
  weekday: number;
}

/**
 * Decodes the packed calendar the core sends.
 *
 * `secsToTimeBitFields` packs a whole date into one word: minute in bits 0-5, hour in 6-10,
 * weekday in 11-13, day of month in 14-19, month in 20-23 and year in 24-31. Only the time of day
 * is read here — the date is the real one on the server's machine and means nothing to the sky.
 */
export function parseLoginSetTimeSpeed(payload: Uint8Array): GameTime {
  const reader = new PacketReader(payload);
  const packed = reader.u32();
  const speed = reader.remaining >= 4 ? reader.f32() : 1 / 60;
  const minute = packed & 0x3f;
  const hour = (packed >> 6) & 0x1f;
  const weekday = (packed >> 11) & 0x07;
  return {
    minuteOfDay: (hour % 24) * 60 + (minute % 60),
    // A zero or a nonsense speed would freeze the sky or spin it; the core's own value is 1/60.
    minutesPerSecond: Number.isFinite(speed) && speed > 0 && speed < 60 ? speed : 1 / 60,
    weekday,
  };
}

/** The same clock `elapsedSeconds` later. */
export function advanceGameTime(time: GameTime, elapsedSeconds: number): GameTime {
  const minuteOfDay = (time.minuteOfDay + time.minutesPerSecond * elapsedSeconds) % DAY_MINUTES;
  return { ...time, minuteOfDay: minuteOfDay < 0 ? minuteOfDay + DAY_MINUTES : minuteOfDay };
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
