/**
 * 15.11 (7.54): the portal walk as Wow.exe 12340 runs it, with a frustum per path.
 *
 * Read from the client (`.runtime/re-2026-11-15/portal5/`), not guessed:
 *
 * - `0x7ac060` walks depth first from one group, with the rectangle it is seen through, and no visited set: a group
 *   reached by two paths is visited twice, each time with its own rectangle. It goes no deeper than ten portals (the
 *   depth is compared with 0x00d1bee4, set once from 0x00adfe40 = 10) and never straight back through the group it came
 *   from. A group with MOGP 0x10000 is never entered; it is drawn by its own pass (`0x7ad1f0`, `0x7b3a10`).
 * - A portal is crossed only from the side its reference leads from: the camera's distance to MOPT's plane, negated
 *   for a negative side, must not be below zero.
 * - Its rectangle is computed once a frame (`0x7a9090`): the polygon, at most its first twelve vertices, is clipped
 *   against the view's five planes (`0x7a72a0`, Sutherland-Hodgman) and what is left is projected and bounded
 *   (`0x7a85e0`, `0x7a6b90`). Fewer than three vertices left: the portal is not seen. A camera within 0.01 of the
 *   portal's plane and inside its polygon (`0x7a7210`) sees through the whole screen.
 * - The next rectangle is the portal's cut by the current one, except its top edge, which `0x7ac060` takes from the
 *   portal alone (the listing at 0x7ac311-0x7ac366 compares the bottom, left and right, and the right twice). A cut
 *   thinner than 0.001 on either axis leads nowhere (`0x482870`).
 * - The rectangle becomes a frustum (`0x790e20`: the view's corners interpolated at its edges) that the group is then
 *   drawn with. So a group is drawn when its box meets the frustum of one of its visits, not merely when it is reached.
 * - With the camera in a room (`0x7ad1f0`) the walk enters rooms only, and a portal into the outside leaves a view of
 *   it (`0x7a8f20`, the portal's own rectangle); the outside is then drawn through those views. From outside
 *   (`0x79a160` -> `0x7b3a10` -> `0x7ad350`) each outdoor group in the view starts its own walk across the whole
 *   screen, into rooms only (`target & 0x10008` stops it).
 *
 * - 15.11 (portal8): with the camera over no WMO at all (the caller decides: `wmoOccludersApply`), the map's occluders (`MapOccluders.ts`) hide an outdoor group whose
 *   sphere lies in one's shadow (`0x79a160` asks `0x7cce00` before `0x7b3a10`) and a portal whose polygon does
 *   (`0x7a85e0` asks `0x7ccfa0`). From a room the volumes are built after the room's own walk, so the room's portals
 *   never ask them; this client builds none for a room (their depth, `0x7905b0`, is not read).
 *
 * Not modelled: the terrain horizon an outdoor group must clear before it starts a walk (`0x78fdc0`, read, off: see
 * `TerrainHorizon.ts`) and the batches' own boxes (MOBA; the group's box stands in for them). `0x7968d0` is no merge:
 * it cuts the screen minus the doors' views into rectangles that `0x796c10` fills with the fog colour at the far
 * plane, after every group is chosen, so it changes no group.
 *
 * Cost: each portal's rectangle once a walk, about 5 x 17 plane tests and one division per vertex left; each visit, one
 * box against four planes plus near and far (8 corners) and one rectangle cut per portal it leaves through. On the 146
 * recorded cameras a walk made at most 36 visits.
 */

import type { WmoBounds, WmoPortals } from "./WmoModel.js";
import type { WmoOcclusionPoint } from "./WmoOcclusion.js";
import { mapOccludersHidePoints, mapOccludersHideSphere, type MapOccluderVolumes } from "./MapOccluders.js";

/** `0x79a160` -> `0x7cce00`: whether a group's bounding sphere lies in an occluder's shadow (volumes in model space). */
export function wmoGroupBehindOccluders(bounds: WmoBounds, occluders: MapOccluderVolumes | undefined): boolean {
  if (occluders === undefined || occluders.volumeCount === 0) return false;
  const radius = 0.5 * Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  return mapOccludersHideSphere(occluders, (bounds.minX + bounds.maxX) * 0.5, (bounds.minY + bounds.maxY) * 0.5,
    (bounds.minZ + bounds.maxZ) * 0.5, radius);
}

