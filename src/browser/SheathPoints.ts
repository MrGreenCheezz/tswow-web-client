// 6.08 (line A7a, slice G2, 05.10): where a stowed weapon hangs, as Wow.exe 3.3.5a 12340 hangs it.
//
// One routine hangs every weapon model in the client, 0x004eacd0 — character select (0x004e4207),
// the corpse (0x00705e7b), a creature's virtual items (0x00725177) and a player's own slots
// (0x0072de7b, 0x0072b8e6) all call it — with the slot (15, 16, 17), the item's SheatheType and a
// "stowed" flag. Drawn, the main hand goes on attachment 1 and the off hand on 2 (a shield on 0).
// Stowed, the point is picked by SheatheType, main hand K-1 and off hand K:
//
//   SheatheType 1 (two-hander)  → 26 / 27   high on the back
//   SheatheType 2 (staff)       → 30 / 31   across the back
//   SheatheType 3 (one-hander)  → 32 / 33   main hand on the left hip, off hand on the right
//   SheatheType 4 (shield)      → 28 / 28   the middle of the back
//   anything else (0, 5, 6, 7)  → nothing: a fist weapon (7) is not drawn stowed at all
//
// and a model without that attachment draws nothing (0x008273d0 fails the hang). No turn is added on
// top of the bone (0x004eaa70 → 0x00831630 with zero offsets): the sheath bones carry the
// orientation, which is why each of 26–34 sits on a bone of its own on the playable models. The
// 1.12.1 client does the same (`CPPClientExample/benilla`, `entities/equipment/mod.rs`, 0x47a070),
// so the table is not a 3.3.5 novelty.
//
// The ranged slot: drawn (sheath state 2, 0x0072b7f0(0, …)) a bow (INVTYPE 15) is in the left hand and
// anything of INVTYPE 26 (gun, crossbow, wand) or 25 (thrown) in the right; otherwise 0x0072dbc0 takes it
// out of the hand (0x004eb070 detaches the hand point). 05.10: ревью G2 — stowing it is not "never": on
// leaving state 2 (0x00731f40, the sheathe events 0x007367b0/0x007368b0/0x007369b0) 0x0072b7f0(1, …) hangs
// it through 0x004eacd0 with the stowed flag, by its SheatheType — a bow by the off-hand column, the rest
// by the main-hand one. SheatheType 0 has no point, and that is what the bows, guns and crossbows carry
// (Item.dbc: 299 of 303 bows, 249 of 252 guns, 156 of 157 crossbows), so in practice a stowed ranged
// weapon is not on the back; the few with 1–4 are. Wow.exe only stows it on leaving state 2 — a unit
// first seen stowed has none hung — which this stateless table does not model (rare items only).
//
// Where SheatheType comes from: a player's item, `item_template.sheath` from the item query (the
// client's item cache, which 0x0072dbc0 reads at +5); a creature's virtual item, `Item.dbc`
// SheatheType by entry (0x00725010 reads the Item.dbc record at +0x1c). Item.dbc is too noisy to
// derive the type from the kind of weapon (68 of 404 INVTYPE_WEAPON axes are type 1, 112 of 259
// polearms type 1 rather than 2; `.runtime/re-2026-10-05/A7a-G2/probe-sheathe.mjs`), so an item whose type has not arrived keeps the old points
// (`Attachment.attachmentPoint`) rather than a guess.
//
// Per-frame cost: called once per hung piece per frame, like `attachmentPoint`; a few compares and
// one property read, no allocation.

import type { AttachedModel, EquippedItem } from "../gateway/CharacterAppearance.js";
import { SHEATH_MELEE, SHEATH_RANGED, attachmentPoint } from "./Attachment.js";
import { ATTACHMENT_HAND_LEFT, ATTACHMENT_HAND_RIGHT } from "./Wvm.js";

