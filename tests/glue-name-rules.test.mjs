import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCharacterName, inNameAlphabet, nameAlphabet, sameCharacterName,
  NAME_ALPHABET_ASCII, NAME_ALPHABET_CJK, NAME_ALPHABET_CYRILLIC, NAME_ALPHABET_HANGUL, NAME_ALPHABET_LATIN,
} from "../dist/code/browser/glue/GlueNameRules.js";

/**
 * The client's name check (FUN_007e18c0 through FUN_007e1e90 in Wow.exe 12340), one rule at a time,
 * by the ResponseCodes value it answers. Numbers, not keys, so a wrong code cannot hide behind a
 * right-looking string.
 */

const SUCCESS = 87;
const NO_NAME = 89;
const TOO_SHORT = 90;
const TOO_LONG = 91;
const INVALID_CHARACTER = 92;
const THREE_CONSECUTIVE = 98;
const RUSSIAN_CONSECUTIVE_SILENT = 101;
const RUSSIAN_SILENT_AT_EDGE = 102;

test("ordinary names pass in every alphabet", () => {
  for (const name of ["Аларин", "Thrall", "Jaïna", "Ёжик", "Ана", "Ab"]) {
    assert.equal(checkCharacterName(name), SUCCESS, name);
  }
  assert.equal(checkCharacterName("가나다"), SUCCESS, "KS X 1001 syllables");
  assert.equal(checkCharacterName("王小明"), SUCCESS, "CJK");
});

test("the first letter picks the alphabet, and every later letter must be in it", () => {
  assert.equal(nameAlphabet("Ana"), NAME_ALPHABET_LATIN, "Latin with Latin-1 comes before ASCII");
  assert.equal(nameAlphabet("Ана"), NAME_ALPHABET_CYRILLIC);
  assert.equal(nameAlphabet("가"), NAME_ALPHABET_HANGUL);
  assert.equal(nameAlphabet("王"), NAME_ALPHABET_CJK);
  assert.equal(checkCharacterName("Anа"), INVALID_CHARACTER, "a Cyrillic а after Latin letters");
  assert.equal(checkCharacterName("Аnа"), INVALID_CHARACTER, "Latin n after a Cyrillic А");
  // Not MIXED_LANGUAGES: the client never answers 93 from this check.
  assert.notEqual(checkCharacterName("Anа"), 93);
});

test("a space, a digit, an apostrophe or a hyphen is an invalid character, wherever it is", () => {
  for (const name of ["Ана Бета", " Ана", "Ана ", "Ана1", "O'Neil", "Ан-на", "   "]) {
    assert.equal(checkCharacterName(name), INVALID_CHARACTER, JSON.stringify(name));
  }
});

test("length: nothing, one letter, and more than 12 (Hangul 8, CJK 6)", () => {
  assert.equal(checkCharacterName(""), NO_NAME);
  assert.equal(checkCharacterName("А"), TOO_SHORT);
  assert.equal(checkCharacterName("Абвгдежзийкл"), SUCCESS, "12 letters");
  assert.equal(checkCharacterName("Абвгдежзийклм"), TOO_LONG, "13 letters");
  assert.equal(checkCharacterName("가나다라마바사아"), SUCCESS, "8 Hangul");
  assert.equal(checkCharacterName("가나다라마바사아자"), TOO_LONG, "9 Hangul");
  assert.equal(checkCharacterName("王小明王小明"), SUCCESS, "6 CJK");
  assert.equal(checkCharacterName("王小明王小明王"), TOO_LONG, "7 CJK");
  // The letter checks come first: a long name with a bad letter is refused for the letter.
  assert.equal(checkCharacterName("Абвгдежзийклм1"), INVALID_CHARACTER);
});

test("three identical letters in a row are refused, case folded, Ё with ё", () => {
  assert.equal(checkCharacterName("Аааня"), THREE_CONSECUTIVE);
  assert.equal(checkCharacterName("ААа"), THREE_CONSECUTIVE);
  assert.equal(checkCharacterName("Aaab"), THREE_CONSECUTIVE);
  assert.equal(checkCharacterName("Ёёё"), THREE_CONSECUTIVE);
  assert.equal(checkCharacterName("Аанна"), SUCCESS, "two in a row is fine");
  assert.equal(checkCharacterName("ЕЁЕ"), SUCCESS, "Ё is not Е");
});

