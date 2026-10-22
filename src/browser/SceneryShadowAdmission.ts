// 22.10 (7.41): scenery the view did not admit but whose shadow falls into it.
//
// The owner's report 22.10: a model behind the camera is not drawn, and when it is big enough that
// its shadow falls on the player, the shadow vanishes as soon as the player turns away from it.
// Measured offline (lookdev, Goldshire at 16:40, camera looking east with the sun behind it): the
// still taken before the camera had ever looked west showed the ground in full sun; the same still
// taken after one look west showed it under the shadows of the trees behind the camera. Draw
// admission (`admitEnvironmentInto`) is a view-frustum test, so
//   * a placement the view never admitted was never built, and cast nothing (the trees above);
//   * a building that left the view had its rooms detached (`#clearWmoGroups`), shadow stand-ins
//     and all, and the caster gate kept buildings out of gate 2 — so a tower behind the camera
//     never cast, seen before or not.
// Retained M2s that had been seen already cast through gate 2 (offline, a look west and back east
// kept the trees' shadows) — unless the warm LRU evicts them: past 960 hidden exterior residents
// it drops the oldest-admitted first, and the trees turned away from on one frame tie and go by id
// (not reproduced offline; one spot in Elwynn reached 783 hidden owners after three looks). A
// shadow-admitted placement now counts as admitted for that LRU, and is rebuilt here if dropped.
//
// The rule here: a candidate the view rejected is admitted for its shadow alone when the sphere
// holding it and its shadow on level ground (`unitShadowFootprint`, the units' rule of 06.10) lies
// in the view frustum and either in a view-fitted cascade or — for a caster big enough for the
// cached cascade — within `shadowDistance` of the camera. Nearest first, at most
// `SCENERY_SHADOW_ADMISSION_BUDGET`; the renderer builds them after the view's own admissions,
// inside the same per-frame build budget.

import { SCENERY_FAR_SHADOW_MIN_RADIUS, SCENERY_SHADOW_MIN_RADIUS } from "./SceneryShadowFlags.js";
import { unitShadowFootprint, type UnitShadowSphere } from "./UnitShadowCasters.js";
import { BoundedTopK } from "./RenderAdmission.js";

/** At most this many placements are admitted for their shadow alone at once. */
export const SCENERY_SHADOW_ADMISSION_BUDGET = 192;
/**
 * Frames a placement stays admitted for its shadow after the rule last held: admission runs at half
 * rate while the camera is calm, and a building's rooms are not to be dropped and re-hung at the
 * edge of the rule.
 */
export const SCENERY_SHADOW_HOLD_FRAMES = 30;
/** Yards of slack on the view frustum, as the view's own admission margin. */
export const SCENERY_SHADOW_FRUSTUM_MARGIN = 8;

export interface ShadowAdmissionObject {
  readonly kind: "m2" | "wmo";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly interior?: boolean | undefined;
  readonly admissionRadius?: number | undefined;
  readonly bounds?: Readonly<{ minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }> | undefined;
}

export interface ShadowAdmissionCandidate<T extends ShadowAdmissionObject = ShadowAdmissionObject> {
  readonly object: T;
  readonly distance: number;
}

export interface ShadowAdmissionPlane {
  readonly normal: Readonly<{ x: number; y: number; z: number }>;
  readonly constant: number;
}

export interface ShadowAdmissionView {
  /** View frustum planes (scene space, normals inward). */
  readonly planes: readonly ShadowAdmissionPlane[];
  /** Points towards the sun; need not be unit length. */
  readonly sun: Readonly<{ x: number; y: number; z: number }>;
  readonly camera: Readonly<{ x: number; y: number; z: number }>;
  /** Where the cached cascade's fade ends (`LightingProfile.shadowDistance`). */
  readonly shadowDistance: number;
  /** Whether a scene sphere overlaps a view-fitted cascade (`CascadedSunShadows.viewFittedCovers`). */
  readonly viewFittedCovers: (x: number, y: number, z: number, radius: number) => boolean;
}

/**
 * The scene sphere a placement stands in, centred at its feet (the footprint's convention), or
 * false when its size is unknown or too small to cast. A WMO's world box maps to scene (x, z, -y);
 * an M2 takes its source vertex radius around the placement origin. Allocation-free.
 */
export function shadowCasterSphere(object: ShadowAdmissionObject, out: UnitShadowSphere): boolean {
  if (object.interior === true) return false;
  const bounds = object.bounds;
  if (bounds !== undefined) {
    const { minX, minY, minZ, maxX, maxY, maxZ } = bounds;
    if (!(minX <= maxX && minY <= maxY && minZ <= maxZ)
      || !Number.isFinite(minX + minY + minZ + maxX + maxY + maxZ)) return false;
    const halfX = (maxX - minX) / 2;
    const halfY = (maxY - minY) / 2;
    out.x = minX + halfX;
    out.y = minZ;
    out.z = -(minY + halfY);
    // From the floor of the box: reaches its top and its corners.
    const height = maxZ - minZ;
    out.radius = Math.sqrt(halfX * halfX + halfY * halfY + height * height);
    return out.radius >= SCENERY_SHADOW_MIN_RADIUS;
  }
  if (object.kind !== "m2") return false;
  const radius = (object.admissionRadius ?? Number.NaN) * object.scale;
  if (!(radius >= SCENERY_SHADOW_MIN_RADIUS) || !Number.isFinite(radius)
    || !Number.isFinite(object.x) || !Number.isFinite(object.y) || !Number.isFinite(object.z)) return false;
  out.x = object.x;
  out.y = object.z;
  out.z = -object.y;
  out.radius = radius;
  return true;
}

