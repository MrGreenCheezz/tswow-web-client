/**
 * 3.13 (15.11): the WMO group under an object beyond the collision's reach, from the buildings the renderer holds.
 *
 * Wow.exe 3.3.5a 12340 (`.runtime/re-2026-11-15/go8/c.c`, `d.c`, `e.c`): 0x007C2F80 links an entity to WMO groups by
 * 0x007C2A70 → 0x007C28F0 — a vertical segment from 0.1 above the feet (0x009E3004) to 1000 below (0x009EA080) against
 * the map's loaded WMO geometry; a group hit counts only above the terrain under it (0x007C1660), and with neither a
 * terrain nor a group hit below, the segment is tried upwards (a roof over an object with no ground). It runs when the
 * entity is made or placed and while it holds no link, so every object in a loaded tile has its links.
 *
 * The minimap's membership (MinimapWmoMembership.ts) reads that from the collision near the player; past it (about
 * 120 yards) there was nothing. Here the renderer answers for farther objects from what it holds for the whole drawn
 * area: every placed static WMO (`PlacedWmo`: its groups' boxes in the scene, the model's group meshes). For each due
 * object the same segment is cast through the groups whose scene box stands over the object, triangle by triangle in
 * the model's space, and the nearest hit is published with its group's MOGP flags and the building's model name (the
 * collision's `canonicalModelName`, so a near and a far answer name one building alike). The terrain rule is the page's,
 * which has the height grid (`wmoFloorWins`).
 *
 * How exact against the original: the segment and its ends are the same; the triangles are the group's drawn ones
 * (MOVI), where Wow.exe tests its collision (the BSP over the same triangles less the ones flagged not to collide), so a
 * drawn-only triangle (a banner, a hanging lamp) under the object can be hit here where it is not there. A group whose
 * mesh has not arrived (a held-back room of a large building) cannot answer: the object stays unknown until it does.
 * Game-object WMOs (transports) are not walked, as 0x007C28F0 walks the map's static ones.
 *
 * Cost: objects between `FAR_WMO_NEAR` and `FAR_WMO_REACH` yards of the player only, each cast at most once a second
 * (the minimap's own cadence) and only after it moved half a yard, the held buildings changed or it was unknown; at most
 * `FAR_WMO_CASTS_PER_PASS` casts a pass. A cast tests the boxes of every held building and the triangles of the groups
 * over the object.
 */

import { canonicalCollisionModelName } from "./CollisionClient.js";

/** The published answer for one object (plain data: it crosses from the render worker). */
export interface FarWmoFloorRow {
  /** The map and the WoW position the segment was cast from. */
  map: number;
  x: number;
  y: number;
  z: number;
  /** The hit's height (WoW z); NaN when nothing was hit. */
  floorZ: number;
  /** The hit group's MOGP flags. */
  groupFlags: number;
  /** The building's model (`canonicalCollisionModelName`), "" when nothing was hit. */
  model: string;
  /** The hit came from the upward try. */
  up: boolean;
}

/** Nearer than this the collision answers (it is loaded 90 yards round the player plus a margin). */
export const FAR_WMO_NEAR = 60;
/** Farther than this no minimap shows an object (the outdoor minimap's widest zoom is well inside it). */
export const FAR_WMO_REACH = 300;
/** Wow.exe rebuilds the minimap's lists at most once a second (0x0057DCA0); nothing here is asked sooner. */
export const FAR_WMO_RECHECK_MS = 1000;
/** A move smaller than this (yards, each axis) does not cast again. */
export const FAR_WMO_STEP = 0.5;
/** The object table is walked at most this often (ms). */
export const FAR_WMO_SCAN_MS = 200;
/** Casts a single pass may make; the rest wait for the next pass. */
export const FAR_WMO_CASTS_PER_PASS = 32;
/** The segment: 0.1 above the feet to 1000 below (0x009E3004, 0x009EA080). */
const RISE = 0.1;
const DEPTH = 1000;

interface Box3Like {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}

/** The part of the renderer's `PlacedWmo` read here. */
export interface FarWmoPlacement {
  readonly name: string;
  readonly model: {
    readonly groups: readonly {
      readonly flags: number;
      readonly mesh?: { readonly positions: ArrayLike<number>; readonly indices: ArrayLike<number> } | undefined;
    }[];
  };
  /** Each group's box in the scene (WoW x, z, −y). */
  readonly boxes: readonly (Box3Like | undefined)[];
  readonly worldToModel: { readonly elements: ArrayLike<number> };
}

/** The renderer's environment placements (a Map of them): only the buildings among them are read. */
export interface FarWmoEnvironment {
  values(): Iterable<{ readonly wmo?: FarWmoPlacement | undefined }>;
}

export interface FarWmoObject {
  readonly guid: bigint;
  readonly typeId: number | undefined;
  readonly position?: { readonly x: number; readonly y: number; readonly z: number } | undefined;
}

