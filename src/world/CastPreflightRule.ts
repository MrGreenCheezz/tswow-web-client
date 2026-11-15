/**
 * Plan item 5.05 (11.11): the client's own refusals of the player's cast before anything is sent, as Wow.exe 3.3.5a 12340
 * makes them — the request builder 0x0080cce0 and the sender 0x0080ac90 (read-only Ghidra,
 * `.runtime/re-2026-11-11/worldtails/w1.c`, `w2.c`; `combat/d1.c`). Each refusal goes to 0x00808200 like the realm's,
 * with the result below; nothing goes on the wire. In the original's order, for a caster that is the active player:
 *
 * 0x0080cce0
 * 1. PLAYER_FLAGS (the player block +8) 0x1000000: CANT_DO_THAT_RIGHT_NOW (0xad) for an "attack" spell — Effect[0]
 *    SPELL_EFFECT_ATTACK (78), Attributes 0x2 (ranged) or AttributesEx2 0x20 (auto repeat) — or a spell 0x007fcc70
 *    calls a swing (Attributes 0x404 on next swing, AttributesEx 0x200, AttributesEx2 0x100000). Otherwise, with
 *    PLAYER_ALLOW_ONLY_ABILITY (0x800000), CANT_DO_THAT_RIGHT_NOW for any spell that is not an "attack" one.
 * 2. Dead — the player's vtable +0x128, 0x006dac10: health ≤ 0 or PLAYER_FLAGS_GHOST (0x10) — CASTER_DEAD (0x17),
 *    unless SPELL_ATTR0_CASTABLE_WHILE_DEAD (0x800000).
 * 3. Attributes 0x2 (SPELL_ATTR0_RANGED): the item in equipment slot 17 (0x00512590(0x11)) must exist and pass
 *    0x006d71a0 — ITEM_FIELD_FLAGS 0x10 clear, and wrapped (0x8), without durability, or not broken — else
 *    EQUIPPED_ITEM (0x1c).
 * 0x0080ac90 (after the target checks)
 * 4. A caster not standing (vtable +0x138, the stand state) without SPELL_ATTR0_CASTABLE_WHILE_SITTING (0x8000000):
 *    0x0071b090 — the active player with the CVar autoStand (0x00bd08f8, default "1") — stands it up (0x0071a360 →
 *    0x006dcb40(0), CMSG_STANDSTATECHANGE 0) and the cast goes on; else NOT_STANDING (0x45).
 *
 * 0. 5.05 (15.11, combat7), first of all (re-2026-11-11/worldtails/w1.c 0x0080d0a4…): a spell that is not an
 *    "attack" one (as in 1), cast by a player and not from an item, while PLAYER_FIELD_BYTES2's low word (the
 *    player block +0x10e4) names an OverrideSpellData row (0x0065c290) whose Flags (+0x2c) lack 0x4: unless 0x007fe820
 *    finds the spell among the row's ten (+0x4…+0x28), CANT_DO_THAT_RIGHT_NOW. The realm never makes this check.
 *
 * 0b. 11.02/5.05 (15.11, vehicle8; listing .runtime/re-2026-11-15/vehicle8/b1.lst 0x0080cee1…0x0080cffe, 0x00800950 in
 *    b1.c), right after 0: a caster riding a carrier (0x0074b8b0: a vehicle's or a player's guid) that is here, on a slot
 *    its vehicle has a seat row for (0x005d3340 → 0x00756ec0). The spell asks the seat for UNCONTROLLED (0x2000) when one
 *    of its effects applies MOD_SHAPESHIFT (aura 36) to a form whose SpellShapeshiftForm Flags lack 0x1 or that the table
 *    lacks (0x00800950), for CAN_CAST_MOUNT_SPELL (0x1000) when one applies MOUNTED (aura 78, 0x007fde50), and for
 *    CAN_ATTACK (0x4000) when neither; unless AttributesEx6 0x1000 (CASTABLE_WHILE_ON_VEHICLE) or Attributes 0x1000000
 *    (CASTABLE_WHILE_MOUNTED), a seat without every asked bit gives CANT_DO_THAT_RIGHT_NOW. The realm makes the same test
 *    (SpellInfo::CheckVehicle). Only 90 of the dataset's 720 seats have CAN_ATTACK.
 *    Not modelled: the loop that follows for a player on a seat with 0x40000800 — as compiled it compares Effect[i] with
 *    0…3 (not SPELL_EFFECT_SUMMON) before reading EffectMiscValueB's SummonProperties Control; no spell of the dataset has
 *    such an effect naming a non-wild row (probe2.txt), so it never refuses here. The realm's own summon test still does.
 */

/** SpellCastResult (SharedDefines.h). */
export const SPELL_FAILED_CASTER_DEAD = 23;
export const SPELL_FAILED_EQUIPPED_ITEM = 28;
export const SPELL_FAILED_NOT_STANDING = 69;
export const SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW = 173;

