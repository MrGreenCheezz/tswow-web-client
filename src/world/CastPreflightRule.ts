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
 * Not modelled (no data in this client): 0x0080cce0's other CANT_DO_THAT_RIGHT_NOW tests — a spell outside the
 * OverrideSpellData row of PLAYER_FIELD_BYTES2's low word, and a vehicle seat's flags against the spell's kind.
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

/** The spell row parts the rules read: attribute words 0..2 and Effect[0]. */
export interface CastPreflightSpell {
  readonly attributes: readonly number[] | undefined;
  readonly effect0: number | undefined;
}

/** The ranged slot's item as 0x006d71a0 reads it; undefined for an empty slot or an item not in view. */
export interface CastPreflightItem {
  readonly flags: number;
  readonly durability: number;
  readonly maxDurability: number;
}

/** The player as 0x0080cce0 reads it. */
export interface CastPreflightCaster {
  readonly health: number;
  readonly playerFlags: number;
  readonly rangedItem: CastPreflightItem | undefined;
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

/** 0x0080cce0's refusals 1–3 for the active player's spell, in its order; undefined lets the cast go on. */
export function castPreflightRefusal(spell: CastPreflightSpell, caster: CastPreflightCaster): number | undefined {
  const attack = attackSpell(spell);
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
