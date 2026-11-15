import type { FrameXmlCursorModel } from "./FrameXmlCursor.js";

/**
 * 3.23 (15.11): the ammo on the cursor — cursor type 9 — Wow.exe 3.3.5a 12340, Ghidra read-only
 * (`.runtime/re-2026-11-15/go8/`: d.c 0x005E85D0, c.c 0x00515200, refs-bd0748.txt, calls-520d30.txt).
 *
 * Who holds what on the cursor (0x00BD0748): every writer of it was read — 0x00520770 the bag item (1), 0x00520880 the
 * player's money (2), 0x00520960 a spell (3), 0x00520A80 (4), 0x00520D30 the item-like holders by its argument (the
 * merchant row 5 from 0x005853A0, the item named by id 7 from the action bar 0x005AB120/0x005ABE70, the guild vault's
 * stack 0xB from 0x005A6200/0x005A6600, and 9 from 0x005E85D0 alone), 0x00522FB0 `PickupItem` (7), 0x00520BE0 a macro
 * (8), 0x00520C60 (10), 0x005208F0 the vault's money (0xC, its one caller 0x005A4330), 0x00520DC0 an equipment set (0xD),
 * and 0x00519280 the let-go. Nothing writes 6: no holder of type 6 exists in this build.
 *
 * Type 9 is the AmmoSlot's: `PickupInventoryItem(0)` (0x005E85D0, the slot index −1) with no bag item held —
 * - with type 9 held (its item id at 0x00BD0758): CMSG_SET_AMMO (0x268) with that id, and the hand lets go;
 * - otherwise, when PLAYER_AMMO_ID (0x005E8300) names an entry the player still carries (0x00754D00 walks the player's
 *   items for it): that entry goes on the cursor as type 9 (0x00520D30, with its picture) when the item cache has it,
 *   and CMSG_SET_AMMO 0 takes it out of the slot; the hand is not let go after;
 * - otherwise the hand lets go (0x00519280).
 * `GetCursorInfo` (0x00515200) answers type 9 with types 7 and 0xB: "item", the id, the link; `CursorHasItem`
 * (0x00515100) is true for types 1 and 9 only. 0x00520D30 shows the action bar grid for type 7 only, and the bar's
 * place path (0x005AB120) takes no type 9.
 *
 * This client: the bag item (`LiveWorldSeam` `#dropOnAmmoSlot`), the vault's stack and the macro keep their own
 * holders and their AmmoSlot paths; this handles the slot click when this model's hand is empty or holds its own
 * content. The item cache test is not repeated: the slot's own picture already needs the entry's item.
 */

/** The AmmoSlot as the seam gives it (LiveWorldSeam). */
export interface FrameXmlAmmoSlot {
  /** PLAYER_AMMO_ID, undefined while 0. */
  entry(): number | undefined;
  /** How many of `entry` the player carries. */
  carried(entry: number): number;
  /** CMSG_SET_AMMO with `entry` (0 clears the slot). */
  set(entry: number): void;
}

export interface FrameXmlAmmoCursorSeam {
  readonly cursor?: FrameXmlCursorModel | undefined;
  readonly ammoSlot?: FrameXmlAmmoSlot | undefined;
}

/**
 * `PickupInventoryItem(0)` as 0x005E85D0 handles it without a bag item: true when this handled the click, false when it
 * belongs to another holder (a bag item, the vault's stack, a macro) or there is no ammo slot here.
 */
export function frameXmlAmmoSlotClick(seam: FrameXmlAmmoCursorSeam): boolean {
  const cursor = seam.cursor;
  const slot = seam.ammoSlot;
  if (!cursor || !slot) return false;
  const held = cursor.held();
  if (held === undefined && cursor.occupied()) return false;
  if (held?.kind === "ammo") {
    slot.set(held.entry);
    cursor.clear();
    return true;
  }
  const entry = slot.entry();
  if (entry !== undefined && slot.carried(entry) > 0) {
    cursor.pickupAmmo(entry);
    slot.set(0);
    return true;
  }
  cursor.clear();
  return true;
}
