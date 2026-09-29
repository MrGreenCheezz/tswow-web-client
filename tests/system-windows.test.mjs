import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  NOTICE_MAX, expireNotices, noticeText, pushNotice,
} from "../dist/code/browser/ui/NoticeModel.js";
import {
  MACRO_BODY_LIMIT, MACRO_NAME_LIMIT, MAX_ACCOUNT_MACROS, MAX_MACROS, findMacro, isAccountMacro,
  macroIndexes, macroLabel, macroLines, macroProblems, macrosForSet, nextFreeMacro, parseMacros,
  putMacro, removeMacro, serialiseMacros, trimMacroName,
} from "../dist/code/browser/ui/MacroModel.js";
import {
  SETTING_DEFINITIONS, coerceSetting, defaultSettings, parseSettings, serialiseSettings,
  settingBoolean, settingDefinition, settingNumber,
} from "../dist/code/browser/ui/SettingsModel.js";
import { spellFailureText } from "../dist/code/world/SpellProtocol.js";
import {
  GLOBAL_STRING_DATA_AVAILABLE, SPELL_CAST_RESULT_NAMES, globalString,
} from "../dist/code/generated/globalStrings.js";

const withGlobalStrings = {
  skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data",
};

// --- notices ------------------------------------------------------------------------------------

test("the same refusal twice is one line and a count", () => {
  // A key held down against a target out of range sends one refusal per attempt; four identical
  // lines say nothing one line and a count does not.
  const list = [];
  pushNotice(list, "Вне зоны действия.", "error", 0);
  pushNotice(list, "Вне зоны действия.", "error", 100);
  pushNotice(list, "Вне зоны действия.", "error", 200);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 3);
  assert.equal(noticeText(list[0]), "Вне зоны действия. ×3");
});

test("a different refusal starts its own line", () => {
  const list = [];
  pushNotice(list, "Нет места.", "error", 0);
  pushNotice(list, "Вне зоны действия.", "error", 1);
  assert.equal(list.length, 2);
  assert.equal(noticeText(list[1]), "Вне зоны действия.");
});

test("the queue is short, and the oldest goes first", () => {
  const list = [];
  for (let index = 0; index < NOTICE_MAX + 3; index++) pushNotice(list, `строка ${index}`, "error", index);
  assert.equal(list.length, NOTICE_MAX);
  assert.equal(list[0].text, "строка 3");
});

test("a repeat keeps the line alive rather than letting it expire mid-burst", () => {
  const list = [];
  pushNotice(list, "Нет места.", "error", 0);
  pushNotice(list, "Нет места.", "error", 5_000);
  expireNotices(list, 5_500);
  assert.equal(list.length, 1, "the second arrival pushed the deadline out");
  expireNotices(list, 20_000);
  assert.equal(list.length, 0);
});

test("an empty message is not a notice", () => {
  const list = [];
  pushNotice(list, "", "error", 0);
  assert.equal(list.length, 0);
});

// --- cast failures ------------------------------------------------------------------------------

test("a cast refusal is worded from the realm's own strings", withGlobalStrings, () => {
  // The wire carries a byte; the sentence has always been the client's job.
  const outOfRange = Object.entries(SPELL_CAST_RESULT_NAMES).find(([, name]) => name === "OUT_OF_RANGE");
  assert.ok(outOfRange, "the core still has an out-of-range result");
  assert.equal(spellFailureText(Number(outOfRange[0])), globalString("SPELL_FAILED_OUT_OF_RANGE"));
  assert.equal(spellFailureText(Number(outOfRange[0])), "Вне зоны действия.");
});

test("«do not report» produces no message at all", withGlobalStrings, () => {
  const dontReport = Object.entries(SPELL_CAST_RESULT_NAMES).find(([, name]) => name === "DONT_REPORT");
  assert.ok(dontReport);
  assert.equal(spellFailureText(Number(dontReport[0])), undefined, "the server is asking for silence");
  assert.equal(spellFailureText(0), undefined, "and success is not a refusal");
  assert.ok(spellFailureText(250)?.includes("250"), "an unknown code still says which one it was");
});

// --- macros --------------------------------------------------------------------------------------

test("fifty-four slots in one namespace, thirty-six of them shared", () => {
  assert.equal(MAX_MACROS, 54);
  assert.equal(isAccountMacro(1), true);
  assert.equal(isAccountMacro(MAX_ACCOUNT_MACROS), true);
  assert.equal(isAccountMacro(MAX_ACCOUNT_MACROS + 1), false, "37 is the first character macro");
  assert.deepEqual(macroIndexes(false)[0], MAX_ACCOUNT_MACROS + 1);
  assert.equal(macroIndexes(true).length, MAX_ACCOUNT_MACROS);
  assert.equal(macroIndexes(false).length, 18);
});

test("a body is the lines that will run, and blank ones are not lines", () => {
  assert.deepEqual(macroLines("/dance\n\n  /say Привет  \n"), ["/dance", "/say Привет"]);
});

