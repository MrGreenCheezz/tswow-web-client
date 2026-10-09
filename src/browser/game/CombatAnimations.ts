// What a melee swing looks like on both ends (6.06, line A7a slice D, 05.10).
//
// `SMSG_ATTACKERSTATEUPDATE` (world/CombatProtocol.ts) is the only packet that says a swing
// happened. Until this module the client read one thing from it for the pose: the attacker swung.
// Three more are in the packet and the client's tables:
// * which hand — `HITINFO_OFFHAND` (0x4, `UnitDefines.h:364`), set by `Unit::CalculateMeleeDamage`
//   for `OFF_ATTACK` (`Unit.cpp:1330`): the left hand swings `AttackOff` / its kits;
// * what the victim did, and when — 05.10-A7a-D2: decided by `game/SwingReactionCues.ts` at the
//   attacker's model events, as Wow.exe does (not on the packet's arrival);
// * which swing — by the weapon's subclass in that hand, as Wow.exe `0x755130` chooses it
//   (05.10-A7a-D-review: not an `AttackAnimKits` roll, see `swingLadder`); which parry — likewise by
//   the victim's main-hand subclass, `0x73b050` (05.10-A7a-D2: not `WeaponParrySeq`).
//
// Pure, and free of allocations on the per-frame path: `combatAnimations` returns shared arrays.

import { ANIMATION_FALLBACK, ANIMATION_IDS } from "../../generated/animations.js";
import { HITINFO_OFFHAND } from "../../world/CombatProtocol.js";
import { PARRY_UNARMED, weaponAnimTable, type WeaponAnimTable, type WeaponHand } from "../WeaponAnimations.js";

/**
 * What the victim of a swing does. 05.10-A7a-D2: `standWound` is Wow.exe's flinch of a victim with
 * no melee target of its own (`0x736640`); `parryUnarmed` a parry with the weapons sheathed.
 */
export type CombatReaction = "wound" | "standWound" | "critical" | "dodge" | "parry" | "parryUnarmed" | "block";

/** The attacker's half: the off-hand bit is the only thing that changes it. */
export function swingAction(hitInfo: number): "attack" | "attackOff" {
  return (hitInfo & HITINFO_OFFHAND) !== 0 ? "attackOff" : "attack";
}

const EQUIPMENT_SLOT_MAINHAND = 15;
const EQUIPMENT_SLOT_OFFHAND = 16;
const INVENTORY_TYPE_TWO_HAND = 17;

interface HeldItem { slot: number; inventoryType: number; subClass?: number }

/**
 * 05.10-A7a-D-review: the inventory types of class-2 items (weapon, two-hand, main/off hand, ranged,
 * thrown, ranged-right) — Wow.exe's swing asks "is the item in this hand a weapon" (class 2), and
 * the attachment record carries the inventory type, not the class.
 */
const WEAPON_INVENTORY_TYPES: ReadonlySet<number> = new Set([13, 15, 17, 21, 22, 25, 26]);

function single(name: string): readonly number[] {
  const id = ANIMATION_IDS[name];
  return Object.freeze(typeof id === "number" ? [id] : []);
}

const REACTION_LADDERS: Readonly<Record<Exclude<CombatReaction, "parry">, readonly number[]>> = {
  wound: single("CombatWound"),
  standWound: single("StandWound"), // 05.10-A7a-D2
  critical: single("CombatCritical"),
  dodge: single("Dodge"),
  parryUnarmed: PARRY_UNARMED, // 05.10-A7a-D2
  block: single("ShieldBlock"),
};
const PARRY_2H = single("Parry2H");
const PARRY_1H = single("Parry1H");
const PARRY_2HL = single("Parry2HL"); // 05.10-A7a-D2
/** 05.10-A7a-D2: a weapon `0x73b050` has no parry for (bows, guns, thrown, crossbows, wands, 9). */
const NO_PARRY: readonly number[] = Object.freeze([]);

// 05.10-A7a-D2: the parry Wow.exe draws. `0x73b050` reads the main hand only: no class-2 item →
// ParryUnarmed; then a byte table by subclass (at 0x73b128, five cases) — 0 4 7 11 14 15 20 →
// Parry1H; 1 5 8 12 → Parry2H, Parry1H when the off hand holds anything (Titan's Grip, as the
// swing); 6 10 17 → Parry2HL; 13 → ParryUnarmed; 2 3 9 16 18 19 → no animation at all.
// `ItemSubClass.WeaponParrySeq` is not consulted (it disagrees for 11, 12, 14 and 20).
// The sheath (weapons away → ParryUnarmed) is the caller's: see `SwingReactionCues`.
function parryLadder(attached: readonly HeldItem[] | undefined, _table: WeaponAnimTable): readonly number[] {
  if (attached === undefined) return PARRY_UNARMED;
  let main: HeldItem | undefined;
  let offHeld = false;
  for (const item of attached) {
    if (item.slot === EQUIPMENT_SLOT_MAINHAND) main = item;
    else if (item.slot === EQUIPMENT_SLOT_OFFHAND) offHeld = true;
  }
  if (main === undefined || !WEAPON_INVENTORY_TYPES.has(main.inventoryType)) return PARRY_UNARMED;
  // A payload without the subclass: the inventory type is all there is.
  if (main.subClass === undefined) return main.inventoryType === INVENTORY_TYPE_TWO_HAND ? PARRY_2H : PARRY_1H;
  switch (main.subClass) {
    case 0: case 4: case 7: case 11: case 14: case 15: case 20: return PARRY_1H;
    case 1: case 5: case 8: case 12: return offHeld ? PARRY_1H : PARRY_2H;
    case 6: case 10: case 17: return PARRY_2HL;
    case 13: return PARRY_UNARMED;
    default: return NO_PARRY;
  }
}

