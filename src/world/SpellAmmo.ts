// 29.10: the ammo pair of SMSG_SPELL_START / SMSG_SPELL_GO (owner: «у охотника не проигрывается анимация стрельбы»).
//
// The core sets `CAST_FLAG_AMMO` for every spell with `SPELL_ATTR0_REQ_AMMO` or the custom NEEDS_AMMO_DATA
// (Spell.cpp:4487-4488 for the GO, 4430-4431 for the start) — Auto Shot, Arcane/Steady/Aimed/Multi-Shot,
// the stings, Shoot, Throw — and writes two words after the trajectory (SpellPackets.cpp:98-102, 155-156):
// `Spell::UpdateSpellCastDataAmmo` (Spell.cpp:4592-4670; called at 4459-4463 and 4570-4574) fills them with
// - a player: the ranged weapon's own display for an `INVTYPE_THROWN` weapon, else the `PLAYER_AMMO_ID` item's
//   display and inventory type (5996, `INVTYPE_AMMO`, with the Requires No Ammo aura 46699);
// - a creature: its virtual ranged item — a thrown weapon's display, 5996 (an arrow) for a bow or a crossbow,
//   5998 (a bullet) for a gun.

import type { PacketReader } from "../protocol/PacketReader.js";

/** `CAST_FLAG_AMMO` (Spell.h). */
export const CAST_FLAG_AMMO = 0x20;
/** `INVTYPE_AMMO` and `INVTYPE_THROWN` (ItemTemplate.h): the two inventory types Wow.exe draws a flight model for. */
export const INVTYPE_AMMO = 24;
export const INVTYPE_THROWN = 25;
/** `INVTYPE_RELIC`, the last inventory type; anything above it is a misread tail. */
const INVTYPE_MAX = 28;

export interface SpellAmmo {
  /** `ItemDisplayInfo` id of the ammo (or of the thrown weapon); 0 when the caster has none. */
  displayId: number;
  /** `InventoryType` of that item. */
  inventoryType: number;
}

/** Reads the pair (both words, always); undefined when the inventory type is not one. Throws on a short tail. */
export function readSpellAmmo(reader: PacketReader): SpellAmmo | undefined {
  const displayId = reader.u32();
  const inventoryType = reader.u32();
  return inventoryType <= INVTYPE_MAX ? { displayId, inventoryType } : undefined;
}

/** Whether a cast carries an ammo display Wow.exe could fly: the flag, a display, and ammo or a thrown weapon. */
export function castFlightAmmo(cast: { castFlags: number; ammo?: SpellAmmo | undefined }): SpellAmmo | undefined {
  const ammo = cast.ammo;
  if ((cast.castFlags & CAST_FLAG_AMMO) === 0 || !ammo || ammo.displayId <= 0) return undefined;
  return ammo.inventoryType === INVTYPE_AMMO || ammo.inventoryType === INVTYPE_THROWN ? ammo : undefined;
}

/**
 * Whether a cast is a ranged weapon release: the flag with a display of any kind. Wider than {@link castFlightAmmo} —
 * a creature with no ranged item sends its melee weapon's display (Spell.cpp:4665-4669), which shoots but flies nothing.
 */
export function castCarriesAmmo(cast: { castFlags: number; ammo?: SpellAmmo | undefined }): boolean {
  return (cast.castFlags & CAST_FLAG_AMMO) !== 0 && cast.ammo !== undefined && cast.ammo.displayId > 0;
}