test("the Russian silent-letter rules: ъ/ь first, ъ last, two in a row", () => {
  assert.equal(checkCharacterName("Ьяна"), RUSSIAN_SILENT_AT_EDGE);
  assert.equal(checkCharacterName("Ъяна"), RUSSIAN_SILENT_AT_EDGE);
  assert.equal(checkCharacterName("Анаъ"), RUSSIAN_SILENT_AT_EDGE);
  assert.equal(checkCharacterName("Анабель"), SUCCESS, "ь last is allowed");
  assert.equal(checkCharacterName("Объект"), SUCCESS, "ъ inside is allowed");
  assert.equal(checkCharacterName("Анаьъя"), RUSSIAN_CONSECUTIVE_SILENT);
  assert.equal(checkCharacterName("Анаьья"), RUSSIAN_CONSECUTIVE_SILENT);
  // Only in Cyrillic: nothing else has those letters to check.
});

test("forceEnglishNames and the category mask narrow the alphabets", () => {
  assert.equal(checkCharacterName("Ана", { forceEnglishNames: true }), INVALID_CHARACTER);
  assert.equal(checkCharacterName("Jaïna", { forceEnglishNames: true }), INVALID_CHARACTER, "ASCII, not Latin-1");
  assert.equal(checkCharacterName("Thrall", { forceEnglishNames: true }), SUCCESS);
  assert.equal(nameAlphabet("Thrall", { forceEnglishNames: true }), NAME_ALPHABET_ASCII);
  // A category that allows Cyrillic only; 0 — no Cfg_Categories row — allows all five.
  assert.equal(checkCharacterName("Thrall", { alphabetMask: 1 << NAME_ALPHABET_CYRILLIC }), INVALID_CHARACTER);
  assert.equal(checkCharacterName("Ана", { alphabetMask: 1 << NAME_ALPHABET_CYRILLIC }), SUCCESS);
  assert.equal(checkCharacterName("Ана", { alphabetMask: 0 }), SUCCESS);
});

test("the alphabets are the client's ranges", () => {
  assert.equal(inNameAlphabet(0xd7, NAME_ALPHABET_LATIN), false, "×");
  assert.equal(inNameAlphabet(0xde, NAME_ALPHABET_LATIN), false, "Þ");
  assert.equal(inNameAlphabet(0xdf, NAME_ALPHABET_LATIN), true, "ß");
  assert.equal(inNameAlphabet(0xf7, NAME_ALPHABET_LATIN), false, "÷");
  assert.equal(inNameAlphabet(0xfe, NAME_ALPHABET_LATIN), false, "þ");
  assert.equal(inNameAlphabet(0xff, NAME_ALPHABET_LATIN), true, "ÿ");
  assert.equal(inNameAlphabet(0x401, NAME_ALPHABET_CYRILLIC), true, "Ё");
  assert.equal(inNameAlphabet(0x404, NAME_ALPHABET_CYRILLIC), false, "Є is not in it");
  assert.equal(inNameAlphabet(0xac01, NAME_ALPHABET_HANGUL), true, "각 is in KS X 1001");
  assert.equal(inNameAlphabet(0xac03, NAME_ALPHABET_HANGUL), false, "갃 is a syllable KS X 1001 leaves out");
  assert.equal(inNameAlphabet(0xf900, NAME_ALPHABET_CJK), true);
  assert.equal(inNameAlphabet(0xfb00, NAME_ALPHABET_CJK), false);
});

test("the current-name comparison ignores case and keeps Ё apart from Е", () => {
  assert.equal(sameCharacterName("Аларин", "аЛАРИН"), true);
  assert.equal(sameCharacterName("Thrall", "tHRALL"), true);
  assert.equal(sameCharacterName("Jaïna", "JAÏNA"), true);
  assert.equal(sameCharacterName("Ёжик", "ёжик"), true);
  assert.equal(sameCharacterName("Ёжик", "Ежик"), false);
  assert.equal(sameCharacterName("Аларин", "Аларина"), false);
});
