/**
 * The character sheet's numbers as the player's own update fields carry them (WORK_PLAN 4.03).
 *
 * DOM-free readers over one `WorldObjectState`, for the native character sheet. Every one of them
 * answers what `LiveWorldSeam` answers the stock PaperDoll for the same fields — the C API rows are
 * named beside each reader — and `tests/character-stat-fields.test.mjs` holds the two side by side
 * on one fixture, so the native and the stock sheet cannot drift apart. The seam keeps its own copy
 * for now (a hot file of another line); delegating it here is a later, separate edit.
 *
 * Absent words: an object's create block carries only its non-zero words, so a field missing from a
 * *present* player object is zero, exactly as the seam reads it. What this module cannot know
 * without a table — a rating's percentage, the defence a rating adds — is the caller's to supply
 * (`characterCombatRatingBonus`, world/CharacterStatData.ts), and is `undefined` until it has one.
 *
 * Field facts, verified in the compatible core:
 * - `UNIT_FIELD_(RANGED_)ATTACK_POWER_MODS` is one TWO_SHORT word, low half the positive modifier and
 *   high half the negative one, both `int16` (Unit.h `SetAttackPowerModPos/Neg`); the total is
 *   base + both (Unit.cpp `GetTotalAttackPowerValue`).
 * - `PLAYER_FIELD_COMBAT_RATING_1` is 25 words indexed by the zero-based `CombatRating` (Unit.h); the
 *   C API's `CR_*` indices are one-based.
 * - `PLAYER_SPELL_CRIT_PERCENTAGE1` and the damage arrays are indexed by `SpellSchools`, physical
 *   first; the C API's school is one-based. The crit array is FLOAT; `PLAYER_FIELD_MOD_DAMAGE_DONE_PCT`
 *   is declared INT but stored with SetFloatValue, so it is read as a float word.
 * - `PLAYER_FIELD_MOD_TARGET_RESISTANCE` holds the negated spell penetration
 *   (StatSystem.cpp `ApplySpellPenetrationBonus`).
 * - The mana regen pair is the POWER_MANA float of `UNIT_FIELD_POWER_REGEN_(INTERRUPTED_)FLAT_MODIFIER`,
 *   mana per second (StatSystem.cpp `UpdateManaRegen`).
 * - `PLAYER_FLAGS_HIDE_HELM` 0x400 and `PLAYER_FLAGS_HIDE_CLOAK` 0x800 (Player.h:364-365), set and
 *   cleared by the core on CMSG_SHOWING_HELM / CMSG_SHOWING_CLOAK (CharacterHandler.cpp:1121-1135).
 */
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { readField } from "./Fields.js";
import type { WorldObjectState } from "./WorldState.js";

/** The C API's one-based `CR_*` indices (Unit.h `CombatRating` plus one), the ones the sheet reads. */
export const CR = Object.freeze({
  DEFENSE_SKILL: 2,
  DODGE: 3,
  PARRY: 4,
  BLOCK: 5,
  HIT_MELEE: 6,
  HIT_RANGED: 7,
  HIT_SPELL: 8,
  CRIT_MELEE: 9,
  CRIT_RANGED: 10,
  CRIT_SPELL: 11,
  CRIT_TAKEN_MELEE: 15,
  CRIT_TAKEN_RANGED: 16,
  CRIT_TAKEN_SPELL: 17,
  HASTE_MELEE: 18,
  HASTE_RANGED: 19,
  HASTE_SPELL: 20,
  EXPERTISE: 24,
  ARMOR_PENETRATION: 25,
});

/** `MAX_COMBAT_RATING` (Unit.h). */
export const COMBAT_RATING_COUNT = 25;
/** `MAX_SPELL_SCHOOL` (SharedDefines.h): physical plus six magic schools. */
export const SPELL_SCHOOL_COUNT = 7;
/** The stock sheet starts its spell rows at holy, the C API's school 2 (PaperDoll skips physical). */
export const FIRST_MAGIC_SCHOOL = 2;
/** `SKILL_DEFENSE` (SharedDefines.h). */
export const SKILL_DEFENSE = 95;

export const PLAYER_FLAGS_HIDE_HELM = 0x0000_0400;
export const PLAYER_FLAGS_HIDE_CLOAK = 0x0000_0800;

type FieldName = keyof typeof UPDATE_FIELDS;

function word(object: WorldObjectState, name: FieldName, index = 0): number {
  return object.fields.get(UPDATE_FIELDS[name].offset + index) ?? 0;
}