/** `0x7a85e0`: a portal is clipped and projected by its first twelve vertices only. */
export const WMO_PORTAL_MAX_VERTICES = 12;
/** `0x7ac060`: the deepest a walk goes, 0x00adfe40. */
export const WMO_PORTAL_MAX_DEPTH = 10;
/** `0x7a7210`: how near the portal's plane counts as standing in it (0x009f1968, 0x00a104b4). */
const IN_PORTAL = 0.01;
/** `0x7ac060` through `0x482870`: a cut thinner than this is no opening (0x009e1134). */
const THIN = 0.001;
/** `0x7a85e0`: the smallest w a vertex is divided by (0x009e8cd0). */
const MIN_W = 1e-4;
/** A guard of this client, not Wow.exe's: a graph that walks longer answers nothing and the older walks decide. */
const VISIT_LIMIT = 1 << 15;
/** `0x7968d0` keeps at most 60 views. */
const VIEW_LIMIT = 60;
/** Polygon scratch: twelve vertices, one more per clipping plane, four doubles each. */
const POLYGON_DOUBLES = (WMO_PORTAL_MAX_VERTICES + 6) * 4;

export interface WmoPortalFrustaScratch {
  /** Per portal, four doubles: the rectangle this walk computed (minX, maxX, minY, maxY), or empty (min > max). */
  rects: Float64Array;
  /** Per portal: the walk that computed `rects` there; 0 never. */
  rectWalk: Uint32Array;
  walk: number;
  /** Per portal: a view of the outside was already left there in this walk. */
  viewed: Uint8Array;
  /** Rectangles of the current path, four doubles per depth. */
  readonly path: Float64Array;
  /** Views of the outside, four doubles each. */
  readonly views: Float64Array;
  viewCount: number;
  visits: number;
  readonly polygonA: Float64Array;
  readonly polygonB: Float64Array;
}

export function createWmoPortalFrustaScratch(): WmoPortalFrustaScratch {
  return {
    rects: new Float64Array(0),
    rectWalk: new Uint32Array(0),
    walk: 0,
    viewed: new Uint8Array(0),
    path: new Float64Array((WMO_PORTAL_MAX_DEPTH + 2) * 4),
    views: new Float64Array(VIEW_LIMIT * 4),
    viewCount: 0,
    visits: 0,
    polygonA: new Float64Array(POLYGON_DOUBLES),
    polygonB: new Float64Array(POLYGON_DOUBLES),
  };
}

/**
 * The screen rectangle of a portal polygon clipped to the view (`0x7a72a0`, `0x7a85e0`, `0x7a6b90`), written to
 * `out` at `outAt` as minX, maxX, minY, maxY in NDC; false when nothing of it is in the view. `modelToClip` is
 * column-major, WebGL clip space: the five planes are x = -w, x = w, y = -w, y = w and the near plane z = -w.
 */
