// 11.01: how Wow.exe 3.3.5a 12340 turns a lift's car (`GAMEOBJECT_TYPE_TRANSPORT`) on its path — TransportRotation.dbc
// and GAMEOBJECT_PARENTROTATION. Ghidra, read-only: .runtime/re-2026-10-11/glue-1110/c724-2.txt (0x0070dc10, 0x00711f20),
// .runtime/re-2026-10-04/l16-transport/r5.c (0x007139e0), .runtime/re-2026-11-11/transport/t1.c, t1.lst, t2.c.
//
// Every frame the lift's update (0x007139e0, set up by 0x00711f20) asks 0x007106d0 for the pose at the path time
// (LiftClock.ts `liftPhaseMs`) and gets two answers:
// - the offset (0x0070daa0): TransportAnimation's two keyframes either side of the time, interpolated linearly, then
//   turned by the matrix of GAMEOBJECT_PARENTROTATION (0x004c5100, a row vector times the transpose of the rotation
//   matrix: the quaternion's ordinary active rotation) — not by the spawn's orientation. The position is the spawn
//   point plus that (0x004f4460 over GO+0xe8).
// - the rotation (0x0070dc10): with fewer than two TransportRotation keys the object's own rotation, unchanged (its
//   vt+0x44); otherwise the keys either side of the time slerped (0x00982460) and multiplied by PARENTROTATION
//   (0x004f4320(out, slerp, parent): the Hamilton product slerp ⊗ parent — the listing pushes the parent before the
//   slerp's four arguments). The result is packed into the object's rotation word (0x004f43b0) and is then the
//   rotation the model is drawn with (0x0070c700) and the one its passengers ride in (0x00704cc0).
//
// The key search (0x0070dc10, the same walk as 0x0070daa0's): keys are in the table's order — every entry of the
// dataset has them sorted by time — and the segment is the pair with `key.time <= t < next.time`. After the last key
// the next is the first; when the first key's time is 0 the segment ends at the last TransportAnimation keyframe's time
// (the path's period) instead, but the fraction still divides by `first.time − last.time` taken as an unsigned 32-bit
// number, so the car holds the last key's rotation up to the end of the path (the fraction stays below 1e-5). No
// segment holds a time before the first key when that key is not at 0: Wow.exe would search forever there (two
// entries without TransportAnimation rows, 193459 and 194350); here the own rotation stays.
//
// Pure, and nothing is allocated per call.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { Quat } from "../world/GameObjectRotation.js";
import type { WorldObjectState } from "../world/WorldState.js";

/** One TransportRotation.dbc row: the time into the path and the rotation there, (x, y, z) the axis part. */
export interface TransportRotationKey {
  time: number;
  x: number;
  y: number;
  z: number;
  w: number;
}

const PARENT = UPDATE_FIELDS.GAMEOBJECT_PARENTROTATION.offset;
const FLOAT = new DataView(new ArrayBuffer(4));
/** 0x00982460's threshold below which the two keys count as one ([0xaa2e58] = 2^−21). */
const SLERP_SAME = 2 ** -21;

function fieldFloat(object: Pick<WorldObjectState, "fields">, offset: number): number {
  // A create block leaves out the words that are zero (Object::BuildValuesUpdate), so an absent word is 0.0.
  FLOAT.setUint32(0, (object.fields.get(offset) ?? 0) >>> 0, true);
  const value = FLOAT.getFloat32(0, true);
  return Number.isFinite(value) ? value : 0;
}

/** GAMEOBJECT_PARENTROTATION as the four floats Wow.exe reads at fields + 0x10 (x, y, z, w; `SetParentRotation`). */
export function parentRotation(object: Pick<WorldObjectState, "fields">, out: Quat): Quat {
  out.x = fieldFloat(object, PARENT);
  out.y = fieldFloat(object, PARENT + 1);
  out.z = fieldFloat(object, PARENT + 2);
  out.w = fieldFloat(object, PARENT + 3);
  return out;
}

/**
 * 0x0070daa0's turn of the path offset: `v · M` with M the matrix 0x004c5100 builds from the quaternion as it is (not
 * normalised: an all-zero parent gives the identity). Written into `out`.
 */