const caster: UnitShadowSphere = { x: 0, y: 0, z: 0, radius: 0 };
const footprint: UnitShadowSphere = { x: 0, y: 0, z: 0, radius: 0 };
/** One run's planes, unit length, as [nx, ny, nz, constant] (the per-candidate test was 70 ns). */
const unitPlanes = new Float64Array(6 * 4);
let unitPlaneCount = 0;

function preparePlanes(planes: readonly ShadowAdmissionPlane[]): void {
  unitPlaneCount = 0;
  for (let index = 0; index < planes.length && unitPlaneCount < 6; index++) {
    const { normal: { x, y, z }, constant } = planes[index]!;
    const length = Math.sqrt(x * x + y * y + z * z);
    if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(constant)) continue;
    const at = unitPlaneCount++ * 4;
    unitPlanes[at] = x / length; unitPlanes[at + 1] = y / length; unitPlanes[at + 2] = z / length;
    unitPlanes[at + 3] = constant / length;
  }
}

/** One run's sun: `unitShadowFootprint`'s factors, without its two `Math.hypot` calls per caster. */
let sunUsable = false;
let sunAwayX = 0;
let sunAwayZ = 0;
let sunReachPerYard = 0;
let sunOverhead = false;

function prepareSun(sun: Readonly<{ x: number; y: number; z: number }>): void {
  // The probe stands in for `unitShadowFootprint`'s own validation and its near-overhead case.
  sunUsable = unitShadowFootprint(0, 0, 0, 1, sun, footprint);
  if (!sunUsable) return;
  const length = Math.sqrt(sun.x * sun.x + sun.y * sun.y + sun.z * sun.z);
  const horizontal = Math.sqrt(sun.x * sun.x + sun.z * sun.z) / length;
  sunOverhead = !(horizontal > 0);
  if (sunOverhead) return;
  // The probe's footprint: centre moved by half the reach of a 1-yard caster, radius 1 + half.
  const half = footprint.radius - 1;
  sunReachPerYard = half;
  sunAwayX = half > 0 ? footprint.x / half : 0;
  sunAwayZ = half > 0 ? footprint.z / half : 0;
}

function reaches(object: ShadowAdmissionObject, view: ShadowAdmissionView): boolean {
  if (!sunUsable || !shadowCasterSphere(object, caster)) return false;
  const radius = caster.radius;
  const half = sunOverhead ? 0 : radius * sunReachPerYard;
  footprint.x = caster.x + sunAwayX * half;
  footprint.y = caster.y;
  footprint.z = caster.z + sunAwayZ * half;
  footprint.radius = radius + half;
  const limit = -(footprint.radius + SCENERY_SHADOW_FRUSTUM_MARGIN);
  for (let at = 0; at < unitPlaneCount * 4; at += 4) {
    if (unitPlanes[at]! * footprint.x + unitPlanes[at + 1]! * footprint.y + unitPlanes[at + 2]! * footprint.z
      + unitPlanes[at + 3]! < limit) return false;
  }
  if (view.viewFittedCovers(footprint.x, footprint.y, footprint.z, footprint.radius)) return true;
  // The cached cascade draws only the large casters, and only to `shadowDistance`.
  if (!(radius >= SCENERY_FAR_SHADOW_MIN_RADIUS || object.kind === "wmo")) return false;
  const dx = footprint.x - view.camera.x, dy = footprint.y - view.camera.y, dz = footprint.z - view.camera.z;
  const reach = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return reach - footprint.radius <= view.shadowDistance;
}

/** Whether one placement's shadow can land in the shadowed part of the view. Allocation-free. */
export function shadowReachesView(object: ShadowAdmissionObject, view: ShadowAdmissionView): boolean {
  preparePlanes(view.planes);
  prepareSun(view.sun);
  return reaches(object, view);
}

const heap = new BoundedTopK<ShadowAdmissionCandidate>();

/**
 * The view-rejected candidates admitted for their shadow, nearest first, into `out` (cleared).
 * `rejected` holds only candidates the view's frustum test turned away (`admitEnvironmentInto`'s
 * `rejected` list), so nothing is both drawn and shadow-only.
 */
export function admitShadowCastersInto<T extends ShadowAdmissionCandidate>(
  rejected: readonly T[],
  view: ShadowAdmissionView,
  out: T[],
  budget = SCENERY_SHADOW_ADMISSION_BUDGET,
): T[] {
  out.length = 0;
  heap.reset(budget);
  preparePlanes(view.planes);
  prepareSun(view.sun);
  for (let index = 0; index < rejected.length; index++) {
    const candidate = rejected[index]!;
    if (reaches(candidate.object, view)) heap.offer(candidate, candidate.distance);
  }
  heap.drainInto(out as ShadowAdmissionCandidate[]);
  return out;
}

/**
 * 22.10 (7.41): of a building's `selected` rooms, those that cast through a stand-in — outdoor, or
 * indoor with exterior-lit runs (`#syncWmoRoomShadow`'s rule) — written into `out` (cleared).
 */
export function outdoorCasterGroups(
  groups: readonly (Readonly<{ indoor: boolean; exterior: boolean }> | undefined)[],
  selected: readonly number[],
  out: number[],
): number[] {
  out.length = 0;
  for (let at = 0; at < selected.length; at++) {
    const index = selected[at]!;
    const group = groups[index];
    if (group && (!group.indoor || group.exterior)) out.push(index);
  }
  return out;
}
