/**
 * Plan item 3.47 (11.11): the error frame's words for a refusal of the player's cast, as Wow.exe 3.3.5a 12340 picks
 * them — the message row of 0x00807f10 for every result, not only the cooldowns (CooldownRefusalWords.ts).
 *
 * Wow.exe (read-only Ghidra, .runtime/re-2026-10-04/l12-small/g2.c, g3.c; rows read from the message table 0x00ac8af0,
 * 20 bytes a row, by .runtime/re-2026-10-05/l301-tails/msg.mjs):
 * - 0x00808200 (the realm's SMSG_CAST_FAILED through 0x00809af0, and the client's own refusals) asks 0x00807f10 for
 *   the row, builds the SPELL_FAILED_* sentence (`local_4cc`, filled from the packet's tail for the results that have
 *   one) and shows the row through 0x005216f0 with that sentence as its argument, unless its repeat rule keeps the
 *   frame quiet. A row whose GlobalString is `%s` says the sentence; any other row says its own words.
 * - 0x00807f10: 2 ERR_SPELL_FAILED_ALREADY_AT_FULL_HEALTH, 3 …_MANA, 4 …_POWER_S, 11 ERR_GENERIC_NO_TARGET, 12 by the
 *   row's Targets (record +0x40): 0x10 ERR_INVALID_ITEM_TARGET, 0x20000 ERR_INVALID_GLYPH_SLOT, else the general row;
 *   28 ERR_SPELL_FAILED_EQUIPPED_ITEM, 29-31 ERR_SPELL_FAILED_EQUIPPED_ITEM_CLASS_S, 45 and 67 the cooldown rows,
 *   52 ERR_NOAMMO_S, 72 ERR_SPELL_FAILED_NOTUNSHEATHED, 94 ERR_SPELL_FAILED_SHAPESHIFT_FORM_S, 97 ERR_SPELL_OUT_OF_RANGE,
 *   100 ERR_SPELL_FAILED_REAGENTS, 129 the limit category's row (AutoRepeatRefusal/WorldClient), 131
 *   ERR_SPELL_FAILED_TOTEMS, 148 ERR_PLAY_TIME_EXCEEDED, 170 ERR_BAD_ON_USE_ENCHANT, 174 ERR_TOO_MANY_SOCKETS, 178
 *   ERR_GENERIC_NO_VALID_TARGETS, 184 ERR_MAX_SOCKETS; any other result row 0x30 ERR_SPELL_FAILED_S («%s»).
 * - Result 4's argument is not the sentence: 0x00808200 case 4 passes the player's power token (UNIT_FIELD_BYTES_0
 *   byte 3 through 0x007fe4b0: MANA, RAGE, FOCUS, ENERGY, HAPPINESS, RUNES, RUNIC_POWER) in the client's words, and a
 *   power type past 6 or without a name says nothing (0x008055c0(0x1b)).
 * Every row here is of type 2 (UI_ERROR_MESSAGE) except 72's, type 1 (UI_INFO_MESSAGE) — `info` below.
 */
import { globalString } from "../generated/globalStrings.js";
import { cooldownRefusalErrorName, type CooldownRefusalRow } from "./CooldownRefusalWords.js";
import { formatGlobalString } from "./GlobalStringFormat.js";

/** Row 0x30, the general refusal: the SPELL_FAILED_* sentence alone. */
export const GENERAL_REFUSAL_ROW = "ERR_SPELL_FAILED_S";
/** SpellCastResult SPELL_FAILED_ALREADY_AT_FULL_POWER (SharedDefines.h): the row with the power's name. */
export const SPELL_FAILED_ALREADY_AT_FULL_POWER = 4;
const SPELL_FAILED_BAD_TARGETS = 12;
const SPELL_FAILED_NOT_UNSHEATHED = 72;
/** Spell.dbc Targets bits 0x00807f10 reads for BAD_TARGETS: TARGET_FLAG_ITEM, TARGET_FLAG_GLYPH_SLOT. */
const TARGET_FLAG_ITEM = 0x10;
const TARGET_FLAG_GLYPH_SLOT = 0x20000;
/** 0x007fe4b0's power tokens, by UNIT_FIELD_BYTES_0 byte 3. */
const POWER_TOKENS = ["MANA", "RAGE", "FOCUS", "ENERGY", "HAPPINESS", "RUNES", "RUNIC_POWER"] as const;