export function wmoPortalScreenRect(
  vertices: Float32Array,
  startVertex: number,
  vertexCount: number,
  m: ArrayLike<number>,
  scratch: Pick<WmoPortalFrustaScratch, "polygonA" | "polygonB">,
  out: Float64Array,
  outAt: number,
): boolean {
  let polygon = scratch.polygonA;
  let other = scratch.polygonB;
  const count = Math.min(vertexCount, WMO_PORTAL_MAX_VERTICES);
  for (let corner = 0; corner < count; corner++) {
    const at = (startVertex + corner) * 3;
    const x = vertices[at]!;
    const y = vertices[at + 1]!;
    const z = vertices[at + 2]!;
    polygon[corner * 4] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    polygon[corner * 4 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    polygon[corner * 4 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    polygon[corner * 4 + 3] = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  }
  let size = count;
  for (let plane = 0; plane < 5 && size >= 3; plane++) {
    let kept = 0;
    let previous = size - 1;
    let previousDistance = planeDistance(polygon, previous, plane);
    for (let corner = 0; corner < size; corner++) {
      const distance = planeDistance(polygon, corner, plane);
      if ((distance >= 0) !== (previousDistance >= 0)) {
        // The edge crosses the plane: its point on the plane, from the previous corner towards this one.
        const t = previousDistance / (previousDistance - distance);
        for (let axis = 0; axis < 4; axis++) {
          const from = polygon[previous * 4 + axis]!;
          other[kept * 4 + axis] = from + (polygon[corner * 4 + axis]! - from) * t;
        }
        kept++;
      }
      if (distance >= 0) {
        for (let axis = 0; axis < 4; axis++) other[kept * 4 + axis] = polygon[corner * 4 + axis]!;
        kept++;
      }
      previous = corner;
      previousDistance = distance;
    }
    const swap = polygon;
    polygon = other;
    other = swap;
    size = kept;
  }
  if (size < 3) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let corner = 0; corner < size; corner++) {
    const w = Math.max(polygon[corner * 4 + 3]!, MIN_W);
    const x = polygon[corner * 4]! / w;
    const y = polygon[corner * 4 + 1]! / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!(minX <= maxX && minY <= maxY)) return false;
  out[outAt] = minX;
  out[outAt + 1] = maxX;
  out[outAt + 2] = minY;
  out[outAt + 3] = maxY;
  return true;
}

function planeDistance(polygon: Float64Array, corner: number, plane: number): number {
  const at = corner * 4;
  const w = polygon[at + 3]!;
  switch (plane) {
    case 0: return w + polygon[at]!;
    case 1: return w - polygon[at]!;
    case 2: return w + polygon[at + 1]!;
    case 3: return w - polygon[at + 1]!;
    default: return w + polygon[at + 2]!;
  }
}

/**
 * `0x7a7210`: whether the camera stands in the portal: within 0.01 of its plane and inside its polygon, seen along
 * the axis the plane faces most (`0x9829b0`, `0x9830d0`). Such a portal is seen through the whole screen.
 */
export function wmoCameraInPortal(
  vertices: Float32Array,
  startVertex: number,
  vertexCount: number,
  planes: Float32Array,
  portal: number,
  camera: WmoOcclusionPoint,
): boolean {
  const at = portal * 4;
  const nx = planes[at]!;
  const ny = planes[at + 1]!;
  const nz = planes[at + 2]!;
  const distance = nx * camera.x + ny * camera.y + nz * camera.z + planes[at + 3]!;
  if (!(distance > -IN_PORTAL && distance < IN_PORTAL)) return false;
  // Drop the axis the normal leans on most and test the point in the polygon that is left (even-odd crossings).
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  const u = ax >= ay && ax >= az ? 1 : 0;
  const v = az >= ax && az >= ay ? 1 : 2;
  const pu = u === 0 ? camera.x : camera.y;
  const pv = v === 1 ? camera.y : camera.z;
  let inside = false;
  const count = Math.min(vertexCount, WMO_PORTAL_MAX_VERTICES);
  for (let corner = 0, previous = count - 1; corner < count; previous = corner++) {
    const a = (startVertex + corner) * 3;
    const b = (startVertex + previous) * 3;
    const au = vertices[a + u]!;
    const av = vertices[a + v]!;
    const bu = vertices[b + u]!;
    const bv = vertices[b + v]!;
    if ((av > pv) !== (bv > pv) && pu < (bu - au) * (pv - av) / (bv - av) + au) inside = !inside;
  }
  return inside;
}

/**
 * Whether a model-space box meets the frustum of a screen rectangle (`0x790e20`, then `0x9839e0` by the box's
 * corners): the four planes through the eye and the rectangle's edges, and the view's near and far planes.
 */
export function wmoBoxInScreenRect(bounds: WmoBounds, m: ArrayLike<number>, rects: Float64Array, at: number): boolean {
  const minX = rects[at]!;
  const maxX = rects[at + 1]!;
  const minY = rects[at + 2]!;
  const maxY = rects[at + 3]!;
  let left = 0;
  let right = 0;
  let bottom = 0;
  let top = 0;
  let near = 0;
  let far = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = (corner & 1) !== 0 ? bounds.maxX : bounds.minX;
    const y = (corner & 2) !== 0 ? bounds.maxY : bounds.minY;
    const z = (corner & 4) !== 0 ? bounds.maxZ : bounds.minZ;
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (cx < minX * w) left++;
    if (cx > maxX * w) right++;
    if (cy < minY * w) bottom++;
    if (cy > maxY * w) top++;
    if (cz < -w) near++;
    if (cz > w) far++;
  }
  return left < 8 && right < 8 && bottom < 8 && top < 8 && near < 8 && far < 8;
}

/** What one walk needs of a group. */
export interface WmoPortalFrustaGroup {
  readonly bounds: WmoBounds;
  readonly flags: number;
  readonly portalStart: number;
  readonly portalCount: number;
}

/** What the walk writes per group: reached (visited at all), drawn (its box met a visit's frustum), the union rectangle. */
export interface WmoPortalFrustaOut {
  readonly reached: Uint8Array;
  readonly drawn: Uint8Array;
  /** Four doubles per group, minX, maxX, minY, maxY: the bounds of every rectangle it was visited with. */
  readonly apertures: Float64Array;
}

const OUTDOOR = 0x8;
const ALWAYS_DRAW = 0x10000;

