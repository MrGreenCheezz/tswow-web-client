/**
 * The twenty seconds of a logout, as the stock CAMP and QUIT popups count them (WORK_PLAN 4.13).
 *
 * The server grants a logout with `SMSG_LOGOUT_RESPONSE` and completes it twenty seconds after the
 * request (`WorldSession::ShouldLogOut`, WorldSession.h:514-517: `currTime >= _logoutTime + 20`);
 * the response carries no clock, so the client counts from its arrival, as stock does
 * (StaticPopup.lua:1476-1494, `timeout = 20`). A resting or flying character, or a game master, is
 * let out at once (`instant`, MiscHandler.cpp:488-489, 514-518): there is nothing to count.
 *
 * The text is stock's (StaticPopup.lua:3321-3335): `ceil` of what is left, seconds under a minute
 * and minutes above it, in `CAMP_TIMER` «До выхода в меню выбора персонажа: %d %s.» or, for
 * `Quit()`, `QUIT_TIMER` «До выхода из игры осталось %d %s».
 */

import { nativeString } from "./Strings.js";

export const LOGOUT_DELAY_SECONDS = 20;

/** Whole seconds left, never below 0; undefined for an instant logout. */
export function logoutRemaining(startedAt: number, now: number, instant: boolean): number | undefined {
  if (instant) return undefined;
  return Math.max(0, Math.ceil(LOGOUT_DELAY_SECONDS - (now - startedAt) / 1000));
}

/** The popup's line for `seconds` left; `quit` picks QUIT_TIMER. */
export function logoutCountdownText(seconds: number, quit: boolean): string {
  const minutes = seconds >= 60;
  const value = minutes ? Math.ceil(seconds / 60) : seconds;
  const unit = minutes ? nativeString("MINUTES", "мин.") : nativeString("SECONDS", "с");
  return quit
    ? nativeString("QUIT_TIMER", "До выхода из игры осталось %d %s", value, unit)
    : nativeString("CAMP_TIMER", "До выхода в меню выбора персонажа: %d %s.", value, unit);
}