/** A start and the AnimationData fallback chain behind it (≤ 8 hops, as `resolveAnimation` walks). */
function chain(name: string): readonly number[] {
  const out: number[] = [];
  for (let id: number | undefined = ANIMATION_IDS[name], hop = 0; id !== undefined && hop < 8; hop++) {
    if (out.includes(id)) break;
    out.push(id);
    id = ANIMATION_FALLBACK[id];
  }
  return Object.freeze(out);
}

// 05.10-A7a-D-review: the swing Wow.exe draws. `0x755130` (UnitCombat_C, the attacker's half of
// SMSG_ATTACKERSTATEUPDATE, called from the opcode switch `0x756800`, case 0x14A) picks one animation
// by the class-2 subclass in the hand and nothing else — no AttackAnimKits roll, no
// WeaponAttackSeq — and skips the swing for HITINFO_NO_ANIMATION or a melee spell id:
//   main  0 4 7 11 14 → Attack1H; 1 5 8 12 → Attack2H, Attack1H when the off hand holds anything
//         (Titan's Grip); 6 10 17 20 → Attack2HL; 15 → Attack1HPierce; any other subclass, a
//         non-weapon or an empty hand → AttackUnarmed;
//   off   a weapon → AttackOff, a dagger → AttackOffPierce, none → AttackUnarmedOff.
const SWING_1H = chain("Attack1H");
const SWING_2H = chain("Attack2H");
const SWING_2HL = chain("Attack2HL");
const SWING_1H_PIERCE = chain("Attack1HPierce");
const SWING_UNARMED = chain("AttackUnarmed");
const SWING_OFF = chain("AttackOff");
const SWING_OFF_PIERCE = chain("AttackOffPierce");
const SWING_UNARMED_OFF = chain("AttackUnarmedOff");
const ITEM_SUBCLASS_DAGGER = 15;

function swingLadder(attached: readonly HeldItem[] | undefined, hand: WeaponHand): readonly number[] | undefined {
  // No record yet (a model still loading): the caller's inventory-type list applies.
  if (attached === undefined) return undefined;
  if (hand === "off") {
    let off: HeldItem | undefined;
    for (const item of attached) if (item.slot === EQUIPMENT_SLOT_OFFHAND) off = item;
    if (off === undefined || !WEAPON_INVENTORY_TYPES.has(off.inventoryType)) return SWING_UNARMED_OFF;
    return off.subClass === ITEM_SUBCLASS_DAGGER ? SWING_OFF_PIERCE : SWING_OFF;
  }
  let main: HeldItem | undefined;
  let offHeld = false;
  for (const item of attached) {
    if (item.slot === EQUIPMENT_SLOT_MAINHAND) main = item;
    else if (item.slot === EQUIPMENT_SLOT_OFFHAND) offHeld = true;
  }
  if (main === undefined || !WEAPON_INVENTORY_TYPES.has(main.inventoryType)) return SWING_UNARMED;
  // A payload without the subclass: the caller's inventory-type list is all there is.
  if (main.subClass === undefined) return undefined;
  switch (main.subClass) {
    case 0: case 4: case 7: case 11: case 14: return SWING_1H;
    case 1: case 5: case 8: case 12: return offHeld ? SWING_1H : SWING_2H;
    case 6: case 10: case 17: case 20: return SWING_2HL;
    case ITEM_SUBCLASS_DAGGER: return SWING_1H_PIERCE;
    default: return SWING_UNARMED;
  }
}

/** The part of a queued pose this module reads (`UnitActionPayload` is wider). */
export interface CombatPosePayload {
  action: string | undefined;
  /**
   * The roll the renderer draws per swing. 05.10-A7a-D-review: unused — Wow.exe does not roll among
   * AttackAnimKits for an auto-attack (`0x755130`); kept for the M2 sub-variation choice (6.16c).
   */
  roll?: number;
  reaction?: CombatReaction;
}

/**
 * The poses a swing or a reaction asks for on this unit, best first; undefined when this module has
 * nothing to say and the caller's own lists (`actionAnimation`, the payload's `wanted`) apply: a shot,
 * a cast, a swing with no subclass known, an off-hand subclass without kits.
 */
export function combatAnimations(payload: CombatPosePayload, attached: readonly HeldItem[] | undefined,
  table: WeaponAnimTable = weaponAnimTable()): readonly number[] | undefined {
  if (payload.reaction !== undefined) {
    return payload.reaction === "parry" ? parryLadder(attached, table) : REACTION_LADDERS[payload.reaction];
  }
  if (payload.action === "attack") return swingLadder(attached, "main");
  if (payload.action === "attackOff") return swingLadder(attached, "off");
  return undefined;
}
