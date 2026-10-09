// What a unit does standing still when no packet pose owns it: 6.03 and 6.04 (line A7a, slice C).
//
// The original client keeps three things here that the renderer used to flatten to `Stand`:
// * `UNIT_NPC_EMOTESTATE` (field 83, `Unit::SetEmoteState`, `Unit.h:970-971`): a stance the unit
//   holds — the blacksmith hammering, the miner, the dancer. It replaces Stand; the unit still walks
//   and runs, and the stance is back the moment it stops. That is why it is a *base*, not a queue
//   entry: `unitActionEndsOnMovement` erases a held emote for good, and the field does not change
//   again, so there would be nothing to bring it back.
// * `UNIT_FLAG_IN_COMBAT` (0x00080000, `UnitDefines.h:154`): the combat stance between swings,
//   Ready1H/2H/2HL/Bow/Rifle/Thrown/Unarmed by what the unit holds.
// * The stance rows of `Emotes.dbc` with `EmoteSpecProc` 1 and no AnimID are not poses at all but
//   stand states (`EmoteSpecProcParam`): STATE_SLEEP 12 → 3, STATE_SIT 13 → 1, STATE_DEAD 65 → 7,
//   STATE_KNEEL 68 → 8 — the creature_addon «мёртвый» corpses and kneeling NPCs.
//
// Everything here is pure and allocation-free per frame: the ladders are built once per value and
// shared, so a city of 500 units pays a field read and a comparison each.

import { ANIMATION_IDS, EMOTE_ANIMATIONS } from "../generated/animations.js";
import {
  UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SLEEP,
  UNIT_STAND_STATE_STAND,
} from "../world/CharacterProgressProtocol.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { weaponAnimTable } from "./WeaponAnimations.js"; // 05.10-A7a-D 6.06: /dbc/weapon-anims

/** `UNIT_FLAG_IN_COMBAT`, `UnitDefines.h:154`; the same constant `world/FactionRules.ts` exports. */
const UNIT_FLAG_IN_COMBAT = 0x00080000;
/** `SHEATH_STATE_*` (`SharedDefines.h`): byte 0 of `UNIT_FIELD_BYTES_2`. */
const SHEATH_STATE_UNARMED = 0;
const SHEATH_STATE_RANGED = 2;

const EQUIPMENT_SLOT_MAINHAND = 15;
const EQUIPMENT_SLOT_RANGED = 17;
const INVENTORY_TYPE_WEAPON = 13;
const INVENTORY_TYPE_RANGED = 15;
const INVENTORY_TYPE_TWO_HAND = 17;
const INVENTORY_TYPE_WEAPON_MAIN_HAND = 21;
const INVENTORY_TYPE_THROWN = 25;
const INVENTORY_TYPE_RANGED_RIGHT = 26;

/** The six values of `ItemSubClass.WeaponReadySeq`, decoded against the subclasses (line A7a, A7-M3). */
const enum ReadySeq { TwoHand = 0, TwoHandLoose = 1, OneHand = 2, Bow = 3, Rifle = 4, Thrown = 5 }

/**
 * `ItemSubClass.dbc` class 2, column `WeaponReadySeq`, by subclass (read 05.10 from the dataset:
 * `.runtime/re-2026-10-05/A7a-C/probe-ready.mjs`). A fallback written into the code until the
 * `/dbc/weapon-anims` route of slice D (6.06) publishes the column; the values are the table's, not
 * guesses — including the two that differ from the attack-side `WeaponPose`: a crossbow (18) stands
 * like a rifle (4), and a wand (19) like a one-hander (2).
 */
const WEAPON_READY_SEQ: readonly ReadySeq[] = [
  /* 0 axe */ ReadySeq.OneHand, /* 1 axe2 */ ReadySeq.TwoHand, /* 2 bow */ ReadySeq.Bow,
  /* 3 gun */ ReadySeq.Rifle, /* 4 mace */ ReadySeq.OneHand, /* 5 mace2 */ ReadySeq.TwoHand,
  /* 6 polearm */ ReadySeq.TwoHandLoose, /* 7 sword */ ReadySeq.OneHand, /* 8 sword2 */ ReadySeq.TwoHand,
  /* 9 obsolete */ ReadySeq.OneHand, /* 10 staff */ ReadySeq.TwoHandLoose, /* 11 exotic */ ReadySeq.OneHand,
  /* 12 exotic2 */ ReadySeq.OneHand, /* 13 fist */ ReadySeq.OneHand, /* 14 misc */ ReadySeq.OneHand,
  /* 15 dagger */ ReadySeq.OneHand, /* 16 thrown */ ReadySeq.Thrown, /* 17 spear */ ReadySeq.TwoHandLoose,
  /* 18 crossbow */ ReadySeq.Rifle, /* 19 wand */ ReadySeq.OneHand, /* 20 fishing pole */ ReadySeq.TwoHandLoose,
];

