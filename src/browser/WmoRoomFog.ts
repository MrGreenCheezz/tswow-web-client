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

import { shapedFogDensity } from "./DistanceFog.js";
import type { WmoFog, WmoGroup, WmoPortals } from "./WmoModel.js";

/** One fog: sRGB colour 0–1 and the distances it begins and is whole at. Reused, never retained. */
export interface WmoRoomFog {
  r: number;
  g: number;
  b: number;
  near: number;
  far: number;
  /** 7.66: the exponent of the linear visibility, 1 on maps under 530 (DistanceFog.ts). */
  density: number;
}

export function createWmoRoomFog(): WmoRoomFog {
  return { r: 0, g: 0, b: 0, near: 0, far: 0, density: 1 };
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
  out.density = 1;
  return true;
}

/*
 * 15.11 (7.55): the land fog of a camera in a WMO group, as Wow.exe builds it, checked against the stand's frames
 * (WowOracle `runs/fog6-*`: VS c30 = −1/(end−start), end/(end−start), density; PS c2 = the colour; numbers in
 * `tests/wmo-room-fog.test.mjs`).
 *
 * 0x007a1150 (called through 0x0077fb90 from the frame's fog, 0x007f16f0):
 * - starts from the WMO's record 0, whatever the group names (white included: the Stormwind keep's throne room
 *   draws 255,255,255 from 111.1 to 444.4);
 * - takes the records the camera's group names in its four MOGP slots (zeros skipped) that are not flagged 1 and
 *   whose outer radius holds the camera, ordered far to near (a max-heap on the distance, 0x007a0f50/0x0097e080),
 *   and blends each over what is there by w = 1 inside the inner radius, else 1 − (d − inner)/(outer − inner):
 *   end and start scale as floats, the colour in bytes by round(255·w) with (to − from)·w >> 8 (0x007a0cd0,
 *   0x006acc50);
 * - measures, from the camera's group through portals into groups without MOGI 0x8|0x40 (four levels at most), the
 *   distance to the nearest portal that leads into one with them, counting only portals nearer than 25 yards
 *   (0x007d8010 → 0x007d77c0, 0x00a2e868); none near reads 25 and more.
 * Then 0x007ed1b0 makes the WMO fog: end = min(end, far clip), start = scale · end, the end at least 30 yards
 * (0x00a19cdc); and 0x007f16f0 mixes the zone's fog towards it by k = clamp(0.04 · distance) (0x00a32e2c): end and
 * start as floats, the colour by round(255·k) in bytes. A line of ten frames from the back of `mageinterior01` to
 * its door to the tower reads k 0.447 … 0.061 against 0.450 … 0.064 computed (`fog6-line-*`): a ramp, 0.04 a yard.
 *
 * On maps from 530 up (DistanceFog.ts, 7.66) 0x007ed1b0 then shapes the room fog: the density from its start and end,
 * the end at the far clip; the zone mix above mixes the density too. Dalaran's Violet Citadel lobby and the Underbelly
 * draw record 0 as 55.6 to 1277 at 5.1667; the bank by its door 66.5, 5.0146 (k 0.9585) (`fog6-n-dal-*`); Black
 * Temple's sewer mouth 108.7, 4.1801 (k 0.86).
 */

/** Yards: a portal to the outside nearer than this mixes the zone's fog in (0x00a2e868). */
export const WMO_FOG_PORTAL_REACH = 25;
/** Per yard from that portal, the share of the room's fog (0x00a32e2c). */
export const WMO_FOG_SHARE_PER_YARD = 0.04;
/** The WMO fog's end never comes nearer (0x00a19cdc). */
export const WMO_FOG_END_FLOOR = 30;
/** Group flags that make a group the outside for this walk: exterior 0x8, exterior-lit 0x40 (0x007a1150). */
const OUTSIDE_GROUP_FLAGS = 0x48;
/** A record flagged so is never blended in (0x007a1150 skips `flags & 1`). */
const SKIPPED_RECORD_FLAG = 0x1;

