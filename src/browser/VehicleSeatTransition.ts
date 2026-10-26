import * as THREE from "three";
import type { VehicleSeatEntry } from "../world/VehicleDbc.js";

/**
 * 11.02 (26.10): a passenger's way into and out of its seat — Wow.exe 3.3.5a's VehiclePassenger_C transition states,
 * which this client used to skip (a unit was seated or not, so it jumped into the seat and back out). 564 of the
 * dataset's 720 seats arc on the way in.
 *
 * Read from the reference (wowdecomp, cited by address):
 * - 0x00749aa0 BeginTransition: boarding arcs when the seat has Flags 0x1 and EnterSpeed > 0 (state 1 while
 *   EnterPreDelay runs, else straight to 2); leaving arcs when the seat has Flags 0x8 (a voluntary exit; 0x8000 a
 *   forced one, 0x0074bb60 tells them apart by movement flags2 0x40) and ExitSpeed > 0 (state 4 while ExitPreDelay
 *   runs, else 5). A seat switch boards the new seat from where the passenger is.
 * - 0x0074a200 ComputeEndValues: the pre-delay lasts its column (at most 10 s). The motion lasts the distance over
 *   EnterSpeed less the vehicle's speed toward the seat (ExitSpeed on the way out), held to Min…MaxDuration (a
 *   MaxDuration of 0 is 1.5 s, at most 10); a gravity of 0 with a positive minimum (or negative maximum) arc is 0.1;
 *   the arc is scaled so its top, gravity × T² / 8, lands inside Min…MaxArcHeight.
 * - 0x00747d70 UpdateBlend: progress over the motion, eased by the seat's Flags — 0x20/0x40 (in; 0x80/0x100 out):
 *   both a half cosine, the first alone t², the second alone 1 − (1 − t)².
 * - 0x0074a7f0 UpdateModel: in motion the model is upright at start + (end − start) × blend, raised by
 *   gravity × e × (T − e) / 2 × scale (e = blend × T), the end being the seat point recomputed every frame (the own
 *   place on the way out); the facing goes from the start facing to the unit's by the same blend (0x00747a30).
 *   During a pre-delay the model holds where the transition began.
 *
 * Not ported (review): the vehicle's speed toward the seat (the duration uses EnterSpeed alone); the forced/voluntary
 * split of the exit flags (either bit arcs); the enter/exit animations (EnterAnimStart/Loop, ExitAnim*), the
 * vehicle's own enter/exit animations on a bone, and the exit pre-delay holding the passenger on the moving seat
 * (it holds where the seat was). A jump of more than {@link SEAT_TRANSITION_MAX_YARDS} is a teleport, not a boarding.
 */

/** Seat Flags bits read here (0x00749aa0, 0x00747d70). */
export const SEAT_TRANSITION_FLAGS = Object.freeze({
  ENTER: 0x0000_0001,
  EXIT_VOLUNTARY: 0x0000_0008,
  ENTER_EASE_IN: 0x0000_0020,
  ENTER_EASE_OUT: 0x0000_0040,
  EXIT_EASE_IN: 0x0000_0080,
  EXIT_EASE_OUT: 0x0000_0100,
  EXIT_FORCED: 0x0000_8000,
});

/** A start further than this from the seat is a teleport or a first sight, never an arc. */
export const SEAT_TRANSITION_MAX_YARDS = 60;
const SOME = 0.0001;

export type SeatTransitionKind = "enter" | "exit";

