/**
 * 23.10 (7.46): the lamps of a city's open-air streets, for the cinematic profile.
 *
 * Owner, 23.10 (Stormwind's trade district at night): the lamp's glass glows faintly, but there is
 * no halo, no far glow and no pool of light on the cobbles. Measured on `Stormwind.wmo`
 * (`.runtime/lane-swlamps3/`): the city's 215 lamp posts are the WMO's own geometry — an opaque post
 * and four `StormwindLampGlass.blp` panes per lamp, MOMT 0xD0 (SIDN, the night glow) — with no MOLT
 * record within 3 yards of any of them, so neither the doodad heuristic (`modelFixtureLights`) nor
 * the WMO's lights (`WmoFixtureLights.ts`) ever named them. 131 of them stand in groups like
 * `bazaar01` (the trade district's streets), flagged indoor (MOGP 0x2000) as most of a city is, and
 * 84 in the outdoor canal groups.
 *
 * Which groups are open air: MOGP 0x8 (outdoor) or 0x40 (exterior-lit) — Wow.exe's own test for
 * lighting a group by the sun, `(flags & 0x48)` (`WmoMaterialFlags.ts`). Over 106 WMOs (the bench
 * cache's 100 plus Ironforge, the Undercity, Dalaran, Darnassus, Duskwood's inn and Stormwind's
 * harbour) 105 groups are indoor and
 * exterior-lit — Stormwind's district streets, gate tunnels and tree facades, Orgrimmar's streets —
 * and not one of them holds an interior or transition batch; every room (shops, inns, the Lion's
 * Pride Inn, the bank, cellars, dungeons) is indoor without 0x40. So a lamp in such a group is a
 * street lamp, and a room's lamp keeps its old answer: no pool, halo or glow through its walls.
 *
 * Which pieces are lamps: a run with the SIDN flag is lamp glass or a window. Its triangles are
 * gathered into pieces (centroids within `LANTERN_JOIN` yards); a lantern's panes face at least two
 * opposite pairs of the eight horizontal directions and the piece is under `LANTERN_SIZE` yards,
 * where a window is one plane and a bay window (Dalaran's `DAL_WINDOW_04`, 97 pieces facing three
 * adjacent directions) faces no opposite pair. Over the same 106 WMOs: 215 lanterns, every one a
 * `StormwindLampGlass` piece, and none of about 5,000 window pieces.
 *
 * A city arrives group by group (`tools/wwm.mjs`), so a model's lanterns are read from each open-air
 * group's mesh once, the first time it is seen, and kept for the model's life.
 */
import * as THREE from "three";
import type { LocalLightSample } from "./LocalLighting.js";
import { WMO_MATERIAL_SIDN } from "./WmoMaterials.js";
import type { WmoDoodadRooms, WmoGroup, WmoGroupMesh, WmoModel } from "./WmoModel.js";

/** MOGP 0x8 (outdoor) | 0x40 (exterior-lit): Wow.exe lights such a group by the sun. */
export const WMO_GROUP_OPEN_AIR = 0x48;
/** Yards between triangle centroids of one glass piece. */
export const LANTERN_JOIN = 1.5;
/** The finder's grid cell: twice the join, so a neighbour within it is in one of 8 cells. */
const LANTERN_CELL = 2 * LANTERN_JOIN;
/** A lantern's glass fits in this many yards along every axis. */
export const LANTERN_SIZE = 3;
/**
 * A WMO lantern lights as a doodad street lamp does: `StormwindStreetLamp01.m2`'s glass pane is an
 * 8-yard, 1.1-strength fixture of `fixtureColour`'s warm default (`LocalLighting.ts`).
 */
export const WMO_LANTERN_RADIUS = 8;
export const WMO_LANTERN_INTENSITY = 1.1;
export const WMO_LANTERN_COLOUR: readonly [number, number, number] = Object.freeze([1, 0.56, 0.2]);

/** Whether a group stands in the open (outdoor or lit by the sun), whatever its indoor flag says. */
export function wmoGroupOpenAir(group: Pick<WmoGroup, "flags">): boolean {
  return (group.flags & WMO_GROUP_OPEN_AIR) !== 0;
}

