import assert from "node:assert/strict";
import test from "node:test";

// 1.19 (15.11, lane misc8): the client's own check of a declined form (Wow.exe 0x4d9a40 → 0x6b0fc0 → 0x76dd90):
// the name walk with the profane and chat lists (not the reserved one) and five letters more, then 0x76e390 —
// the form begins with the name's stem (0x76de70, a fleeting е/о/ё cut off) and adds fewer than six letters.
const { checkDeclinedName, glueDeclensionStem, glueDeclensionMatchesName } =
  await import("../dist/code/browser/glue/GlueDeclensionCheck.js");
const { RESPONSE_CODES } = await import("../dist/code/generated/responseCodes.js");

const OK = RESPONSE_CODES.CHAR_NAME_SUCCESS;

test("the stem: the rule's, or the fleeting vowel's position (0x76de70)", () => {
  assert.deepEqual(glueDeclensionStem("Аэлинда"), { word: "аэлинда", stem: 6 }, "rule «а»: the а cut off");
  assert.deepEqual(glueDeclensionStem("Кролик"), { word: "кролик", stem: 6 }, "no rule, и before the last: no fleeting vowel");
  assert.deepEqual(glueDeclensionStem("Котёл"), { word: "котёл", stem: 3 }, "no rule, ё before the last: cut there");
  assert.deepEqual(glueDeclensionStem("Огонь"), { word: "огонь", stem: 2 }, "rule «ь», о two before the last: cut there");
  assert.deepEqual(glueDeclensionStem("Ель"), { word: "ель", stem: 2 }, "under four letters the ь rule keeps its own stem");
});

test("0x76e390: the form begins with the stem, case folded, and adds fewer than six letters", () => {
  assert.equal(glueDeclensionMatchesName("Котёл", "Котла"), true, "only with the fleeting vowel");
  assert.equal(glueDeclensionMatchesName("Огонь", "ОГНЯ"), true, "case folded as 0x7e1180 folds");
  assert.equal(glueDeclensionMatchesName("Огонь", "Агня"), false);
  assert.equal(glueDeclensionMatchesName("Кролик", "Кролика"), true);
  assert.equal(glueDeclensionMatchesName("Кролик", "Кроликабвгд"), true, "five letters past the stem");
  assert.equal(glueDeclensionMatchesName("Кролик", "Кроликабвгде"), false, "six are too many");
  assert.equal(glueDeclensionMatchesName("Кролик", "Крол"), false, "shorter than the stem");
});

test("the walk: profane and chat lists but not the reserved one, the limit five letters longer, ruRU only", () => {
  // Lower-case Cyrillic patterns: the client's caseless match folds ASCII only (GlueNameFilters.ts).
  const nameFilters = { profane: [/лохиш/], chat: [/рани/], reserved: [/отла/] };
  assert.equal(checkDeclinedName("Котёл", "Котла", { nameFilters }), OK, "a reserved pattern does not refuse a form");
  assert.equal(checkDeclinedName("Брань", "Брани", { nameFilters }), RESPONSE_CODES.CHAR_NAME_RESERVED);
  assert.equal(checkDeclinedName("Плохиш", "Плохиша", { nameFilters }), RESPONSE_CODES.CHAR_NAME_RESERVED);
  const long = "Абвгдежзийклмнопр"; // 17 letters: 12 + 5
  assert.equal(checkDeclinedName(long, long, {}), OK);
  assert.equal(checkDeclinedName(long, `${long}а`, {}), RESPONSE_CODES.CHAR_NAME_TOO_LONG);
  assert.equal(checkDeclinedName("Котёл", "Кот ла", {}), RESPONSE_CODES.CHAR_NAME_INVALID_CHARACTER);
  assert.equal(checkDeclinedName("Котёл", "Котла", { locale: "enUS" }), RESPONSE_CODES.CHAR_NAME_FAILURE);
});