/** The motion's numbers, fixed when it starts (0x0074a200). */
export interface SeatTransitionMotion {
  /** Seconds. */
  readonly total: number;
  readonly gravity: number;
  readonly arcScale: number;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Whether this seat arcs a passenger in (`enter`) or out (`exit`) (0x00749aa0). */
export function seatTransitionArcs(seat: VehicleSeatEntry, kind: SeatTransitionKind): boolean {
  const F = SEAT_TRANSITION_FLAGS;
  if (kind === "enter") return (seat.flags & F.ENTER) !== 0 && finite(seat.enterSpeed) > SOME;
  return (seat.flags & (F.EXIT_VOLUNTARY | F.EXIT_FORCED)) !== 0 && finite(seat.exitSpeed) > SOME;
}

/** The pre-delay in seconds (0x0074a200 states 1 and 4: the column, at most 10). */
export function seatTransitionDelay(seat: VehicleSeatEntry, kind: SeatTransitionKind): number {
  const delay = finite(kind === "enter" ? seat.enterPreDelay : seat.exitPreDelay);
  return delay <= SOME ? 0 : Math.min(delay, 10);
}

/** The motion over `distance` yards (0x0074a200 states 2 and 5). */
export function seatTransitionMotion(seat: VehicleSeatEntry, kind: SeatTransitionKind, distance: number): SeatTransitionMotion {
  const enter = kind === "enter";
  let gravity = finite(enter ? seat.enterGravity : seat.exitGravity);
  const minDuration = finite(enter ? seat.enterMinDuration : seat.exitMinDuration);
  let maxDuration = finite(enter ? seat.enterMaxDuration : seat.exitMaxDuration);
  const minArc = finite(enter ? seat.enterMinArcHeight : seat.exitMinArcHeight);
  const maxArc = finite(enter ? seat.enterMaxArcHeight : seat.exitMaxArcHeight);
  if (maxDuration < SOME) maxDuration = 1.5;
  else if (maxDuration > 10) maxDuration = 10;
  const speed = finite(enter ? seat.enterSpeed : seat.exitSpeed);
  let total: number;
  if (distance <= SOME) total = 0;
  else if (speed <= SOME) total = maxDuration;
  else total = Math.min(maxDuration, Math.max(minDuration, distance / speed));
  if (Math.abs(gravity) < SOME && (minArc > 0 || maxArc < 0)) gravity = 0.1;
  let arcScale = 1;
  if (total > SOME) {
    const height = gravity * total * total * 0.125;
    if (height < minArc) arcScale = minArc / height;
    else if (maxArc < height) arcScale = maxArc / height;
  }
  if (!Number.isFinite(arcScale)) arcScale = 1;
  return { total, gravity, arcScale };
}

/** The motion's progress 0…1 at `elapsed` seconds, eased by the seat's flags (0x00747d70). */
export function seatTransitionBlend(seat: VehicleSeatEntry, kind: SeatTransitionKind, elapsed: number, total: number): number {
  if (total < SOME) return 1;
  const t = Math.min(1, Math.max(0, elapsed / total));
  const F = SEAT_TRANSITION_FLAGS;
  const easeIn = (seat.flags & (kind === "enter" ? F.ENTER_EASE_IN : F.EXIT_EASE_IN)) !== 0;
  const easeOut = (seat.flags & (kind === "enter" ? F.ENTER_EASE_OUT : F.EXIT_EASE_OUT)) !== 0;
  if (easeIn && easeOut) return 0.5 - Math.cos(t * Math.PI) * 0.5;
  if (easeIn) return t * t;
  if (easeOut) return 1 - (1 - t) * (1 - t);
  return t;
}

/** The arc's rise at progress `blend` (0x0074a7f0). */
export function seatTransitionArc(motion: SeatTransitionMotion, blend: number): number {
  if (Math.abs(motion.gravity) <= SOME) return 0;
  const elapsed = blend * motion.total;
  const half = motion.gravity * elapsed * 0.5;
  return (motion.total * half - elapsed * half) * motion.arcScale;
}

interface Transition {
  kind: SeatTransitionKind;
  seat: VehicleSeatEntry;
  fromX: number;
  fromY: number;
  fromZ: number;
  fromYaw: number;
  /** When the motion starts (ms): the pre-delay's end. */
  motionAt: number;
  motion: SeatTransitionMotion | undefined;
}

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/** A node's heading about the scene's up axis. */
function yawOf(quaternion: THREE.Quaternion): number {
  return _euler.setFromQuaternion(quaternion, "YXZ").y;
}

/**
 * The renderer's transitions in flight, by unit guid. `begin` when a drawn unit's seat changes (before its node is
 * moved to this frame's place: that is where it starts); `apply` once the seat placement has put every node where
 * it belongs this frame, which is the transition's end.
 */
export class VehicleSeatTransitions {
  readonly #active = new Map<bigint, Transition>();

