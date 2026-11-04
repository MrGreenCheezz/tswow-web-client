// 11.02-H: the pose a vehicle passenger holds — VehicleSeat.dbc's ride animations and
// HIDE_PASSENGER, which the core never reads — by Wow.exe 3.3.5a 12340's rules (Ghidra, read-only:
// .runtime/re-2026-10-03/l1102h/r1-r4.c). AnimatedModel.ts asks these for `UnitPose.vehicleSeat`;
// where the passenger is drawn is VehiclePassengerPose.ts. Pure, no three.js.
//
// Seated (VehiclePassenger_C state 3):
// - The legs: seat Flags HAS_LOWER_ANIM_FOR_RIDE 0x2 → RideAnimStart once (unless −1), then
//   RideAnimLoop (0x00747b20 case 3; "start played" is passenger+0x10 bit 1), under whatever the
//   unit's own pose is, which moves to the upper body (0x007385c0 → 0x00747b20).
// - The unit's own pose: seat Flags 0x4 (DBCEnums.h:473 UNK3) → RideUpperAnimStart once, then
//   RideUpperAnimLoop (0x007485b0, low in the chooser 0x00724500); otherwise the ordinary choice.
// - So without 0x2 the whole body plays RideUpper (with 0x4) or the ordinary pose (neither).
// - 04.11: with the legs' animation the base is that animation, and the unit's own pose goes to the split track when its
//   AnimationData BehaviorID is not 0 (0x007385c0 at 0x00738eb5, 0x007176b0 reads the row's +0x18), so a stand stays out of
//   it and the legs' clip takes the whole body. That own pose is RideUpper where nothing else asks (`upper` below).
// - −1 (and anything at or past the AnimationData row count 0x1fa) is no animation.
// - Entering (states 1/2: HAS_LOWER_ANIM_FOR_ENTER 0x1 → EnterAnimStart/Loop) and leaving (4/5:
//   ExitAnimStart/Loop, ExitAnimEnd on landing — JumpEnd turned JumpLandRun when moving): 26.10, while
//   VehicleSeatTransition.ts carries the passenger, `vehicleSeatTransitionPose`; 04.11 the landing, `vehicleSeatTransition`.
//
// HIDE_PASSENGER 0x200: 0x007489c0 sets passenger+0x10 bit 0x400 on entering state 3 (kept on a
// seat switch inside the same root vehicle); 0x00730f30 then gives the unit no model.

import type { VehicleSeatEntry } from "../world/VehicleDbc.js";
import { VEHICLE_SEAT_FLAGS } from "../world/VehicleSeatModel.js";
import { ANIMATION_IDS } from "../generated/animations.js";
import { animationBehavior } from "./game/AnimationSplit.js";

/** VehicleSeat Flags 0x4 (DBCEnums.h:473 UNK3): the unit's own pose is RideUpperAnim (Wow.exe 0x007485b0). */
export const SEAT_FLAG_HAS_UPPER_ANIM_FOR_RIDE = 0x0000_0004;

/** Wow.exe's "no animation": the AnimationData row count, 0x1fa; the DBC writes −1. */
const NO_ANIMATION = 0x1fa;

/** An animation id the client can play, or undefined for −1 and the out-of-table values. */
function animationOf(value: number): number | undefined {
  return Number.isInteger(value) && value >= 0 && value < NO_ANIMATION ? value : undefined;
}

/** A one-shot and the loop after it; either may be missing. */
export interface SeatAnimationPair {
  readonly start: number | undefined;
  readonly loop: number | undefined;
}

/** The seated passenger's two Wow.exe layers: the legs and the unit's own pose. */
export interface PassengerSeatAnimations {
  /** HAS_LOWER_ANIM_FOR_RIDE: RideAnimStart/Loop on the legs (0x00747b20). */
  readonly lower: SeatAnimationPair | undefined;
  /** Flags 0x4: RideUpperAnimStart/Loop as the unit's own pose (0x007485b0). */
  readonly upper: SeatAnimationPair | undefined;
}

function pair(start: number, loop: number): SeatAnimationPair | undefined {
  const first = animationOf(start);
  const repeat = animationOf(loop);
  return first === undefined && repeat === undefined ? undefined : { start: first, loop: repeat };
}