/** The lanterns of one group's mesh: model-space centres, x/y/z each. */
export function findWmoLanterns(mesh: Pick<WmoGroupMesh, "positions" | "indices" | "runs">): Float32Array {
  const found: number[] = [];
  const positions = mesh.positions;
  const indices = mesh.indices;
  for (const run of mesh.runs) {
    if ((run.materialFlags & WMO_MATERIAL_SIDN) === 0) continue;
    const end = Math.min(indices.length, run.start + run.count);
    const count = Math.max(0, Math.floor((end - run.start) / 3));
    if (count === 0) continue;
    // 23.10 (7.46 review): pieces are the triangles linked by centroids closer than `LANTERN_JOIN`,
    // found through a grid of cells twice that size: a centroid within reach lies in the cell of this
    // one or its neighbour on the near side along each axis, so each triangle asks 8 cells and a group
    // costs about its SIDN triangle count. The first form asked every piece so far for every
    // triangle, triangles × pieces on a street group with hundreds of window panes (Orgrimmar's
    // bazzaar02 and Warrior02: 2.5–7.6 ms cold in one pass, now 0.6–1.1). The pieces are the same on
    // all 145 groups with SIDN runs of the 106-WMO census: 215 lanterns, none of them a window.
    const centres = new Float64Array(count * 3);
    const sectors = new Uint8Array(count);
    const parent = new Int32Array(count);
    const next = new Int32Array(count);
    const cells = new Map<number, number>();
    const find = (at: number): number => {
      while (parent[at] !== at) { parent[at] = parent[parent[at]!]!; at = parent[at]!; }
      return at;
    };
    for (let triangle = 0; triangle < count; triangle++) {
      const at = run.start + triangle * 3;
      const a = indices[at]! * 3, b = indices[at + 1]! * 3, c = indices[at + 2]! * 3;
      const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
      const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
      const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      parent[triangle] = triangle;
      next[triangle] = -1;
      centres[triangle * 3] = mx; centres[triangle * 3 + 1] = my; centres[triangle * 3 + 2] = mz;
      if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mz)) { parent[triangle] = -1; continue; }
      // Model space is z-up: a pane's facing is its normal's heading, when the normal is mostly level.
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const level = nx * nx + ny * ny;
      if (level > 0.25 * (level + nz * nz)) sectors[triangle] = 1 << (Math.round(Math.atan2(ny, nx) / (Math.PI / 4)) & 7);
      const fx = mx / LANTERN_CELL, fy = my / LANTERN_CELL, fz = mz / LANTERN_CELL;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const sx = fx - ix < 0.5 ? -1 : 1, sy = fy - iy < 0.5 ? -1 : 1, sz = fz - iz < 0.5 ? -1 : 1;
      for (let near = 0; near < 8; near++) {
        const key = lanternCell(ix + ((near & 1) !== 0 ? sx : 0), iy + ((near & 2) !== 0 ? sy : 0), iz + ((near & 4) !== 0 ? sz : 0));
        for (let other = cells.get(key) ?? -1; other >= 0; other = next[other]!) {
          const dx = centres[other * 3]! - mx, dy = centres[other * 3 + 1]! - my, dz = centres[other * 3 + 2]! - mz;
          if (dx * dx + dy * dy + dz * dz >= LANTERN_JOIN * LANTERN_JOIN) continue;
          const mine = find(triangle), theirs = find(other);
          if (mine !== theirs) parent[Math.max(mine, theirs)] = Math.min(mine, theirs);
        }
      }
      const key = lanternCell(ix, iy, iz);
      next[triangle] = cells.get(key) ?? -1;
      cells.set(key, triangle);
    }
    // Per piece, in the order of its first triangle: centroid sum, count, facing sectors, vertex box.
    const slot = new Int32Array(count).fill(-1);
    const pieces: { x: number; y: number; z: number; n: number; sectors: number; box: number[] }[] = [];
    for (let triangle = 0; triangle < count; triangle++) {
      if (parent[triangle] === -1) continue;
      const root = find(triangle);
      let piece = pieces[slot[root]!];
      if (slot[root] === -1 || !piece) {
        slot[root] = pieces.length;
        piece = { x: 0, y: 0, z: 0, n: 0, sectors: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
        pieces.push(piece);
      }
      piece.x += centres[triangle * 3]!; piece.y += centres[triangle * 3 + 1]!; piece.z += centres[triangle * 3 + 2]!;
      piece.n++;
      piece.sectors |= sectors[triangle]!;
      const box = piece.box;
      for (let corner = 0; corner < 3; corner++) {
        const vertex = indices[run.start + triangle * 3 + corner]! * 3;
        for (let axis = 0; axis < 3; axis++) {
          const value = positions[vertex + axis]!;
          if (value < box[axis]!) box[axis] = value;
          if (value > box[axis + 3]!) box[axis + 3] = value;
        }
      }
    }
    for (const piece of pieces) {
      let opposite = 0;
      for (let sector = 0; sector < 4; sector++) {
        if ((piece.sectors & (1 << sector)) !== 0 && (piece.sectors & (1 << (sector + 4))) !== 0) opposite++;
      }
      const box = piece.box;
      if (opposite < 2 || box[3]! - box[0]! >= LANTERN_SIZE || box[4]! - box[1]! >= LANTERN_SIZE
        || box[5]! - box[2]! >= LANTERN_SIZE) continue;
      found.push(piece.x / piece.n, piece.y / piece.n, piece.z / piece.n);
    }
  }
  return new Float32Array(found);
}

