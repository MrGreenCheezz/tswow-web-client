import { RESPONSE_CODES } from "../../generated/responseCodes.js";

/**
 * The client's own check of a character name, before the name goes anywhere.
 *
 * Read off Wow.exe 12340 (FUN_007e18c0, called through FUN_007e1e90 by the rename and the creation
 * screens with no extra characters allowed): the answer is a `ResponseCodes` value, 87
 * `CHAR_NAME_SUCCESS` or the refusal the screen prints. The rules, in the order the client applies
 * them while it walks the name one UTF-16 unit at a time:
 *
 * - The **first letter picks the alphabet**: the first of 0 Latin with Latin-1, 1 ASCII, 2 Cyrillic,
 *   3 Hangul (the 2,350 KS X 1001 syllables), 4 CJK that holds it and that the mask allows. Every
 *   later letter must be in that alphabet; anything else — a space, a digit, an apostrophe, a letter
 *   of another alphabet — is `CHAR_NAME_INVALID_CHARACTER`. (The client never answers
 *   `CHAR_NAME_MIXED_LANGUAGES` from here.)
 * - **Three identical letters in a row**, case folded, are `CHAR_NAME_THREE_CONSECUTIVE`.
 * - In Cyrillic, **ъ or ь first**, or **ъ last**, is `..._SILENT_CHARACTER_AT_BEGINNING_OR_END`, and
 *   **ъ/ь after ъ/ь** is `..._CONSECUTIVE_SILENT_CHARACTERS`.
 * - Fewer than two letters: `CHAR_NAME_NO_NAME` / `CHAR_NAME_TOO_SHORT`.
 * - More than 12 (Hangul 8, CJK 6): `CHAR_NAME_TOO_LONG`, checked last.
 *
 * The mask is `Cfg_Categories.dbc`'s `Create_charset_mask` for the chosen realm's category
 * (0x4dab40 → 0x7e2250; `/dbc/realm-categories?v=1`, `GlueSession.nameAlphabetMask`); without the
 * row — or while an older gateway has no route — the client itself uses 0, every alphabet. The CVar
 * `forceEnglishNames` narrows it to ASCII alone.
 *
 * Not checked here: the client also matches the name against the locale's `NamesProfanity` and
 * `NamesReserved` patterns (`CHAR_NAME_PROFANE`/`_RESERVED`). No route serves those tables, and the
 * core checks its own reserved list, so the server answers that part.
 */

export const NAME_ALPHABET_LATIN = 0;
export const NAME_ALPHABET_ASCII = 1;
export const NAME_ALPHABET_CYRILLIC = 2;
export const NAME_ALPHABET_HANGUL = 3;
export const NAME_ALPHABET_CJK = 4;
const NAME_ALPHABETS = 5;

/** What decides which alphabets a name may be written in. */
export interface GlueNameRuleOptions {
  /** CVar `forceEnglishNames` read as a number that is not 0 (the client's default is "0"). */
  readonly forceEnglishNames?: boolean;
  /** `Cfg_Categories` alphabet mask of the realm's category; 0, the default, allows all five. */
  readonly alphabetMask?: number;
}

const HARD_SIGN = 0x44a;
const SOFT_SIGN = 0x44c;
const SPACE = 0x20;

let hangulSyllables: ReadonlySet<number> | undefined;

/**
 * The 2,350 Hangul syllables of KS X 1001, which is the client's table at 0xAF2B98 (compared entry
 * by entry against EUC-KR B0A1..C8FE). Decoded once through the platform's EUC-KR decoder rather
 * than compiled in; a platform without one falls back to the whole syllable block.
 */
function hangulTable(): ReadonlySet<number> | undefined {
  if (hangulSyllables) return hangulSyllables;
  try {
    const decoder = new TextDecoder("euc-kr");
    const table = new Set<number>();
    for (let lead = 0xb0; lead <= 0xc8; lead++) {
      for (let trail = 0xa1; trail <= 0xfe; trail++) {
        table.add(decoder.decode(Uint8Array.of(lead, trail)).charCodeAt(0));
      }
    }
    hangulSyllables = table;
    return table;
  } catch {
    return undefined;
  }
}

/** FUN_007e1080: whether one UTF-16 unit belongs to an alphabet. */
export function inNameAlphabet(unit: number, alphabet: number): boolean {
  switch (alphabet) {
    case NAME_ALPHABET_LATIN:
      return (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a)
        || (unit >= 0xc0 && unit <= 0xdd && unit !== 0xd7) || unit === 0xdf
        || (unit >= 0xe0 && unit <= 0xff && unit !== 0xf7 && unit !== 0xfe);
    case NAME_ALPHABET_ASCII:
      return (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a);
    case NAME_ALPHABET_CYRILLIC:
      return (unit >= 0x410 && unit <= 0x44f) || unit === 0x401 || unit === 0x451;
    case NAME_ALPHABET_HANGUL: {
      if (unit < 0xac00 || unit > 0xd7a3) return false;
      return hangulTable()?.has(unit) ?? true;
    }
    case NAME_ALPHABET_CJK:
      return (unit >= 0x4e00 && unit <= 0x9fff) || (unit >= 0x3400 && unit <= 0x4dff)
        || (unit >= 0xf900 && unit <= 0xfaff);
    default:
      return false;
  }
}

