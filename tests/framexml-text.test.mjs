import assert from "node:assert/strict";
import test from "node:test";

const { parseFrameXmlText, plainFrameXmlText, hasFrameXmlEscapes } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");

test("message links preserve payload and nested colours without exposing escape codes", () => {
  assert.deepEqual(parseFrameXmlText("От |Hplayer:Игрок:1:SAY|h|cff00ff00[Игрок]|r|h: привет", true), [
    { text: "От " },
    { text: "[Игрок]", color: "#00ff00ff", hyperlink: "player:Игрок:1:SAY" },
    { text: ": привет" },
  ]);
  assert.deepEqual(parseFrameXmlText("|Hitem:1|h[Предмет]|h", false), [{ text: "[Предмет]" }]);
});

// Every string in this file is one the client itself ships. They were read out of the live glue
// screen, where they were being drawn as their own escape codes.

test("a string with no escape comes back as one uncoloured run", () => {
  assert.deepEqual(parseFrameXmlText("Войти в игровой мир"), [{ text: "Войти в игровой мир" }]);
  assert.equal(hasFrameXmlEscapes("Войти в игровой мир"), false);
  assert.deepEqual(parseFrameXmlText(""), []);
});

test("|cAARRGGBB opens a colour and |r closes it", () => {
  // `AccountLoginSavePasswordText` on this client's login screen.
  assert.deepEqual(parseFrameXmlText("|cffDFD8B5Запомнить пароль"), [
    { text: "Запомнить пароль", color: "#dfd8b5ff" },
  ]);
  // `RealmWizardGameTypeButton2Text`.
  assert.deepEqual(parseFrameXmlText("Игроки пр. игроков |cffff0000(PvP)|r"), [
    { text: "Игроки пр. игроков " },
    { text: "(PvP)", color: "#ff0000ff" },
  ]);
  // The alpha byte leads and lands last in CSS.
  assert.deepEqual(parseFrameXmlText("|c80112233half|r"), [{ text: "half", color: "#11223380" }]);
});

test("an uppercase |C is accepted, because the client's own data uses it", () => {
  // `AccountLoginUIText`, verbatim: a colour opened and closed with nothing between it, which the
  // screen was drawing as the literal text "|CFFb90908|r".
  assert.deepEqual(parseFrameXmlText("|CFFb90908|r"), []);
  assert.deepEqual(parseFrameXmlText("|CFFb90908тест|R"), [{ text: "тест", color: "#b90908ff" }]);
});

test("|r restores the colour that was open before, not "
  + "no colour at all", () => {
  assert.deepEqual(parseFrameXmlText("|cffff0000a|cff00ff00b|rc|r"), [
    { text: "a", color: "#ff0000ff" },
    { text: "b", color: "#00ff00ff" },
    { text: "c", color: "#ff0000ff" },
  ]);
});

test("|| is a literal pipe and is read before any other escape", () => {
  assert.deepEqual(parseFrameXmlText("a||b"), [{ text: "a|b" }]);
  // `||c` is the two characters "|c" and must not open a colour.
  assert.deepEqual(parseFrameXmlText("||cffff0000"), [{ text: "|cffff0000" }]);
});

test("|n is a line break", () => {
  assert.deepEqual(parseFrameXmlText("первая|nвторая"), [{ text: "первая\nвторая" }]);
});

test("Russian |3-N grammar markers keep the supplied form without leaking syntax", () => {
  const header = "Человек, |3-6(Паладин) 69-го уровня";
  // Case 6 comes only from the client's DeclinedWord dictionary; without one the word stays.
  assert.deepEqual(parseFrameXmlText(header), [{ text: "Человек, Паладин 69-го уровня" }]);
  assert.equal(plainFrameXmlText(header), "Человек, Паладин 69-го уровня");
  // The client's `|3` pass (Wow.exe 0x481E90) takes the word to the end of an unterminated string.
  assert.deepEqual(parseFrameXmlText("|3-6(Паладин"), [{ text: "Паладин" }]);
});

test("a hyperlink renders its text and drops its payload", () => {
  assert.deepEqual(parseFrameXmlText("|Hitem:19019:0:0:0|h[Тандерфьюри]|h"), [
    { text: "[Тандерфьюри]" },
  ]);
  assert.deepEqual(parseFrameXmlText("|cff1eff00|Hitem:3299|h[Кинжал]|h|r"), [
    { text: "[Кинжал]", color: "#1eff00ff" },
  ]);
});

test("an inline texture is dropped whole rather than printed as a path", () => {
  assert.deepEqual(parseFrameXmlText("до |TInterface\\Icons\\INV_Misc_Rune_01:16|t после"), [
    { text: "до  после" },
  ]);
});

test("an escape this build does not know keeps its own characters", () => {
  // Never swallow: a malformed sequence shows itself instead of eating the line.
  assert.deepEqual(parseFrameXmlText("100|% готово"), [{ text: "100|% готово" }]);
  // Eight hex digits are required; seven is not a colour.
  assert.deepEqual(parseFrameXmlText("|cffff000 текст"), [{ text: "|cffff000 текст" }]);
  // An unterminated colour runs to the end of the string, as the client's own does.
  assert.deepEqual(parseFrameXmlText("|cff00ff00до конца"), [
    { text: "до конца", color: "#00ff00ff" },
  ]);
});

test("a |4 plural agrees with the number written before it", () => {
  // GlobalStrings.lua:7319 SPELL_TIME_REMAINING_MIN, formatted with each Russian form's numbers.
  const minutes = (count) => plainFrameXmlText(`Осталось: ${count} |4минута:минуты:минут;`);
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(minutes), [
    "Осталось: 1 минута", "Осталось: 2 минуты", "Осталось: 4 минуты", "Осталось: 5 минут",
    "Осталось: 11 минут", "Осталось: 12 минут", "Осталось: 14 минут", "Осталось: 21 минута",
    "Осталось: 22 минуты", "Осталось: 25 минут", "Осталось: 101 минута", "Осталось: 111 минут",
  ]);
  // Two forms are the English rule; the number may sit in an earlier colour run.
  assert.equal(plainFrameXmlText("|cffffffff1|r |4hour:hours;"), "1 hour");
  assert.equal(plainFrameXmlText("3 |4hour:hours;"), "3 hours");
  // A combat line: the amount is the last number before the escape.
  assert.equal(plainFrameXmlText("Игрок получает 150 |4единицу:единицы:единиц; урона."), "Игрок получает 150 единиц урона.");
  // Unterminated, it is shown as written.
  assert.equal(plainFrameXmlText("5 |4минута:минуты"), "5 |4минута:минуты");
});

test("plainFrameXmlText is every run joined", () => {
  assert.equal(plainFrameXmlText("|cffff0000(PvP)|r и |cff00ff00(RP)|r"), "(PvP) и (RP)");
  assert.equal(plainFrameXmlText("|Hspell:133|h[Огненный шар]|h"), "[Огненный шар]");
});
