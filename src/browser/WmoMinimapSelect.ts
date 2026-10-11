/**
 * 12.10 (7.27): which baked tiles the building minimap draws, and in which order — Wow.exe 3.3.5a 12340,
 * read 12.10 (`.runtime/re-2026-10-12/mm1210/mm1210-a…m.txt`).
 *
 * - The query (0x007F5BA0): with `s` the minimap's radius in yards (the indoor zoom table at 0x00A41E1C:
 *   150, 120, 90, 60, 40, 25 by `minimapInsideZoom`, default 3), the world cell `floor(x / s)·s` grown by `s`
 *   each way — `[x0 − s, x0 + 2s] × [y0 − s, y0 + 2s] × [z − 1.5s, z + s]` (0x0070BD70) — taken into the
 *   model as an axis-aligned box (0x007F9430), its top replaced by the character's group's MOGP box top
 *   (0x007B00A0). Recomputed only when the character leaves the cell or changes group.
 * - The tiles of one group (0x007AF8D0): `ceil(extent / 128)` along each model axis, each `pixels / 2` yards,
 *   `pixels = clamp(2^ceil(log2(extent / 128 · 256)), 32, 256)` (constants 0x00D1C47C = 128, 0x009E2A4C =
 *   256, 0x00AEE00C = 0.5); the outer edges of the grid are pushed out by 1 yard (2 × 0.5). A tile is kept
 *   when its rectangle meets the query box in X and Y; at most 256 (the caller's 0x100). Checked against the
 *   corpus 12.10: 10,984 of 10,992 bakes have exactly the rule's size (the 8 others are one flat 0.1-yard
 *   group), 6,126 of 6,126 groups keep their cells inside the rule's grid.
 * - `rooms` (0x007AFC70): from the character's group, the groups whose MOGP `flags & mask` equal the start
 *   group's value (`WmoMinimapGate.ts`), each visited once, whose box meets the query box in X and Y, add
 *   their tiles; the walk goes on through each portal (MOPR of the group) to a group that is not the one it
 *   came from, not MOGI 0x80, and whose portal polygon is not wholly outside the query box on one side
 *   (0x007AE1F0 outcodes), at most `minimapPortalMax` (default "99") deep. Groups with MOGP id 0x59E7/0x59E8
 *   (Valgarde's `valgarde_80gw` groups 16 and 22) are never walked into; started in, they add their own
 *   tiles and no portal is followed.
 * - `whole` (0x007AFE70): the root box cut the same way, every tile named with group number `nGroups`.
 * - Order (0x007F5070 depth, 0x0057BD10 list, 0x00581290 draw): ascending by the tile's mid height less the
 *   character's model height, frozen at the query; the character's own group last (FLT_MAX), on top.
 *
 * Everything lives in fixed arrays of 256 reused for every query: the minimap repaints up to ~10 Hz and a
 * query runs only on a new cell or group.
 */

import { wmoMinimapKindMask, wmoMinimapKindValue, MOGP_UNREACHABLE } from "./WmoMinimapGate.js";
import { wmoModelToWorld, wmoWorldToModel, type WmoMinimapPlacement } from "./WmoMinimapDraw.js";
import { WMO_MINIMAP_TILE_SIZE } from "./WmoMinimapTiles.js";

/** The caller's capacity (0x007F5BA0 passes 0x100). */
export const WMO_MINIMAP_TILE_LIMIT = 256;
/** `minimapPortalMax`, "Max Number of Portals to traverse for minimap", default "99" (0x0051D9B0). */
export const WMO_MINIMAP_PORTAL_MAX = 99;
/** Yards per bake pixel (0x00AEE00C). */
export const WMO_MINIMAP_YARDS_PER_PIXEL = 0.5;
/** The grid's outer margin (0x007AF8D0 `0.5 + 0.5`). */
export const WMO_MINIMAP_EDGE = 1;
/** MOGP group ids the walk never enters (0x007AFC70). */
const WALK_STOP_IDS: readonly number[] = [0x59e7, 0x59e8];