/** The lower case the name checks compare in: ASCII, Latin-1 C0-DE, Œ, А-Я and Ё. */
function nameLower(unit: number): number {
  if (unit >= 0x41 && unit <= 0x5a) return unit + 0x20;
  if (unit >= 0xc0 && unit <= 0xde) return unit + 0x20;
  if (unit === 0x152) return 0x153;
  if (unit >= 0x410 && unit <= 0x42f) return unit + 0x20;
  if (unit === 0x401) return 0x451;
  return unit;
}

/** The mask FUN_007e18c0 works with: `forceEnglishNames` wins, then the category's, else 0. */
export function nameAlphabetMask(options: GlueNameRuleOptions = {}): number {
  if (options.forceEnglishNames) return 1 << NAME_ALPHABET_ASCII;
  const mask = options.alphabetMask ?? 0;
  return Number.isInteger(mask) ? mask >>> 0 : 0;
}

/** The alphabet a name's first letter picks under a mask, or -1 when none holds it. */
export function nameAlphabet(name: string, options: GlueNameRuleOptions = {}): number {
  if (name.length === 0) return -1;
  const mask = nameAlphabetMask(options);
  const unit = name.charCodeAt(0);
  for (let alphabet = 0; alphabet < NAME_ALPHABETS; alphabet++) {
    if ((mask === 0 || (mask & (1 << alphabet)) !== 0) && inNameAlphabet(unit, alphabet)) return alphabet;
  }
  return -1;
}

/** Longest name the client allows in an alphabet (FUN_007e1e90). */
export function nameLengthLimit(alphabet: number): number {
  if (alphabet === NAME_ALPHABET_HANGUL) return 8;
  if (alphabet === NAME_ALPHABET_CJK) return 6;
  return 12;
}

/** The client's verdict on a character name, as a `ResponseCodes` value (87 is success). */
export function checkCharacterName(name: string, options: GlueNameRuleOptions = {}): number {
  const alphabet = nameAlphabet(name, options);
  let count = 0;
  for (let at = 0; at < name.length; at++) {
    const unit = name.charCodeAt(at);
    count += 1;
    if (!inNameAlphabet(unit, alphabet)) return RESPONSE_CODES.CHAR_NAME_INVALID_CHARACTER;
    if (count > 2) {
      const first = nameLower(name.charCodeAt(at - 2));
      if (first === nameLower(name.charCodeAt(at - 1)) && first === nameLower(unit)) {
        return RESPONSE_CODES.CHAR_NAME_THREE_CONSECUTIVE;
      }
    }
    if (alphabet === NAME_ALPHABET_CYRILLIC) {
      const letter = nameLower(unit);
      const silent = letter === HARD_SIGN || letter === SOFT_SIGN;
      const next = at + 1 < name.length ? name.charCodeAt(at + 1) : 0;
      if ((count === 1 && silent) || ((next === 0 || next === SPACE) && letter === HARD_SIGN)) {
        return RESPONSE_CODES.CHAR_NAME_RUSSIAN_SILENT_CHARACTER_AT_BEGINNING_OR_END;
      }
      if (count > 1 && silent) {
        const previous = nameLower(name.charCodeAt(at - 1));
        if (previous === HARD_SIGN || previous === SOFT_SIGN) {
          return RESPONSE_CODES.CHAR_NAME_RUSSIAN_CONSECUTIVE_SILENT_CHARACTERS;
        }
      }
    }
  }
  if (count === 0) return RESPONSE_CODES.CHAR_NAME_NO_NAME;
  if (count === 1) return RESPONSE_CODES.CHAR_NAME_TOO_SHORT;
  if (count > nameLengthLimit(alphabet)) return RESPONSE_CODES.CHAR_NAME_TOO_LONG;
  return RESPONSE_CODES.CHAR_NAME_SUCCESS;
}

/**
 * The key FUN_0076ea40 compares two names by, one code point at a time: ASCII and Latin-1 fold to
 * upper case, œ to Œ, Cyrillic to upper case in a collation where Ё/ё is its own letter between Е
 * and Ж — so the comparison ignores case and still tells Ё from Е.
 */
function nameCompareKey(point: number): number {
  if (point < 0x80) return point >= 0x61 && point <= 0x7a ? point - 0x20 : point;
  if (point >= 0x800) return point;
  if (point >= 0xe0 && point <= 0xfe) return point - 0x20;
  if (point === 0x153) return 0x152;
  if (point === 0x401 || point === 0x451) return 0x415;
  if (point >= 0x410 && point <= 0x415) return point - 1;
  if (point >= 0x430 && point <= 0x44f) return point - 0x20 - (point <= 0x435 ? 1 : 0);
  return point;
}

/** Whether two names are the same name to the client's RenameCharacter (FUN_004e3410). */
export function sameCharacterName(left: string, right: string): boolean {
  const a = [...left];
  const b = [...right];
  if (a.length !== b.length) return false;
  return a.every((character, at) =>
    nameCompareKey(character.codePointAt(0) ?? 0) === nameCompareKey(b[at]?.codePointAt(0) ?? 0));
}