interface Due {
  at: number;
  revision: number;
  x: number;
  y: number;
  z: number;
  map: number;
  known: boolean;
  seen: number;
}

/** Scratch for one cast. */
const segment = new Float64Array(6);

function toModel(m: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array, at: number): void {
  out[at] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out[at + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out[at + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
}

/**
 * The nearest crossing of the segment `s` (start xyz, end xyz) with a triangle list, as a fraction of the segment;
 * Infinity for none. Both faces count: a floor is hit from above whichever way its triangles wind.
 */
export function segmentHitFraction(s: ArrayLike<number>, positions: ArrayLike<number>, indices: ArrayLike<number>, best: number): number {
  const ox = s[0]!, oy = s[1]!, oz = s[2]!;
  const dx = s[3]! - ox, dy = s[4]! - oy, dz = s[5]! - oz;
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const a = indices[at]! * 3, b = indices[at + 1]! * 3, c = indices[at + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const e1x = positions[b]! - ax, e1y = positions[b + 1]! - ay, e1z = positions[b + 2]! - az;
    const e2x = positions[c]! - ax, e2y = positions[c + 1]! - ay, e2z = positions[c + 2]! - az;
    // Möller–Trumbore.
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inverse = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inverse;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inverse;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    if (t >= 0 && t <= 1 && t < best) best = t;
  }
  return best;
}

/** The union of a building's group boxes (min x, y, z, max x, y, z), made once per boxes list. */
const wholeBoxes = new WeakMap<readonly (Box3Like | undefined)[], Float64Array>();
function wholeBox(boxes: readonly (Box3Like | undefined)[]): Float64Array {
  let whole = wholeBoxes.get(boxes);
  if (whole === undefined) {
    whole = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (const box of boxes) {
      if (box === undefined) continue;
      whole[0] = Math.min(whole[0]!, box.min.x);
      whole[1] = Math.min(whole[1]!, box.min.y);
      whole[2] = Math.min(whole[2]!, box.min.z);
      whole[3] = Math.max(whole[3]!, box.max.x);
      whole[4] = Math.max(whole[4]!, box.max.y);
      whole[5] = Math.max(whole[5]!, box.max.z);
    }
    wholeBoxes.set(boxes, whole);
  }
  return whole;
}

/** The collision's name of a building, made once per name: a cast allocates no strings. */
const canonicalNames = new Map<string, string>();
function canonicalName(name: string): string {
  let canonical = canonicalNames.get(name);
  if (canonical === undefined) {
    canonical = canonicalCollisionModelName(name);
    if (canonicalNames.size > 4096) canonicalNames.clear();
    canonicalNames.set(name, canonical);
  }
  return canonical;
}

/** One cast's answer: undefined when a group over the point has no mesh yet. */
interface CastAnswer {
  floorZ: number;
  flags: number;
  model: string;
  up: boolean;
}
const answer: CastAnswer = { floorZ: Number.NaN, flags: 0, model: "", up: false };

/** 0x007C28F0's segment through every held building, downwards and then (nothing hit) upwards. */
export function castFarWmoFloor(placements: readonly FarWmoPlacement[], x: number, y: number, z: number): CastAnswer | undefined {
  // The scene's axes: WoW x, z, −y.
  const sx = x;
  const sz = -y;
  for (let pass = 0; pass < 2; pass++) {
    const up = pass === 1;
    const fromY = up ? z : z + RISE;
    const toY = up ? z + DEPTH : z + RISE - DEPTH;
    const lowY = up ? fromY : toY;
    const highY = up ? toY : fromY;
    let best = Infinity;
    let bestFlags = 0;
    let bestName = "";
    for (let at = 0; at < placements.length; at++) {
      const placed = placements[at]!;
      const boxes = placed.boxes;
      // The building's whole box first: most buildings stand nowhere near the object.
      const whole = wholeBox(boxes);
      if (sx < whole[0]! || sx > whole[3]! || sz < whole[2]! || sz > whole[5]! || whole[4]! < lowY || whole[1]! > highY) continue;
      let transformed = false;
      for (let index = 0; index < boxes.length; index++) {
        const box = boxes[index];
        if (box === undefined || sx < box.min.x || sx > box.max.x || sz < box.min.z || sz > box.max.z) continue;
        if (box.max.y < lowY || box.min.y > highY) continue;
        const group = placed.model.groups[index];
        if (group === undefined) continue;
        const mesh = group.mesh;
        if (mesh === undefined) return undefined;
        if (!transformed) {
          const m = placed.worldToModel.elements;
          toModel(m, sx, fromY, sz, segment, 0);
          toModel(m, sx, toY, sz, segment, 3);
          transformed = true;
        }
        const t = segmentHitFraction(segment, mesh.positions, mesh.indices, best);
        if (t < best) {
          best = t;
          bestFlags = group.flags;
          bestName = placed.name;
        }
      }
    }
    if (best !== Infinity) {
      answer.floorZ = fromY + (toY - fromY) * best;
      answer.flags = bestFlags;
      answer.model = canonicalName(bestName);
      answer.up = up;
      return answer;
    }
  }
  answer.floorZ = Number.NaN;
  answer.flags = 0;
  answer.model = "";
  answer.up = false;
  return answer;
}

/** The renderer's side: which objects are due, the cast, and the rows it leaves in `RenderResults.farWmoFloors`. */
export class FarWmoFloors {
  readonly #due = new Map<bigint, Due>();
  #placements: FarWmoPlacement[] = [];
  #collectedAt = Number.NEGATIVE_INFINITY;
  #revision = 0;
  #pass = 0;
  #scannedAt = Number.NEGATIVE_INFINITY;
  #scannedMap: number | undefined;
  /** Casts made so far (tests and diagnostics). */
  casts = 0;

  /** Every static building the renderer holds, gathered at most once a second; a change bumps the revision. */
  #collect(environment: FarWmoEnvironment, now: number): void {
    if (now - this.#collectedAt < FAR_WMO_RECHECK_MS) return;
    this.#collectedAt = now;
    const previous = this.#placements;
    const next: FarWmoPlacement[] = [];
    let changed = false;
    for (const rendered of environment.values()) {
      const placed = rendered.wmo;
      if (placed === undefined) continue;
      if (previous[next.length] !== placed) changed = true;
      next.push(placed);
    }
    if (changed || next.length !== previous.length) {
      this.#placements = next;
      this.#revision++;
    }
  }

  /**
   * One pass: casts for the due objects between `FAR_WMO_NEAR` and `FAR_WMO_REACH` of the player and keeps `rows` to
   * the objects in that ring. `now` in milliseconds.
   */
  publish(
    rows: Map<bigint, FarWmoFloorRow>,
    objects: { values(): Iterable<FarWmoObject> } | undefined,
    player: { readonly x: number; readonly y: number } | undefined,
    map: number | undefined,
    environment: FarWmoEnvironment,
    now: number,
  ): void {
    if (objects === undefined || player === undefined || map === undefined) {
      if (rows.size > 0) rows.clear();
      this.#due.clear();
      this.#scannedAt = Number.NEGATIVE_INFINITY;
      return;
    }
    // Nothing is due sooner than a second after its last cast: the object table is walked five times a second at most.
    if (now - this.#scannedAt < FAR_WMO_SCAN_MS && this.#scannedMap === map) return;
    this.#scannedAt = now;
    this.#scannedMap = map;
    const pass = ++this.#pass;
    this.#collect(environment, now);
    const near = FAR_WMO_NEAR * FAR_WMO_NEAR;
    const reach = FAR_WMO_REACH * FAR_WMO_REACH;
    let casts = 0;
    let kept = 0;
    for (const object of objects.values()) {
      const typeId = object.typeId;
      if (typeId !== 3 && typeId !== 4 && typeId !== 5) continue;
      const position = object.position;
      if (position === undefined) continue;
      const dx = position.x - player.x;
      const dy = position.y - player.y;
      const distance = dx * dx + dy * dy;
      if (distance < near || distance > reach) continue;
      let due = this.#due.get(object.guid);
      if (due === undefined) {
        due = { at: Number.NEGATIVE_INFINITY, revision: -1, x: 0, y: 0, z: 0, map: -1, known: false, seen: pass };
        this.#due.set(object.guid, due);
      }
      due.seen = pass;
      const ripe = due.map !== map || (now - due.at >= FAR_WMO_RECHECK_MS && (!due.known || due.revision !== this.#revision
        || Math.abs(position.x - due.x) >= FAR_WMO_STEP || Math.abs(position.y - due.y) >= FAR_WMO_STEP
        || Math.abs(position.z - due.z) >= FAR_WMO_STEP));
      if (ripe && casts < FAR_WMO_CASTS_PER_PASS) {
        casts++;
        this.casts++;
        const hit = castFarWmoFloor(this.#placements, position.x, position.y, position.z);
        due.at = now;
        due.map = map;
        due.revision = this.#revision;
        due.x = position.x;
        due.y = position.y;
        due.z = position.z;
        due.known = hit !== undefined;
        if (hit === undefined) {
          rows.delete(object.guid);
        } else {
          let row = rows.get(object.guid);
          if (row === undefined) {
            row = { map, x: 0, y: 0, z: 0, floorZ: Number.NaN, groupFlags: 0, model: "", up: false };
            rows.set(object.guid, row);
          }
          row.map = map;
          row.x = position.x;
          row.y = position.y;
          row.z = position.z;
          row.floorZ = hit.floorZ;
          row.groupFlags = hit.flags;
          row.model = hit.model;
          row.up = hit.up;
        }
      }
      kept++;
    }
    if (this.#due.size !== kept) {
      for (const [guid, due] of this.#due) {
        if (due.seen === pass) continue;
        this.#due.delete(guid);
        rows.delete(guid);
      }
    }
  }
}