const ROWS: ReadonlyMap<number, string> = new Map([
  [2, "ERR_SPELL_FAILED_ALREADY_AT_FULL_HEALTH"], [3, "ERR_SPELL_FAILED_ALREADY_AT_FULL_MANA"],
  [4, "ERR_SPELL_FAILED_ALREADY_AT_FULL_POWER_S"], [11, "ERR_GENERIC_NO_TARGET"],
  [28, "ERR_SPELL_FAILED_EQUIPPED_ITEM"], [29, "ERR_SPELL_FAILED_EQUIPPED_ITEM_CLASS_S"],
  [30, "ERR_SPELL_FAILED_EQUIPPED_ITEM_CLASS_S"], [31, "ERR_SPELL_FAILED_EQUIPPED_ITEM_CLASS_S"],
  [52, "ERR_NOAMMO_S"], [72, "ERR_SPELL_FAILED_NOTUNSHEATHED"], [94, "ERR_SPELL_FAILED_SHAPESHIFT_FORM_S"],
  [97, "ERR_SPELL_OUT_OF_RANGE"], [100, "ERR_SPELL_FAILED_REAGENTS"], [131, "ERR_SPELL_FAILED_TOTEMS"],
  [148, "ERR_PLAY_TIME_EXCEEDED"], [170, "ERR_BAD_ON_USE_ENCHANT"], [174, "ERR_TOO_MANY_SOCKETS"],
  [178, "ERR_GENERIC_NO_VALID_TARGETS"], [184, "ERR_MAX_SOCKETS"],
]);

/** What 0x00807f10 and 0x00808200 read of the refused spell's row; any part may be unknown. */
export interface CastFailureRow extends CooldownRefusalRow {
  /** Spell.dbc Targets. */
  readonly targets?: number | undefined;
  /** Spell.dbc PowerType (record +0xa4; -2 is health). */
  readonly powerType?: number | undefined;
}

/** SpellCastResult SPELL_FAILED_NO_POWER (SharedDefines.h; 0x00808200's and 0x00805610's case 0x55). */
export const SPELL_FAILED_NO_POWER = 85;
/** Spell.dbc PowerType -2: the spell costs health (POWER_HEALTH). */
const POWER_HEALTH = -2;
/** Wow.exe 0x00a439c8: the message row per power type for NO_POWER, by name (read by powtab.mjs, 11.11). */
const NO_POWER_ROWS = ["ERR_OUT_OF_MANA", "ERR_OUT_OF_RAGE", "ERR_OUT_OF_FOCUS", "ERR_OUT_OF_ENERGY",
  "ERR_NOT_HAPPY_ENOUGH", "ERR_OUT_OF_RUNES", "ERR_OUT_OF_RUNIC_POWER"] as const;

/**
 * 0x00808200 / 0x00805610 case 0x55: the row for NO_POWER by the spell's PowerType — ERR_OUT_OF_HEALTH for -2, else
 * the type's row of 0x00a439c8 — shown with no argument. Its first branch (record +0x290, PowerDisplayId, non-zero:
 * ERR_OUT_OF_POWER_DISPLAY with the display's name) never runs on this dataset: no Spell.dbc row has one (11.11).
 * Undefined when the row's PowerType is unknown or out of the table.
 */
export function noPowerRowName(row: CastFailureRow | undefined): string | undefined {
  const type = row?.powerType;
  if (type === POWER_HEALTH) return "ERR_OUT_OF_HEALTH";
  return type === undefined ? undefined : NO_POWER_ROWS[type];
}

/** 0x00807f10 (and 0x00808200's own case 0x55): the GlobalStrings name of the error frame's row for a result. */
export function castFailureErrorRowName(result: number, row: CastFailureRow | undefined): string {
  const cooldown = cooldownRefusalErrorName(result, row);
  if (cooldown !== undefined) return cooldown;
  if (result === SPELL_FAILED_NO_POWER) return noPowerRowName(row) ?? GENERAL_REFUSAL_ROW;
  if (result === SPELL_FAILED_BAD_TARGETS) {
    const targets = row?.targets ?? 0;
    if ((targets & TARGET_FLAG_ITEM) !== 0) return "ERR_INVALID_ITEM_TARGET";
    if ((targets & TARGET_FLAG_GLYPH_SLOT) !== 0) return "ERR_INVALID_GLYPH_SLOT";
    return GENERAL_REFUSAL_ROW;
  }
  return ROWS.get(result) ?? GENERAL_REFUSAL_ROW;
}