test("a conditional is evaluated when it runs; only options that cannot be read are refused", () => {
  // Conditions are the client's own macro options, evaluated as the line runs (macro/MacroOptions.ts),
  // so `[combat]` is written like any other line; a bracket never closed cannot be read at all.
  assert.deepEqual(macroProblems("Бой", "/cast [combat] Удар; Рывок"), []);
  assert.ok(macroProblems("Бой", "/cast [combat Удар").some((line) => line.includes("не закрыта скобка")));
  assert.deepEqual(macroProblems("Бой", "/cast [@target] Удар"), []);
  assert.deepEqual(macroProblems("Танец", "/dance"), []);
  assert.ok(macroProblems("", "/dance").some((line) => line.includes("имя")));
  assert.ok(macroProblems("Пусто", "   ").some((line) => line.includes("пустое")));
});

test("names and bodies are cut to the limits the real client's frame declares", () => {
  assert.equal(trimMacroName("я".repeat(40)).length, MACRO_NAME_LIMIT);
  assert.ok(macroProblems("Имя", "я".repeat(MACRO_BODY_LIMIT + 1)).some((line) => line.includes("длиннее")));
});

test("the next free slot is in the half the player is looking at", () => {
  const macros = [{ index: 1, name: "А", body: "/dance" }];
  assert.equal(nextFreeMacro(macros, true), 2);
  assert.equal(nextFreeMacro(macros, false), MAX_ACCOUNT_MACROS + 1);
  const full = macroIndexes(false).map((index) => ({ index, name: "х", body: "/dance" }));
  assert.equal(nextFreeMacro(full, false), undefined);
});

test("putting a macro replaces the slot rather than adding a second one", () => {
  let macros = [{ index: 3, name: "Старое", body: "/dance" }];
  macros = putMacro(macros, { index: 3, name: "Новое", body: "/wave" });
  assert.equal(macros.length, 1);
  assert.equal(findMacro(macros, 3).name, "Новое");
  assert.equal(removeMacro(macros, 3).length, 0);
});

test("the two halves are stored apart, because they are two account slots", () => {
  const macros = [{ index: 1, name: "Общий", body: "/dance" }, { index: 40, name: "Свой", body: "/wave" }];
  assert.deepEqual(macrosForSet(macros, true).map((macro) => macro.name), ["Общий"]);
  assert.deepEqual(macrosForSet(macros, false).map((macro) => macro.name), ["Свой"]);
});

test("a stored blob survives the round trip and drops what it cannot use", () => {
  const macros = [{ index: 2, name: "Танец", body: "/dance" }];
  assert.deepEqual(parseMacros(serialiseMacros(macros)), macros);
  assert.equal(parseMacros("не json"), undefined);
  assert.deepEqual(parseMacros('[{"index":0},{"index":99},{"index":5,"name":"А","body":"/wave"}]'),
    [{ index: 5, name: "А", body: "/wave" }]);
});

test("a bar slot shows four letters, and a missing macro still says which slot", () => {
  assert.equal(macroLabel({ index: 3, name: "Танцевать", body: "" }, 3), "Танц");
  assert.equal(macroLabel(undefined, 7), "М7");
});

// --- settings --------------------------------------------------------------------------------------

test("every option has a definition and a default", () => {
  const values = defaultSettings();
  for (const definition of SETTING_DEFINITIONS) {
    assert.equal(values[definition.id], definition.fallback, definition.id);
    assert.equal(settingDefinition(definition.id)?.id, definition.id);
  }
});

test("post-process settings describe their visual effect and quality requirement", () => {
  const definition = settingDefinition("godRays");
  assert.equal(definition?.label, "Солнечные лучи");
  assert.equal(definition?.kind, "boolean");
  assert.equal(definition?.fallback, false);
  assert.match(definition?.hint ?? "", /качества освещения 1 или 2/);
  assert.equal(settingBoolean(parseSettings('{"godRays":true}'), "godRays"), true);
  assert.match(settingDefinition("fullscreenGlow")?.hint ?? "",
    /Мягкое сияние.*текущей зоны/);
});

test("applying settings pushes the god-rays leaf into the renderer", async () => {
  const source = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  assert.match(source, /setGodRays\?\.\(settingBoolean\(values, "godRays"\)\)/);
});

test("a number is clamped into its range and a boolean stays a boolean", () => {
  const height = settingDefinition("chatLogHeight");
  assert.equal(coerceSetting(height, 9999), height.max);
  assert.equal(coerceSetting(height, 1), height.min);
  assert.equal(coerceSetting(height, "не число"), height.fallback);
  const bubbles = settingDefinition("chatBubbles");
  assert.equal(coerceSetting(bubbles, "да"), false, "anything but true is false");
  assert.equal(coerceSetting(bubbles, true), true);
});

test("only what differs from the default is stored", () => {
  // The slot is shared with whatever version of this client wrote it last, and a blob that repeats
  // every default grows with every option added.
  const values = { ...defaultSettings(), chatBubbles: false };
  const text = serialiseSettings(values);
  assert.equal(text, '{"chatBubbles":false}');
  const parsed = parseSettings(text);
  assert.equal(settingBoolean(parsed, "chatBubbles"), false);
  assert.equal(settingBoolean(parsed, "floatingCombatText"), true, "the rest come back as defaults");
});

test("an option that no longer exists does not survive in the blob", () => {
  const parsed = parseSettings('{"chatBubbles":false,"somethingRemoved":42}');
  assert.equal(parsed.somethingRemoved, undefined);
  assert.equal(parseSettings("[]"), undefined, "an array is not a settings blob");
  assert.equal(parseSettings("{"), undefined);
  assert.equal(settingNumber(parsed, "chatLogHeight"), 190);
});
