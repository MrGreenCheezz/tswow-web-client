/**
 * 05.10-A7b-2 (7.12): the one fog of a frame whose camera stands in a room with MFOG.
 *
 * The client keeps one fog per frame: while the camera is in a group naming an MFOG record, that
 * record replaces the zone's fog for everything drawn — the room itself, its doodads, units,
 * particles, water and whatever shows through the doorway. Until this slice only the room's own
 * interior runs took it (`applyWmoInteriorFog`); everything else kept the zone's Light.dbc fog.
 *
 * A record has two halves (`WmoFog.land`, `.water`). The water half is the camera-under-water one,
 * and it is mostly left at the authoring tool's default: over the client's 1,985 roots, 2,429 of the
 * 2,463 records hold end 222.2 with a start scale of −0.5 or −1 (`.runtime/re-2026-10-05/A7b-2/
 * probe-mfog.out.txt`) — a start behind the camera, no distance anyone chose. 33 records carry a
 * positive scale and a real end (Sunken Temple 36.1 × 0.01, Blackfathom 69.4 × 0.1, Black Temple
 * 361.1 × 0.01, the Undercity canals 41.7 × 0.5): only those are read. Under water in a room whose
 * record is the default, the frame keeps what it did before — the zone's own underwater light.
 */

import type { WmoFog } from "./WmoModel.js";

/** One fog: sRGB colour 0–1 and the distances it begins and is whole at. Reused, never retained. */
export interface WmoRoomFog {
  r: number;
  g: number;
  b: number;
  near: number;
  far: number;
}

export function createWmoRoomFog(): WmoRoomFog {
  return { r: 0, g: 0, b: 0, near: 0, far: 0 };
}

/**
 * Writes the half of `fog` a camera `underwater` or not is in into `out`; false when that half
 * cannot be used (an unauthored water half, a non-finite or empty distance) — the caller then keeps
 * the zone's fog. The land half is read as the renderer always read it: `near = end · scale`.
 */
export function wmoRoomFogFor(fog: WmoFog, underwater: boolean, out: WmoRoomFog): boolean {
  const half = underwater ? fog.water : fog.land;
  const { end, scale, colour } = half;
  if (!Number.isFinite(end) || !Number.isFinite(scale) || end <= 0) return false;
  if (underwater && !(scale > 0 && scale < 1)) return false;
  out.r = colour[0] / 255;
  out.g = colour[1] / 255;
  out.b = colour[2] / 255;
  out.near = end * scale;
  out.far = end;
  return true;
}
