/**
 * L8 5.14 (step D): `cameraWaterCollision` — «Расположение камеры над водой, если персонаж находится на
 * поверхности воды, и под водой, если он ныряет» (OPTION_TOOLTIP_WATER_COLLISION), on by default.
 *
 * Wow.exe 3.3.5a 12340 (Ghidra read-only; .runtime/re-2026-10-03/l1102gf3/r1.c, r2.c, r4.c and
 * re-2026-10-04/l8-movement): the CVar (registered at 0x005fe029, default "1", global 0x00c249b4) adds the
 * liquid bit 0x20000 to the camera's collision mask (0x005fec50: 0x100171 | 0x20000), the mask its boom and
 * height sweeps are cast with (0x00605d60, the world query 0x00759580). 0x006049c0 asks the liquid under the
 * camera's subject and calls it at the surface while the water is no deeper than the subject's height less
 * 0.2222 (0x00a1ea24) and submerged past that; 0x00605d60 then keeps the camera's hinge 0.2222 over the
 * surface for the first and under it for the second. The boom, swept with liquid solid, stops where it meets
 * the surface: from above the camera stays out of the water, from below it stays in it.
 *
 * Here the surface is the one the mover's feet last answered (the physics' own query, WMO water included),
 * taken as flat, and the side is where the hinge is. Over it the surface is one more floor under the camera,
 * the way this rig keeps the camera off the character's feet and the collision floors: the tilt gives way
 * (`CameraRig.cameraFloorPitch`), not the arm — Wow.exe's sweep would cut the arm there, as it does for every
 * floor, and the rig re-derives the tilt from the arm it drew, so a cut arm would only let the tilt swing the
 * camera under after all. Under it the boom is cut where it would cross the surface less the same 0.2222, as a
 * wall cuts it. Not modelled: water the boom crosses away from the subject's own column (a lake behind a
 * character standing on its shore), the hinge raised over the surface, and the pitch nudges of
 * `cameraDive`/`camera*FinalPitch` on crossing it.
 */

import { LIQUID_RECALL_YARDS } from "./Physics.js";

/** 0x00a1ea24: how far from the surface the hinge is kept in 0x00605d60, used here for the camera too. */
export const CAMERA_WATER_CLEARANCE = 0.2222222238779068;

/**
 * The surface the boom stops at: the one the mover's feet last answered (`Physics.CharacterMotion.liquid`), while
 * that answer is for the column at (`x`, `y`) — within {@link LIQUID_RECALL_YARDS}, as the physics reads it.
 */
export function cameraWaterSurface(
  liquid: { readonly x: number; readonly y: number; readonly surface: { readonly height: number } | undefined } | undefined,
  x: number, y: number,
): number | undefined {
  const surface = liquid?.surface;
  if (liquid === undefined || surface === undefined) return undefined;
  const dx = x - liquid.x;
  const dy = y - liquid.y;
  return dx * dx + dy * dy <= LIQUID_RECALL_YARDS * LIQUID_RECALL_YARDS ? surface.height : undefined;
}

/**
 * The floor the surface puts under a camera hinged over it: {@link CAMERA_WATER_CLEARANCE} above the water, or
 * `-Infinity` when there is no water or the hinge is under it.
 */
export function cameraWaterFloor(pivotZ: number, surfaceZ: number | undefined): number {
  if (surfaceZ === undefined || !Number.isFinite(surfaceZ) || !(pivotZ >= surfaceZ)) return Number.NEGATIVE_INFINITY;
  return surfaceZ + CAMERA_WATER_CLEARANCE;
}

/**
 * The longest arm the surface allows a camera hinged under it: the distance along the boom (camera z =
 * pivotZ − sin(pitch) · arm, `SimpleScene.createCamera`) at which a camera swung above the hinge comes within
 * {@link CAMERA_WATER_CLEARANCE} of the surface; 0 when the hinge is already that close; `Infinity` when there
 * is no water, the hinge is over it or the boom heads down. Allocates nothing; called once a frame.
 */
export function cameraWaterArm(pivotZ: number, pitch: number, surfaceZ: number | undefined): number {
  if (surfaceZ === undefined || !Number.isFinite(surfaceZ) || !(pivotZ < surfaceZ)) return Number.POSITIVE_INFINITY;
  const sine = Math.sin(pitch);
  if (!(sine < 0)) return Number.POSITIVE_INFINITY;
  const room = (surfaceZ - CAMERA_WATER_CLEARANCE) - pivotZ;
  return room > 0 ? room / -sine : 0;
}
