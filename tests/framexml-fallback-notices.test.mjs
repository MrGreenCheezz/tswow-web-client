import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.24: a stock window whose gate refused is told to the player once per kind, recorded
// for frameXmlWorld().fallbacks, and still warned on the console (FrameXmlFallbackNotices.ts).
const {
  createFrameXmlFallbackNotices, frameXmlFallbackText,
} = await import("../dist/code/browser/framexml/FrameXmlFallbackNotices.js");

test("one notice per kind, every report recorded and warned", () => {
  const notices = [];
  const warnings = [];
  let clock = 0;
  const fallbacks = createFrameXmlFallbackNotices({
    notice: (text) => notices.push(text), warn: (text) => warnings.push(text), now: () => ++clock,
  });
  fallbacks.report("trainer", "ClassTrainerFrame не прошёл проверку");
  fallbacks.report("trainer", "ещё раз");
  fallbacks.report("mail", "нет MailFrame");
  assert.deepEqual(notices, [
    "Штатное окно «Тренер» не собралось: ClassTrainerFrame не прошёл проверку. Показано упрощённое.",
    "Штатное окно «Почта» не собралось: нет MailFrame. Показано упрощённое.",
  ]);
  assert.deepEqual(fallbacks.records.map((record) => [record.kind, record.reason, record.at]), [
    ["trainer", "ClassTrainerFrame не прошёл проверку", 1], ["trainer", "ещё раз", 2], ["mail", "нет MailFrame", 3],
  ]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[1], /^\[FrameXML trainer\] ещё раз/);
});

test("an unknown kind is named as it is; a throwing notice does not break the report", () => {
  assert.equal(frameXmlFallbackText("guildbank", "x"), "Штатное окно «guildbank» не собралось: x. Показано упрощённое.");
  const fallbacks = createFrameXmlFallbackNotices({ notice: () => { throw new Error("no strip"); }, warn: () => {} });
  fallbacks.report("map", "нет карты");
  assert.equal(fallbacks.records.length, 1);
});
