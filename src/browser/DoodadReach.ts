import * as THREE from "three";
import type { EnvironmentObject } from "./Terrain.js";

/**
 * 15.11 (7.66 tail, 7.03): how far Wow.exe draws a doodad — by a size class, not by a count or a scaled radius.
 *
 * - 0x007bdb10 sets a doodad's class (byte +0x24) from the largest side of its world box (the model's header box
 *   carried through the placement transform, 0x007f9430): under 1, 4, 15 and 100 yards (`0x00adf350`) it is class
 *   0–3, anything larger class 4.
 * - 0x0078f570 (the `environmentDetail` CVar's callback 0x0078dc60, 0.5–1.5) gives each class its distance:
 *   30, 100·d, 200·d, 750·d and 1250 yards (`0x00adf364`…`0x00adf374`; classes 0 and 4 are not scaled), and a fade
 *   over the last 5, 10, 15, 20 and 50 yards of it (`0x00adf38c`…).
 * - 0x00791cb0 drops the doodad past its class's distance, measured from the camera to its sphere centre, and fades
 *   it inside the last stretch (with `objectFade`, default on). 0x00799980/0x00799b70 feed it per depth band
 *   (0x0078fb60), so a band only offers the classes that still reach it. The doodads of map objects read the same
 *   table (0x007babc0, 0x007bc490, 0x007bcc00, 0x007bcf20).
 *
 * The stand's frames agree (`.runtime/re-2026-11-15/far7/`, `reach.mjs`, environmentDetail 1.5 there): in the
 * Netherstorm frame the farthest doodads drawn are class-4 trees at 1,190–1,221 yards and class-3 rocks and ferns at
 * 1,124–1,135 (the 1,125-yard class-3 distance); 237 class-3 ferns stood in view inside twice that distance and
 * ten of them, all within it, were drawn.
 */
export const DOODAD_CLASS_SIDES: readonly number[] = Object.freeze([1, 4, 15, 100]);
/** Per class, the distance at `environmentDetail` 1 (0x00adf364…0x00adf374). */
export const DOODAD_CLASS_DISTANCES: readonly number[] = Object.freeze([30, 100, 200, 750, 1250]);
/** Per class, whether `environmentDetail` scales its distance (0x0078f570 multiplies classes 1–3 only). */
const DOODAD_CLASS_SCALED: readonly boolean[] = Object.freeze([false, true, true, true, false]);

/** The class of a doodad whose world box's largest side is `side` yards (0x007bdb10). */
export function doodadSizeClass(side: number): number {
  for (let index = 0; index < DOODAD_CLASS_SIDES.length; index++) {
    if (side < DOODAD_CLASS_SIDES[index]!) return index;
  }
  return DOODAD_CLASS_SIDES.length;
}

/** How far a doodad of this class is drawn at this `environmentDetail` (0x0078f570). */
export function doodadClassDistance(sizeClass: number, detail: number): number {
  const index = Math.max(0, Math.min(DOODAD_CLASS_DISTANCES.length - 1, Math.floor(sizeClass)));
  const scale = Number.isFinite(detail) && detail > 0 ? detail : 1;
  return DOODAD_CLASS_DISTANCES[index]! * (DOODAD_CLASS_SCALED[index] ? scale : 1);
}

/** A model's header box (`WvmModel.bounds`), in its own axes. */
export interface DoodadModelBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * Header boxes of the models built so far, by lower-case path. A placement's class needs its model's box, which a
 * placement record does not carry; the box is learnt once any placement of the model is built, and every other
 * placement of it is ranked by its true class from then on.
 */
const MODEL_BOXES = new Map<string, DoodadModelBox>();
const SIDE_OF = new WeakMap<EnvironmentObject, number>();

/**
 * Records a built model's header box; a degenerate (all-zero or inverted) box is not a box and is ignored. True when
 * the model's box is new, so the placements ranked by a bound can be ranked again by their class.
 */
