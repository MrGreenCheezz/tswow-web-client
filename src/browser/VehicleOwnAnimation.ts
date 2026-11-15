import * as THREE from "three";
import { animationBlend, clipBlendTime } from "./AnimatedModel.js";
import type { VehicleSeatEntry } from "../world/VehicleDbc.js";
import { seatVehicleExitBit } from "./VehicleExitBit.js";

/**
 * 11.02 (04.11): what the vehicle itself plays as a passenger takes, rides or leaves a seat — VehicleEnterAnim,
 * VehicleRideAnimLoop and VehicleExitAnim, each on a key bone (a drake's claw closing on its load, a giant's arm throwing it).
 * 94 of the dataset's 720 seats name one. Read from Wow.exe 3.3.5a 12340:
 *
 * - 0x0074be80 (in 0x0074be10): boarding with Flags 0x400000 plays VehicleEnterAnim, leaving with Flags 0x80000 (0x40000
 *   when the passenger's movement flags2 has 0x40 — one bit or the other, `seatVehicleExitBit`, 11.11) plays
 *   VehicleExitAnim. Both are on the root of the seat chain (0x00757000), at most 0x1f9.
 * - 0x007489c0: on reaching the seat (state 3), Flags 0x20000 plays VehicleRideAnimLoop; its end callback 0x00747980
 *   replays it. Leaving the seat stops it (0x007577e0).
 * - 0x00756f80: the column's bone is a key bone, from 0x23 on (and −1, read unsigned) the root 0x1a, and the root means the
 *   whole model.
 * - 0x00748070: with the animation playing the passenger waits. Flags 0x8000000 (out: 0x10000000) waits the column
 *   VehicleEnterAnimDelay (out: VehicleExitAnimDelay) in seconds, at most 3; otherwise until the animation's end callback
 *   0x00749d50, or 3 seconds. The pre-delay of VehicleSeatTransition.ts runs after that.
 *
 * Three's mixer averages actions by weight, so an own animation is given a weight that all but owns the tracks it keys: the
 * base and the overlay go on under it untouched, and every other bone keeps them. Not modelled: 0x00724500's narrowing of the
 * vehicle's own choice of pose — read 11.11 (0x00756f40): it is not tied to these animations but to Vehicle Flags 0x10000
 * (12 rows) with the unit's +0xa38 bit 0x400 or +0xfa4 ≠ −1, and then only 0x00724330's movement choice runs.
 * 11.11 (.runtime/re-2026-11-11/vehicle2): +0xa38 0x400 is cleared by 0x0072ed80 when the cast visual of the unit's
 * cast bar (+0xa60 spell, +0xa5c count) ends, and +0xa60/+0xa5c are set by 0x00715a80 — but 0x00715a80 does not set the
 * bit, and its setter and +0xfa4 are still unread; 0x00756f40 is also called from 0x00723e30.
 * 15.11 (.runtime/re-2026-11-15/vehicle5/b1-scan.txt, b2.c, b2-refs.txt): the bit's one setter is 0x00715af0 (a bool
 * setter, set and clear), called only from 0x007fa2e0, which is not read; +0xfa4 is written by the spell visual kit's
 * play (0x0073b140: a kit played with flag 0x80 keeps its animation id there) and set back to −1 when that animation
 * ends (0x0073bbd0) or the unit is reset (0x0073e410). So the narrowing holds while such a kit's animation, or whatever
 * 0x007fa2e0 marks, plays on a Vehicle Flags 0x10000 vehicle; then only 0x00724330 (the cast pose) chooses. Not modelled.
 * 15.11 (vehicle8, .runtime/re-2026-11-15/vehicle8/b1.c, b2.c): 0x007fa2e0 is the cast's visual start (called twice from
 * 0x00805330): the spell's SpellVisual (vtable +0xbc) names a PrecastKit (row +4) whose StartAnimID or AnimID (+4, +8) is
 * above 0 → 0x00715af0(1), and the kit plays (0x00745230). So +0xa38 0x400 is "a precast animation is on", cleared when the
 * cast visual ends (0x0072ed80, 11.11). 0x00724500, the base-animation chooser, runs 0x00724060, 0x00716fd0 and a seated
 * passenger's 0x00748560 first; then, for a unit whose own vehicle (+0xf5c) has Flags 0x10000 while either mark holds, it
 * returns 0x00724330's answer alone — 0x1fa (no change) when that has none — skipping every movement, stand-state and
 * stance rung. The rule: such a vehicle keeps its precast or flag-0x80 kit animation while it moves. Twelve Vehicle rows;
 * not wired, because this client's pose choice is not 0x00724500's chain (WorldRenderer3D `#animateUnit`).
 */