export interface WmoMinimapBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** A group as the visual WMO artifact keeps it (`WmoModel.ts` `WmoGroup`), in file order. */
export interface WmoMinimapGroup {
  readonly bounds: WmoMinimapBounds;
  readonly boundsValid?: boolean;
  readonly flags: number;
  readonly portalStart: number;
  readonly portalCount: number;
}

/** MOPV/MOPT/MOPR (`WmoModel.ts` `WmoPortals`). */
export interface WmoMinimapPortals {
  readonly vertices: Float32Array;
  readonly definitions: readonly { readonly startVertex: number; readonly vertexCount: number }[];
  readonly references: readonly { readonly portal: number; readonly group: number }[];
}

export interface WmoMinimapModel {
  readonly groups: readonly WmoMinimapGroup[];
  readonly portals?: WmoMinimapPortals | undefined;
}

/** Bake pixels along one axis of a group whose box is `extent` yards long (0x007AF8D0). */
export function wmoMinimapTilePixels(extent: number): number {
  const pixels = 2 ** Math.ceil(Math.log2(extent / WMO_MINIMAP_TILE_SIZE * 256));
  // NaN and an empty box fall to the bottom, as the original's `1 << ftol(…)` does.
  return pixels >= 256 ? 256 : pixels >= 32 ? pixels : 32;
}

/** Tiles along one axis (0x007AF8D0 `ceil(extent / 128)`). */
export function wmoMinimapTileCount(extent: number): number {
  return Math.ceil(extent / WMO_MINIMAP_TILE_SIZE);
}

/** The tiles of one query: parallel arrays, `count` used, `order` the draw order. */
export class WmoMinimapTileList {
  count = 0;
  readonly group = new Int32Array(WMO_MINIMAP_TILE_LIMIT);
  readonly x = new Int32Array(WMO_MINIMAP_TILE_LIMIT);
  readonly y = new Int32Array(WMO_MINIMAP_TILE_LIMIT);
  /** `minX, minY, maxX, maxY` of each tile in model space, outer margin included. */
  readonly rect = new Float64Array(WMO_MINIMAP_TILE_LIMIT * 4);
  /** The tile's height: its box's middle (0x007AF8D0 writes it as both Z of the tile). */
  readonly z = new Float64Array(WMO_MINIMAP_TILE_LIMIT);
  readonly depth = new Float64Array(WMO_MINIMAP_TILE_LIMIT);
  readonly order = new Int32Array(WMO_MINIMAP_TILE_LIMIT);
  /**
   * Each tile's corners in world space, for the draw: picture top-left, picture right, picture down
   * (`wmoMinimapPictureCorners`), six numbers a tile.
   */
  readonly world = new Float64Array(WMO_MINIMAP_TILE_LIMIT * 6);
  /** Each tile's world X/Y extent, `minX, minY, maxX, maxY`: the draw skips one outside the circle. */
  readonly reach = new Float64Array(WMO_MINIMAP_TILE_LIMIT * 4);
  /** Each tile's bake md5, resolved once per query; undefined when md5translate has none. */
  readonly hashes: (string | undefined)[] = new Array<string | undefined>(WMO_MINIMAP_TILE_LIMIT).fill(undefined);
}

