import * as THREE from "three";
import { animationBlend, clipBlendTime } from "./AnimatedModel.js";
import type { VehicleSeatEntry } from "../world/VehicleDbc.js";

/**
 * 11.02 (04.11): what the vehicle itself plays as a passenger takes, rides or leaves a seat — VehicleEnterAnim,
 * VehicleRideAnimLoop and VehicleExitAnim, each on a key bone (a drake's claw closing on its load, a giant's arm throwing it).
 * 94 of the dataset's 720 seats name one. Read from Wow.exe 3.3.5a 12340:
 *
 * - 0x0074be80: boarding with Flags 0x400000 plays VehicleEnterAnim, leaving with Flags 0x80000 (0x40000 when the unit's
 *   movement flags2 has 0x40) plays VehicleExitAnim. Both are on the root of the seat chain (0x00757000), at most 0x1f9.
 * - 0x007489c0: on reaching the seat (state 3), Flags 0x20000 plays VehicleRideAnimLoop; its end callback 0x00747980
 *   replays it. Leaving the seat stops it (0x007577e0).
 * - 0x00756f80: the column's bone is a key bone, from 0x23 on (and −1, read unsigned) the root 0x1a, and the root means the
 *   whole model.
 * - 0x00748070: with the animation playing the passenger waits. Flags 0x8000000 (out: 0x10000000) waits the column
 *   VehicleEnterAnimDelay (out: VehicleExitAnimDelay) in seconds, at most 3; otherwise until the animation's end callback
 *   0x00749d50, or 3 seconds. The pre-delay of VehicleSeatTransition.ts runs after that.
 *
 * Three's mixer averages actions by weight, so an own animation is given a weight that all but owns the tracks it keys: the
 * base and the overlay go on under it untouched, and every other bone keeps them. Not modelled: the exit's forced bit (either
 * bit plays, as the arcs do) and 0x00724500 narrowing the vehicle's own choice of pose while one plays.
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

/** What the vehicle plays for this seat and this moment, or undefined. */
export function seatVehicleAnimation(seat: SeatColumns, kind: SeatVehicleAnimationKind): SeatVehicleAnimation | undefined {
  const F = SEAT_VEHICLE_ANIM_FLAGS;
  const allowed = kind === "enter" ? F.ENTER : kind === "ride" ? F.RIDE : F.EXIT_VOLUNTARY | F.EXIT_FORCED;
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

  /** A seat's moment on `vehicle`: what plays comes on the vehicle's next `step`. */
  play(vehicle: bigint, passenger: bigint, kind: SeatVehicleAnimationKind, animation: SeatVehicleAnimation, now: number): void {
    let plays = this.#byVehicle.get(vehicle);
    if (plays === undefined) this.#byVehicle.set(vehicle, plays = []);
    plays.push({ kind, passenger, animation, askedAt: now, action: undefined, blendMs: 0, startedAt: now, endsAt: 0, stoppedAt: undefined });
  }

  /** 0x007577e0: the passenger left the seat, its ride animation ends. */
  stopRide(vehicle: bigint, passenger: bigint, now: number): void {
    for (const play of this.#byVehicle.get(vehicle) ?? []) {
      if (play.kind === "ride" && play.passenger === passenger && play.stoppedAt === undefined) play.stoppedAt = now;
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
        if (play.kind === "ride" && play.stoppedAt === undefined && !drawn(play.passenger)) play.stoppedAt = now;
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
        if (play.kind !== "ride") ended(play.passenger);
        continue;
      }
      if (play.kind !== "ride" && play.stoppedAt === undefined && now >= play.endsAt) {
        play.stoppedAt = now;
        ended(play.passenger);
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