const scratch = new DataView(new ArrayBuffer(4));

/** A raw update-field word read as the float the server stored in it; 0 for anything not finite. */
export function floatWord(value: number): number {
  scratch.setUint32(0, value >>> 0, true);
  const decoded = scratch.getFloat32(0, true);
  return Number.isFinite(decoded) ? decoded : 0;
}

/** A TWO_SHORT word's halves, low first, each read as the `int16` the core wrote. */
export function signedShorts(value: number): [number, number] {
  return [((value & 0xffff) << 16) >> 16, (value >>> 16) << 16 >> 16];
}

/** x87 `fistp` under the default control word: to the nearest integer, a tie to the even one; never -0. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  const rounded = fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return rounded === 0 ? 0 : rounded;
}

/** A FLOAT field read the generated way (`readField` decodes by the field's type); 0 when absent. */
function floatField(object: WorldObjectState, name: FieldName): number {
  const value = readField(object, name);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `UnitStat("player", index)`'s three numbers, index 1-5: the total and the buff halves. */
export interface StatTuple {
  readonly effective: number;
  readonly positive: number;
  readonly negative: number;
}

export function unitStat(object: WorldObjectState, index: number): StatTuple | undefined {
  if (!Number.isInteger(index) || index < 1 || index > 5) return undefined;
  // StatSystem.cpp publishes the total in STAT; the buff halves are informational (LiveWorldSeam.unitStat).
  return {
    effective: word(object, "UNIT_FIELD_STAT0", index - 1) | 0,
    positive: word(object, "UNIT_FIELD_POSSTAT0", index - 1) | 0,
    negative: word(object, "UNIT_FIELD_NEGSTAT0", index - 1) | 0,
  };
}

/** `UnitResistance("player", school)`, school 0 being armour: base is the total less both buffs. */
export interface ResistanceTuple {
  readonly base: number;
  readonly effective: number;
  readonly positive: number;
  readonly negative: number;
}

export function unitResistance(object: WorldObjectState, school: number): ResistanceTuple | undefined {
  if (!Number.isInteger(school) || school < 0 || school >= SPELL_SCHOOL_COUNT) return undefined;
  const effective = word(object, "UNIT_FIELD_RESISTANCES", school) | 0;
  const positive = word(object, "UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE", school) | 0;
  const negative = word(object, "UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE", school) | 0;
  return { base: effective - positive - negative, effective, positive, negative };
}

/**
 * `UnitAttackPower` / `UnitRangedAttackPower`: base and the two modifiers; `effective` is what the
 * stock PaperDoll prints, `max(0, base + positive + negative)`.
 *
 * Wow.exe (0x00610b60 / 0x00610ca0) scales each of the three by `1.0f + UNIT_FIELD_(RANGED_)ATTACK_POWER_MULTIPLIER`
 * in single precision and rounds it to the nearest integer, ties to even (x87 default): the core keeps the
 * TOTAL_PCT part apart in the multiplier word (StatSystem.cpp `UpdateAttackPowerAndDamage`).
 */
export interface AttackPower {
  readonly base: number;
  readonly positive: number;
  readonly negative: number;
  readonly effective: number;
}

export function attackPower(object: WorldObjectState, ranged = false): AttackPower {
  const scale = Math.fround(1 + floatWord(word(object,
    ranged ? "UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER" : "UNIT_FIELD_ATTACK_POWER_MULTIPLIER")));
  const scaled = (value: number): number => roundHalfEven(Math.fround(scale * Math.fround(value)));
  const base = scaled(word(object, ranged ? "UNIT_FIELD_RANGED_ATTACK_POWER" : "UNIT_FIELD_ATTACK_POWER") | 0);
  const [rawPositive, rawNegative] = signedShorts(word(object,
    ranged ? "UNIT_FIELD_RANGED_ATTACK_POWER_MODS" : "UNIT_FIELD_ATTACK_POWER_MODS"));
  const positive = scaled(rawPositive);
  const negative = scaled(rawNegative);
  return { base, positive, negative, effective: Math.max(0, base + positive + negative) };
}

/**
 * Stock `UnitHasMana("player")` — FrameXML's own Lua (UIParent.lua:3221), not a C function: the
 * displayed power (UnitPowerType, `UNIT_FIELD_BYTES_0` byte 3) is mana and `UnitPowerMax` of it is above
 * zero. A druid in a rage or energy form has a mana pool and still answers nil.
 */
export function unitHasMana(object: WorldObjectState): boolean {
  return ((word(object, "UNIT_FIELD_BYTES_0") >>> 24) & 0xff) === 0 && (word(object, "UNIT_FIELD_MAXPOWER1") | 0) > 0;
}

/** `GetCombatRating(index)`, one-based; 0 outside the 25 slots. */
export function combatRating(object: WorldObjectState, index: number): number {
  if (!Number.isInteger(index) || index < 1 || index > COMBAT_RATING_COUNT) return 0;
  return word(object, "PLAYER_FIELD_COMBAT_RATING_1", index - 1);
}

/** `GetSpellCritChance(school)`, one-based school. */
export function spellCritChance(object: WorldObjectState, school: number): number {
  if (!Number.isInteger(school) || school < 1 || school > SPELL_SCHOOL_COUNT) return 0;
  return floatWord(word(object, "PLAYER_SPELL_CRIT_PERCENTAGE1", school - 1));
}

/** `GetSpellBonusDamage(school)`, one-based school: the positive and the negative modifier summed. */
export function spellBonusDamage(object: WorldObjectState, school: number): number {
  if (!Number.isInteger(school) || school < 1 || school > SPELL_SCHOOL_COUNT) return 0;
  return (word(object, "PLAYER_FIELD_MOD_DAMAGE_DONE_POS", school - 1) | 0)
    + (word(object, "PLAYER_FIELD_MOD_DAMAGE_DONE_NEG", school - 1) | 0);
}

/** `GetSpellBonusHealing()`. */
export function spellBonusHealing(object: WorldObjectState): number {
  return word(object, "PLAYER_FIELD_MOD_HEALING_DONE_POS");
}

/** `GetSpellPenetration()`: the stored value is the negated bonus. */
export function spellPenetration(object: WorldObjectState): number {
  return -(word(object, "PLAYER_FIELD_MOD_TARGET_RESISTANCE") | 0);
}

/** `GetManaRegen()`: mana per second out of combat-casting and while casting. */
export function manaRegen(object: WorldObjectState): readonly [number, number] {
  return [floatField(object, "UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER"),
    floatField(object, "UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER")];
}

/** `GetExpertise()`: main hand and off hand. */
export function expertise(object: WorldObjectState): readonly [number, number] {
  return [word(object, "PLAYER_EXPERTISE"), word(object, "PLAYER_OFFHAND_EXPERTISE")];
}

/** `GetExpertisePercent()`: a quarter percent per point (Player.cpp `GetExpertiseDodgeOrParryReduction`). */
export function expertisePercent(object: WorldObjectState): readonly [number, number] {
  const [main, off] = expertise(object);
  return [main / 4, off / 4];
}

/** The six percentages the core writes as floats, as `GetCritChance()` and its neighbours answer. */
export function meleeCritChance(object: WorldObjectState): number { return floatField(object, "PLAYER_CRIT_PERCENTAGE"); }
export function rangedCritChance(object: WorldObjectState): number { return floatField(object, "PLAYER_RANGED_CRIT_PERCENTAGE"); }
export function dodgeChance(object: WorldObjectState): number { return floatField(object, "PLAYER_DODGE_PERCENTAGE"); }
export function parryChance(object: WorldObjectState): number { return floatField(object, "PLAYER_PARRY_PERCENTAGE"); }
export function blockChance(object: WorldObjectState): number { return floatField(object, "PLAYER_BLOCK_PERCENTAGE"); }
/** `GetShieldBlock()`. */
export function shieldBlock(object: WorldObjectState): number { return word(object, "PLAYER_SHIELD_BLOCK"); }

/**
 * The lowest of the magic schools 2-7 and every school's value, as the stock sheet's bonus-damage and
 * spell-crit rows build them (the row prints the minimum, the tooltip one line per school).
 */
export interface SchoolSpread {
  readonly min: number;
  /** One-based school → value, schools 2-7. */
  readonly bySchool: ReadonlyMap<number, number>;
}

export function magicSchoolSpread(read: (school: number) => number): SchoolSpread {
  const bySchool = new Map<number, number>();
  let min = Infinity;
  for (let school = FIRST_MAGIC_SCHOOL; school <= SPELL_SCHOOL_COUNT; school++) {
    const value = read(school);
    bySchool.set(school, value);
    min = Math.min(min, value);
  }
  return { min, bySchool };
}

/**
 * The stock resilience row: the lowest of the three crit-taken ratings and the one it came from —
 * melee on a tie, then ranged, then spell, as the stock row breaks ties.
 */
export function resilience(object: WorldObjectState): { readonly rating: number; readonly index: number } {
  const melee = combatRating(object, CR.CRIT_TAKEN_MELEE);
  const ranged = combatRating(object, CR.CRIT_TAKEN_RANGED);
  const spell = combatRating(object, CR.CRIT_TAKEN_SPELL);
  const rating = Math.min(melee, ranged, spell);
  const index = melee === rating ? CR.CRIT_TAKEN_MELEE : ranged === rating ? CR.CRIT_TAKEN_RANGED : CR.CRIT_TAKEN_SPELL;
  return { rating, index };
}

/** The defence skill entry as `ui/Skills.ts` reads it (the slot whose id is SKILL_DEFENSE). */
export interface DefenseSkill {
  readonly value: number;
  readonly temporaryBonus: number;
  readonly permanentBonus: number;
}

/**
 * `UnitDefense("player")`: the skill's value, and its bonuses plus the whole points the defence
 * rating adds (LiveWorldSeam.unitDefense). Undefined without the skill; the rating's points are the
 * caller's (`characterCombatRatingBonus(…, CR.DEFENSE_SKILL, …)`), undefined when it has no table.
 */
export function defense(skill: DefenseSkill | undefined, ratingBonus: number | undefined): readonly [number, number] | undefined {
  if (!skill || ratingBonus === undefined) return undefined;
  return [skill.value, skill.temporaryBonus + skill.permanentBonus + Math.trunc(ratingBonus)];
}

/** `GetDodgeBlockParryChanceFromDefense()`: 0.04 % per point above five per level, never negative. */
export function avoidanceFromDefense(defenseValue: readonly [number, number], level: number): number {
  return Math.max(0, (defenseValue[0] + defenseValue[1] - level * 5) * 0.04);
}

/** `UnitAttackSpeed("player")` in seconds; the off hand only when it has a speed. */
export function attackSpeed(object: WorldObjectState): readonly [number, number | undefined] {
  const main = word(object, "UNIT_FIELD_BASEATTACKTIME");
  const off = word(object, "UNIT_FIELD_BASEATTACKTIME", 1);
  return [main > 0 ? main / 1000 : 1, off > 0 ? off / 1000 : undefined];
}

/** `UnitRangedDamage`'s speed, in seconds. */
export function rangedAttackSpeed(object: WorldObjectState): number {
  const speed = word(object, "UNIT_FIELD_RANGEDATTACKTIME");
  return speed > 0 ? speed / 1000 : 1;
}

/** The weapon damage the server computed, main hand, off hand and ranged. */
export interface DamageRange {
  readonly min: number;
  readonly max: number;
}

export function meleeDamage(object: WorldObjectState): { readonly main: DamageRange; readonly off: DamageRange } {
  return {
    main: { min: floatField(object, "UNIT_FIELD_MINDAMAGE"), max: floatField(object, "UNIT_FIELD_MAXDAMAGE") },
    off: { min: floatField(object, "UNIT_FIELD_MINOFFHANDDAMAGE"), max: floatField(object, "UNIT_FIELD_MAXOFFHANDDAMAGE") },
  };
}

export function rangedDamage(object: WorldObjectState): DamageRange {
  return { min: floatField(object, "UNIT_FIELD_MINRANGEDDAMAGE"), max: floatField(object, "UNIT_FIELD_MAXRANGEDDAMAGE") };
}

/** `ShowingHelm()` / `ShowingCloak()`: the player's flag word without the hide bit. */
export function showingHelm(object: WorldObjectState): boolean {
  return (word(object, "PLAYER_FLAGS") & PLAYER_FLAGS_HIDE_HELM) === 0;
}

export function showingCloak(object: WorldObjectState): boolean {
  return (word(object, "PLAYER_FLAGS") & PLAYER_FLAGS_HIDE_CLOAK) === 0;
}

/**
 * CMSG_SHOWING_HELM / CMSG_SHOWING_CLOAK's body: one byte, non-zero to show (CharacterPackets.cpp
 * reads a `bool`, ByteBuffer.h `operator>>(bool&)` takes a byte). The core answers with the flag
 * word alone, so nothing is written locally (CharacterHandler.cpp:1121-1135).
 */
export function buildShowingToggle(show: boolean): Uint8Array {
  return new PacketWriter().u8(show ? 1 : 0).toUint8Array();
}