/** 0x007AF8D0: one group's (or the root's) tiles meeting `box` in X and Y, appended to `list`. */
export function collectWmoMinimapTiles(
  list: WmoMinimapTileList, box: WmoMinimapBounds, groupIndex: number, bounds: WmoMinimapBounds,
): void {
  const extentX = bounds.maxX - bounds.minX;
  const extentY = bounds.maxY - bounds.minY;
  const columns = wmoMinimapTileCount(extentX);
  const rows = wmoMinimapTileCount(extentY);
  if (!(rows >= 1)) return;
  const width = wmoMinimapTilePixels(extentX) * WMO_MINIMAP_YARDS_PER_PIXEL;
  const height = wmoMinimapTilePixels(extentY) * WMO_MINIMAP_YARDS_PER_PIXEL;
  const z = (bounds.maxZ + bounds.minZ) * 0.5;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      let minX = column * width + bounds.minX;
      let minY = row * height + bounds.minY;
      let maxX = minX + width;
      let maxY = minY + height;
      if (column === 0) minX -= WMO_MINIMAP_EDGE;
      if (row === 0) minY -= WMO_MINIMAP_EDGE;
      if (column === columns - 1) maxX += WMO_MINIMAP_EDGE;
      if (row === rows - 1) maxY += WMO_MINIMAP_EDGE;
      if (box.minX > maxX || box.minY > maxY || !(minX < box.maxX) || !(minY < box.maxY)) continue;
      const at = list.count;
      if (at >= WMO_MINIMAP_TILE_LIMIT) continue;
      list.group[at] = groupIndex;
      list.x[at] = column;
      list.y[at] = row;
      list.rect[at * 4] = minX;
      list.rect[at * 4 + 1] = minY;
      list.rect[at * 4 + 2] = maxX;
      list.rect[at * 4 + 3] = maxY;
      list.z[at] = z;
      list.hashes[at] = undefined;
      list.count = at + 1;
    }
  }
}

/** 0x007AE2B0: two boxes meet in X and Y. */
function meetsXY(bounds: WmoMinimapBounds, box: WmoMinimapBounds): boolean {
  return box.minX <= bounds.maxX && box.minY <= bounds.maxY && bounds.minX < box.maxX && bounds.minY < box.maxY;
}

/** 0x007AE1F0 over a portal's vertices: false when all of them lie beyond one face of the box. */
export function wmoMinimapPortalTouches(portals: WmoMinimapPortals, portal: number, box: WmoMinimapBounds): boolean {
  const definition = portals.definitions[portal];
  if (!definition || definition.vertexCount <= 0) return false;
  const vertices = portals.vertices;
  let outside = 0x3f;
  for (let index = 0; index < definition.vertexCount; index++) {
    const at = (definition.startVertex + index) * 3;
    if (at + 2 >= vertices.length) return false;
    const x = vertices[at]!, y = vertices[at + 1]!, z = vertices[at + 2]!;
    let code = 0;
    if (x < box.minX) code |= 0x1;
    if (y < box.minY) code |= 0x2;
    if (z < box.minZ) code |= 0x4;
    if (x > box.maxX) code |= 0x8;
    if (y > box.maxY) code |= 0x10;
    if (z > box.maxZ) code |= 0x20;
    outside &= code;
  }
  return outside === 0;
}

let visited = new Uint32Array(64);
let stamp = 0;

function walk(
  model: WmoMinimapModel, groupIndex: number, previous: number, box: WmoMinimapBounds, list: WmoMinimapTileList,
  mask: number, value: number, depth: number, stops: Uint8Array | undefined,
): void {
  const groups = model.groups;
  const group = groups[groupIndex];
  if (!group || (group.flags & mask) !== value || visited[groupIndex] === stamp) return;
  visited[groupIndex] = stamp;
  if (group.boundsValid === false || !meetsXY(group.bounds, box)) return;
  collectWmoMinimapTiles(list, box, groupIndex, group.bounds);
  if (stops?.[groupIndex] === 1) return;
  const portals = model.portals;
  if (!portals || group.portalCount === 0 || depth >= WMO_MINIMAP_PORTAL_MAX) return;
  for (let index = 0; index < group.portalCount; index++) {
    const reference = portals.references[group.portalStart + index];
    if (!reference) break;
    const other = reference.group;
    if (other === 0xffff || other === previous) continue;
    const target = groups[other];
    if (!target || (target.flags & MOGP_UNREACHABLE) !== 0) continue;
    if (!wmoMinimapPortalTouches(portals, reference.portal, box) || stops?.[other] === 1) continue;
    // 0x007AFC70 counts every portal it goes through, siblings included, against the limit.
    depth++;
    walk(model, other, groupIndex, box, list, mask, value, depth, stops);
  }
}