/**
 * One walk. `seeds` start it: with `fromRoom` the camera's room alone, each across the whole screen; otherwise every
 * outdoor group (the caller's choice) whose box is in the view. `out.reached` and `out.drawn` must be cleared by the
 * caller. False when the walk ran past this client's guard.
 */
export function walkWmoPortalFrusta(
  groups: readonly WmoPortalFrustaGroup[],
  portals: WmoPortals,
  planes: Float32Array,
  camera: WmoOcclusionPoint,
  m: ArrayLike<number>,
  seeds: readonly number[] | Int32Array,
  seedCount: number,
  fromRoom: boolean,
  out: WmoPortalFrustaOut,
  scratch: WmoPortalFrustaScratch,
  horizonHidden?: Uint8Array,
  occluders?: MapOccluderVolumes,
): boolean {
  const portalCount = portals.definitions.length;
  if (scratch.rectWalk.length < portalCount) {
    scratch.rects = new Float64Array(portalCount * 4);
    scratch.rectWalk = new Uint32Array(portalCount);
    scratch.viewed = new Uint8Array(portalCount);
    scratch.walk = 0;
  }
  scratch.walk = scratch.walk >= 0xfffffff0 ? 1 : scratch.walk + 1;
  if (scratch.walk === 1) scratch.rectWalk.fill(0);
  scratch.viewed.fill(0, 0, portalCount);
  scratch.viewCount = 0;
  scratch.visits = 0;
  const shadows = occluders !== undefined && occluders.volumeCount > 0 ? occluders : undefined;
  const context: WalkContext = { groups, portals, planes, camera, m, out, scratch, fromRoom, occluders: shadows };
  const path = scratch.path;
  for (let at = 0; at < seedCount; at++) {
    const seed = seeds[at]!;
    path[0] = -1;
    path[1] = 1;
    path[2] = -1;
    path[3] = 1;
    if (!fromRoom && !wmoBoxInScreenRect(groups[seed]!.bounds, m, path, 0)) continue;
    // 15.11: an outdoor group behind the terrain's horizon starts no walk (`0x79a160` asks `0x78fdc0`).
    if (!fromRoom && horizonHidden !== undefined && horizonHidden[seed] === 1) continue;
    // 15.11 (portal8): nor does one in an occluder's shadow (`0x79a160` asks `0x7cce00` first).
    if (!fromRoom && wmoGroupBehindOccluders(groups[seed]!.bounds, shadows)) continue;
    if (!visit(context, seed, -1, 0)) return false;
  }
  if (!fromRoom) return true;
  // From a room the outside is drawn through the views its portals left (`0x7a8f20`): each outdoor group a view shows
  // starts a walk of its own through that view, as from outside (`0x7b3a10` -> `0x7ad350`).
  context.fromRoom = false;
  const views = scratch.views;
  const viewCount = scratch.viewCount;
  for (let index = 0; index < groups.length; index++) {
    const flags = groups[index]!.flags;
    if ((flags & OUTDOOR) === 0 || (flags & ALWAYS_DRAW) !== 0) continue;
    if (horizonHidden !== undefined && horizonHidden[index] === 1) continue;
    if (wmoGroupBehindOccluders(groups[index]!.bounds, shadows)) continue;
    for (let view = 0; view < viewCount; view++) {
      if (!wmoBoxInScreenRect(groups[index]!.bounds, m, views, view * 4)) continue;
      path[0] = views[view * 4]!;
      path[1] = views[view * 4 + 1]!;
      path[2] = views[view * 4 + 2]!;
      path[3] = views[view * 4 + 3]!;
      if (!visit(context, index, -1, 0)) return false;
    }
  }
  return true;
}

interface WalkContext {
  readonly groups: readonly WmoPortalFrustaGroup[];
  readonly portals: WmoPortals;
  readonly planes: Float32Array;
  readonly camera: WmoOcclusionPoint;
  readonly m: ArrayLike<number>;
  readonly out: WmoPortalFrustaOut;
  readonly scratch: WmoPortalFrustaScratch;
  fromRoom: boolean;
  /** The map's occluder volumes in model space, or none. */
  readonly occluders: MapOccluderVolumes | undefined;
}