/** Seat Flags these rules read. */
export const SEAT_VEHICLE_ANIM_FLAGS = Object.freeze({
  EXIT_FORCED: 0x0004_0000,
  EXIT_VOLUNTARY: 0x0008_0000,
  RIDE: 0x0002_0000,
  ENTER: 0x0040_0000,
  WAIT_DELAY_ENTER: 0x0800_0000,
  WAIT_DELAY_EXIT: 0x1000_0000,
});

export type SeatVehicleAnimationKind = "enter" | "ride" | "exit";

/** The root key bone: the whole model. */
const KEY_BONE_ROOT = 0x1a;
const KEY_BONE_COUNT = 0x23;
const NO_ANIMATION = 0x1fa;
/** 0x00748070: what the passenger waits at most. */
export const SEAT_VEHICLE_WAIT_SECONDS = 3;

export interface SeatVehicleAnimation {
  readonly animation: number;
  /** The key bone; undefined for the whole model. */
  readonly keyBone: number | undefined;
}

type SeatColumns = Pick<VehicleSeatEntry, "flags" | "vehicleEnterAnim" | "vehicleExitAnim" | "vehicleRideAnimLoop"
  | "vehicleEnterAnimBone" | "vehicleExitAnimBone" | "vehicleRideAnimLoopBone" | "vehicleEnterAnimDelay" | "vehicleExitAnimDelay">;

/**
 * What the vehicle plays for this seat and this moment, or undefined. `flags2`: the passenger's, for the exit's bit
 * (11.11, VehicleExitBit.ts: 0x80000 on this realm, 0x40000 only with flags2 0x40 — no longer either).
 */
export function seatVehicleAnimation(seat: SeatColumns, kind: SeatVehicleAnimationKind, flags2 = 0): SeatVehicleAnimation | undefined {
  const F = SEAT_VEHICLE_ANIM_FLAGS;
  const allowed = kind === "enter" ? F.ENTER : kind === "ride" ? F.RIDE : seatVehicleExitBit(flags2);
  if ((seat.flags & allowed) === 0) return undefined;
  const animation = kind === "enter" ? seat.vehicleEnterAnim : kind === "ride" ? seat.vehicleRideAnimLoop : seat.vehicleExitAnim;
  if (!Number.isInteger(animation) || animation < 0 || animation >= NO_ANIMATION) return undefined;
  const bone = kind === "enter" ? seat.vehicleEnterAnimBone : kind === "ride" ? seat.vehicleRideAnimLoopBone : seat.vehicleExitAnimBone;
  const keyBone = bone >= 0 && bone < KEY_BONE_COUNT && bone !== KEY_BONE_ROOT ? bone : undefined;
  return { animation, keyBone };
}

/**
 * How the passenger waits for it (0x00748070): seconds fixed by the column, or undefined to wait for the animation's end,
 * which {@link SEAT_VEHICLE_WAIT_SECONDS} caps.
 */
export function seatVehicleWaitSeconds(seat: SeatColumns, kind: "enter" | "exit"): number | undefined {
  const F = SEAT_VEHICLE_ANIM_FLAGS;
  if ((seat.flags & (kind === "enter" ? F.WAIT_DELAY_ENTER : F.WAIT_DELAY_EXIT)) === 0) return undefined;
  const seconds = kind === "enter" ? seat.vehicleEnterAnimDelay : seat.vehicleExitAnimDelay;
  return Number.isFinite(seconds) ? Math.min(SEAT_VEHICLE_WAIT_SECONDS, Math.max(0, seconds)) : 0;
}

const subtrees = new WeakMap<THREE.AnimationClip, Map<number, THREE.AnimationClip>>();