/** What Wow.exe plays on a seated passenger, by layer. */
export function passengerSeatAnimations(seat: Pick<VehicleSeatEntry,
  "flags" | "rideAnimStart" | "rideAnimLoop" | "rideUpperAnimStart" | "rideUpperAnimLoop">): PassengerSeatAnimations {
  return {
    lower: (seat.flags & VEHICLE_SEAT_FLAGS.HAS_LOWER_ANIM_FOR_RIDE) !== 0 ? pair(seat.rideAnimStart, seat.rideAnimLoop) : undefined,
    upper: (seat.flags & SEAT_FLAG_HAS_UPPER_ANIM_FOR_RIDE) !== 0 ? pair(seat.rideUpperAnimStart, seat.rideUpperAnimLoop) : undefined,
  };
}

/** A seat as the unit's pose carries it (`UnitPose.vehicleSeat`): one frozen object per seat row. */
export interface VehiclePassengerSeatPose {
  /** The VehicleSeat row id: a seat switch is a new seat. */
  readonly id: number;
  /** The whole-body loop, as `poseAnimation` asks for it; empty when the seat names none. */
  readonly wanted: readonly number[];
  /** The one-shot played on taking the seat, when it differs from the loop. */
  readonly start: number | undefined;
  /** HIDE_PASSENGER: the passenger is not drawn while it sits here. */
  readonly hidden: boolean;
  /** 04.11: the base is the legs' clip, so a pose of the unit's own goes on the split track (0x007385c0). */
  readonly split?: boolean;
  /** 04.11: RideUpperAnimStart/Loop on the split track over the legs (0x007485b0). */
  readonly upper?: SeatAnimationPair;
  /** 04.11: on the way out, what plays on landing: ExitAnimEnd (0x007489c0, state 5 to 0). */
  readonly landing?: SeatLanding;
}

/** The landing's one-shot and whether Flags 0x200000 plays it in a fall or in water too (0x0074b9c0). */
export interface SeatLanding {
  readonly animation: number;
  readonly always: boolean;
}

/** Seat Flags 0x200000: the landing's animation plays whatever the unit's movement says (0x0074b9c0). */
const SEAT_FLAG_LANDING_ALWAYS = 0x0020_0000;

/** What keeps a landing from showing (0x0074b9c0): falling, swimming, or flying, each with a pose of its own. */
const LANDING_YIELDS_TO = 0x1000 | 0x20_0000 | 0x200_0000;
/** The movement bits 0x00748d28 tests for JumpEnd: any of forward, backward, strafes. */
const LANDING_MOVING = 0xf;

const seatPoses = new WeakMap<VehicleSeatEntry, VehiclePassengerSeatPose>();

/**
 * This frame's move on the split track over a seat's legs (0x007485b0): the start once on taking the seat, then the loop;
 * nothing to do while the start plays or the rig has no cut of the clip yet.
 */
export function seatUpperMove(upper: SeatAnimationPair, fresh: boolean, onShow: number | undefined, onShowRunning: boolean,
  hasCut: (animation: number) => boolean): { readonly animation: number; readonly loop: boolean } | undefined {
  const { start, loop } = upper;
  if (fresh && start !== undefined && hasCut(start)) return { animation: start, loop: false };
  if (start !== undefined && onShow === start && onShowRunning) return undefined;
  return loop !== undefined && hasCut(loop) ? { animation: loop, loop: true } : undefined;
}

/** Whether a pose of the unit's own goes on the split track over the legs (0x007385c0): any with a BehaviorID other than 0. */
export function seatSplitsPose(seat: VehiclePassengerSeatPose | undefined, animation: number): boolean {
  return seat?.split === true && animationBehavior(animation) !== 0;
}

/**
 * The seat's base pose: the legs' pair when it has a loop, else the upper pair over the whole body; its start only when it
 * is a different clip. Cached per seat row.
 */
export function vehiclePassengerSeatPose(seat: VehicleSeatEntry): VehiclePassengerSeatPose {
  const cached = seatPoses.get(seat);
  if (cached) return cached;
  const { lower, upper } = passengerSeatAnimations(seat);
  const chosen = lower?.loop !== undefined ? lower : upper?.loop !== undefined ? upper : undefined;
  const loop = chosen?.loop;
  const start = chosen?.start !== undefined && chosen.start !== loop ? chosen.start : undefined;
  const pose: VehiclePassengerSeatPose = Object.freeze({
    id: seat.id,
    wanted: Object.freeze(loop === undefined ? [] : [loop]),
    start,
    hidden: (seat.flags & VEHICLE_SEAT_FLAGS.HIDE_PASSENGER) !== 0,
    ...(chosen !== undefined && chosen === lower ? { split: true } : {}),
    ...(chosen !== undefined && chosen === lower && upper?.loop !== undefined && animationBehavior(upper.loop) !== 0 ? { upper } : {}),
  });
  seatPoses.set(seat, pose);
  return pose;
}