const UNION = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

/**
 * MOHD's box, which the visual artifact does not carry, as the union of the groups' boxes: equal in X and Y
 * for 759 of the 788 baked roots (12.10), both roots with a whole-building set (Stormwind, Dalaran) among them.
 */
export function wmoMinimapRootBounds(groups: readonly WmoMinimapGroup[], out = UNION): WmoMinimapBounds | undefined {
  let any = false;
  for (const group of groups) {
    if (group.boundsValid === false) continue;
    const b = group.bounds;
    if (!any) {
      out.minX = b.minX; out.minY = b.minY; out.minZ = b.minZ; out.maxX = b.maxX; out.maxY = b.maxY; out.maxZ = b.maxZ;
      any = true;
      continue;
    }
    if (b.minX < out.minX) out.minX = b.minX;
    if (b.minY < out.minY) out.minY = b.minY;
    if (b.minZ < out.minZ) out.minZ = b.minZ;
    if (b.maxX > out.maxX) out.maxX = b.maxX;
    if (b.maxY > out.maxY) out.maxY = b.maxY;
    if (b.maxZ > out.maxZ) out.maxZ = b.maxZ;
  }
  return any ? out : undefined;
}

/**
 * 0x007B00A0: the query's tiles into `list` (cleared first) — the whole-building set or the room walk from
 * `current` (a file group index). `stops` marks the groups with MOGP id 0x59E7/0x59E8, when known.
 */
export function selectWmoMinimapTiles(
  list: WmoMinimapTileList, model: WmoMinimapModel, mode: "whole" | "rooms", current: number, box: WmoMinimapBounds,
  stops?: Uint8Array,
): void {
  list.count = 0;
  if (mode === "whole") {
    const root = wmoMinimapRootBounds(model.groups);
    if (root) collectWmoMinimapTiles(list, box, model.groups.length, root);
    return;
  }
  const start = model.groups[current];
  if (!start) return;
  if (visited.length < model.groups.length) visited = new Uint32Array(Math.max(model.groups.length, visited.length * 2));
  stamp = (stamp + 1) >>> 0;
  if (stamp === 0) {
    visited.fill(0);
    stamp = 1;
  }
  walk(model, current, current, box, list, wmoMinimapKindMask(start.flags), wmoMinimapKindValue(start.flags), 0, stops);
}

/** Whether a MOGP group id is one 0x007AFC70 never walks into. */
export function wmoMinimapWalkStops(groupId: number): boolean {
  return WALK_STOP_IDS.includes(groupId);
}

const CORNER = { x: 0, y: 0, z: 0 };

/**
 * The query box (see the module comment) for a character at world (`x`, `y`, `z`), radius `radius` yards,
 * standing in a group whose model box tops out at `groupMaxZ`; written into `out`.
 */
export function wmoMinimapQueryBox(
  placement: WmoMinimapPlacement, x: number, y: number, z: number, radius: number, groupMaxZ: number,
  out: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): typeof out {
  const cellX = Math.floor(x / radius) * radius;
  const cellY = Math.floor(y / radius) * radius;
  const lowX = cellX - radius, highX = cellX + 2 * radius;
  const lowY = cellY - radius, highY = cellY + 2 * radius;
  const lowZ = z - 1.5 * radius, highZ = z + radius;
  out.minX = out.minY = out.minZ = Number.POSITIVE_INFINITY;
  out.maxX = out.maxY = out.maxZ = Number.NEGATIVE_INFINITY;
  for (let corner = 0; corner < 8; corner++) {
    wmoWorldToModel(placement, corner & 1 ? highX : lowX, corner & 2 ? highY : lowY, corner & 4 ? highZ : lowZ, CORNER);
    if (CORNER.x < out.minX) out.minX = CORNER.x;
    if (CORNER.y < out.minY) out.minY = CORNER.y;
    if (CORNER.z < out.minZ) out.minZ = CORNER.z;
    if (CORNER.x > out.maxX) out.maxX = CORNER.x;
    if (CORNER.y > out.maxY) out.maxY = CORNER.y;
    if (CORNER.z > out.maxZ) out.maxZ = CORNER.z;
  }
  out.maxZ = groupMaxZ;
  return out;
}