/** 0x007ed1b0 in fog mode 1: the density from the room fog's own start and end, the end then at `end`, the start not below 0. */
export function shapeWmoRoomFog(room: WmoRoomFog, end: number): void {
  room.density = shapedFogDensity(room.near, room.far);
  room.near = Math.max(0, room.near);
  room.far = end;
}

/**
 * Writes the WMO fog of a camera at (x, y, z) in a group naming `fogIds` into `out` (before the zone mix); false
 * when record 0 is missing or not a distance, and the caller keeps the zone's fog.
 */
export function wmoGroupLandFog(
  fogs: readonly WmoFog[], fogIds: readonly number[], x: number, y: number, z: number, out: WmoRoomFog,
): boolean {
  const base = fogs[0];
  if (!base || !usableLand(base)) return false;
  let end = base.land.end;
  let scale = base.land.scale;
  let r = base.land.colour[0], g = base.land.colour[1], b = base.land.colour[2];
  // Far to near; a group names at most four records, so a tiny insertion order over the slots does.
  const order = ORDER;
  let count = 0;
  for (const id of fogIds) {
    if (id === 0) continue;
    const fog = fogs[id];
    if (!fog || !usableLand(fog) || (fog.flags & SKIPPED_RECORD_FLAG) !== 0) continue;
    const distance = Math.hypot(fog.position[0] - x, fog.position[1] - y, fog.position[2] - z);
    if (!(distance < fog.outerRadius)) continue;
    let at = count++;
    while (at > 0 && order[at - 1]!.distance < distance) {
      order[at] = order[at - 1]!;
      at--;
    }
    order[at] = { fog, distance };
  }
  for (let index = 0; index < count; index++) {
    const { fog, distance } = order[index]!;
    const w = distance < fog.innerRadius || !(fog.outerRadius > fog.innerRadius)
      ? 1 : 1 - (distance - fog.innerRadius) / (fog.outerRadius - fog.innerRadius);
    end += (fog.land.end - end) * w;
    scale += (fog.land.scale - scale) * w;
    const steps = Math.round(w * 255) & 0xff;
    r = mixByte(r, fog.land.colour[0], steps);
    g = mixByte(g, fog.land.colour[1], steps);
    b = mixByte(b, fog.land.colour[2], steps);
  }
  out.r = r / 255;
  out.g = g / 255;
  out.b = b / 255;
  out.near = scale * end;
  out.far = Math.max(WMO_FOG_END_FLOOR, end);
  out.density = 1;
  return true;
}

const ORDER: { fog: WmoFog; distance: number }[] = [];

/** 0x006acc50: a byte towards another by `steps`/256, 255 meaning all the way. */
function mixByte(from: number, to: number, steps: number): number {
  if (steps === 255) return to;
  return (from + Math.floor(((to - from) * steps) / 256)) & 0xff;
}

/**
 * The share k of the room's fog for a camera at (x, y, z) in `groups[start]`: clamp(0.04 · d), d the distance to the
 * nearest portal leading out (see above), 1 when none is within 25 yards.
 */
export function wmoRoomFogShare(
  groups: readonly Pick<WmoGroup, "flags" | "portalStart" | "portalCount">[], portals: WmoPortals | undefined,
  start: number, x: number, y: number, z: number,
): number {
  if (!portals) return 1;
  const distance = outwardPortalDistance(groups, portals, start, -1, 0, x, y, z, WMO_FOG_PORTAL_REACH);
  return Math.min(1, Math.max(0, distance * WMO_FOG_SHARE_PER_YARD));
}

function outwardPortalDistance(
  groups: readonly Pick<WmoGroup, "flags" | "portalStart" | "portalCount">[], portals: WmoPortals,
  group: number, from: number, depth: number, x: number, y: number, z: number, best: number,
): number {
  const here = groups[group];
  if (!here || depth >= 4) return best;
  for (let ref = here.portalStart; ref < here.portalStart + here.portalCount; ref++) {
    const reference = portals.references[ref];
    if (!reference) continue;
    const other = groups[reference.group];
    if (!other || reference.group === from) continue;
    if ((other.flags & OUTSIDE_GROUP_FLAGS) === 0) {
      best = outwardPortalDistance(groups, portals, reference.group, group, depth + 1, x, y, z, best);
    } else {
      const definition = portals.definitions[reference.portal];
      if (!definition) continue;
      const d = pointPolygonDistance(portals.vertices, definition.startVertex, definition.vertexCount, x, y, z);
      if (d < best) best = d;
    }
  }
  return best;
}