/** `0x7ac060`: one visit of `index`, seen through the rectangle at `path[depth * 4]`. */
function visit(context: WalkContext, index: number, from: number, depth: number): boolean {
  if (depth > WMO_PORTAL_MAX_DEPTH) return true;
  const { groups, portals, planes, camera, m, out, scratch } = context;
  const group = groups[index]!;
  if ((group.flags & ALWAYS_DRAW) !== 0) return true;
  if (++scratch.visits > VISIT_LIMIT) return false;
  const path = scratch.path;
  const here = depth * 4;
  const apertures = out.apertures;
  const base = index * 4;
  if (out.reached[index] === 0) {
    out.reached[index] = 1;
    apertures[base] = path[here]!;
    apertures[base + 1] = path[here + 1]!;
    apertures[base + 2] = path[here + 2]!;
    apertures[base + 3] = path[here + 3]!;
  } else {
    if (path[here]! < apertures[base]!) apertures[base] = path[here]!;
    if (path[here + 1]! > apertures[base + 1]!) apertures[base + 1] = path[here + 1]!;
    if (path[here + 2]! < apertures[base + 2]!) apertures[base + 2] = path[here + 2]!;
    if (path[here + 3]! > apertures[base + 3]!) apertures[base + 3] = path[here + 3]!;
  }
  if (out.drawn[index] === 0 && wmoBoxInScreenRect(group.bounds, m, path, here)) out.drawn[index] = 1;
  const rects = scratch.rects;
  const next = here + 4;
  const end = group.portalStart + group.portalCount;
  for (let at = group.portalStart; at < end; at++) {
    const reference = portals.references[at]!;
    const target = reference.group;
    if (target === from) continue;
    const plane = reference.portal * 4;
    let facing = planes[plane]! * camera.x + planes[plane + 1]! * camera.y + planes[plane + 2]! * camera.z + planes[plane + 3]!;
    if (reference.side < 0) facing = -facing;
    if (!(facing >= 0)) continue;
    const portal = reference.portal;
    const rect = portal * 4;
    if (scratch.rectWalk[portal] !== scratch.walk) {
      scratch.rectWalk[portal] = scratch.walk;
      const definition = portals.definitions[portal]!;
      if (wmoCameraInPortal(portals.vertices, definition.startVertex, definition.vertexCount, planes, portal, camera)) {
        rects[rect] = -1;
        rects[rect + 1] = 1;
        rects[rect + 2] = -1;
        rects[rect + 3] = 1;
      } else if ((context.occluders !== undefined && mapOccludersHidePoints(context.occluders, portals.vertices,
        definition.startVertex, Math.min(definition.vertexCount, WMO_PORTAL_MAX_VERTICES)))
        || !wmoPortalScreenRect(portals.vertices, definition.startVertex, definition.vertexCount, m, scratch, rects, rect)) {
        rects[rect] = 1;
        rects[rect + 1] = -1;
        rects[rect + 2] = 1;
        rects[rect + 3] = -1;
      }
    }
    const minX = rects[rect]!;
    const maxX = rects[rect + 1]!;
    const minY = rects[rect + 2]!;
    const maxY = rects[rect + 3]!;
    if (!(minX <= maxX)) continue;
    if (!(minX <= path[here + 1]! && path[here]! <= maxX && minY <= path[here + 3]! && path[here + 2]! <= maxY)) continue;
    const cutMinX = Math.max(minX, path[here]!);
    const cutMaxX = Math.min(maxX, path[here + 1]!);
    const cutMinY = Math.max(minY, path[here + 2]!);
    // 0x7ac060 never lowers the top edge to the current rectangle's.
    const cutMaxY = maxY;
    if (Math.abs(cutMinX - cutMaxX) < THIN || Math.abs(cutMinY - cutMaxY) < THIN) continue;
    const targetFlags = groups[target]!.flags;
    if ((targetFlags & (OUTDOOR | ALWAYS_DRAW)) !== 0) {
      // Not entered; from a room a portal into the outside leaves a view of it, once (`0x7a8f20`).
      if (context.fromRoom && (targetFlags & ALWAYS_DRAW) === 0 && scratch.viewed[portal] === 0
        && scratch.viewCount < VIEW_LIMIT) {
        scratch.viewed[portal] = 1;
        const view = scratch.viewCount++ * 4;
        scratch.views[view] = minX;
        scratch.views[view + 1] = maxX;
        scratch.views[view + 2] = minY;
        scratch.views[view + 3] = maxY;
      }
      continue;
    }
    if (depth + 1 > WMO_PORTAL_MAX_DEPTH) continue;
    path[next] = cutMinX;
    path[next + 1] = cutMaxX;
    path[next + 2] = cutMinY;
    path[next + 3] = cutMaxY;
    if (!visit(context, target, index, depth + 1)) return false;
  }
  return true;
}