/** One grid cell's key; a collision only costs a distance test. */
function lanternCell(x: number, y: number, z: number): number {
  // Kept under 2^30 so the key stays a small integer in V8's maps.
  return (Math.imul(x, 73_856_093) ^ Math.imul(y, 19_349_663) ^ Math.imul(z, 83_492_791)) & 0x3fffffff;
}

/**
 * Milliseconds of group reading one `wmoLanterns` call may spend. A group itself takes 0.07–0.25 ms
 * warm on the 24,000-triangle street groups (best of 60); the first ones read in a session run cold
 * and took 0.6–3.5 ms in one pass on this machine under external load.
 */
export const WMO_LANTERN_SCAN_BUDGET_MS = 0.5;

/** A model's lanterns found so far, in model space; `generation` grows when more are found. */
export interface WmoLanterns {
  positions: Float32Array;
  generation: number;
}

interface LanternScan extends WmoLanterns {
  /** One byte per group: its mesh was read (or it is not open air and never will be). */
  readonly scanned: Uint8Array;
  remaining: number;
  /** 24.10 (7.50): the open-air groups read from their mesh and what each held (`wmoLanternGroups`). */
  readonly read: Map<number, Float32Array>;
  readRevision: number;
}

const LANTERNS = new WeakMap<WmoModel, LanternScan>();
let lanternGeneration = 0;

/** Grows whenever any model finds more lanterns: a far-glow source list built before is stale. */
export function wmoLanternGeneration(): number {
  return lanternGeneration;
}

/** The lanterns of every open-air group of `model` whose mesh has arrived; cheap once all are read. */
export function wmoLanterns(model: WmoModel): WmoLanterns {
  let scan = LANTERNS.get(model);
  if (!scan) {
    scan = newLanternScan(model);
    LANTERNS.set(model, scan);
  }
  if (scan.remaining === 0) return scan;
  let added: number[] | undefined;
  const groups = model.groups;
  // 23.10 (7.46 review): a call reads groups only until `WMO_LANTERN_SCAN_BUDGET_MS` is spent; the
  // rest wait for the next frame, so a city arriving with many street groups does not stall one.
  const started = performance.now();
  for (let index = 0; index < groups.length; index++) {
    if (scan.scanned[index] === 1) continue;
    const group = groups[index]!;
    if (!wmoGroupOpenAir(group) || group.triangleCount === 0) {
      scan.scanned[index] = 1;
      scan.remaining--;
      continue;
    }
    if (!group.mesh) continue;
    scan.scanned[index] = 1;
    scan.remaining--;
    const found = findWmoLanterns(group.mesh);
    scan.read.set(index, found); // 24.10 (7.50)
    scan.readRevision++;
    if (found.length > 0) (added ??= []).push(...found);
    if (performance.now() - started > WMO_LANTERN_SCAN_BUDGET_MS) break;
  }
  if (added) {
    const grown = new Float32Array(scan.positions.length + added.length);
    grown.set(scan.positions);
    grown.set(added, scan.positions.length);
    scan.positions = grown;
    scan.generation++;
    lanternGeneration++;
  }
  return scan;
}

const PLACED = new WeakMap<object, { generation: number; positions: Float32Array }>();
const point = new THREE.Vector3();

/** Scene positions of one placement's lanterns, x/y/z each; recomputed only when more were found. */
export function wmoLanternWorldPositions(placement: object, lanterns: WmoLanterns, modelToWorld: THREE.Matrix4): Float32Array {
  const known = PLACED.get(placement);
  if (known && known.generation === lanterns.generation) return known.positions;
  const model = lanterns.positions;
  const positions = new Float32Array(model.length);
  for (let at = 0; at + 2 < model.length; at += 3) {
    point.set(model[at]!, model[at + 1]!, model[at + 2]!).applyMatrix4(modelToWorld);
    positions[at] = point.x; positions[at + 1] = point.y; positions[at + 2] = point.z;
  }
  PLACED.set(placement, { generation: lanterns.generation, positions });
  return positions;
}

/**
 * One lantern as a fixture sample: the doodad street lamp's colour, reach and strength, a halo, and
 * the same slow flicker `sampleFixtureLight` gives a lamp (none when `worldMs` is undefined: the far
 * glows sample once).
 */