/** The distance from a point to a convex planar polygon: to its plane over the inside, to its nearest edge outside. */
export function pointPolygonDistance(
  vertices: Float32Array, startVertex: number, vertexCount: number, x: number, y: number, z: number,
): number {
  if (vertexCount < 3) return Number.POSITIVE_INFINITY;
  const at = startVertex * 3;
  const ax = vertices[at]!, ay = vertices[at + 1]!, az = vertices[at + 2]!;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 1; i + 1 < vertexCount; i++) {
    const bx = vertices[at + i * 3]! - ax, by = vertices[at + i * 3 + 1]! - ay, bz = vertices[at + i * 3 + 2]! - az;
    const cx = vertices[at + i * 3 + 3]! - ax, cy = vertices[at + i * 3 + 4]! - ay, cz = vertices[at + i * 3 + 5]! - az;
    nx += by * cz - bz * cy;
    ny += bz * cx - bx * cz;
    nz += bx * cy - by * cx;
  }
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0)) return Number.POSITIVE_INFINITY;
  nx /= length; ny /= length; nz /= length;
  const plane = (x - ax) * nx + (y - ay) * ny + (z - az) * nz;
  const qx = x - nx * plane, qy = y - ny * plane, qz = z - nz * plane;
  let sign = 0;
  let inside = true;
  let edge = Number.POSITIVE_INFINITY;
  for (let i = 0; i < vertexCount; i++) {
    const p = at + i * 3, q = at + ((i + 1) % vertexCount) * 3;
    const px = vertices[p]!, py = vertices[p + 1]!, pz = vertices[p + 2]!;
    const ex = vertices[q]! - px, ey = vertices[q + 1]! - py, ez = vertices[q + 2]! - pz;
    const wx = qx - px, wy = qy - py, wz = qz - pz;
    const side = (ey * wz - ez * wy) * nx + (ez * wx - ex * wz) * ny + (ex * wy - ey * wx) * nz;
    if (side !== 0) {
      if (sign === 0) sign = Math.sign(side);
      else if (Math.sign(side) !== sign) inside = false;
    }
    const lengthSq = ex * ex + ey * ey + ez * ez;
    const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - px) * ex + (y - py) * ey + (z - pz) * ez) / lengthSq)) : 0;
    edge = Math.min(edge, Math.hypot(x - (px + ex * t), y - (py + ey * t), z - (pz + ez * t)));
  }
  return inside ? Math.abs(plane) : edge;
}

/**
 * 0x007f16f0: the zone's fog mixed towards the room's by k, written into `room`. `zone` is sRGB 0–1 like `room`; the
 * colour goes in bytes by round(255·k), the distances as floats.
 */
export function mixZoneIntoRoomFog(zone: Readonly<WmoRoomFog>, room: WmoRoomFog, k: number): void {
  const steps = Math.round(Math.min(1, Math.max(0, k)) * 255) & 0xff;
  const zr = Math.round(zone.r * 255), zg = Math.round(zone.g * 255), zb = Math.round(zone.b * 255);
  room.r = (steps === 0 ? zr : mixByte(zr, Math.round(room.r * 255), steps)) / 255;
  room.g = (steps === 0 ? zg : mixByte(zg, Math.round(room.g * 255), steps)) / 255;
  room.b = (steps === 0 ? zb : mixByte(zb, Math.round(room.b * 255), steps)) / 255;
  room.near = zone.near + (room.near - zone.near) * k;
  room.far = zone.far + (room.far - zone.far) * k;
  room.density = zone.density + (room.density - zone.density) * k; // 7.66: 0x007f16f0 mixes it too
}

function usableLand(fog: WmoFog): boolean {
  const { end, scale, colour } = fog.land;
  return Number.isFinite(end) && end > 0 && Number.isFinite(scale)
    && colour.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255);
}
