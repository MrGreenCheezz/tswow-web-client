import assert from "node:assert/strict";
import test from "node:test";

// 5.37 (11.11): Wow.exe's macro cache text (account-data slots 4 and 5), read as its reader 0x00567c10 reads
// it and written as its writer 0x005668f0 writes it. Every text here is written for the test.

const {
  parseWowMacroText, serialiseWowMacroText, stormToken, stormAtoi, WOW_CHARACTER_MACRO_BASE,
} = await import("../dist/code/browser/ui/MacroCacheText.js");

const CRLF = "\r\n";
const lines = (...rows) => rows.map((row) => row + CRLF).join("");

test("a block: id, a quoted name with spaces, the icon name, body lines with a LF each, blank lines gone", () => {
  const text = lines("MACRO 3 \"Two words\" Spell_Fire_Fireball", "/cast Fireball", "", "/say hi", "END");
  assert.deepEqual(parseWowMacroText(text, false), [
    { id: 3, name: "Two words", icon: "Spell_Fire_Fireball", body: "/cast Fireball\n/say hi\n" },
  ]);
  // LF alone splits lines as well: the reader's delimiters are CR and LF.
  assert.deepEqual(parseWowMacroText("MACRO 3 \"A\" X\n/a\nEND\n", false)[0].body, "/a\n");
});

test("MACRO and END are matched without case; END only as the whole line", () => {
  const text = lines("macro 1 \"A\" X", " END", "/b", "end", "Macro 2 \"B\" Y", "END");
  const read = parseWowMacroText(text, false);
  assert.deepEqual(read.map((macro) => [macro.id, macro.body]), [[1, " END\n/b\n"], [2, ""]]);
});

test("a header with id 0, a non-number or an id already read is skipped, and so are its body lines", () => {
  const text = lines(
    "MACRO 0 \"Zero\" X", "/zero", "END",
    "MACRO abc \"Word\" X", "/word", "END",
    "MACRO 5 \"First\" X", "/first", "END",
    "MACRO 5 \"Again\" X", "/again", "END",
  );
  assert.deepEqual(parseWowMacroText(text, false).map((macro) => [macro.id, macro.name, macro.body]), [[5, "First", "/first\n"]]);
});

test("a character set adds 0x1000000 to an id below it; an id at or above it stays", () => {
  const text = lines("MACRO 1 \"Low\" X", "END", "MACRO 16777218 \"High\" X", "END");
  assert.deepEqual(parseWowMacroText(text, true).map((macro) => macro.id), [WOW_CHARACTER_MACRO_BASE + 1, WOW_CHARACTER_MACRO_BASE + 2]);
  assert.deepEqual(parseWowMacroText(text, false).map((macro) => macro.id), [1, 16777218]);
});

test("an empty name skips the block; a missing icon is an empty one", () => {
  const text = lines("MACRO 1 \"\" X", "/skipped", "END", "MACRO 2 \"NoIcon\"", "/kept", "END");
  assert.deepEqual(parseWowMacroText(text, false), [{ id: 2, name: "NoIcon", icon: "", body: "/kept\n" }]);
});

test("the reader takes 36 macros of a set and no more", () => {
  let text = "";
  for (let id = 1; id <= 40; id += 1) text += lines(`MACRO ${id} "M${id}" X`, "/x", "END");
  assert.equal(parseWowMacroText(text, false).length, 36);
});

test("the name keeps 63 bytes, the icon 255, the body 256 characters", () => {
  const name = "n".repeat(70);
  const icon = "i".repeat(300);
  const body = "b".repeat(300);
  const [macro] = parseWowMacroText(lines(`MACRO 1 "${name}" ${icon}`, body, "END"), false);
  assert.equal(macro.name, "n".repeat(63));
  assert.equal(macro.icon, "i".repeat(255));
  assert.equal(macro.body, "b".repeat(256));
  // Bytes, not characters: a Cyrillic letter is two, and one the cut would split is dropped.
  assert.equal(parseWowMacroText(lines(`MACRO 1 "${"ж".repeat(40)}" X`, "END"), false)[0].name, "ж".repeat(31));
});

test("a block never closed keeps its name and icon and no body", () => {
  assert.deepEqual(parseWowMacroText(lines("MACRO 4 \"Open\" X", "/lost"), false), [{ id: 4, name: "Open", icon: "X", body: "" }]);
});

test("lines outside a block that are not a header are ignored", () => {
  assert.deepEqual(parseWowMacroText(lines("junk", "MACRO", "MACRO 7 \"A\" X", "END", "more junk"), false).map((macro) => macro.id), [7]);
  assert.deepEqual(parseWowMacroText('[{"index":1,"name":"Gm","body":"/x"}]', false), []);
});

test("Storm's tokenizer: a quote opens a run, a quote after text ends the token unconsumed", () => {
  const cursor = { text: "MACRO 1 \"a b\"c\" d", at: 0 };
  assert.equal(stormToken(cursor, " "), "MACRO");
  assert.equal(stormToken(cursor, " "), "1");
  assert.equal(stormToken(cursor, " \"\r\n"), "a b");
  assert.equal(stormToken(cursor, " \"\r\n"), "c");
  assert.equal(stormToken(cursor, " \"\r\n"), " d", "the closing quote is consumed by the next token and opens a run");
  assert.equal(stormAtoi("-12x"), -12);
  assert.equal(stormAtoi("x12"), 0);
  assert.equal(stormAtoi("4294967297"), 1, "32-bit wrap");
});

test("the writer: CRLF, sorted by name without case, empty lines dropped, nothing escaped", () => {
  const text = serialiseWowMacroText([
    { id: 2, name: "beta", icon: "B", body: "/b\n\n/c" },
    { id: 9, name: "Alpha", icon: "A", body: "/a\n" },
    { id: 0x1000001, name: "Gamma", icon: "", body: "" },
  ]);
  assert.equal(text, lines(
    "MACRO 9 \"Alpha\" A", "/a", "END",
    "MACRO 2 \"beta\" B", "/b", "/c", "END",
    "MACRO 16777217 \"Gamma\" ", "END",
  ));
  assert.equal(serialiseWowMacroText([]), "");
});

test("round trip: Wow.exe's text read and written gives back the same text", () => {
  const original = lines(
    "MACRO 1 \"Attack\" Ability_Rogue_Sprint", "#showtooltip", "/cast [@target,harm] Sinister Strike", "END",
    "MACRO 12 \"bandage\" INV_Misc_Bandage_15", "/use Heavy Frostweave Bandage", "END",
    "MACRO 4 \"Огонь и лёд\" Spell_Fire_Fireball02", "/cast Огненный шар", "/say \"пли\"", "END",
  );
  const read = parseWowMacroText(original, false);
  assert.equal(read.length, 3);
  assert.equal(serialiseWowMacroText(read), original);
  assert.deepEqual(parseWowMacroText(serialiseWowMacroText(read), false), read);
});
