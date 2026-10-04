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
//   This client has one persistent layer: the whole body takes the legs' pair when it has a loop
//   (sitting is what shows), else the RideUpper pair; the upper/lower split itself is not drawn.
// - −1 (and anything at or past the AnimationData row count 0x1fa) is no animation.
// - Entering (states 1/2: HAS_LOWER_ANIM_FOR_ENTER 0x1 → EnterAnimStart/Loop) and leaving (4/5:
//   ExitAnimStart/Loop, ExitAnimEnd on landing — JumpEnd turned JumpLandRun when moving) are not
//   seen by this client, which has a passenger seated or not.
//
// HIDE_PASSENGER 0x200: 0x007489c0 sets passenger+0x10 bit 0x400 on entering state 3 (kept on a
// seat switch inside the same root vehicle); 0x00730f30 then gives the unit no model.

import type { VehicleSeatEntry } from "../world/VehicleDbc.js";
import { VEHICLE_SEAT_FLAGS } from "../world/VehicleSeatModel.js";

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
}

const seatPoses = new WeakMap<VehicleSeatEntry, VehiclePassengerSeatPose>();

/**
 * The seat's whole-body pose for this client's single layer: the legs' pair when it has a loop,
 * else the upper pair; its start only when it is a different clip. Cached per seat row.
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
  });
  seatPoses.set(seat, pose);
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
 * apply); otherwise the seat's start on taking it — a seat switch is a new seat — and nothing else:
 * the vehicle does any jumping, and leaving is not seen.
 */
export function vehicleSeatTransition(previous: VehiclePassengerSeatPose | undefined,
  next: VehiclePassengerSeatPose | undefined): number | undefined | false {
  if (previous === undefined && next === undefined) return false;
  return next !== undefined && previous?.id !== next.id ? next.start : undefined;
}