/** The clip on one bone and everything under it (0x00832ab0 on a key bone). Kept per clip and bone. */
export function boneSubtreeClip(clip: THREE.AnimationClip, parents: ArrayLike<number>, bone: number): THREE.AnimationClip {
  let byBone = subtrees.get(clip);
  if (byBone === undefined) subtrees.set(clip, byBone = new Map());
  const known = byBone.get(bone);
  if (known !== undefined) return known;
  const inside = new Uint8Array(parents.length);
  // A parent always comes before its children in an M2's bone list.
  for (let index = 0; index < parents.length; index++) {
    inside[index] = index === bone || (parents[index]! >= 0 && inside[parents[index]!] === 1) ? 1 : 0;
  }
  const tracks = clip.tracks.filter((track) => {
    const match = /^bone(\d+)\./.exec(track.name);
    return match !== null && inside[Number(match[1])] === 1;
  });
  const cut = new THREE.AnimationClip(`${clip.name}-bone${bone}`, clip.duration, tracks);
  cut.userData = { ...clip.userData };
  byBone.set(bone, cut);
  return cut;
}

/** What it takes of a vehicle's model to play on it. */
export interface VehicleOwnModel {
  readonly mixer: THREE.AnimationMixer;
  readonly parents: ArrayLike<number>;
  /** The M2 key bone table; absent on an older model, which then plays only on the whole body. */
  readonly keyBones: ArrayLike<number> | undefined;
}

/** A clip, nothing yet ("wait": it may still come), or none on this model. */
export type VehicleOwnClip = THREE.AnimationClip | "wait" | undefined;

interface OwnPlay {
  readonly kind: SeatVehicleAnimationKind;
  readonly passenger: bigint;
  /**
   * 15.11 (vehicle8): a FlagsB 0x10000 passenger's copy of its vehicle's key-bone play (0x00735a60, VehicleAnimationCopy.ts
   * `keyBoneCopyPassengers`): the vehicle it copies. A copy holds no passenger back (no `ended`) and ends with the vehicle's.
   */
  readonly copyOf: bigint | undefined;
  readonly animation: SeatVehicleAnimation;
  readonly askedAt: number;
  action: THREE.AnimationAction | undefined;
  blendMs: number;
  startedAt: number;
  /** One-shot: when it has played out. */
  endsAt: number;
  /** The fade out's start, once it was told to stop or has played out. */
  stoppedAt: number | undefined;
}

/** What an own animation weighs at full strength: it takes 99.9 % of a track the base also keys. */
const OWN_FULL_WEIGHT = 1000;

/** The weight that gives the action this share of a track against a base of weight 1. */
function shareWeight(share: number): number {
  return share >= 1 ? OWN_FULL_WEIGHT : Math.min(OWN_FULL_WEIGHT, share / (1 - share));
}

/** The measured blend curve (AnimationBlend.ts). */
function blendShare(elapsedMs: number, blendMs: number): number {
  if (blendMs <= 0 || elapsedMs >= blendMs) return 1;
  const x = Math.max(0, elapsedMs) / blendMs;
  return x * x * (3 - 2 * x);
}

/** The renderer's own animations in flight, by the guid of the vehicle that plays them. */
export class VehicleOwnAnimations {
  readonly #byVehicle = new Map<bigint, OwnPlay[]>();

  get size(): number {
    return this.#byVehicle.size;
  }

  has(vehicle: bigint): boolean {
    return this.#byVehicle.size > 0 && this.#byVehicle.has(vehicle);
  }

  /**
   * A seat's moment on `vehicle`: what plays comes on the vehicle's next `step`. `copyOf`: this is `vehicle`'s (a copying
   * passenger's) copy of that vehicle's play on the same key bone (0x00735a60).
   */
  play(vehicle: bigint, passenger: bigint, kind: SeatVehicleAnimationKind, animation: SeatVehicleAnimation, now: number,
    copyOf?: bigint): void {
    let plays = this.#byVehicle.get(vehicle);
    if (plays === undefined) this.#byVehicle.set(vehicle, plays = []);
    plays.push({ kind, passenger, copyOf, animation, askedAt: now, action: undefined, blendMs: 0, startedAt: now, endsAt: 0, stoppedAt: undefined });
  }