/** 0x007F5070/0x0057BD10: depths and the draw order of the tiles in `list`. */
export function orderWmoMinimapTiles(list: WmoMinimapTileList, current: number, playerModelZ: number): void {
  const { order, depth } = list;
  for (let at = 0; at < list.count; at++) {
    depth[at] = list.group[at] === current ? Number.MAX_VALUE : list.z[at]! - playerModelZ;
    // Insertion by depth; ties keep the query's order (the original's ties follow its slot order, which is
    // not the query's either — tiles of one group, which share a depth, do not overlap).
    let slot = at;
    while (slot > 0 && depth[order[slot - 1]!]! > depth[at]!) {
      order[slot] = order[slot - 1]!;
      slot--;
    }
    order[slot] = at;
  }
}

/**
 * 0x0057E7F0 (12.10): where a tile's picture lies, in model space — picture top-left at (minX, maxY), picture
 * right along +X, picture down along −Y (the quad's UVs: (minX, minY) ↔ (½ texel, 1 − ½ texel), (maxX, maxY)
 * ↔ (1 − ½, ½)). The corpus agrees: over 9,249 bakes the opaque rectangle sits where this lay puts the
 * group's box on 4,285 of 4,286 tiles where the eight lays disagree, mean overlap 0.850 against ≤ 0.603
 * for every other lay (12.10 probe `bbox2`); against Stormwind's ADT bakes (roofs above interiors) the
 * picture's edges correlate best under it too, r 0.097 against ≤ 0.037. World corners of tile `at` written
 * into `list.world`: origin, picture-right step, picture-down step (x, y each), at the model height `modelZ`.
 */
export function wmoMinimapPictureCorners(
  list: WmoMinimapTileList, at: number, placement: WmoMinimapPlacement, modelZ: number,
): void {
  const minX = list.rect[at * 4]!, minY = list.rect[at * 4 + 1]!, maxX = list.rect[at * 4 + 2]!, maxY = list.rect[at * 4 + 3]!;
  const world = list.world;
  wmoModelToWorld(placement, minX, maxY, modelZ, CORNER);
  const ox = CORNER.x, oy = CORNER.y;
  wmoModelToWorld(placement, maxX, maxY, modelZ, CORNER);
  world[at * 6] = ox;
  world[at * 6 + 1] = oy;
  world[at * 6 + 2] = CORNER.x - ox;
  world[at * 6 + 3] = CORNER.y - oy;
  wmoModelToWorld(placement, minX, minY, modelZ, CORNER);
  world[at * 6 + 4] = CORNER.x - ox;
  world[at * 6 + 5] = CORNER.y - oy;
  // The parallelogram's four corners: origin, + right, + down, + both.
  const ux = world[at * 6 + 2]!, uy = world[at * 6 + 3]!, vx = world[at * 6 + 4]!, vy = world[at * 6 + 5]!;
  const reach = list.reach;
  reach[at * 4] = ox + Math.min(0, ux) + Math.min(0, vx);
  reach[at * 4 + 1] = oy + Math.min(0, uy) + Math.min(0, vy);
  reach[at * 4 + 2] = ox + Math.max(0, ux) + Math.max(0, vx);
  reach[at * 4 + 3] = oy + Math.max(0, uy) + Math.max(0, vy);
}
