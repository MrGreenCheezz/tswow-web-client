import assert from "node:assert/strict";
import test from "node:test";

// The client's own words in the native interface (ui/Strings.ts, WORK_PLAN 4.10): string.format's
// subset, the fallback literal for a checkout without the local GlobalStrings table, and the
// client's escapes resolved. The table is a test double (`setStringSource`), never the local data.
const { formatGlobalString, nativeString, setStringSource } = await import("../dist/code/browser/ui/Strings.js");

const TABLE = {
  CAMP_TIMER: "До выхода в меню выбора персонажа: %d %s.",
  SWAPPED: "%2$s, затем %1$s",
  PERCENT: "%d%% готово",
  PRICE: "%.1f з.",
  PLURAL: "%d |4минута:минуты:минут;",
  COLOURED: "|cffffd100Жёлтый|r текст",
};

test("a key from the table is formatted: %d, %s, positional, %%, %.Nf", () => {
  setStringSource((key) => TABLE[key]);
  try {
    assert.equal(nativeString("CAMP_TIMER", "запас", 5.7, "с"), "До выхода в меню выбора персонажа: 5 с.");
    assert.equal(nativeString("SWAPPED", "запас", "первое", "второе"), "второе, затем первое");
    assert.equal(nativeString("PERCENT", "запас", 40), "40% готово");
    assert.equal(nativeString("PRICE", "запас", 2.25), "2.3 з.");
  } finally {
    setStringSource(undefined);
  }
});

test("flags and width as Lua's string.format reads them: %0.2f, %5d, %-4s|, %02d, %+d", () => {
  // DEFAULT_STATARMOR_TOOLTIP is "…снижен на %0.2f%%.": the 0 flag with no width pads nothing.
  assert.equal(formatGlobalString("снижен на %0.2f%%.", [12.346]), "снижен на 12.35%.");
  assert.equal(formatGlobalString("%.02f", [1.5]), "1.50");
  assert.equal(formatGlobalString("[%5d]", [42]), "[   42]");
  assert.equal(formatGlobalString("[%-4s]", ["ab"]), "[ab  ]");
  assert.equal(formatGlobalString("%02d:%02d", [3, 7]), "03:07");
  assert.equal(formatGlobalString("%05.1f", [-2.25]), "-02.3");
  assert.equal(formatGlobalString("%+d", [4]), "+4");
});

test("the client's escapes are resolved: |4 plurals agree with the number, colours are dropped", () => {
  setStringSource((key) => TABLE[key]);
  try {
    assert.equal(nativeString("PLURAL", "запас", 1), "1 минута");
    assert.equal(nativeString("PLURAL", "запас", 3), "3 минуты");
    assert.equal(nativeString("PLURAL", "запас", 11), "11 минут");
    assert.equal(nativeString("COLOURED", "запас"), "Жёлтый текст");
  } finally {
    setStringSource(undefined);
  }
});

test("L7 4.14: the Lua source's escapes are read as Lua reads them, not printed", () => {
  // The generated table keeps GlobalStrings.lua's text verbatim: TIME_UNIT_DELIMITER is "\32" (a
  // space) and CONFIRM_REMOVE_GLYPH-style questions carry \" around their %s.
  setStringSource((key) => ({ DELIMITER: "\\32", QUOTED: "Убрать \\\"%s\\\"?\\nДа" })[key]);
  try {
    assert.equal(nativeString("DELIMITER", "запас"), " ");
    assert.equal(nativeString("QUOTED", "запас", "Символ"), "Убрать \"Символ\"?\nДа");
  } finally {
    setStringSource(undefined);
  }
});

test("a missing key falls back to the literal, formatted the same way, and never throws", () => {
  setStringSource(() => undefined);
  try {
    assert.equal(nativeString("NO_SUCH_KEY", "Персонаж"), "Персонаж");
    assert.equal(nativeString("NO_SUCH_KEY", "Осталось %d с", 9), "Осталось 9 с");
    assert.equal(formatGlobalString("%s и %s", ["один"]), "один и ", "a missing argument is empty");
    assert.equal(formatGlobalString("%d", ["не число"]), "0");
  } finally {
    setStringSource(undefined);
  }
});
