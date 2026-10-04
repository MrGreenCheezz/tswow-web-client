// 4.13: the native logout panel counts the server's twenty seconds the way the stock CAMP popup
// does (StaticPopup.lua:1476-1494, 3321-3335), and Escape on it cancels the logout.
import assert from "node:assert/strict";
import test from "node:test";

const { setStringSource } = await import("../dist/code/browser/ui/Strings.js");
const countdown = await import("../dist/code/browser/ui/LogoutCountdown.js");

setStringSource((key) => ({
  CAMP_TIMER: "До выхода в меню выбора персонажа: %d %s.",
  QUIT_TIMER: "До выхода из игры осталось %d %s",
  SECONDS: "с", MINUTES: "мин.",
})[key]);

test("twenty seconds from the response, rounded up, never below zero; nothing for an instant logout", () => {
  assert.equal(countdown.LOGOUT_DELAY_SECONDS, 20);
  assert.equal(countdown.logoutRemaining(0, 0, false), 20);
  assert.equal(countdown.logoutRemaining(0, 1_000, false), 19);
  assert.equal(countdown.logoutRemaining(0, 19_001, false), 1, "ceil, as stock's timeleft");
  assert.equal(countdown.logoutRemaining(0, 20_000, false), 0);
  assert.equal(countdown.logoutRemaining(0, 25_000, false), 0);
  assert.equal(countdown.logoutRemaining(0, 0, true), undefined, "resting or GM: no count");
});

test("the CAMP and QUIT lines, seconds under a minute and minutes above", () => {
  assert.equal(countdown.logoutCountdownText(20, false), "До выхода в меню выбора персонажа: 20 с.");
  assert.equal(countdown.logoutCountdownText(7, true), "До выхода из игры осталось 7 с");
  assert.equal(countdown.logoutCountdownText(61, false), "До выхода в меню выбора персонажа: 2 мин..");
});