  get size(): number {
    return this.#active.size;
  }

  /**
   * A drawn unit's seat changed: from `before` (undefined: on foot) to `after` (undefined: leaving). `node` is still
   * where it was drawn last frame. Starts the transition the seat calls for, or forgets one in flight.
   */
  begin(guid: bigint, before: VehicleSeatEntry | undefined, after: VehicleSeatEntry | undefined,
    node: THREE.Object3D, now: number): void {
    this.#active.delete(guid);
    const kind: SeatTransitionKind = after !== undefined ? "enter" : "exit";
    const seat = after ?? before;
    if (seat === undefined || !seatTransitionArcs(seat, kind)) return;
    const at = node.position;
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) return;
    this.#active.set(guid, {
      kind, seat, fromX: at.x, fromY: at.y, fromZ: at.z, fromYaw: yawOf(node.quaternion),
      motionAt: now + seatTransitionDelay(seat, kind) * 1000, motion: undefined,
    });
  }

  /** The seat and the direction a unit is moving in, or undefined (VehicleSeatPose.ts `vehicleSeatTransitionPose`). */
  transitionOf(guid: bigint): { readonly seat: VehicleSeatEntry; readonly kind: SeatTransitionKind } | undefined {
    return this.#active.size > 0 ? this.#active.get(guid) : undefined;
  }

  /** Forgets a unit (gone from view, cleared world). */
  forget(guid: bigint): void {
    this.#active.delete(guid);
  }

  clear(): void {
    this.#active.clear();
  }

  /**
   * Every transition onto its node: `nodeOf` answers the unit's node as placed this frame (undefined: not drawn,
   * which ends it). A finished transition leaves the node where the frame put it.
   */
  apply(nodeOf: (guid: bigint) => THREE.Object3D | undefined, now: number): void {
    if (this.#active.size === 0) return;
    for (const [guid, transition] of this.#active) {
      const node = nodeOf(guid);
      if (node === undefined || !this.#applyOne(transition, node, now)) this.#active.delete(guid);
    }
  }

  /** False once the transition is over. */
  #applyOne(transition: Transition, node: THREE.Object3D, now: number): boolean {
    const at = node.position;
    if (now < transition.motionAt) {
      at.set(transition.fromX, transition.fromY, transition.fromZ);
      node.quaternion.setFromAxisAngle(AXIS_Y, transition.fromYaw);
      return true;
    }
    const dx = at.x - transition.fromX;
    const dy = at.y - transition.fromY;
    const dz = at.z - transition.fromZ;
    if (transition.motion === undefined) {
      const distance = Math.hypot(dx, dy, dz);
      if (distance > SEAT_TRANSITION_MAX_YARDS) return false;
      transition.motion = seatTransitionMotion(transition.seat, transition.kind, distance);
    }
    const motion = transition.motion;
    const elapsed = (now - transition.motionAt) / 1000;
    if (elapsed >= motion.total) return false;
    const blend = seatTransitionBlend(transition.seat, transition.kind, elapsed, motion.total);
    // The end is where the frame put the node: the seat point (or the own place on the way out).
    let target = yawOf(node.quaternion);
    while (target + Math.PI < transition.fromYaw) target += Math.PI * 2;
    while (target - Math.PI > transition.fromYaw) target -= Math.PI * 2;
    at.set(transition.fromX + dx * blend, transition.fromY + dy * blend + seatTransitionArc(motion, blend), transition.fromZ + dz * blend);
    node.quaternion.setFromAxisAngle(AXIS_Y, transition.fromYaw + (target - transition.fromYaw) * blend);
    return true;
  }
}
