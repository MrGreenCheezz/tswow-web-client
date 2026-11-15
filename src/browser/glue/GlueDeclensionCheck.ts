import { RESPONSE_CODES } from "../../generated/responseCodes.js";
import { frameXmlDeclensionClass } from "../ui/framexml_compat/FrameXmlDeclension.js";
import { checkCharacterName, type GlueNameRuleOptions } from "./GlueNameRules.js";

/**
 * 1.19 (15.11): the client's own check of each declined form before `DeclineCharacter` sends them (Wow.exe 3.3.5a
 * 12340, read-only Ghidra, .runtime/re-2026-11-15/misc8): 0x4d9a40 asks 0x6b0fc0(name, form) for each of the five
 * cases and stops at the first that is not 87, firing FORCE_DECLINE_CHARACTER with its message (event 0x18) and
 * answering nil. 0x6b0fc0 is 0x76dd90(client locale, name, form) + 87:
 *
 * - A client whose locale is not ruRU (index 8) answers 1 — `CHAR_NAME_FAILURE`.
 * - The form goes through 0x7e1e90(8, form, 1, 1, 0, 0, 5): the name walk of 0x7e18c0 (the category's alphabet mask;
 *   `forceEnglishNames` not consulted), the NamesProfanity and ChatProfanity lists but not NamesReserved, and the
 *   alphabet's length limit plus five letters (GlueNameRules.ts).
 * - Then 0x76e390(name, form): 0x76de70 classifies the name with gender 2 (FrameXmlDeclension.ts) — its rule and stem
 *   — and marks a fleeting vowel: for a name of three letters or more whose rule is none of the patterned ones
 *   (35/36), the letter before the last; for a name of four or more ending in ь under a rule with a pattern that
 *   begins with ь (the patterns are stored left-aligned, `0xadce88`), the letter two before the last — when that
 *   letter is е, о or ё the stem ends there instead. The form, lower-cased the same way (0x7e1180), must begin with
 *   that stem and be fewer than six letters longer than it; otherwise 16 — `CHAR_NAME_DECLENSION_DOESNT_MATCH_BASE_NAME`.
 */

const SOFT_SIGN = "ь";
const FLEETING_VOWELS = new Set(["е", "о", "ё"]);

/** 0x76de70's stem for 0x76e390: the fleeting vowel's position when it marks one, else the rule's stem. */
export function glueDeclensionStem(name: string): { readonly word: string; readonly stem: number } {
  const { word, stem, patterns, matched } = frameXmlDeclensionClass(name, 2);
  const length = word.length;
  let at = 0;
  if (length > 2) {
    if (!matched) at = length - 2;
    else if (length >= 4 && word[length - 1] === SOFT_SIGN && patterns.some((pattern) => pattern[0] === SOFT_SIGN)) {
      at = length - 3;
    }
  }
  if (at > 0 && FLEETING_VOWELS.has(word[at]!)) return { word, stem: at };
  return { word, stem };
}

/** 0x7e1180, one UTF-16 unit: ASCII, Latin-1 C0–DE, Œ, А–Я and Ё lowered. */
function lowerUnit(unit: number): number {
  if ((unit >= 0x41 && unit <= 0x5a) || (unit >= 0xc0 && unit <= 0xde) || (unit >= 0x410 && unit <= 0x42f)) return unit + 0x20;
  if (unit === 0x152) return 0x153;
  if (unit === 0x401) return 0x451;
  return unit;
}

/** 0x76e390: whether the declined form begins with the name's stem and adds fewer than six letters. */
export function glueDeclensionMatchesName(name: string, form: string): boolean {
  const { word, stem } = glueDeclensionStem(name);
  for (let at = 0; at < stem; at++) {
    if (at >= form.length || lowerUnit(form.charCodeAt(at)) !== word.charCodeAt(at)) return false;
  }
  return form.length - stem < 6;
}

export interface GlueDeclensionCheckOptions extends Pick<GlueNameRuleOptions, "alphabetMask" | "nameFilters"> {
  /** `GetLocale()`; only a ruRU client declines. */
  readonly locale?: string;
}

/** 0x6b0fc0(name, form): a `ResponseCodes` value, 87 when the form is accepted. */
export function checkDeclinedName(name: string, form: string, options: GlueDeclensionCheckOptions = {}): number {
  // 0x76dd90 tests the locale index (DAT_00c5de9c) against 8, ruRU.
  if ((options.locale ?? "ruRU") !== "ruRU") return RESPONSE_CODES.CHAR_NAME_FAILURE;
  const walk = checkCharacterName(form, {
    alphabetMask: options.alphabetMask ?? 0,
    ...(options.nameFilters ? { nameFilters: options.nameFilters } : {}),
    nameFilterUse: { profane: true, chat: true, reserved: false },
    extraLength: 5,
  });
  if (walk !== RESPONSE_CODES.CHAR_NAME_SUCCESS) return walk;
  return glueDeclensionMatchesName(name, form)
    ? RESPONSE_CODES.CHAR_NAME_SUCCESS : RESPONSE_CODES.CHAR_NAME_DECLENSION_DOESNT_MATCH_BASE_NAME;
}