/** 11.02 (26.10): the seat poses of the way in and out, cached per seat row. */
const enterPoses = new WeakMap<VehicleSeatEntry, VehiclePassengerSeatPose>();
const exitPoses = new WeakMap<VehicleSeatEntry, VehiclePassengerSeatPose>();
/** Ids kept apart from the seat's own (a VehicleSeat id is far below these), so each is a new pose. */
const ENTER_POSE_ID = 0x0100_0000;
const EXIT_POSE_ID = 0x0200_0000;

/**
 * 11.02 (26.10): the pose a passenger holds on its way into a seat (`enter`, Wow.exe states 1/2) or out of it
 * (`exit`, 4/5) — 0x00747b20's lower anim, played whole-body by 0x00748560 while the unit is not seated:
 * EnterAnimStart once, then EnterAnimLoop (seat Flags 0x1); ExitAnimStart, then ExitAnimLoop (exit Flags 0x8 or
 * 0x8000 — review: 0x0074bb60 picks one by movement flags2 0x40). ExitAnimEnd is for the landing (`vehicleSeatTransition`).
 */
export function vehicleSeatTransitionPose(seat: VehicleSeatEntry, kind: "enter" | "exit"): VehiclePassengerSeatPose {
  const cache = kind === "enter" ? enterPoses : exitPoses;
  const cached = cache.get(seat);
  if (cached) return cached;
  const allowed = kind === "enter"
    ? (seat.flags & VEHICLE_SEAT_FLAGS.HAS_LOWER_ANIM_FOR_ENTER) !== 0
    : (seat.flags & (0x8 | 0x8000)) !== 0;
  const chosen = allowed
    ? (kind === "enter" ? pair(seat.enterAnimStart, seat.enterAnimLoop) : pair(seat.exitAnimStart, seat.exitAnimLoop))
    : undefined;
  const loop = chosen?.loop;
  const pose: VehiclePassengerSeatPose = Object.freeze({
    id: (kind === "enter" ? ENTER_POSE_ID : EXIT_POSE_ID) + seat.id,
    wanted: Object.freeze(loop === undefined ? [] : [loop]),
    start: chosen?.start !== undefined && chosen.start !== loop ? chosen.start : undefined,
    hidden: false,
    ...(kind === "exit" && animationOf(seat.exitAnimEnd) !== undefined
      ? { landing: { animation: seat.exitAnimEnd, always: (seat.flags & SEAT_FLAG_LANDING_ALWAYS) !== 0 } } : {}),
  });
  cache.set(seat, pose);
  return pose;
}

/**
 * `poseAnimation`'s list for a seated unit: the seat's loop alone, no Stand behind it (the same rule
 * as the rider's seat ladder); undefined when there is no seat or it names no loop.
 */
export function seatPoseWanted(seat: VehiclePassengerSeatPose | undefined): number[] | undefined {
  return seat !== undefined && seat.wanted.length > 0 ? seat.wanted as number[] : undefined;
}

/**
 * Whether the pose's list is a seat request (`poseAnimationFamily` "mount"): resolved inside the
 * seat family, never through AnimationData's fallback into another one — dead units excepted,
 * whose list is Dead/Death.
 */
export function seatPoseFamily(seat: VehiclePassengerSeatPose | undefined, dead: boolean): boolean {
  return !dead && seatPoseWanted(seat) !== undefined;
}

/**
 * `poseTransition` across a vehicle seat: false when neither pose is seated (the ordinary one-shots
 * apply); otherwise the seat's start on taking it — a seat switch is a new seat — and, 04.11, the landing at the end of
 * the way out (0x007489c0 state 5 to 0 → 0x0074b9c0): ExitAnimEnd, JumpEnd being JumpLandRun for a unit on the move.
 */
export function vehicleSeatTransition(previous: VehiclePassengerSeatPose | undefined,
  next: VehiclePassengerSeatPose | undefined, movementFlags = 0): number | undefined | false {
  if (previous === undefined && next === undefined) return false;
  if (next === undefined && previous?.landing !== undefined) {
    const { animation, always } = previous.landing;
    if (!always && (movementFlags & LANDING_YIELDS_TO) !== 0) return undefined;
    return animation === ANIMATION_IDS.JumpEnd && (movementFlags & LANDING_MOVING) !== 0 ? ANIMATION_IDS.JumpLandRun : animation;
  }
  return next !== undefined && previous?.id !== next.id ? next.start : undefined;
}
