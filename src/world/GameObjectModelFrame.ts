/**
 * 06.10-7.24: which way a game object's model faces, and the box a click on it lands in.
 *
 * The core puts a game object's model at `position + Rz(o)·v` (`GameObjectModel::initialize`,
 * GameObjectModel.cpp:129 — `fromEulerAnglesZYX(GetOrientation(), 0, 0)` — and the ray test at
 * :174 inverts the same matrix), where `v` is the vmap copy of the model. That copy is the M2's own
 * axes: `vmap4_extractor` runs every bounding vertex through `fixCoordSystem` (model.cpp:56,
 * `(x, z, −y)`) and swaps it straight back when it writes the file (model.cpp:118-123). A unit is
 * drawn the same way (`rotation.y = o` over `M2_TO_SCENE`), and the core seats a player on a chair
 * facing the chair's own orientation (GameObject.cpp:1808, `TeleportTo(…, GetOrientation())`).
 *
 * The renderer's game object meshes are in the tile's frame instead (`ADT_MODEL_TO_SCENE`, which is
 * `world→scene · Rz(π)`): that frame is right for an ADT/WMO doodad, whose vmap spawn is stored in
 * the internal `mid − x, mid − y` coordinates (half a turn), and wrong by exactly that half turn for
 * an object placed by the core's own orientation. The node therefore turns by `o + π`, and the mesh's
 * built-in half turn takes it back to `Rz(o)`.
 *
 * Evidence beside the core: the client's own `GameObjectDisplayInfo.GeoBox` for the stock chair
 * (display 39, GeneralChairLoEnd01) spans x −1.00…0.18 — the back of the chair is behind −x and the
 * seat opens towards +x, which is the way the seated player faces only under `Rz(o)`. All 4,145
 * chair spawns of the TDB dump carry a quaternion whose yaw equals their orientation (9 shipboard
 * ones differ, by the ship's frame), so nothing in the data adds a turn of its own.
 */
import { passengerGameObjectTilt } from "./TransportPassengers.js";
import type { Quat } from "./GameObjectRotation.js";
import type { WorldObjectState } from "./WorldState.js";

/** The half turn between the tile frame the meshes are built in and the core's `Rz(o)`. */
export const GAME_OBJECT_MODEL_HALF_TURN = Math.PI;

/** The yaw, in the renderer's VMAP-conjugated sense (`sceneYaw`), a game object's node turns by. */
export function gameObjectNodeYaw(orientation: number): number {
  return orientation + GAME_OBJECT_MODEL_HALF_TURN;
}

/** A model-space box in the model's own (M2/WMO, WoW) axes. */
export interface ModelBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * The whole world rotation of a game object, WoW axes: the tilt `passengerGameObjectTilt` gives
 * (identity for a level object) after the yaw of `orientation`. Writes `out`; allocates nothing.
 */
export function gameObjectWorldRotation(
  object: Pick<WorldObjectState, "rotation" | "fields" | "transport">,
  orientation: number,
  out: Quat,
): Quat {
  const half = (Number.isFinite(orientation) ? orientation : 0) / 2;
  const yz = Math.sin(half);
  const yw = Math.cos(half);
  if (!passengerGameObjectTilt(object, orientation, out)) {
    out.x = 0; out.y = 0; out.z = yz; out.w = yw;
    return out;
  }
  // out = tilt ⊗ yaw, yaw = (0, 0, yz, yw).
  const { x, y, z, w } = out;
  out.x = x * yw + y * yz;
  out.y = y * yw - x * yz;
  out.z = z * yw + w * yz;
  out.w = w * yw - z * yz;
  return out;
}

/**
 * The eight world corners of `box` placed at `position`, turned by `rotation` (WoW axes) and scaled
 * by `scale`, as `x, y, z` triples into `out` (24 numbers). The order is the bit pattern of the
 * corner index: bit 0 picks max x, bit 1 max y, bit 2 max z.
 */
export function placedBoxCorners(
  box: ModelBox,
  position: Readonly<{ x: number; y: number; z: number }>,
  rotation: Readonly<Quat>,
  scale: number,
  out: Float64Array,
): Float64Array {
  const { x: qx, y: qy, z: qz, w: qw } = rotation;
  for (let corner = 0; corner < 8; corner++) {
    const vx = ((corner & 1) ? box.maxX : box.minX) * scale;
    const vy = ((corner & 2) ? box.maxY : box.minY) * scale;
    const vz = ((corner & 4) ? box.maxZ : box.minZ) * scale;
    // v' = v + 2w(q×v) + 2q×(q×v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out[corner * 3] = position.x + vx + qw * tx + (qy * tz - qz * ty);
    out[corner * 3 + 1] = position.y + vy + qw * ty + (qz * tx - qx * tz);
    out[corner * 3 + 2] = position.z + vz + qw * tz + (qx * ty - qy * tx);
  }
  return out;
}
