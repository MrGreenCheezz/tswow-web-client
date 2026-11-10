/**
 * Plan item 3.57 (11.11): the three usability gates of `Spell_C_IsUsableAction` (0x0080b5d0) and
 * `Spell_C_HaveSpellPower` (0x008017e0) that FrameXmlActionUsable.ts left open until now, as Wow.exe 3.3.5a 12340
 * decides them (Ghidra, `.runtime/re-2026-11-11/usable/u1.c`, `u2.c`, `u2.lst`; the caller's own dump
 * `.runtime/re-2026-10-19/usable/u-b.txt`, `u-e.txt`, `u-f.txt`):
 *
 * - **Runes** (0x005ee5b0, `CGRuneInfo::HasRunesForSpell`, reached from 0x008017e0 for power type 5 and only for
 *   the active player — any other unit is short of runes): the spell's cost percentage is
 *   round((100 + UNIT_FIELD_POWER_COST_MODIFIER) × (1 + UNIT_FIELD_POWER_COST_MULTIPLIER)), each the smallest over
 *   the spell's schools (0x005ee050, 0x005ee0b0), then SPELLMOD_COST (0x007fdb50 with op 14). At 0 the spell is
 *   free. Without a SpellRuneCost row it is free too. Otherwise each of the row's blood, unholy and frost counts
 *   (raised by the percentage only above 100) is met by the ready runes of that type (0x005ee3d0), and what they
 *   lack must be met by the ready death runes.
 * - **Flying-only spells** (AttributesExD 0x4000000; 0x007261b0): the area under the player — its AreaTable row,
 *   else its zone's (0x0051a1d0) — has flag 0x400 and not 0x20000000; and a player on map 571 (Northrend) knows
 *   spell 54197 («Полёты в холодную погоду», 0x0053c5b0).
 * - **The restricted player** (PLAYER_FLAGS 0x1000000, 0x0080b61a): an attack (effect 78 or Attributes 0x2) is
 *   refused, and so is a spell 0x007fcc70 marks — Attributes 0x404, AttributesEx 0x200 or AttributesExB 0x100000.
 *   The register listing at 0x0080b631 shows the spell row handed to 0x007fcc70 in EAX.
 * - **Charm** (0x004f5f00 + 0x008046c0, inside the no-control branch): a charmed unit (UNIT_FIELD_CHARMEDBY not 0)
 *   may still use a spell that lifts every MOD_CHARM (6), AOE_CHARM (177) or MOD_POSSESS (2) effect on it.
 */
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { ActionRangeModifier } from "./FrameXmlActionRange.js";

/** One rune as the active player's rune state holds it: the core's type (0 blood … 3 death) and its ready bit. */
export interface ActionUsableRune {
  readonly type: number;
  readonly ready: boolean;
}

/** What the rune gate reads beyond the unit; every member a cache read. */
export interface ActionUsableRuneHost {
  /** The six runes; undefined while the realm has not said (the gate stays open). */
  runes(): readonly ActionUsableRune[] | undefined;
  /** ChrClasses.SpellClassSet of the player's class (0x007fd970 compares the spell's). */
  playerSpellFamily(): number | undefined;
  spellModifiers(): Iterable<ActionRangeModifier>;
}

const RUNE_DEATH = 3;
const SPELLMOD_COST = 14;
const ATTR3_NO_CASTER_MODIFIERS = 0x20000000;
/** AreaTable flags read by 0x0051a1d0. */
const AREA_FLAG_FLYABLE = 0x400;
const AREA_FLAG_NO_FLY_ZONE = 0x20000000;
const MAP_NORTHREND = 571;
const SPELL_COLD_WEATHER_FLYING = 54197;
const TYPEID_PLAYER = 4;

const floatBits = new DataView(new ArrayBuffer(4));

function fieldWord(unit: WorldObjectState, offset: number): number {
  return unit.fields.get(offset) ?? 0;
}

function fieldFloat(unit: WorldObjectState, offset: number): number {
  floatBits.setUint32(0, fieldWord(unit, offset) >>> 0, true);
  return floatBits.getFloat32(0, true);
}

/** fistp's default rounding: to nearest, ties to even. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 0x005ee050 / 0x005ee0b0: the smallest per-school value over the mask's schools (0 / 0.0 with none). */
function smallestOverSchools(mask: number, read: (school: number) => number): number {
  let found = false;
  let value = 0;
  for (let school = 0; school < 7; school++) {
    if ((mask & (1 << school)) === 0) continue;
    const next = read(school);
    if (!found || next < value) { value = next; found = true; }
  }
  return value;
}

