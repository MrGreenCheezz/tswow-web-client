import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * A game object's full rotation (5.27, docs/implementation/line-A4.ru.md).
 *
 * The create block of every game object ends in `UPDATEFLAG_ROTATION`: 64 bits holding the spawn's
 * local rotation quaternion (`GameObject::UpdatePackedRotation`, GameObject.cpp:2451-2464; written
 * by `Object::BuildMovementUpdate`, Object.cpp:471-472). Wow.exe keeps the rotation in the same packed
 * form — its own packer (0x004F43B0) scales x by 2^21 (constant at 0x009F6EF0) and y, z by 2^20
 * (0x009F6EF4) after folding the sign of w into them — and composes quaternions with 0x004F4320.
 *
 * The orientation the renderer turns a model by is the yaw of that quaternion for nearly every
 * object; a bridge, a fallen pillar or a siege engine leaning on a slope has more, and that is
 * all `gameObjectTilt` returns, so a level object is drawn exactly as before.
 */

/** A rotation quaternion, `(x, y, z)` the axis part, `w` the angle part, WoW world axes. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

const X_SCALE = 2 ** 21;
const YZ_SCALE = 2 ** 20;
const MASK_21 = (1n << 21n) - 1n;
const MASK_22 = (1n << 22n) - 1n;

function signed(value: bigint, bits: number): number {
  const number = Number(value);
  return number >= 2 ** (bits - 1) ? number - 2 ** bits : number;
}

/**
 * The inverse of `UpdatePackedRotation`: `x` is the top 22 bits over 2^21, `y` the next 21 over
 * 2^20, `z` the low 21 over 2^20, each two's complement; `w` is never sent and is the non-negative
 * root, because the packer flipped the whole quaternion when it was negative (same rotation).
 */
export function unpackRotation(packed: bigint): Quat {
  const bits = BigInt.asUintN(64, packed);
  const x = signed((bits >> 42n) & MASK_22, 22) / X_SCALE;
  const y = signed((bits >> 21n) & MASK_21, 21) / YZ_SCALE;
  const z = signed(bits & MASK_21, 21) / YZ_SCALE;
  const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  return { x, y, z, w };
}

/** `GameObject::UpdatePackedRotation`, for fixtures and tools; the client never sends it. */
export function packRotation(q: Quat): bigint {
  const sign = q.w >= 0 ? 1 : -1;
  const x = BigInt(Math.trunc(q.x * X_SCALE) * sign) & MASK_22;
  const y = BigInt(Math.trunc(q.y * YZ_SCALE) * sign) & MASK_21;
  const z = BigInt(Math.trunc(q.z * YZ_SCALE) * sign) & MASK_21;
  return BigInt.asIntN(64, z | (y << 21n) | (x << 42n));
}

const FLOAT_SCRATCH = new DataView(new ArrayBuffer(4));
const PARENT = UPDATE_FIELDS.GAMEOBJECT_PARENTROTATION.offset;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
/** `GAMEOBJECT_TYPE_MO_TRANSPORT`, byte 1 of `GAMEOBJECT_BYTES_1` (`GameObject::SetGoType`). */
const GO_TYPE_MO_TRANSPORT = 15;
const NO_TILT = 1e-4;

function fieldFloat(fields: ReadonlyMap<number, number>, index: number): number {
  const raw = fields.get(index);
  if (raw === undefined) return 0;
  FLOAT_SCRATCH.setUint32(0, raw >>> 0, true);
  const value = FLOAT_SCRATCH.getFloat32(0, true);
  return Number.isFinite(value) ? value : 0;
}

/**
 * The rotation this object carries beyond the yaw of `orientation` (its position's), in WoW world axes,
 * written into `out`; false when there is none to speak of (a level object, or one with no
 * rotation in its create block), so the caller does nothing.
 *
 * The world rotation is `GAMEOBJECT_PARENTROTATION ⊗ local` — the parent is `(0, 0, 0, 1)` except on
 * the transports `gameobject_addon` gives one (GameObject.cpp:336-342). The tilt is that times the
 * inverse of the orientation's yaw, so applying the tilt after the yaw the renderer already applies
 * gives the whole rotation back. Allocates nothing: it runs per object per frame.
 */
export function gameObjectTilt(object: Pick<WorldObjectState, "rotation" | "fields">, orientation: number, out: Quat): boolean {
  const local = object.rotation;
  if (local === undefined || !Number.isFinite(orientation)) return false;
  // A ship or a zeppelin is given the identity for both rotations (Transport.cpp:102-103) and
  // faces along its path by its orientation (TransportMgr.cpp:396); its quaternion says nothing.
  if (gameObjectType(object) === GO_TYPE_MO_TRANSPORT) return false;
  // A create block leaves out every zero field (Object.cpp:490), so an identity parent arrives as
  // its `w` alone and an absent one as nothing: both are the identity.
  const fields = object.fields;
  let px = fieldFloat(fields, PARENT);
  let py = fieldFloat(fields, PARENT + 1);
  let pz = fieldFloat(fields, PARENT + 2);
  let pw = fieldFloat(fields, PARENT + 3);
  if (px === 0 && py === 0 && pz === 0 && pw === 0) pw = 1;
  else {
    const length = Math.hypot(px, py, pz, pw);
    px /= length; py /= length; pz /= length; pw /= length;
  }
  // q = parent ⊗ local (Hamilton product).
  const qw = pw * local.w - px * local.x - py * local.y - pz * local.z;
  const qx = pw * local.x + px * local.w + py * local.z - pz * local.y;
  const qy = pw * local.y - px * local.z + py * local.w + pz * local.x;
  const qz = pw * local.z + px * local.y - py * local.x + pz * local.w;
  // tilt = q ⊗ conj(yaw), yaw = (0, 0, sin(o/2), cos(o/2)).
  const s = -Math.sin(orientation / 2);
  const c = Math.cos(orientation / 2);
  let tw = qw * c - qz * s;
  let tx = qx * c + qy * s;
  let ty = qy * c - qx * s;
  let tz = qz * c + qw * s;
  if (tw < 0) {
    tw = -tw; tx = -tx; ty = -ty; tz = -tz;
  }
  if (Math.abs(tx) < NO_TILT && Math.abs(ty) < NO_TILT && Math.abs(tz) < NO_TILT) return false;
  out.x = tx;
  out.y = ty;
  out.z = tz;
  out.w = tw;
  return true;
}

function gameObjectType(object: Pick<WorldObjectState, "fields">): number {
  return ((object.fields.get(BYTES_1) ?? 0) >>> 8) & 0xff;
}

/**
 * The renderer's yaw for a game object, in the scene's axes: what `mappedVmapRotation(0, o, 0)`
 * gives — a turn about VMAP z conjugated by `VMAP_TO_THREE`, which is a proper rotation taking
 * VMAP z to scene y — in closed form, a turn by `orientation` about scene +y. Allocates nothing.
 */
export function sceneYaw(orientation: number, out: Quat): Quat {
  out.x = 0;
  out.y = Math.sin(orientation / 2);
  out.z = 0;
  out.w = Math.cos(orientation / 2);
  return out;
}

/**
 * A WoW-axis rotation in the scene's axes. The scene puts a world point `(x, y, z)` at
 * `(x, z, −y)` — a proper rotation — so a quaternion's axis part maps the same way.
 */
export function toRenderAxes(q: Quat, out: Quat): Quat {
  const y = q.y;
  out.x = q.x;
  out.y = q.z;
  out.z = -y;
  out.w = q.w;
  return out;
}
