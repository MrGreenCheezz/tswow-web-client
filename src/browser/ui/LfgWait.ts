/**
 * The dungeon finder's waits in words, as stock LFDFrame.lua writes them (WORK_PLAN 4.14).
 *
 * `SMSG_LFG_QUEUE_STATUS` carries every wait in seconds (`int32`, LFGHandler.cpp:464-474; the time
 * in queue is `currTime - joinTime`, LFGQueue.cpp:596): the native panel divided them by 60000 as
 * if they were milliseconds and always printed «0 мин». Stock (LFDFrame.lua:1133-1143): the time in
 * queue is `TIME_IN_QUEUE` with `SecondsToTime(elapsed)` from a minute on and
 * `LESS_THAN_ONE_MINUTE` before it; a wait is `TIME_UNKNOWN` at -1, else `SecondsToTime(wait, false,
 * false, 1)` — one abbreviated unit (UIParent.lua:2271-2325).
 */

import { nativeString } from "./Strings.js";

/** Stock `SecondsToTime(seconds, noSeconds, notAbbreviated = false, maxCount)`, abbreviated units. */
export function secondsToTime(seconds: number, noSeconds = false, maxCount = 2): string {
  let rest = Math.floor(Math.max(0, seconds));
  const parts: string[] = [];
  const unit = (size: number, key: string, fallback: string, always: boolean): void => {
    if (rest < size || (!always && parts.length >= maxCount)) return;
    parts.push(nativeString(key, fallback, Math.floor(rest / size)));
    rest %= size;
  };
  // Days and hours are written whatever maxCount says, as stock's two first branches do.
  unit(86400, "DAYS_ABBR", "%d д.", true);
  unit(3600, "HOURS_ABBR", "%d ч.", true);
  unit(60, "MINUTES_ABBR", "%d мин.", false);
  if (!noSeconds && rest > 0 && parts.length < maxCount) parts.push(nativeString("SECONDS_ABBR", "%d с.", rest));
  return parts.join(nativeString("TIME_UNIT_DELIMITER", " "));
}

/** A wait the server estimated: unknown at -1, else one unit; under a second reads as under a minute. */
export function formatLfgWait(seconds: number): string {
  if (seconds < 0) return nativeString("TIME_UNKNOWN", "Неизвестно");
  return secondsToTime(seconds, false, 1) || nativeString("LESS_THAN_ONE_MINUTE", "< 1 минуты");
}

/** The time already spent in the queue. */
export function formatLfgQueued(seconds: number): string {
  const elapsed = seconds >= 60 ? secondsToTime(seconds) : nativeString("LESS_THAN_ONE_MINUTE", "< 1 минуты");
  return nativeString("TIME_IN_QUEUE", "Время ожидания: %s", elapsed);
}

/** The average wait line. */
export function formatLfgAverage(seconds: number): string {
  return nativeString("LFG_STATISTIC_AVERAGE_WAIT", "Среднее время ожидания: %s", formatLfgWait(seconds));
}