/** 0x007fd970 + 0x007fdb50 with SPELLMOD_COST: (value + flat) × (100 + pct) / 100 when any modifier applies. */
function applyCostModifiers(spell: SpellMetadata, value: number, host: ActionUsableRuneHost): number {
  if (((spell.attributes?.[3] ?? 0) & ATTR3_NO_CASTER_MODIFIERS) !== 0) return value;
  const family = host.playerSpellFamily();
  if (family === undefined || spell.spellClassSet === 0 || spell.spellClassSet !== family) return value;
  let flat = 0;
  let pct = 0;
  for (const modifier of host.spellModifiers()) {
    if (modifier.op !== SPELLMOD_COST) continue;
    const bit = modifier.effectIndex;
    if (bit < 0 || bit >= 96) continue;
    if (((spell.spellClassMask[bit >>> 5] ?? 0) & (1 << (bit & 31))) === 0) continue;
    if (modifier.pct) pct += modifier.value;
    else flat += modifier.value;
  }
  if (flat === 0 && pct === 0) return value;
  return Math.trunc((value + flat) * Math.max(0, 100 + pct) / 100);
}

/**
 * 0x005ee5b0 for the active player: whether its ready runes pay the spell's SpellRuneCost row. True while the
 * row or the rune state is not known — a row from a gateway that does not serve `runeCost`, runes not reported.
 */
export function frameXmlHasRunesForSpell(unit: WorldObjectState, spell: SpellMetadata, host: ActionUsableRuneHost): boolean {
  const schools = spell.schoolMask;
  const modifier = smallestOverSchools(schools,
    (school) => fieldWord(unit, UPDATE_FIELDS.UNIT_FIELD_POWER_COST_MODIFIER.offset + school) | 0);
  const multiplier = smallestOverSchools(schools,
    (school) => fieldFloat(unit, UPDATE_FIELDS.UNIT_FIELD_POWER_COST_MULTIPLIER.offset + school));
  // The x87 product of (multiplier + 1.0) and the integer, stored to a float, then fistp.
  let percent = roundHalfEven(Math.fround((multiplier + 1) * (modifier + 100)));
  percent = applyCostModifiers(spell, percent, host);
  if (percent === 0) return true;
  const cost = spell.runeCost;
  if (cost === undefined) return true;
  const runes = host.runes();
  if (runes === undefined) return true;
  const ready = (type: number): number => runes.filter((rune) => rune.ready && rune.type === type).length;
  let missing = 0;
  for (let type = 0; type < 3; type++) {
    let need = cost[type] ?? 0;
    if (need === 0) continue;
    if (percent > 100) need = Math.trunc(need * percent / 100);
    const have = ready(type);
    if (have < need) missing += need - have;
  }
  return missing === 0 || ready(RUNE_DEATH) >= missing;
}

/** What the flying gate reads; undefined answers leave it open. */
export interface ActionUsableFlightHost {
  /** The AreaTable Flags of the player's area, else of its zone (0x0051a1d0); undefined while unknown. */
  areaFlags(): number | undefined;
  mapId(): number | undefined;
  knowsSpell(spellId: number): boolean;
}

/** 0x007261b0(1) for a spell with AttributesExD 0x4000000: false refuses it here. */
export function frameXmlFlyingAllowed(unit: WorldObjectState, host: ActionUsableFlightHost | undefined): boolean {
  if (!host) return true;
  const flags = host.areaFlags();
  if (flags !== undefined && ((flags & AREA_FLAG_FLYABLE) === 0 || (flags & AREA_FLAG_NO_FLY_ZONE) !== 0)) return false;
  if (unit.typeId === TYPEID_PLAYER && host.mapId() === MAP_NORTHREND && !host.knowsSpell(SPELL_COLD_WEATHER_FLYING)) return false;
  return true;
}

/** 0x007fcc70: what a restricted player (PLAYER_FLAGS 0x1000000) may not use besides an attack. */
export function frameXmlRestrictedAbility(spell: SpellMetadata): boolean {
  const word = (index: number): number => (spell.attributes?.[index] ?? 0) >>> 0;
  return (word(0) & 0x404) !== 0 || (word(1) & 0x200) !== 0 || (word(2) & 0x100000) !== 0;
}

/** 0x004f5f00: UNIT_FIELD_CHARMEDBY is set. */
export function frameXmlUnitCharmed(unit: WorldObjectState): boolean {
  const offset = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
  return fieldWord(unit, offset) !== 0 || fieldWord(unit, offset + 1) !== 0;
}

/** 0x008046c0's three aura types, in its order. */
export const FRAMEXML_CHARM_AURA_TYPES: readonly number[] = Object.freeze([6, 177, 2]);
