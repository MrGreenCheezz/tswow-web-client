import type { Quat } from "./GameObjectRotation.js";
import type { WorldPosition } from "./WorldState.js";

/**
 * 11.01 (15.11): a carrier whose whole rotation is more than a heading — a lift car turned by its TransportRotation.dbc keys
 * (browser/TransportRotation.ts, 0x0070dc10). Wow.exe packs that rotation into the object's rotation word, draws the model
 * with it (0x0070c700) and composes each passenger's matrix as its offset times the carrier's (0x00704cc0 → carrier
 * vt+0xc4): the offset is turned by the whole rotation, not by its heading alone. In the dataset only 194301 and 194303
 * tilt (they turn about their y axis through a full circle on the way up); every other key set is a heading.
 *
 * A pose that carries it is the lift's (browser/LiftClock.ts `LiftPose`): `rotated` and `rotation`, the rotation in WoW
 * axes, `orientation` its heading. Every other pose is composed by heading alone, as before. Pure; nothing allocated.
 */
export interface RotatedCarrier {
  readonly rotated?: boolean;
  readonly rotation?: Quat;
}

/** The pose's whole rotation when it has one beyond its heading's say; undefined otherwise. */
export function carrierRotation(pose: WorldPosition): Quat | undefined {
  const rotated = pose as WorldPosition & RotatedCarrier;
  return rotated.rotated === true && rotated.rotation !== undefined ? rotated.rotation : undefined;
}

/** `q · v · q*` (the quaternion's active rotation, as 0x004c5100's matrix applies it) into `out`. */
export function rotateByQuat(q: Quat, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
}

/** `q* · v · q`: the inverse turn, for a unit quaternion. */
export function rotateByQuatInverse(q: Quat, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const inverse = INVERSE;
  inverse.x = -q.x; inverse.y = -q.y; inverse.z = -q.z; inverse.w = q.w;
  rotateByQuat(inverse, x, y, z, out);
}

const INVERSE: Quat = { x: 0, y: 0, z: 0, w: 1 };
const FORWARD = { x: 0, y: 0, z: 0 };

/** The heading of the passenger's +x turned by `q` after its own facing `local` on the carrier. */
export function facingOnRotated(q: Quat, local: number): number {
  rotateByQuat(q, Math.cos(local), Math.sin(local), 0, FORWARD);
  return Math.atan2(FORWARD.y, FORWARD.x);
}

/** The facing on the carrier whose heading in the world is `world` (the inverse of `facingOnRotated` on level ground). */
export function facingOffRotated(q: Quat, world: number): number {
  rotateByQuatInverse(q, Math.cos(world), Math.sin(world), 0, FORWARD);
  return Math.atan2(FORWARD.y, FORWARD.x);
}

const TURNED = { x: 0, y: 0, z: 0 };

/** `pose + q · local`, facing `facingOnRotated`, into `out` (which may be `local`). */
export function composeOnRotated(pose: WorldPosition, q: Quat, local: { x: number; y: number; z: number; orientation: number },
  out: WorldPosition): WorldPosition {
  rotateByQuat(q, local.x, local.y, local.z, TURNED);
  const orientation = facingOnRotated(q, local.orientation);
  out.x = pose.x + TURNED.x;
  out.y = pose.y + TURNED.y;
  out.z = pose.z + TURNED.z;
  out.orientation = orientation;
  return out;
}

/** `q* · (world − pose)`, facing `facingOffRotated`, into `out`. */
export function offsetOnRotated(pose: WorldPosition, q: Quat, world: WorldPosition,
  out: { x: number; y: number; z: number; orientation: number }): void {
  rotateByQuatInverse(q, world.x - pose.x, world.y - pose.y, world.z - pose.z, TURNED);
  out.orientation = facingOffRotated(q, world.orientation);
  out.x = TURNED.x;
  out.y = TURNED.y;
  out.z = TURNED.z;
}
