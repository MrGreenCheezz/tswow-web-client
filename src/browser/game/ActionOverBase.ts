// What a packet pose off Wow.exe's split list does over a base that is not standing (6.21b, 05.10).
//
// Owner decision of 05.10, read from Wow.exe 3.3.5a (12340); notes in .runtime/re-2026-10-05/l621/
// (723e30.asm.txt) and A7a-D2/d1.c (0x7385c0 and the behaviour classes it calls).
//
// * 0x723e30 answers only "split track or not". A pose it does not split goes to the track of the
//   whole model, whatever the base is doing: a pose off the 0x71d800 list (Mutilate, Whirlwind, Kick,
//   the druid form attacks, EmoteKneel...) requested while the unit runs, swims, flies, falls or sneaks
//   plays with the whole body — the legs take the pose while the unit keeps travelling — and the base
//   comes back when it ends. Before this the client dropped such a one-shot ("yield").
// * Falling: 0x723350 (called at 0x723f56 on the movement block +0x788) answers 1 for a unit that is
//   really falling, so a listed pose splits over a fall as over a run (what `isBaseIdle` already does).
//   For a pose off the list the fall has its own branch: an attack-class behaviour (0x71d590: the
//   swings, parries and Special*, Kick 95, the druid cat/bear attacks 170..179, Mutilate 212) splits
//   when the movement flags carry FALLING 0x1000 (0x723fc0..0x723fd8).
// * Rider: 0x7385c0 takes its own branch when the unit is mounted (`unit+0x98c`): a listed pose goes to
//   the split track over the mount's pose, a locomotion behaviour (0x71d6b0) is translated for the
//   seat, and any other pose is put on neither track — a rider does not play it. Kept as "yield".
// * Seated stand states and vehicle seats are not in 0x723e30 at all; they stay as they were (a
//   one-shot off the list gives way) until frames say otherwise (14.25).
// * Holds are not covered: Wow.exe re-sets the base whenever movement changes, which a hold off the
//   list would not survive; a hold keeps waiting for the base to settle.

import type { UnitPose } from "../AnimatedModel.js";
import { animationBehavior } from "./AnimationSplit.js";
import { seatPoseWanted } from "../VehicleSeatPose.js";
import { ANIMATION_IDS, ANIMATION_NAMES } from "../../generated/animations.js";
import {
  UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SIT_CHAIR,
  UNIT_STAND_STATE_SIT_HIGH_CHAIR, UNIT_STAND_STATE_SIT_LOW_CHAIR, UNIT_STAND_STATE_SIT_MEDIUM_CHAIR,
  UNIT_STAND_STATE_SLEEP,
} from "../../world/CharacterProgressProtocol.js";

/** `MOVEMENTFLAG_FALLING`, the bit 0x723fd1 tests. */
const MOVEMENT_FALLING = 0x1000;

/** AnimationData BehaviorIDs of Wow.exe's attack class 0x71d590. 33 of them. */
export const WOW_ATTACK_BEHAVIORS: ReadonlySet<number> = new Set([
  10, 16, 17, 18, 19, 20, 21, 22, 23, 24, 30, 36, 57, 58, 59, 85, 86, 87, 88, 95, 117, 118,
  170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 212,
]);

type Names = Readonly<Record<number, string>>;
type Ids = Readonly<Record<string, number | undefined>>;

const attackCache = new WeakMap<Names, Map<number, boolean>>(); // 05.10: ревью 6.21b

/** An attack-class pose over a falling base goes to the split track even off the list (0x723fc0). */
export function attackSplitsWhileFalling(animation: number, movementFlags: number,
  names: Names = ANIMATION_NAMES, ids: Ids = ANIMATION_IDS): boolean {
  if ((movementFlags & MOVEMENT_FALLING) === 0) return false;
  // 05.10: ревью 6.21b — answered once per id: a Fly twin's behaviour is found by slicing its name,
  // which allocated a string every frame a unit fell with such a pose queued.
  let byId = attackCache.get(names);
  if (byId === undefined) {
    byId = new Map();
    attackCache.set(names, byId);
  }
  let attack = byId.get(animation);
  if (attack === undefined) {
    attack = WOW_ATTACK_BEHAVIORS.has(animationBehavior(animation, names, ids));
    byId.set(animation, attack);
  }
  return attack;
}

/**
 * Whether the unit's own base is one Wow.exe keeps a pose off the list out of: dead, mounted, in a
 * vehicle seat, or sitting/kneeling/sleeping. Every other base that is not plain standing — moving,
 * on a spline, swimming, flying, hovering, falling, sneaking — is travel.
 */
export function unitBaseSeated(pose: UnitPose): boolean {
  if (pose.dead || pose.mounted === true) return true;
  if (seatPoseWanted(pose.vehicleSeat) !== undefined) return true;
  switch (pose.standState) {
    case UNIT_STAND_STATE_SIT: case UNIT_STAND_STATE_SIT_CHAIR: case UNIT_STAND_STATE_SIT_MEDIUM_CHAIR:
    case UNIT_STAND_STATE_SIT_LOW_CHAIR: case UNIT_STAND_STATE_SIT_HIGH_CHAIR: case UNIT_STAND_STATE_KNEEL:
    case UNIT_STAND_STATE_DEAD: case UNIT_STAND_STATE_SLEEP:
      return true;
  }
  return false;
}

/**
 * Whether a pose that will not split plays with the whole body over this (not standing) base: a
 * one-shot off the list over a travelling base. Asked only when the base is not idle.
 */
export function poseTakesWholeBody(pose: UnitPose, listed: boolean, held: boolean): boolean {
  return !held && !listed && !unitBaseSeated(pose);
}

const startedTravelling = new WeakMap<object, boolean>(); // 05.10: ревью 6.21b

/**
 * 05.10: ревью 6.21b — whether a pose may keep the whole body over the travel the unit is in now.
 * Called for every queued pose the renderer considers, each frame: until the pose starts it notes
 * whether the unit was travelling; once it has started, a pose begun with the unit still is over
 * the moment the unit sets off. Wow.exe keeps such a pose on the whole-model track, the track the
 * base is on too (0x723e30 = 0), and the run the base switches to when the unit starts moving
 * replaces it (A10 6.21: "legs in the pose until movement re-sets the animation"). Without this a
 * /kneel, a Kick or a Whirlwind begun standing slid along with frozen legs for the rest of its clip
 * once the unit ran off — the very slide the arbiter's yield was written against. A pose begun on
 * the run keeps the body while the run goes on.
 */
export function wholeBodyOutlivesBase(entry: { readonly started: boolean }, travelling: boolean): boolean {
  if (!entry.started) {
    startedTravelling.set(entry, travelling);
    return true;
  }
  return !travelling || startedTravelling.get(entry) !== false;
}