/** Spell.dbc bits 0x0080cce0 and 0x0080ac90 read (SharedDefines.h). */
const SPELL_ATTR0_RANGED = 0x2;
const SPELL_ATTR0_ON_NEXT_SWING_ANY = 0x404;
const SPELL_ATTR0_CASTABLE_WHILE_DEAD = 0x800000;
const SPELL_ATTR0_CASTABLE_WHILE_SITTING = 0x8000000;
const SPELL_ATTR1_SWING_LIKE = 0x200;
const SPELL_ATTR2_AUTOREPEAT = 0x20;
const SPELL_ATTR2_SWING_LIKE = 0x100000;
const SPELL_EFFECT_ATTACK = 78;
/** PLAYER_FLAGS (Player.h). */
const PLAYER_FLAGS_GHOST = 0x10;
const PLAYER_ALLOW_ONLY_ABILITY = 0x800000;
const PLAYER_FLAGS_NO_MELEE_ABILITY = 0x1000000;
/** ITEM_FIELD_FLAGS (ItemTemplate.h): WRAPPED, and the bit 0x006d71a0 refuses outright. */
const ITEM_FIELD_FLAG_WRAPPED = 0x8;
const ITEM_FIELD_FLAG_UNK2 = 0x10;

/** The spell row parts the rules read: attribute words 0..2 (and 6 for 0b) and Effect[0]. */
export interface CastPreflightSpell {
  readonly attributes: readonly number[] | undefined;
  readonly effect0: number | undefined;
  /** 15.11 (vehicle8): EffectAura[0..2] and the first MOD_SHAPESHIFT effect's form Flags (`/dbc/spells`), for 0b. */
  readonly effectAura?: readonly number[] | undefined;
  readonly shapeshiftFormFlags?: number | undefined;
}

/** 15.11 (vehicle8): the seat row a passenger caster sits on, as 0x0080cce0 reads it (row +4, Flags). */
export interface CastPreflightSeat {
  readonly flags: number;
}

const SPELL_ATTR0_CASTABLE_WHILE_MOUNTED = 0x0100_0000;
const SPELL_ATTR6_CASTABLE_WHILE_ON_VEHICLE = 0x1000;
const SPELL_AURA_MOD_SHAPESHIFT = 36;
const SPELL_AURA_MOUNTED = 78;
const SEAT_FLAG_CAN_CAST_MOUNT_SPELL = 0x1000;
const SEAT_FLAG_UNCONTROLLED = 0x2000;
const SEAT_FLAG_CAN_ATTACK = 0x4000;
/** SpellShapeshiftForm Flags bit 0x1 (unnamed in DBCStructure.h): a form 0x00800950 does not count. */
const SHAPESHIFT_FORM_FLAG_STANCE = 0x1;

/**
 * 15.11 (vehicle8): refusal 0b — the passenger's seat lacks what the spell asks of it (0x0080cce0 → 0x00800950,
 * 0x007fde50). `seat` undefined: not riding a seat with a row (no test).
 */
export function vehicleSeatRefused(spell: CastPreflightSpell, seat: CastPreflightSeat | undefined): boolean {
  if (seat === undefined) return false;
  const auras = spell.effectAura ?? [];
  let asked = 0;
  // 0x00800950: the first MOD_SHAPESHIFT effect's form is the only one /dbc/spells resolves; no row → asked.
  if (auras.includes(SPELL_AURA_MOD_SHAPESHIFT)
    && (spell.shapeshiftFormFlags === undefined || (spell.shapeshiftFormFlags & SHAPESHIFT_FORM_FLAG_STANCE) === 0)) {
    asked |= SEAT_FLAG_UNCONTROLLED;
  }
  if (auras.includes(SPELL_AURA_MOUNTED)) asked |= SEAT_FLAG_CAN_CAST_MOUNT_SPELL;
  if (asked === 0) asked = SEAT_FLAG_CAN_ATTACK;
  const words = spell.attributes;
  if (((words?.[6] ?? 0) & SPELL_ATTR6_CASTABLE_WHILE_ON_VEHICLE) !== 0
    || ((words?.[0] ?? 0) & SPELL_ATTR0_CASTABLE_WHILE_MOUNTED) !== 0) return false;
  return (seat.flags & asked) !== asked;
}

/** The ranged slot's item as 0x006d71a0 reads it; undefined for an empty slot or an item not in view. */
export interface CastPreflightItem {
  readonly flags: number;
  readonly durability: number;
  readonly maxDurability: number;
}

/** 5.05 (15.11, combat7): an OverrideSpellData row as 0x0080cce0 reads it — Flags (+0x2c) and Spells[10] (+0x4). */
export interface OverrideSpellRow {
  readonly flags: number;
  readonly spells: readonly number[];
}