/** Whether the row is of type 1 (0x005216f0 → UI_INFO_MESSAGE) rather than 2 (UI_ERROR_MESSAGE). */
export function castFailureErrorRowIsInfo(result: number): boolean {
  return result === SPELL_FAILED_NOT_UNSHEATHED;
}

/** 0x007fe4b0 over the client's words: the power's name, or undefined for a type past 6 or a missing string. */
export function powerTokenName(powerType: number | undefined): string | undefined {
  const token = powerType === undefined ? undefined : POWER_TOKENS[powerType];
  return token === undefined ? undefined : globalString(token) || undefined;
}

/**
 * The words 0x00808200 shows for a refusal: the row of 0x00807f10 filled with `sentence` (the SPELL_FAILED_* words
 * already filled from the packet's tail), or for result 4 with `powerName`. Undefined when there is nothing to say
 * (no sentence for a `%s` row). A build whose strings lack the row, or result 4 without the power's name (the
 * generated GlobalStrings subset has no power tokens), keeps the sentence: a gap in this page's data, not the
 * client's rule.
 */
export function castFailureErrorText(
  result: number, row: CastFailureRow | undefined, sentence: string | undefined, powerName?: string,
): string | undefined {
  const template = globalString(castFailureErrorRowName(result, row));
  if (template === undefined) return sentence;
  if (result === SPELL_FAILED_ALREADY_AT_FULL_POWER && powerName === undefined) return sentence;
  const argument = result === SPELL_FAILED_ALREADY_AT_FULL_POWER ? powerName : sentence;
  if (template === "%s") return argument || undefined;
  return formatGlobalString(template, argument === undefined ? [] : [argument]);
}

/**
 * Wow.exe 0x00805610, the pet's refusal (SMSG_PET_CAST_FAILED 0x138 → 0x00806c30): the error frame's words. Its own
 * rows — 1 ERR_PET_SPELL_AFFECTING_COMBAT, 23 ERR_PET_SPELL_DEAD, 56 ERR_PET_SPELL_NOPATH, 57 ERR_PET_SPELL_NOT_BEHIND,
 * 97 ERR_PET_SPELL_OUT_OF_RANGE, 103 ERR_PET_SPELL_ROOTED, 109 ERR_PET_SPELL_TARGETS_DEAD; 67 the spell or ability
 * cooldown row by SPELL_ATTR0_ABILITY alone (no potion or food rows); 85 the NO_POWER row — and for 29-31, 94, 101,
 * 102 and 147 the sentence filled from the tail (shown through row 0x30 or 0xe5, both `%s`), nothing when no name is
 * found; 172 (a custom error) says nothing; every other result the sentence through ERR_SPELL_FAILED_S.
 */
export function petCastFailureErrorText(result: number, row: CastFailureRow | undefined, sentence: string | undefined): string | undefined {
  if (result === SPELL_FAILED_CUSTOM_ERROR) return undefined;
  const own = PET_ROWS.get(result)
    ?? (result === SPELL_FAILED_NOT_READY_RESULT
      ? (((row?.attributes?.[0] ?? 0) & 0x10) !== 0 ? "ERR_ABILITY_COOLDOWN" : "ERR_SPELL_COOLDOWN")
      : result === SPELL_FAILED_NO_POWER ? noPowerRowName(row) : undefined);
  const template = own === undefined ? undefined : globalString(own);
  if (template === undefined) return sentence || undefined;
  return formatGlobalString(template);
}

const SPELL_FAILED_CUSTOM_ERROR = 172;
const SPELL_FAILED_NOT_READY_RESULT = 67;
const PET_ROWS: ReadonlyMap<number, string> = new Map([
  [1, "ERR_PET_SPELL_AFFECTING_COMBAT"], [23, "ERR_PET_SPELL_DEAD"], [56, "ERR_PET_SPELL_NOPATH"],
  [57, "ERR_PET_SPELL_NOT_BEHIND"], [97, "ERR_PET_SPELL_OUT_OF_RANGE"], [103, "ERR_PET_SPELL_ROOTED"],
  [109, "ERR_PET_SPELL_TARGETS_DEAD"],
]);
