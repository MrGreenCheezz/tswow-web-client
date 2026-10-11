import { UPDATE_FIELDS, type UpdateFieldName } from "../../generated/updateFields.js";

/**
 * 12.10: what a spell description reads from the active player, the way Wow.exe's evaluator
 * (QuestTextParser.cpp, 0x005782d0 for `${…}`'s named values, 0x005796c0 for `$?`) reads it.
 *
 * Wow.exe reads its own copy of the player's update fields: the unit block that starts at
 * OBJECT_END (object + 0xd0) and the player block that starts at UNIT_END (object + 0x1008), so every
 * value below names the field and the offset the client reads it at. A field the server never sent
 * reads 0, as a zeroed descriptor does. Kept DOM-free and world-free: the caller hands in the words.
 */
export interface SpellTextPlayer {
  /** The active player's update-field words by index (Fields.readSlot); undefined reads 0. */
  readonly slot: (index: number) => number | undefined;
  /** 0x007260e0 for `$?s`: the spell is in the player's own spell bitmap (0x00be8dc4, the spellbook). */
  readonly knowsSpell?: (spellId: number) => boolean;
  /** 0x007282a0 for `$?a`: one of the player's auras is that spell. */
  readonly hasAura?: (spellId: number) => boolean;
  /**
   * The item an entry of PLAYER_VISIBLE_ITEM_n_ENTRYID names, from the item query cache
   * (0x0067ca30): the first damage entry (+0xc0 min, +0xc8 max, +0xd0 type) and its class.
   */
  readonly item?: (entry: number) => SpellTextItem | undefined;
  /** 0x0071b770 for `$c`'s ManaCostPct: the base the percentage is of (UNIT_FIELD_BASE_MANA for mana). */
  readonly basePower?: (powerType: number) => number | undefined;
}

export interface SpellTextItem {
  readonly itemClass: number;
  readonly subClass: number;
  readonly damageMin: number;
  readonly damageMax: number;
  readonly damageType: number;
}

const scratch = new DataView(new ArrayBuffer(4));

function index(name: UpdateFieldName): number {
  return UPDATE_FIELDS[name].offset;
}

/** An INT word as the client's `int` reads it. */
export function spellTextInt(player: SpellTextPlayer, name: UpdateFieldName, offset = 0): number {
  return (player.slot(index(name) + offset) ?? 0) | 0;
}

/** A FLOAT word (or any word the client reads as a float: PLAYER_FIELD_MOD_DAMAGE_DONE_PCT is one). */
export function spellTextFloat(player: SpellTextPlayer, name: UpdateFieldName, offset = 0): number {
  scratch.setUint32(0, (player.slot(index(name) + offset) ?? 0) >>> 0, true);
  return scratch.getFloat32(0, true);
}

/** A signed 16-bit half of a TWO_SHORT word, low first. */
function spellTextShort(player: SpellTextPlayer, name: UpdateFieldName, half: 0 | 1): number {
  const raw = (player.slot(index(name)) ?? 0) >>> 0;
  return ((half === 0 ? raw & 0xffff : raw >>> 16) << 16) >> 16;
}

/**
 * The sex `$g` picks a form by (0x00579e50): byte 2 of UNIT_FIELD_BYTES_0 (unit block +0x46), and
 * when that is 2 (none) byte 0 of PLAYER_BYTES_3 (player block +0x1c). 0x00576cd0 takes any non-zero
 * value as the second form.
 */
export function spellTextPlayerSex(player: SpellTextPlayer): number {
  const sex = ((player.slot(index("UNIT_FIELD_BYTES_0")) ?? 0) >>> 16) & 0xff;
  return sex === 2 ? (player.slot(index("PLAYER_BYTES_3")) ?? 0) & 0xff : sex;
}

/** UNIT_MOD_CAST_SPEED (unit block +0x128): what 0x00800a70 and `$t` scale a hasted period by. */
export function spellTextCastSpeed(player: SpellTextPlayer): number {
  return spellTextFloat(player, "UNIT_MOD_CAST_SPEED");
}

/** UNIT_FIELD_LEVEL (unit block +0xc0). */
export function spellTextLevel(player: SpellTextPlayer): number {
  return spellTextInt(player, "UNIT_FIELD_LEVEL");
}

/** EQUIPMENT_SLOT_MAINHAND/OFFHAND/RANGED: 0x006de330's slot, PLAYER_VISIBLE_ITEM_<slot+1>_ENTRYID. */
const WEAPON_SLOTS = [15, 16, 17] as const;

/** The item in an equipment slot (0x006de330 then 0x0067ca30 on the entry's absolute value). */
function equipped(player: SpellTextPlayer, slot: number): SpellTextItem | undefined {
  const entry = Math.abs(spellTextInt(player, "PLAYER_VISIBLE_ITEM_1_ENTRYID", slot * 2));
  return entry > 0 ? player.item?.(entry) : undefined;
}

