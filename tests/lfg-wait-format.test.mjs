// 4.14: the dungeon finder's waits are seconds on the wire (LFGHandler.cpp:464-474) and read in
// stock LFDFrame.lua's words; the native panel used to divide them by 60000 and print «0 мин».
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { setStringSource } = await import("../dist/code/browser/ui/Strings.js");
const wait = await import("../dist/code/browser/ui/LfgWait.js");
setStringSource((key) => ({
  DAYS_ABBR: "%d д.", HOURS_ABBR: "%d ч.", MINUTES_ABBR: "%d мин.", SECONDS_ABBR: "%d с.", TIME_UNIT_DELIMITER: " ",
  LESS_THAN_ONE_MINUTE: "< 1 минуты", TIME_UNKNOWN: "Неизвестно", TIME_IN_QUEUE: "Время ожидания: %s",
  LFG_STATISTIC_AVERAGE_WAIT: "Среднее время ожидания: %s",
})[key]);

test("a wait: unknown at -1, one abbreviated unit otherwise", () => {
  assert.equal(wait.formatLfgWait(-1), "Неизвестно");
  assert.equal(wait.formatLfgWait(30), "30 с.");
  assert.equal(wait.formatLfgWait(90), "1 мин.");
  assert.equal(wait.formatLfgWait(1500), "25 мин.");
  assert.equal(wait.formatLfgWait(0), "< 1 минуты");
  assert.equal(wait.formatLfgAverage(1500), "Среднее время ожидания: 25 мин.");
});

test("the time in queue: under a minute, then SecondsToTime's two units", () => {
  assert.equal(wait.formatLfgQueued(45), "Время ожидания: < 1 минуты");
  assert.equal(wait.formatLfgQueued(125), "Время ожидания: 2 мин. 5 с.");
  assert.equal(wait.formatLfgQueued(3725), "Время ожидания: 1 ч. 2 мин.");
  assert.equal(wait.secondsToTime(90061, false, 1), "1 д. 1 ч.", "days and hours ignore maxCount, as stock");
});

test("the native queue panel no longer divides seconds by 60000", async () => {
  const source = await readFile(new URL("../src/browser/ui/Social.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/ 60000\) \} мин|wait \/ 60000|waitTimeAverage \/ 60000/);
  // L7 4.14: since the 02.10 review the line is stock's myWait, the wire's second wait (LFDFrame.lua:1137-1143).
  assert.match(source, /formatLfgAverage\(queue\.waitTime\)/);
});