export function turnByParent(q: Quat, x: number, y: number, z: number, out: [number, number, number]): [number, number, number] {
  const x2 = q.x * 2, y2 = q.y * 2, z2 = q.z * 2;
  const xx = q.x * x2, yy = q.y * y2, zz = q.z * z2;
  const xy = q.x * y2, xz = q.x * z2, yz = q.y * z2;
  const wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;
  out[0] = x * (1 - (yy + zz)) + y * (xy - wz) + z * (xz + wy);
  out[1] = x * (xy + wz) + y * (1 - (xx + zz)) + z * (yz - wx);
  out[2] = x * (xz - wy) + y * (yz + wx) + z * (1 - (xx + yy));
  return out;
}

/** 0x00982460: slerp from `a` to `b` by `t`, through the shorter arc; `a` itself when the two are (nearly) one. */
export function transportSlerp(a: Quat, b: Quat, t: number, out: Quat): Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let sign = 1;
  if (dot < 0) {
    sign = -1;
    dot = -dot;
  }
  const sin = Math.sqrt(Math.abs(1 - dot * dot));
  if (Math.abs(sin) < SLERP_SAME) {
    out.x = a.x; out.y = a.y; out.z = a.z; out.w = a.w;
    return out;
  }
  const angle = Math.atan2(sin, dot);
  const wa = Math.sin((1 - t) * angle) / sin;
  const wb = sign * Math.sin(t * angle) / sin;
  out.x = a.x * wa + b.x * wb;
  out.y = a.y * wa + b.y * wb;
  out.z = a.z * wa + b.z * wb;
  out.w = a.w * wa + b.w * wb;
  return out;
}

/** 0x004f4320: the Hamilton product `a ⊗ b` into `out` (which may be either operand). */
export function transportMultiply(a: Quat, b: Quat, out: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x; out.y = y; out.z = z; out.w = w;
  return out;
}

const SLERPED: Quat = { x: 0, y: 0, z: 0, w: 1 };
const PARENT_SCRATCH: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The car's rotation at path time `time` (0x0070dc10), written into `out`, or undefined when the keys leave the object's
 * own rotation in place (fewer than two keys, or a time no segment holds). `period` is the last TransportAnimation
 * keyframe's time. The result goes through the rotation word as Wow.exe stores it (0x004f43b0 → 0x00982340): turned to a
 * non-negative w, which is then taken from the axis part again — so an all-zero parent comes back as the identity.
 */
export function transportPathRotation(keys: readonly TransportRotationKey[] | undefined, period: number, time: number,
  parent: Quat, out: Quat): Quat | undefined {
  if (keys === undefined || keys.length < 2) return undefined;
  const t = time >>> 0;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    const next = keys[index + 1 === keys.length ? 0 : index + 1]!;
    const end = next.time !== 0 ? next.time : period;
    if (!(key.time <= t && t < end)) continue;
    // Both differences as Wow.exe converts them: a negative one plus 2^32 (the wrap's `first − last`).
    const span = (next.time - key.time) >>> 0;
    const fraction = span === 0 ? 0 : ((t - key.time) >>> 0) / span;
    transportSlerp(key, next, fraction, SLERPED);
    transportMultiply(SLERPED, parent, out);
    if (out.w < 0) {
      out.x = -out.x; out.y = -out.y; out.z = -out.z; out.w = -out.w;
    }
    out.w = Math.sqrt(Math.max(0, 1 - out.x * out.x - out.y * out.y - out.z * out.z));
    return out;
  }
  return undefined;
}

/** {@link transportPathRotation} with the object's own PARENTROTATION. */
export function liftPathRotation(object: Pick<WorldObjectState, "fields">, keys: readonly TransportRotationKey[] | undefined,
  period: number, time: number, out: Quat): Quat | undefined {
  if (keys === undefined || keys.length < 2) return undefined;
  return transportPathRotation(keys, period, time, parentRotation(object, PARENT_SCRATCH), out);
}

/**
 * The heading of a rotation: where it points the object's +x, about z. The colliders and the passengers' frame are
 * yaw-only here (game/TransportCollision.ts, WorldState's carrier composition), so a rotated car gives them this; it is
 * the whole rotation for every key of the dataset with a TransportAnimation path but 194301 and 194303, which tilt.
 */
export function rotationHeading(q: Quat): number {
  return Math.atan2(2 * (q.x * q.y + q.w * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}
