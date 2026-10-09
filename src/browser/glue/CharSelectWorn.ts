/**
 * 6.18 (line A7a, slice G, 05.10): which of the SMSG_CHAR_ENUM equipment slots the character-select
 * figure wears.
 *
 * Wow.exe 0x004e3cd0 (called by the `SelectCharacter` Lua function 0x004e4580) walks the 23 slots
 * of the selected character's enum record (0x198 bytes, flags word at +0x170, class byte at +0x179)
 * and puts a slot on the figure only when it has a display and:
 *  - it is not the head (slot 0) while CHARACTER_FLAG_HIDE_HELM 0x400 is set, nor the back (slot 14)
 *    while CHARACTER_FLAG_HIDE_CLOAK 0x800 is set — TrinityCore sets both from PLAYER_FLAGS_HIDE_HELM
 *    / HIDE_CLOAK (Player.cpp:1540-1543) and sends the equipment regardless;
 *  - for a hunter (class 3) it is not the main or off hand (15, 16); for every other class it is not
 *    the ranged slot (17). A hunter stands there with the bow, anyone else with the melee weapons.
 * The ghost flag 0x2000 (a ghost's look and backdrop) is read by the same function and is not done
 * here.
 *
 * Where the weapons go: 0x004eacd0 is called with no sheath state, which hangs the main hand on
 * attachment 1 (right hand), the off hand on 2 (left hand; a shield on 0) and the ranged weapon on 2
 * — the hunter holds the bow in the left hand. `charSelectSheath` names that in this client's terms.
 */
import { SHEATH_MELEE, SHEATH_RANGED } from "../Attachment.js";

const SLOT_HEAD = 0;
const SLOT_BACK = 14;
const SLOT_MAIN_HAND = 15;
const SLOT_OFF_HAND = 16;
const SLOT_RANGED = 17;
const CLASS_HUNTER = 3;
export const CHARACTER_FLAG_HIDE_HELM = 0x400;
export const CHARACTER_FLAG_HIDE_CLOAK = 0x800;

export function charSelectWears(slot: number, classId: number, flags: number): boolean {
  if (slot === SLOT_HEAD && (flags & CHARACTER_FLAG_HIDE_HELM) !== 0) return false;
  if (slot === SLOT_BACK && (flags & CHARACTER_FLAG_HIDE_CLOAK) !== 0) return false;
  if (classId === CLASS_HUNTER) return slot !== SLOT_MAIN_HAND && slot !== SLOT_OFF_HAND;
  return slot !== SLOT_RANGED;
}

/** The sheath state `Attachment.attachmentPoint` takes for one slot of the select-screen figure. */
export function charSelectSheath(slot: number): number {
  return slot === SLOT_RANGED ? SHEATH_RANGED : SHEATH_MELEE;
}

/**
 * 05.10-A7a-G review 6.18: the sheath state for a glue figure's slot. The select screen's hang is
 * `charSelectSheath`; the creation screen draws CharStartOutfit — a rogue's row is a dagger, an
 * off-hand dagger and a thrown knife, a hunter's a two-hander and a bow — and was not checked against
 * Wow.exe, so it keeps the hang it had: the melee weapons in the hands, the ranged one stowed.
 */
export function figureSheath(slot: number, charSelect: boolean): number {
  return charSelect ? charSelectSheath(slot) : SHEATH_MELEE;
}