export const SHEATH_POINT_BACK_MAIN = 26;
export const SHEATH_POINT_BACK_OFF = 27;
export const SHEATH_POINT_SHIELD = 28;
export const SHEATH_POINT_STAFF_MAIN = 30;
export const SHEATH_POINT_STAFF_OFF = 31;
export const SHEATH_POINT_HIP_MAIN = 32;
export const SHEATH_POINT_HIP_OFF = 33;

const SLOT_MAIN_HAND = 15;
const SLOT_OFF_HAND = 16;
const SLOT_RANGED = 17;
/** INVTYPE_RANGED: a bow, the one ranged weapon held in the left hand. */
const INVENTORY_TYPE_RANGED = 15;

/** Wow.exe 0x004eacd0: the stowed point for a hand slot and a SheatheType, or undefined for none. */
export function sheathPoint(slot: number, sheathe: number): number | undefined {
  const off = slot === SLOT_OFF_HAND;
  if (!off && slot !== SLOT_MAIN_HAND) return undefined;
  switch (sheathe) {
    case 1: return off ? SHEATH_POINT_BACK_OFF : SHEATH_POINT_BACK_MAIN;
    case 2: return off ? SHEATH_POINT_STAFF_OFF : SHEATH_POINT_STAFF_MAIN;
    case 3: return off ? SHEATH_POINT_HIP_OFF : SHEATH_POINT_HIP_MAIN;
    case 4: return SHEATH_POINT_SHIELD;
    default: return undefined;
  }
}

/**
 * Where a piece hangs in the world: `Attachment.attachmentPoint` for everything worn and drawn, the
 * Wow.exe sheath table for a stowed hand weapon whose SheatheType is known, and the ranged slot only
 * while it is drawn. `sheathe` is the item's SheatheType when known (`sheatheOf`).
 */
export function worldAttachmentPoint(item: AttachedModel, sheath: number,
  sheathe: number | undefined = item.sheathe): number | undefined {
  if (item.slot === SLOT_RANGED) {
    const bow = item.inventoryType === INVENTORY_TYPE_RANGED;
    // 05.10: ревью G2 — stowed, 0x0072b7f0(1, …) hangs it through 0x004eacd0 like a hand weapon: a bow by the
    // off-hand column, INVTYPE 26/25 by the main-hand one. SheatheType 0 (nearly every bow, gun and crossbow)
    // and an unknown type hang nothing.
    if (sheath !== SHEATH_RANGED) return sheathe === undefined ? undefined : sheathPoint(bow ? SLOT_OFF_HAND : SLOT_MAIN_HAND, sheathe);
    return bow ? ATTACHMENT_HAND_LEFT : ATTACHMENT_HAND_RIGHT;
  }
  // Worn pieces, drawn hands (a shield on the forearm), and a stowed piece of unknown type: as before.
  if (sheathe === undefined || sheath === SHEATH_MELEE
    || (item.slot !== SLOT_MAIN_HAND && item.slot !== SLOT_OFF_HAND)) return attachmentPoint(item, sheath);
  return sheathPoint(item.slot, sheathe);
}

/** The worn table `unitModelFor` keeps for a player: SheatheType by slot, for the hand slots known. */
export type WornSheathes = Readonly<Record<number, number>>;

/** A piece's SheatheType: its own (a creature's held weapon), else the player's worn table. */
export function sheatheOf(item: AttachedModel, metadata: { readonly wornSheathe?: WornSheathes | undefined } | undefined): number | undefined {
  return item.sheathe ?? metadata?.wornSheathe?.[item.slot];
}

/** The worn table out of a player's equipment list, or undefined when no hand slot's type is known. */
export function wornSheathes(equipment: readonly EquippedItem[]): WornSheathes | undefined {
  let table: Record<number, number> | undefined;
  for (const item of equipment) {
    if (item.sheathe === undefined || (item.slot !== SLOT_MAIN_HAND && item.slot !== SLOT_OFF_HAND && item.slot !== SLOT_RANGED)) continue;
    (table ??= {})[item.slot] = item.sheathe;
  }
  return table;
}
