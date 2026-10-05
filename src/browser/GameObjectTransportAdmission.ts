/**
 * 7.05 variant A (owner decision 05.10): moving transports outside the game-object limits.
 *
 * Ships, zeppelins, gunships (GAMEOBJECT_TYPE_MO_TRANSPORT = 15) and lifts (GAMEOBJECT_TYPE_TRANSPORT
 * = 11) used to share the 120-yard / 96-object game-object budget with doors and mailboxes, so a ship
 * seen from the shore at three hundred yards vanished until it was nearly at the dock. The server
 * sends every MO transport of a map at login (`Map::SendInitTransports`), so the client already
 * knows where they are; only the renderer was cutting them. A moving transport now has the
 * environment's far range and a quota of its own, outside the ordinary budget: the ordinary
 * selection is unchanged and at most `GAMEOBJECT_TRANSPORT_BUDGET` extra entries are admitted.
 */
import * as THREE from "three";

import { stableBoundedTopKWhere, type UnitAdmissionCandidate } from "./RenderAdmission.js";
import { ENVIRONMENT_FAR_RANGE } from "./Terrain.js";

/** Admission range of a moving transport: the far scenery leash (750 yards). */
export const GAMEOBJECT_TRANSPORT_RANGE = ENVIRONMENT_FAR_RANGE;
/**
 * 05.10-7.05-review: a moving transport's outdoor shell leash. `wmoShellRange` keeps a hull under a
 * 120-yard diagonal (the zeppelin's, 102.9 yd) on the 250-yard near leash, and judges the diagonal on
 * the box rotated by whatever yaw the transport was built at — so an admitted zeppelin drew nothing
 * past ~290 yards, or did, by chance of its build heading. The hull is drawn as far as it is admitted.
 */
export const GAMEOBJECT_TRANSPORT_SHELL_RANGE = GAMEOBJECT_TRANSPORT_RANGE;
/** Moving transports admitted on one frame, apart from the ordinary game-object budget. */
export const GAMEOBJECT_TRANSPORT_BUDGET = 8;

/** One in-range game object, classified as a moving transport or not. */
export interface GameObjectAdmissionCandidate<T> extends UnitAdmissionCandidate<T> {
  readonly transport: boolean;
}

/** Whether a game object at `distance` is a candidate at all; a transport has its own range. */
export function gameObjectWithinAdmissionRange(
  distance: number,
  transport: boolean,
  ordinaryRange: number,
): boolean {
  // Written as "not beyond" so a non-finite distance is kept exactly as the old filter kept it.
  return !(distance > (transport ? GAMEOBJECT_TRANSPORT_RANGE : ordinaryRange));
}

const acceptOrdinary = (candidate: GameObjectAdmissionCandidate<unknown>): boolean =>
  !candidate.transport && (candidate.pinned || candidate.visible);
const acceptTransport = (candidate: GameObjectAdmissionCandidate<unknown>): boolean =>
  candidate.transport && (candidate.pinned || candidate.visible);
const pinnedFirst = (candidate: GameObjectAdmissionCandidate<unknown>): number =>
  candidate.pinned ? -1 : candidate.distance;

/**
 * Pinned-first, nearest-first admission with two quotas: the ordinary objects against `budget`,
 * the moving transports against `transportBudget`. Ordinary objects come first in the result in the
 * order the shared selection always gave them; the transports follow. `dropped` counts both.
 */
export function selectGameObjectAdmissionWithTransports<T>(
  candidates: readonly GameObjectAdmissionCandidate<T>[],
  budget: number,
  transportBudget = GAMEOBJECT_TRANSPORT_BUDGET,
): { readonly admitted: GameObjectAdmissionCandidate<T>[]; readonly dropped: number } {
  let eligible = 0;
  let transports = 0;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    if (!candidate.pinned && !candidate.visible) continue;
    eligible++;
    if (candidate.transport) transports++;
  }
  const admitted = stableBoundedTopKWhere(candidates, acceptOrdinary, budget, pinnedFirst);
  if (transports > 0) {
    const ships = stableBoundedTopKWhere(candidates, acceptTransport, transportBudget, pinnedFirst);
    for (let index = 0; index < ships.length; index++) admitted.push(ships[index]!);
  }
  return { admitted, dropped: Math.max(0, eligible - admitted.length) };
}

/** Involution: WMO model axes ↔ scene axes, the same matrix as `VMAP_TO_THREE` in the renderer. */
const MODEL_TO_SCENE = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);
const CURRENT_TO_MODEL = new THREE.Matrix4();
const VIEWER = new THREE.Vector3();

/**
 * The player expressed where a moving WMO transport stood when its rooms' boxes were taken.
 *
 * `wmoGroupBoxes` transforms each group box once, at the build position; a ship built far out at
 * sea keeps those boxes while it sails to the dock, and the room leash measured from them would
 * drop every room of a ship that is now beside the player. Carrying the player through the
 * transport's current placement into its build placement measures the same distances against the
 * unchanged boxes. `buildModelToWorld` is `PlacedWmo.modelToWorld`; `node` is the transport's
 * current scene node (position, rotation, scale already applied this frame, in a root-level group).
 * Writes into and returns `out`; allocates nothing.
 */
export function transportWmoViewer<P extends { x: number; y: number; z: number }>(
  buildModelToWorld: THREE.Matrix4,
  node: THREE.Object3D,
  player: Readonly<{ x: number; y: number; z: number }>,
  out: P,
): P {
  CURRENT_TO_MODEL.compose(node.position, node.quaternion, node.scale).multiply(MODEL_TO_SCENE);
  if (CURRENT_TO_MODEL.determinant() === 0) {
    out.x = player.x;
    out.y = player.y;
    out.z = player.z;
    return out;
  }
  CURRENT_TO_MODEL.invert();
  VIEWER.set(player.x, player.z, -player.y).applyMatrix4(CURRENT_TO_MODEL).applyMatrix4(buildModelToWorld);
  out.x = VIEWER.x;
  out.y = -VIEWER.z;
  out.z = VIEWER.y;
  return out;
}