export function recordDoodadModelBox(name: string, box: DoodadModelBox): boolean {
  const { min, max } = box;
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(min[axis]!) || !Number.isFinite(max[axis]!) || max[axis]! < min[axis]!) return false;
  }
  // `tools/wvm.mjs` writes zeros for a model without a header box.
  if (min.every((value) => value === 0) && max.every((value) => value === 0)) return false;
  const key = name.toLowerCase();
  if (MODEL_BOXES.has(key)) return false;
  MODEL_BOXES.set(key, { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] });
  return true;
}

/** Forgets the recorded boxes (tests). */
export function clearDoodadModelBoxes(): void {
  MODEL_BOXES.clear();
}

const _rotation = new THREE.Matrix4();
const _step = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _corner = new THREE.Vector3();
/** Model axes to the scene's, as `WorldRenderer3D`'s `VMAP_TO_THREE`: a signed permutation, so it keeps sides. */
const MODEL_TO_SCENE = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

/**
 * The largest side of the placement's world box: the model's header box carried through the placement's rotation
 * and scale (0x007f9430), as the renderer places it (`placeEnvironmentNode`: a WMO doodad's quaternion, else the
 * tile's Euler angles as `mappedVmapRotation` reads them). Undefined while the model's box is not known.
 */
export function doodadWorldSide(object: EnvironmentObject): number | undefined {
  const cached = SIDE_OF.get(object);
  if (cached !== undefined) return cached;
  const box = MODEL_BOXES.get(object.name.toLowerCase());
  if (!box || !Number.isFinite(object.scale) || object.scale <= 0) return undefined;
  if (object.quaternionX !== undefined && object.quaternionY !== undefined
    && object.quaternionZ !== undefined && object.quaternionW !== undefined) {
    // The quaternion acts in the scene's frame, on geometry already turned into it.
    _quaternion.set(object.quaternionX, object.quaternionY, object.quaternionZ, object.quaternionW).normalize();
    _rotation.makeRotationFromQuaternion(_quaternion).multiply(MODEL_TO_SCENE);
  } else {
    // Rz(y)·Ry(x)·Rx(z) in the model's own axes; the scene's frame differs by a signed permutation only.
    _rotation.makeRotationZ(THREE.MathUtils.degToRad(object.rotationY))
      .multiply(_step.makeRotationY(THREE.MathUtils.degToRad(object.rotationX)))
      .multiply(_step.makeRotationX(THREE.MathUtils.degToRad(object.rotationZ)));
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    _corner.set(
      corner & 1 ? box.max[0] : box.min[0],
      corner & 2 ? box.max[1] : box.min[1],
      corner & 4 ? box.max[2] : box.min[2],
    ).applyMatrix4(_rotation);
    minX = Math.min(minX, _corner.x); maxX = Math.max(maxX, _corner.x);
    minY = Math.min(minY, _corner.y); maxY = Math.max(maxY, _corner.y);
    minZ = Math.min(minZ, _corner.z); maxZ = Math.max(maxZ, _corner.z);
  }
  const side = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * object.scale;
  if (!Number.isFinite(side)) return undefined;
  SIDE_OF.set(object, side);
  return side;
}

/**
 * The faithful levels' draw distance of an outdoor doodad: its class's distance (0x0078f570), or undefined when
 * nothing about its size is known yet.
 *
 * Before its model is built the class comes from the tile's origin radius: every vertex lies within that radius of
 * the origin, so no side of the box exceeds twice it, and the class read from that bound is never lower than the true
 * one. The doodad is admitted, its model built, and from then on it is held to its true class. A doodad with no
 * radius (an animated or emitting model: the tile publishes radii for static geometry only) is the caller's to
 * bound: the renderer holds it to the reach until its box is learnt — Netherstorm's Area 52 dome, a 520-yard class-4
 * model with effects, stands 845 yards from the stand's camera.
 */
export function doodadOriginalReach(object: EnvironmentObject, detail: number): number | undefined {
  const side = doodadWorldSide(object);
  if (side !== undefined) return doodadClassDistance(doodadSizeClass(side), detail);
  const radius = object.admissionRadius;
  if (radius === undefined || !Number.isFinite(radius) || radius < 0
    || !Number.isFinite(object.scale) || object.scale <= 0) return undefined;
  return doodadClassDistance(doodadSizeClass(2 * radius * object.scale), detail);
}