/** Two-handed weapon subclasses 0x00714c80 counts for `$hnd`: axe, mace, polearm, sword, staff, exotic, spear, fishing pole. */
const TWO_HANDED = new Set([1, 5, 6, 8, 10, 12, 17, 20]);

/** 0x00578210 + 0x00578250: PLAYER_FIELD_MOD_DAMAGE_DONE_POS + _NEG of one school (player block +0xffc, +0x1018). */
function schoolPower(player: SpellTextPlayer, school: number): number {
  return spellTextInt(player, "PLAYER_FIELD_MOD_DAMAGE_DONE_POS", school)
    + spellTextInt(player, "PLAYER_FIELD_MOD_DAMAGE_DONE_NEG", school);
}

/** Attack power as 0x005782d0 has it for `$AP`/`$RAP`: (base + both signed mods) × (1 + multiplier), not below 0. */
function totalAttackPower(player: SpellTextPlayer, ranged: boolean): number {
  const base = ranged ? "UNIT_FIELD_RANGED_ATTACK_POWER" : "UNIT_FIELD_ATTACK_POWER";
  const mods = ranged ? "UNIT_FIELD_RANGED_ATTACK_POWER_MODS" : "UNIT_FIELD_ATTACK_POWER_MODS";
  const multiplier = ranged ? "UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER" : "UNIT_FIELD_ATTACK_POWER_MULTIPLIER";
  const sum = spellTextShort(player, mods, 1) + spellTextShort(player, mods, 0) + spellTextInt(player, base);
  return Math.max(0, Math.fround((spellTextFloat(player, multiplier) + 1) * sum));
}

const STAT_NAMES = ["STR", "AGI", "STA", "INT", "SPI"] as const;
/** `sph` … `spa` and `ph` … `pa`: holy 1, fire 2, nature 3, frost 4, shadow 5, arcane 6 (0x005782d0's `index + 1`). */
const SCHOOL_SUFFIXES = ["h", "fi", "n", "fr", "s", "a"] as const;

/**
 * The value of one of 0x005782d0's player-side names (the name table at 0x00ace8f8, matched
 * case-sensitively by 0x00576b50), or undefined for a name that is not one of them.
 *
 * * `STR AGI STA INT SPI`: UNIT_FIELD_STAT0+n, a negative word read as 0 (0x005774b0); lower case,
 *   STAT − POSSTAT − NEGSTAT, the base.
 * * `ap`/`rap`: UNIT_FIELD_(RANGED_)ATTACK_POWER, not below 0; `AP`/`RAP` the whole sum above.
 * * `mwb MWB owb OWB rwb RWB`: the equipped weapon's own first damage entry, min and max, and 0
 *   when that entry is not physical or the slot is empty.
 * * `mw MW ow OW rw RW`: UNIT_FIELD_(MIN|MAX)(OFFHAND|RANGED)DAMAGE, the minimum floored and the
 *   maximum raised, never below 1.
 * * `mws ows rws`: UNIT_FIELD_BASEATTACKTIME (both hands) and _RANGEDATTACKTIME, in seconds.
 * * `pl`: UNIT_FIELD_LEVEL. `hnd`: 2 with a two-handed weapon in the main hand, else 1.
 * * `sp`: the least of the six schools' spell damage (holy … arcane); `sph spfi spn spfr sps spa`
 *   one school's (POS + NEG); `ph pfi pn pfr ps pa` its PLAYER_FIELD_MOD_DAMAGE_DONE_PCT, read as a
 *   float; `bh` PLAYER_FIELD_MOD_HEALING_DONE_POS; `pbh` _MOD_HEALING_PCT; `pbhd` _MOD_HEALING_DONE_PCT.
 *   Both cases of each of these read the same value (the jump table at 0x00578bb8 sends them to one case).
 *
 * `ar`/`AR` (0x006337a0's object, 0x004f54d0) are not answered: no description of the dataset uses them.
 */
