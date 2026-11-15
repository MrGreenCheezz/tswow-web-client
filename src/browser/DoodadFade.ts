import type { EnvironmentObject } from "./Terrain.js";
import { ENVIRONMENT_RESIDENT_HYSTERESIS } from "./Terrain.js";
import { RESELECT_DISTANCE } from "./RenderStats.js";
import { doodadBuiltSizeClass, doodadClassDistance } from "./DoodadReach.js";

/**
 * 15.11 (7.66, the last stretch; fade9): how Wow.exe 3.3.5a 12340 lets a doodad go at its class distance — a fade over
 * the last yards, measured from the camera in 3D (`.runtime/re-2026-11-15/far7/g4.c`, `g5.c`).
 *
 * - 0x0078f570 keeps, per size class, the distance D (30, 100·d, 200·d, 750·d, 1250; `DoodadReach.ts`), its square
 *   (0x00adf3b4…), the fade's start D − L and its square (0x00adf3c8…, 0x00adf3dc…), L being 5, 10, 15, 20 and 50 yards
 *   (0x00adf38c…0x00adf39c).
 * - 0x00791cb0, with `objectFade` (bit 0x4000 of 0x00cd774c) and without the def's 0x800 (the biodome flag, far8):
 *   d² = |sphere centre (+0x38…+0x40) − camera (0x00cd8f5c…0x00cd8f64)|²; past D² the doodad is not drawn; past
 *   (D − L)² it is drawn with α = 1 − (d − (D − L)) / L, an α above 0.99 (0x009e2ff4) counting as 1 and an α of 0.01
 *   (0x009f1968) or less not drawn. α goes to the model's +0x178 — the same model alpha a unit's fade writes
 *   (0x00744030), so the batches fade by their blend as a unit's do (`fadeMaterial`, ModelBuild.ts).
 */
export const DOODAD_CLASS_FADES: readonly number[] = Object.freeze([5, 10, 15, 20, 50]);
/** 0x009e2ff4: an α above this is drawn whole. */
export const DOODAD_FADE_WHOLE = 0.99;
/** 0x009f1968: an α at or below this is not drawn. */
export const DOODAD_FADE_GONE = 0.01;

/** The fade length of a size class (0x00adf38c…). */
export function doodadClassFade(sizeClass: number): number {
  const index = Math.max(0, Math.min(DOODAD_CLASS_FADES.length - 1, Math.floor(sizeClass)));
  return DOODAD_CLASS_FADES[index]!;
}

/**
 * The model alpha 0x00791cb0 gives a doodad `distance` yards from the camera whose class ends at `edge` and fades over
 * its last `fade` yards: 1 inside, the linear ramp in the band, 0 where it is not drawn.
 */
export function doodadFadeAlpha(distance: number, edge: number, fade: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(edge) || !(distance < edge)) return 0;
  if (!(fade > 0) || distance <= edge - fade) return 1;
  const alpha = 1 - (distance - (edge - fade)) / fade;
  if (alpha > DOODAD_FADE_WHOLE) return 1;
  return alpha <= DOODAD_FADE_GONE ? 0 : alpha;
}

/**
 * Whether a placement is measured and faded by the doodad rule: an outdoor M2 that is not a biodome (0x00791cb0 skips a
 * def with 0x800; `biodomeDrawRange`). A map object's own doodads (`interior`) keep their rooms' leash here.
 */
export function doodadViewMeasured(object: EnvironmentObject): boolean {
  return object.kind === "m2" && object.interior !== true && object.biodome !== true;
}

/**
 * Where the distance is taken from. The faithful levels measure as Wow.exe, from the camera (`eye`, scene axes) to the
 * centre of the doodad's sphere; the enhanced levels keep their own leashes, measured across the ground from the player
 * (`player`, map axes) — live rather than from the four-yard reselection.
 */
export interface DoodadView {
  readonly eye: { x: number; y: number; z: number };
  readonly player: { x: number; y: number };
  readonly camera3d: boolean;
}

/** A sphere in scene axes, as `EnvironmentVisibilitySphere`. */
export interface DoodadSphere { readonly x: number; readonly y: number; readonly z: number }

/** The placement's distance under `view`; the sphere's centre when known, else its origin. */
export function doodadViewDistance(object: EnvironmentObject, sphere: DoodadSphere | undefined, view: DoodadView): number {
  if (!view.camera3d) {
    const dx = object.x - view.player.x;
    const dy = object.y - view.player.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  // Scene axes: x = map x, y = map z (up), z = −map y (`environmentSourceVisibilitySphere`).
  const cx = sphere ? sphere.x : object.x;
  const cy = sphere ? sphere.y : object.z;
  const cz = sphere ? sphere.z : -object.y;
  const dx = cx - view.eye.x;
  const dy = cy - view.eye.y;
  const dz = cz - view.eye.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * How many yards past its leash a measured doodad stays a candidate, so the admission's own test under the view decides.
 * The ranking measures across the ground from the player, once per `RESELECT_DISTANCE` of walking; the camera stands at
 * most `CAMERA_MAX_DISTANCE` (55) from the player across the ground, so a doodad the camera has within its leash is never
 * more than 55 + 4 yards farther from the ranking's point: the resident band (60) covers it. The enhanced levels' live
 * player distance needs only the walk.
 */
export function doodadCandidateSlack(object: EnvironmentObject, faithful: boolean): number {
  if (!doodadViewMeasured(object)) return 0;
  return faithful ? ENVIRONMENT_RESIDENT_HYSTERESIS : RESELECT_DISTANCE;
}

/**
 * The model alpha of an admitted doodad under `view`: by Wow.exe's rule on the faithful levels (its class's distance and
 * fade, `detail` the `environmentDetail`), and on the enhanced levels the same fade length over the last yards of its own
 * leash `range`. 1 when nothing is known about its class yet (its model not built) or it is not a measured doodad.
 */
export function doodadViewAlpha(
  object: EnvironmentObject,
  range: number | undefined,
  sphere: DoodadSphere | undefined,
  view: DoodadView,
  detail: number,
): number {
  if (!doodadViewMeasured(object)) return 1;
  const sizeClass = doodadBuiltSizeClass(object);
  if (sizeClass === undefined) return 1;
  const edge = view.camera3d ? doodadClassDistance(sizeClass, detail) : range;
  if (edge === undefined || !Number.isFinite(edge)) return 1;
  return doodadFadeAlpha(doodadViewDistance(object, sphere, view), edge, doodadClassFade(sizeClass));
}

/**
 * Whether a doodad seen for the first time `distance` yards out (as ranked) is already inside its fade band — the fade
 * then brings it in, and the renderer's own grow-in would only fight it.
 */
export function doodadFirstSightFades(object: EnvironmentObject, distance: number, range: number | undefined): boolean {
  if (!doodadViewMeasured(object) || range === undefined || !Number.isFinite(range)) return false;
  const sizeClass = doodadBuiltSizeClass(object);
  return sizeClass !== undefined && distance > range - doodadClassFade(sizeClass);
}