function ladder(...names: readonly string[]): readonly number[] {
  const out: number[] = [];
  for (const name of names) {
    const id = ANIMATION_IDS[name];
    if (typeof id === "number" && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The stance for each `WeaponReadySeq`, best first. The fallbacks behind the first rung are what a
 * creature rig without that stance should stand in; AnimationData's own `Fallback` (Ready2HL → 25,
 * not 27) would skip the two-hander, which a polearm-wielding rig without 28 does have.
 */
const READY_LADDERS: readonly (readonly number[])[] = [
  ladder("Ready2H", "Ready1H", "ReadyUnarmed"),
  ladder("Ready2HL", "Ready2H", "Ready1H", "ReadyUnarmed"),
  ladder("Ready1H", "ReadyUnarmed"),
  ladder("ReadyBow", "ReadyUnarmed"),
  ladder("ReadyRifle", "ReadyBow", "ReadyUnarmed"),
  ladder("ReadyThrown", "ReadyUnarmed"),
];
export const READY_UNARMED: readonly number[] = ladder("ReadyUnarmed");

interface HeldItem { slot: number; inventoryType: number; subClass?: number }

function readySeqOf(item: HeldItem): ReadySeq | undefined {
  const type = item.inventoryType;
  const weapon = type === INVENTORY_TYPE_WEAPON || type === INVENTORY_TYPE_TWO_HAND
    || type === INVENTORY_TYPE_WEAPON_MAIN_HAND || type === INVENTORY_TYPE_RANGED
    || type === INVENTORY_TYPE_THROWN || type === INVENTORY_TYPE_RANGED_RIGHT;
  // A relic in the ranged slot is class 4: its subclass would read as a class-2 sword.
  if (!weapon) return undefined;
  // 05.10-A7a-D: the route's WeaponReadySeq (WeaponAnimations.ts); this file's table stays the fallback.
  if (item.subClass !== undefined) return (weaponAnimTable().subclass(item.subClass)?.ready as ReadySeq | undefined) ?? WEAPON_READY_SEQ[item.subClass];
  // Appearance payloads from before the optional subclass: the inventory type is all there is.
  switch (type) {
    case INVENTORY_TYPE_TWO_HAND: return ReadySeq.TwoHand;
    case INVENTORY_TYPE_WEAPON:
    case INVENTORY_TYPE_WEAPON_MAIN_HAND: return ReadySeq.OneHand;
    case INVENTORY_TYPE_RANGED: return ReadySeq.Bow;
    case INVENTORY_TYPE_THROWN: return ReadySeq.Thrown;
    // 26 is guns, crossbows and wands alike; without the subclass nothing tells them apart.
    default: return undefined;
  }
}

/**
 * The combat stance for what the unit is holding *now*: a drawn melee weapon is the main hand's
 * subclass, a drawn ranged weapon the ranged slot's, empty hands ReadyUnarmed. An off-hand alone
 * does not make a stance — the original's table is keyed by the main hand.
 *
 * Sheathed weapons (`SHEATH_STATE_UNARMED`) make no stance at all: the unit keeps Stand. A caster
 * fights with its weapons away, and whether Wow.exe raises its fists between casts is not known
 * here (open for the 14.25 side-by-side); Stand is what this client always drew, so the unknown
 * case keeps it rather than guessing a boxer's guard.
 */
export function readyStance(attached: readonly HeldItem[] | undefined, sheath: number | undefined): readonly number[] | undefined {
  if (sheath === SHEATH_STATE_UNARMED) return undefined;
  if (attached === undefined) return READY_UNARMED;
  const slot = sheath === SHEATH_STATE_RANGED ? EQUIPMENT_SLOT_RANGED : EQUIPMENT_SLOT_MAINHAND;
  for (const item of attached) {
    if (item.slot !== slot) continue;
    const seq = readySeqOf(item);
    return seq === undefined ? READY_UNARMED : READY_LADDERS[seq] ?? READY_UNARMED;
  }
  return READY_UNARMED;
}

/** The stand state a `EmoteSpecProc` 1 row means (`EmoteSpecProcParam`), for the rows with no pose. */
const EMOTE_STAND_STATES: ReadonlyMap<number, number> = new Map([
  [12, UNIT_STAND_STATE_SLEEP], [13, UNIT_STAND_STATE_SIT], [65, UNIT_STAND_STATE_DEAD], [68, UNIT_STAND_STATE_KNEEL],
]);

/** The stand state a held emote state puts the unit in, if it is one of those rows. */
export function emoteStandState(emote: number): number | undefined {
  return EMOTE_STAND_STATES.get(emote);
}

/** The looping pose an emote state holds (`EmoteSpecProc` ≠ 0 with an AnimID), or undefined. */
export function emoteStateAnimation(emote: number): number | undefined {
  const row = EMOTE_ANIMATIONS[emote];
  return row !== undefined && row.state ? row.animation : undefined;
}

/** A one-shot row (`EmoteSpecProc` 0) written into the field: played once when the value changes. */
export function emoteStateOneShot(emote: number): number | undefined {
  const row = EMOTE_ANIMATIONS[emote];
  return row !== undefined && !row.state ? row.animation : undefined;
}

const stanceLadders = new Map<number, readonly number[]>();
let standLadder: readonly number[] | undefined;
let stealthLadder: readonly number[] | undefined;

/** What `UnitPose` carries for this module; a structural subset so the module stays pure. */
export interface StandingPose {
  stealth?: boolean;
  standState: number;
  /** The raw `UNIT_NPC_EMOTESTATE`, when not zero. Only what changed it is compared. */
  npcEmote?: number;
  /** The resolved AnimationData id of a held emote state. */
  emoteState?: number;
  /** The combat stance ladder, while `UNIT_FLAG_IN_COMBAT` is up. */
  ready?: readonly number[];
}

/**
 * The ladder for a unit standing still on its feet: crouch, then the emote stance, then the combat
 * stance, then Stand. A sneaking unit keeps the crouch (`animationLadder("StealthStand", "Stand")`
 * as before). The emote stance outranks the combat stance: the core clears the field when a
 * creature engages (`Unit::Attack`, `Unit.cpp:6014`) and when it dies (`Unit.cpp:9324`), so a stance
 * that survives into combat is one a script set on purpose (a channel, a stun). Shared arrays —
 * nothing calls `push` on a `wanted` list.
 */
export function standingAnimations(pose: StandingPose): readonly number[] {
  if (pose.stealth === true) return stealthLadder ??= ladder("StealthStand", "Stand");
  if (pose.emoteState !== undefined) {
    let stance = stanceLadders.get(pose.emoteState);
    if (stance === undefined) {
      stance = ANIMATION_IDS.Stand === pose.emoteState ? [pose.emoteState] : [pose.emoteState, ANIMATION_IDS.Stand];
      stanceLadders.set(pose.emoteState, stance);
    }
    return stance;
  }
  if (pose.ready !== undefined && pose.ready.length > 0) return pose.ready;
  return standLadder ??= [ANIMATION_IDS.Stand];
}

const NPC_EMOTESTATE = UPDATE_FIELDS.UNIT_NPC_EMOTESTATE.offset;
const FIELD_FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const FIELD_BYTES_2 = UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset;

/**
 * Fills the standing half of a freshly built pose from the unit's fields, and returns the emote to
 * play once when a one-shot value was just written into the field (undefined otherwise).
 *
 * `previous` is the pose of the last frame (`RenderedUnit.pose`); a unit seen for the first time —
 * or rebuilt — does not replay a one-shot it was already in, or every NPC of a city would bow at
 * once on arrival. Only an engaged unit scans its weapons, so the crowd pays two `Map.get`s.
 */
export function applyStandingPose(
  pose: StandingPose,
  fields: ReadonlyMap<number, number>,
  attached: readonly HeldItem[] | undefined,
  previous: StandingPose | undefined,
): number | undefined {
  const emote = fields.get(NPC_EMOTESTATE) ?? 0;
  if (emote !== 0) {
    pose.npcEmote = emote;
    const held = emoteStateAnimation(emote);
    if (held !== undefined) pose.emoteState = held;
    // Only over plain standing: a sitting or dead byte already says more than the emote.
    const standState = emoteStandState(emote);
    if (standState !== undefined && pose.standState === UNIT_STAND_STATE_STAND) pose.standState = standState;
  }
  if (((fields.get(FIELD_FLAGS) ?? 0) & UNIT_FLAG_IN_COMBAT) !== 0) {
    const bytes2 = fields.get(FIELD_BYTES_2);
    const ready = readyStance(attached, bytes2 === undefined ? undefined : bytes2 & 0xff);
    if (ready !== undefined) pose.ready = ready;
  }
  if (previous === undefined || emote === 0 || (previous.npcEmote ?? 0) === emote) return undefined;
  return emoteStateOneShot(emote);
}