export function spellTextPlayerVariable(name: string, player: SpellTextPlayer): number | undefined {
  const stat = STAT_NAMES.indexOf(name as typeof STAT_NAMES[number]);
  if (stat >= 0) return Math.max(0, spellTextInt(player, "UNIT_FIELD_STAT0", stat));
  const baseStat = STAT_NAMES.indexOf(name.toUpperCase() as typeof STAT_NAMES[number]);
  if (baseStat >= 0 && name === name.toLowerCase()) {
    return spellTextInt(player, "UNIT_FIELD_STAT0", baseStat) - spellTextInt(player, "UNIT_FIELD_POSSTAT0", baseStat)
      - spellTextInt(player, "UNIT_FIELD_NEGSTAT0", baseStat);
  }
  switch (name) {
    case "ap": return Math.max(0, spellTextInt(player, "UNIT_FIELD_ATTACK_POWER"));
    case "AP": return totalAttackPower(player, false);
    case "rap": return Math.max(0, spellTextInt(player, "UNIT_FIELD_RANGED_ATTACK_POWER"));
    case "RAP": return totalAttackPower(player, true);
    case "mwb": case "MWB": case "owb": case "OWB": case "rwb": case "RWB": {
      const item = equipped(player, WEAPON_SLOTS["mor".indexOf(name[0]!.toLowerCase())]!);
      if (!item || item.damageType !== 0) return 0;
      return name === name.toLowerCase() ? item.damageMin : item.damageMax;
    }
    case "mw": return Math.max(1, Math.floor(spellTextFloat(player, "UNIT_FIELD_MINDAMAGE")));
    case "MW": return Math.max(1, Math.ceil(spellTextFloat(player, "UNIT_FIELD_MAXDAMAGE")));
    case "ow": return Math.max(1, Math.floor(spellTextFloat(player, "UNIT_FIELD_MINOFFHANDDAMAGE")));
    case "OW": return Math.max(1, Math.ceil(spellTextFloat(player, "UNIT_FIELD_MAXOFFHANDDAMAGE")));
    case "rw": return Math.max(1, Math.floor(spellTextFloat(player, "UNIT_FIELD_MINRANGEDDAMAGE")));
    case "RW": return Math.max(1, Math.ceil(spellTextFloat(player, "UNIT_FIELD_MAXRANGEDDAMAGE")));
    // The words are unsigned; 0x005782d0 adds 2^32 to a negative int before scaling by 0.001.
    case "mws": case "MWS": return Math.fround((player.slot(index("UNIT_FIELD_BASEATTACKTIME")) ?? 0) * Math.fround(0.001));
    case "ows": case "OWS": return Math.fround((player.slot(index("UNIT_FIELD_BASEATTACKTIME") + 1) ?? 0) * Math.fround(0.001));
    case "rws": case "RWS": return Math.fround((player.slot(index("UNIT_FIELD_RANGEDATTACKTIME")) ?? 0) * Math.fround(0.001));
    case "pl": case "PL": return spellTextLevel(player);
    case "hnd": case "HND": {
      const item = equipped(player, WEAPON_SLOTS[0]);
      return item && item.itemClass === 2 && TWO_HANDED.has(item.subClass) ? 2 : 1;
    }
    case "sp": case "SP": {
      let least = schoolPower(player, 1);
      for (let school = 2; school <= 6; school++) least = Math.min(least, schoolPower(player, school));
      return least;
    }
    case "bh": case "BH": return spellTextInt(player, "PLAYER_FIELD_MOD_HEALING_DONE_POS");
    case "pbh": case "pBH": return spellTextFloat(player, "PLAYER_FIELD_MOD_HEALING_PCT");
    case "pbhd": case "pBHD": return spellTextFloat(player, "PLAYER_FIELD_MOD_HEALING_DONE_PCT");
    default: break;
  }
  const school = /^(sp|p)(h|fi|n|fr|s|a)$/i.exec(name);
  if (school && (name === name.toLowerCase() || name === name.toUpperCase())) {
    const which = SCHOOL_SUFFIXES.indexOf(school[2]!.toLowerCase() as typeof SCHOOL_SUFFIXES[number]) + 1;
    return school[1]!.length === 2
      ? schoolPower(player, which)
      : spellTextFloat(player, "PLAYER_FIELD_MOD_DAMAGE_DONE_PCT", which);
  }
  return undefined;
}

/** The player-side names of 0x00ace8f8's table, both spellings, for the lexer (`ar`/`AR` among them). */
export const SPELL_TEXT_PLAYER_NAMES: ReadonlySet<string> = new Set([
  "STR", "AGI", "STA", "INT", "SPI", "str", "agi", "sta", "int", "spi",
  "ap", "AP", "rap", "RAP", "mwb", "MWB", "owb", "OWB", "rwb", "RWB", "mw", "MW", "ow", "OW", "rw", "RW",
  "ar", "AR", "mws", "MWS", "ows", "OWS", "rws", "RWS", "pl", "PL", "hnd", "HND", "sp", "SP",
  "sph", "spfi", "spn", "spfr", "sps", "spa", "SPH", "SPFI", "SPN", "SPFR", "SPS", "SPA", "bh", "BH",
  "ph", "pfi", "pn", "pfr", "ps", "pa", "PH", "PFI", "PN", "PFR", "PS", "PA", "pbh", "pBH", "pbhd", "pBHD",
]);