  /** 0x007577e0: the passenger left the seat, its ride animation ends — and the copies of it (15.11, vehicle8). */
  stopRide(vehicle: bigint, passenger: bigint, now: number): void {
    for (const [key, plays] of this.#byVehicle) {
      if (key !== vehicle && !plays.some((play) => play.copyOf === vehicle)) continue;
      for (const play of plays) {
        if (play.kind === "ride" && play.passenger === passenger && play.stoppedAt === undefined
          && (key === vehicle ? play.copyOf === undefined : play.copyOf === vehicle)) play.stoppedAt = now;
      }
    }
  }

  /** Drops what no drawn vehicle can play any more, and ends the ride of a passenger gone from view. */
  sweep(drawn: (guid: bigint) => boolean, now: number): void {
    for (const [vehicle, plays] of this.#byVehicle) {
      if (!drawn(vehicle)) {
        this.#byVehicle.delete(vehicle);
        continue;
      }
      for (const play of plays) {
        if (play.stoppedAt !== undefined) continue;
        if (play.kind === "ride" && !drawn(play.passenger)) play.stoppedAt = now;
        else if (play.copyOf !== undefined && !drawn(play.copyOf)) play.stoppedAt = now; // 15.11 (vehicle8)
      }
    }
  }

  clear(): void {
    this.#byVehicle.clear();
  }

  /**
   * One frame of `vehicle`'s animations. `clipOf` answers an animation on this model, asking for it if need be; `ended`
   * hears that a passenger's enter or exit animation is over or will not play (0x00749d50).
   */
  step(vehicle: bigint, model: VehicleOwnModel, now: number, clipOf: (animation: number) => VehicleOwnClip,
    ended: (passenger: bigint) => void): void {
    const plays = this.#byVehicle.get(vehicle);
    if (plays === undefined) return;
    for (let index = plays.length - 1; index >= 0; index--) {
      const play = plays[index]!;
      if (play.action === undefined && !this.#start(play, model, now, clipOf)) {
        if (now - play.askedAt < SEAT_VEHICLE_WAIT_SECONDS * 1000 && play.stoppedAt === undefined && clipOf(play.animation.animation) === "wait") continue;
        plays.splice(index, 1);
        if (play.kind !== "ride" && play.copyOf === undefined) ended(play.passenger);
        continue;
      }
      if (play.kind !== "ride" && play.stoppedAt === undefined && now >= play.endsAt) {
        play.stoppedAt = now;
        if (play.copyOf === undefined) ended(play.passenger);
      }
      if (play.stoppedAt !== undefined && now - play.stoppedAt >= play.blendMs) {
        play.action!.stop();
        plays.splice(index, 1);
      }
    }
    // The same bone answers to the latest: a ride loop gives way while a one-shot plays over it.
    for (const play of plays) {
      if (play.action === undefined) continue;
      const covered = play.kind === "ride" && plays.some((other) => other.kind !== "ride" && other.action !== undefined
        && other.animation.keyBone === play.animation.keyBone);
      const share = covered ? 0 : blendShare(now - play.startedAt, play.blendMs)
        * (play.stoppedAt === undefined ? 1 : 1 - blendShare(now - play.stoppedAt, play.blendMs));
      play.action.setEffectiveWeight(shareWeight(share));
    }
    if (plays.length === 0) this.#byVehicle.delete(vehicle);
  }

  #start(play: OwnPlay, model: VehicleOwnModel, now: number, clipOf: (animation: number) => VehicleOwnClip): boolean {
    const clip = clipOf(play.animation.animation);
    if (clip === undefined || clip === "wait") return false;
    const { keyBone } = play.animation;
    let cut = clip;
    if (keyBone !== undefined) {
      const bone = model.keyBones?.[keyBone];
      if (bone === undefined || bone < 0) return false;
      cut = boneSubtreeClip(clip, model.parents, bone);
    }
    if (cut.tracks.length === 0) return false;
    const action = model.mixer.clipAction(cut);
    action.reset();
    action.setEffectiveTimeScale(1);
    const loop = play.kind === "ride";
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.setEffectiveWeight(0);
    action.play();
    play.action = action;
    play.blendMs = animationBlend(clipBlendTime(cut)) * 1000;
    play.startedAt = now;
    play.endsAt = now + cut.duration * 1000;
    return true;
  }
}