/** OverrideSpellData Flags bit 0x4: the row restricts nothing (0x0080cce0 skips the test). */
const OVERRIDE_SPELL_FLAG_UNRESTRICTED = 0x4;

/** The player as 0x0080cce0 reads it. */
export interface CastPreflightCaster {
  readonly health: number;
  readonly playerFlags: number;
  readonly rangedItem: CastPreflightItem | undefined;
  /**
   * 5.05 (15.11, combat7): the OverrideSpellData row PLAYER_FIELD_BYTES2's low word names, when it is non-zero and the
   * row is known; absent: no test (no override, or the rows have not landed).
   */
  readonly overrideSpells?: OverrideSpellRow | undefined;
  /** 15.11 (vehicle8): the seat row the player rides on a carrier in view (refusal 0b); absent: none or not known. */
  readonly seat?: CastPreflightSeat | undefined;
}

/** `local_5` of 0x0080cce0: Effect[0] ATTACK, a ranged spell or an auto-repeating one. */
function attackSpell(spell: CastPreflightSpell): boolean {
  const words = spell.attributes;
  return spell.effect0 === SPELL_EFFECT_ATTACK || ((words?.[0] ?? 0) & SPELL_ATTR0_RANGED) !== 0
    || ((words?.[2] ?? 0) & SPELL_ATTR2_AUTOREPEAT) !== 0;
}

/** 0x007fcc70: a spell that rides the swing. */
function swingSpell(spell: CastPreflightSpell): boolean {
  const words = spell.attributes;
  return ((words?.[0] ?? 0) & SPELL_ATTR0_ON_NEXT_SWING_ANY) !== 0 || ((words?.[1] ?? 0) & SPELL_ATTR1_SWING_LIKE) !== 0
    || ((words?.[2] ?? 0) & SPELL_ATTR2_SWING_LIKE) !== 0;
}

/** 0x006d71a0: the ranged item may be used. */
export function rangedItemUsable(item: CastPreflightItem | undefined): boolean {
  if (item === undefined || (item.flags & ITEM_FIELD_FLAG_UNK2) !== 0) return false;
  return (item.flags & ITEM_FIELD_FLAG_WRAPPED) !== 0 || item.maxDurability === 0 || item.durability !== 0;
}

/** 5.05 (15.11, combat7): refusal 0 — the spell is outside a restricting OverrideSpellData row (0x007fe820). */
export function overrideSpellRefused(spellId: number, row: OverrideSpellRow | undefined): boolean {
  return row !== undefined && (row.flags & OVERRIDE_SPELL_FLAG_UNRESTRICTED) === 0 && !row.spells.includes(spellId);
}

/**
 * 0x0080cce0's refusals 0–3 for the active player's spell, in its order; undefined lets the cast go on. `spell.id`
 * is needed for refusal 0 only (absent: no test).
 */
export function castPreflightRefusal(spell: CastPreflightSpell & { readonly id?: number }, caster: CastPreflightCaster): number | undefined {
  const attack = attackSpell(spell);
  // 5.05 (15.11, combat7): refusal 0, before the PLAYER_FLAGS tests.
  if (!attack && spell.id !== undefined && overrideSpellRefused(spell.id, caster.overrideSpells)) {
    return SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW;
  }
  if (vehicleSeatRefused(spell, caster.seat)) return SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW; // 0b, 15.11 (vehicle8)
  if ((caster.playerFlags & PLAYER_FLAGS_NO_MELEE_ABILITY) !== 0) {
    if (attack || swingSpell(spell)) return SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW;
  } else if (!attack && (caster.playerFlags & PLAYER_ALLOW_ONLY_ABILITY) !== 0) {
    return SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW;
  }
  const attributes0 = spell.attributes?.[0] ?? 0;
  const dead = !(caster.health > 0) || (caster.playerFlags & PLAYER_FLAGS_GHOST) !== 0;
  if (dead && (attributes0 & SPELL_ATTR0_CASTABLE_WHILE_DEAD) === 0) return SPELL_FAILED_CASTER_DEAD;
  if ((attributes0 & SPELL_ATTR0_RANGED) !== 0 && !rangedItemUsable(caster.rangedItem)) return SPELL_FAILED_EQUIPPED_ITEM;
  return undefined;
}

export type SittingCast = "go" | "stand" | "refuse";

/** 0x0080ac90's stand test: go on, stand up first, or refuse NOT_STANDING. */
export function sittingCastRule(attributes0: number | undefined, standState: number, autoStand: boolean): SittingCast {
  if (standState === 0 || ((attributes0 ?? 0) & SPELL_ATTR0_CASTABLE_WHILE_SITTING) !== 0) return "go";
  return autoStand ? "stand" : "refuse";
}