export function sampleWmoLantern(x: number, y: number, z: number, worldMs: number | undefined, result: LocalLightSample): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  result.position.set(x, y, z);
  result.colour.set(WMO_LANTERN_COLOUR[0], WMO_LANTERN_COLOUR[1], WMO_LANTERN_COLOUR[2]);
  result.radius = WMO_LANTERN_RADIUS;
  let flicker = 1;
  if (worldMs !== undefined) {
    const phase = x * 0.71 + y * 0.37 + z * 0.53;
    const seconds = worldMs / 1000;
    flicker = 0.94 + 0.04 * Math.sin(seconds * 4.1 + phase) + 0.02 * Math.sin(seconds * 7.7 + phase * 1.7);
  }
  result.intensity = WMO_LANTERN_INTENSITY * flicker;
  result.client = false;
  result.halo = true;
  return true;
}

/**
 * Whether the MODD record at `ordinal` of a placement's doodad set is named only by open-air groups
 * (WME4, `WmoModel.doodadRooms`). The tile marks every doodad an indoor group names `interior`, and
 * the fixture paths skip those so a room's lamp never shines through its walls; in Stormwind that
 * also took 124 street lamps of open-air indoor groups — the Park's `KalidarStreetLamp01/02`, the
 * Dwarven District's 24 braziers, 77 gate and wall torches, hanging lanterns. 408 lamp doodads
 * named by a room stay out, as do the Lion's Pride Inn's 7. False without a table or an owner.
 */
export function wmoDoodadOpenAir(model: Pick<WmoModel, "groups" | "doodadRooms">, set: number, ordinal: number): boolean {
  const tables = model.doodadRooms ?? [];
  const table = tables[set] ?? tables[0];
  if (!table || !Number.isInteger(ordinal) || ordinal < 0) return false;
  return doodadOpenAir(model, table, ordinal);
}

const OPEN_AIR_DOODADS = new WeakMap<WmoDoodadRooms, Uint8Array>();

function doodadOpenAir(model: Pick<WmoModel, "groups">, table: WmoDoodadRooms, ordinal: number): boolean {
  if (ordinal + 1 >= table.offsets.length) return false;
  let known = OPEN_AIR_DOODADS.get(table);
  if (!known) {
    known = new Uint8Array(table.offsets.length - 1);
    OPEN_AIR_DOODADS.set(table, known);
  }
  if (known[ordinal] === 0) {
    const start = table.offsets[ordinal]!, end = table.offsets[ordinal + 1]!;
    let open = end > start;
    for (let at = start; at < end && open; at++) {
      const group = model.groups[table.groups[at]!];
      open = group !== undefined && wmoGroupOpenAir(group);
    }
    known[ordinal] = open ? 1 : 2;
  }
  return known[ordinal] === 1;
}

function newLanternScan(model: WmoModel): LanternScan {
  return { positions: new Float32Array(0), generation: 0, scanned: new Uint8Array(model.groups.length),
    remaining: model.groups.length, read: new Map(), readRevision: 0 };
}

/**
 * 24.10 (7.50): the open-air groups of `model` read so far, each with the lanterns it held (model
 * space), and a revision that grows with every group read — what `LightTemplateCatalog` keeps
 * between sessions. Undefined before the model was first asked for its lanterns.
 */
export function wmoLanternGroups(model: WmoModel): { readonly readRevision: number; readonly read: ReadonlyMap<number, Float32Array> } | undefined {
  return LANTERNS.get(model); // the scan itself: asked every frame, so no new object
}

/**
 * 24.10 (7.50): lanterns of groups read in an earlier session (`wmoLanternGroups`): those groups
 * count as read and their lanterns light before their meshes arrive. A group read already, out of
 * range or not open air is left as it is, so nothing is counted twice.
 */
export function seedWmoLanterns(model: WmoModel, groups: Iterable<readonly [number, ArrayLike<number>]>): void {
  let scan = LANTERNS.get(model);
  if (!scan) {
    scan = newLanternScan(model);
    LANTERNS.set(model, scan);
  }
  const added: number[] = [];
  for (const [index, positions] of groups) {
    const group = model.groups[index];
    if (!Number.isInteger(index) || !group || scan.scanned[index] === 1 || !wmoGroupOpenAir(group)) continue;
    if (positions.length % 3 !== 0) continue;
    scan.scanned[index] = 1;
    scan.remaining--;
    for (let at = 0; at < positions.length; at++) added.push(positions[at]!);
  }
  if (added.length === 0) return;
  const grown = new Float32Array(scan.positions.length + added.length);
  grown.set(scan.positions);
  grown.set(added, scan.positions.length);
  scan.positions = grown;
  scan.generation++;
  lanternGeneration++;
}
