/**
 * 24.10 (7.50): a building's lamp table — the lamp posts of a WMO's open-air groups, found once by the
 * gateway and handed to the browser before the groups themselves arrive.
 *
 * Stormwind's 215 lamp posts are the city WMO's own geometry (`StormwindLampGlass` SIDN panes, see
 * `src/browser/WmoOpenAirLamps.ts`). The browser found them group by group as the groups' meshes came
 * in, so on a first visit to the trade district the lamp posts lit ≈1.75 s after the loading screen
 * lifted (103 of 149 lamps within 150 yards at the lift). Everything else the light pass needs of a
 * building travels in its root — MOLT (`WmoFixtureLights.ts`), the groups' MOGP flags (open air), WME4
 * (which doodads only open-air groups name) — and the curtain already waits for the root; the lantern
 * centres were the one thing only the group meshes held.
 *
 * Shared by the gateway (`src/gateway/WmoLampTableRoute.ts`, which builds the table from the WWM
 * artifact it already published) and the browser (`WmoOpenAirLamps.ts` finds the same lanterns in a
 * group that arrives without a table), so both answers are one function's: the finder lives here.
 * The gateway may not load browser modules (tests/gateway-build.test.mjs), so the few WWM fields the
 * table reads are read here too; `tests/wmo-lamp-table.test.mjs` holds them equal to `decodeWwm` and
 * `decodeWwmGroup` on the bench cache's real artifacts.
 *
 * The answer (`/visual/wmo-lamps?path=<wmo>&v=1`):
 *
 *   { "version": 1, "groupCount": <the root's group count>, "groups": [[<group>, [x, y, z, …]], …] }
 *
 * — every open-air group (MOGP 0x48) that has triangles, each with its lanterns' model-space centres
 * (float32 values, exactly what the finder gives), empty when it holds none. A group listed counts as
 * read, so the browser never scans its mesh for lanterns.
 */

/** MOGP 0x8 (outdoor) | 0x40 (exterior-lit): Wow.exe lights such a group by the sun. */
export const WMO_GROUP_OPEN_AIR = 0x48;
/** MOMT 0x10: lit by `sidnColour` at night (`WmoMaterials.ts` WMO_MATERIAL_SIDN). */
export const WMO_RUN_SIDN = 0x10;
/** Yards between triangle centroids of one glass piece. */
export const LANTERN_JOIN = 1.5;
/** The finder's grid cell: twice the join, so a neighbour within it is in one of 8 cells. */
const LANTERN_CELL = 2 * LANTERN_JOIN;
/** A lantern's glass fits in this many yards along every axis. */
export const LANTERN_SIZE = 3;

/** Whether a group with these MOGP flags stands in the open (outdoor or lit by the sun). */
export function wmoFlagsOpenAir(flags: number): boolean {
  return (flags & WMO_GROUP_OPEN_AIR) !== 0;
}

/** What the finder reads of one group's mesh (`WmoGroupMesh`). */
export interface LanternMesh {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly runs: readonly { readonly start: number; readonly count: number; readonly materialFlags: number }[];
}

/**
 * The lanterns of one group's mesh: model-space centres, x/y/z each.
 *
 * A run with the SIDN flag is lamp glass or a window. Its triangles are gathered into pieces
 * (centroids within `LANTERN_JOIN` yards); a lantern's panes face at least two opposite pairs of the
 * eight horizontal directions and the piece is under `LANTERN_SIZE` yards, where a window is one plane
 * and a bay window faces no opposite pair (23.10, 7.46: 215 lanterns over 106 WMOs, none a window).
 */
export function findWmoLanterns(mesh: LanternMesh): Float32Array {
  const found: number[] = [];
  const positions = mesh.positions;
  const indices = mesh.indices;
  for (const run of mesh.runs) {
    if ((run.materialFlags & WMO_RUN_SIDN) === 0) continue;
    const end = Math.min(indices.length, run.start + run.count);
    const count = Math.max(0, Math.floor((end - run.start) / 3));
    if (count === 0) continue;
    // 23.10 (7.46 review): pieces are the triangles linked by centroids closer than `LANTERN_JOIN`,
    // found through a grid of cells twice that size: a centroid within reach lies in the cell of this
    // one or its neighbour on the near side along each axis, so each triangle asks 8 cells and a group
    // costs about its SIDN triangle count.
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

// ---- The WWM fields the table reads (`tools/wwm.mjs` writes them; `WmoModel.ts` decodes all of it) ----

const WWM_HEADER_SIZE = 24;
const WWM_GROUP_SIZE = 40;
const WWM_LIGHT_SIZE = 28;
const WWM_BLOCK_HEADER_SIZE = 16;
const WWM_RUN_SIZE = 16;
const WWM_AUTHORED_NORMALS = 0x01;
const WWM_COMPOSITE_STREAMS = 0x02;
const WWM_TRANSITION_VERTICES = 0x04;

/** One group as the root's table states it, and its block when the root carries it. */
export interface WwmLampGroup {
  readonly flags: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** The group's block inside the root (a building under the publisher's budget), else undefined. */
  readonly block: ArrayBuffer | undefined;
}

/** The group table of a WWM1/WWM2 root, with the blocks that travel inside it. Throws on a malformed root. */
export function readWwmLampGroups(data: ArrayBuffer): WwmLampGroup[] {
  if (data.byteLength < WWM_HEADER_SIZE) throw new Error("WMO model is truncated");
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== "WWM1" && magic !== "WWM2") throw new Error("WMO model has an invalid header");
  const groupCount = view.getUint32(4, true);
  const textureCount = view.getUint16(8, true);
  const lightCount = view.getUint16(14, true);
  if (groupCount === 0 || groupCount > 65_535) throw new Error("WMO model has invalid counts");
  if (view.getUint32(16, true) !== data.byteLength) throw new Error("WMO model length does not match");
  if (WWM_HEADER_SIZE + groupCount * WWM_GROUP_SIZE > data.byteLength) throw new Error("WMO model group table is truncated");
  const table: { flags: number; vertexCount: number; triangleCount: number; size: number }[] = [];
  let offset = WWM_HEADER_SIZE;
  for (let index = 0; index < groupCount; index++, offset += WWM_GROUP_SIZE) {
    table.push({ flags: view.getUint32(offset + 24, true), vertexCount: view.getUint32(offset + 28, true),
      triangleCount: view.getUint32(offset + 32, true), size: view.getUint32(offset + 36, true) });
  }
  for (let index = 0; index < textureCount; index++) {
    if (offset + 2 > data.byteLength) throw new Error("WMO model texture table is truncated");
    offset += 2 + view.getUint16(offset, true);
  }
  offset = ((offset + 3) & ~3) + lightCount * WWM_LIGHT_SIZE;
  const groups: WwmLampGroup[] = [];
  for (const entry of table) {
    let block: ArrayBuffer | undefined;
    if (entry.size > 0) {
      if (offset + entry.size > data.byteLength) throw new Error("WMO model group block is truncated");
      block = data.slice(offset, offset + entry.size);
      offset += entry.size;
    }
    groups.push({ flags: entry.flags, vertexCount: entry.vertexCount, triangleCount: entry.triangleCount, block });
  }
  return groups;
}

/** One group block's geometry, as far as the finder needs it, and the group it says it is. */
export function readWwmLampMesh(data: ArrayBuffer): { index: number; mesh: LanternMesh } {
  if (data.byteLength < WWM_BLOCK_HEADER_SIZE) throw new Error("WMO group is truncated");
  const view = new DataView(data);
  const vertexCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);
  const runCount = view.getUint16(8, true);
  const indexBytes = view.getUint8(10);
  const streamFlags = view.getUint8(11);
  const index = view.getUint16(12, true);
  const lightRefCount = view.getUint16(14, true);
  if (vertexCount === 0 || vertexCount > 1_000_000 || indexCount % 3 !== 0 || indexCount > 6_000_000
    || (indexBytes !== 2 && indexBytes !== 4)
    || (streamFlags & ~(WWM_AUTHORED_NORMALS | WWM_COMPOSITE_STREAMS | WWM_TRANSITION_VERTICES)) !== 0) {
    throw new Error("WMO group has invalid counts or stream flags");
  }
  const vertexStride = 24 + ((streamFlags & WWM_AUTHORED_NORMALS) !== 0 ? 12 : 0);
  const compositeOffset = WWM_BLOCK_HEADER_SIZE + vertexCount * vertexStride;
  const transitionOffset = compositeOffset
    + ((streamFlags & WWM_COMPOSITE_STREAMS) !== 0 ? vertexCount * 8 + ((vertexCount + 3) & ~3) : 0);
  const indexOffset = transitionOffset + ((streamFlags & WWM_TRANSITION_VERTICES) !== 0 ? 4 : 0);
  const runOffset = indexOffset + ((indexCount * indexBytes + 3) & ~3);
  const lightOffset = runOffset + runCount * WWM_RUN_SIZE;
  if (lightOffset + ((lightRefCount * 2 + 3) & ~3) !== data.byteLength) throw new Error("WMO group length is invalid");
  const positions = new Float32Array(data.slice(WWM_BLOCK_HEADER_SIZE, WWM_BLOCK_HEADER_SIZE + vertexCount * 12));
  const indices = indexBytes === 2
    ? new Uint16Array(data.slice(indexOffset, indexOffset + indexCount * 2))
    : new Uint32Array(data.slice(indexOffset, indexOffset + indexCount * 4));
  for (let at = 0; at < indices.length; at++) if (indices[at]! >= vertexCount) throw new Error("WMO group index is out of range");
  const runs: { start: number; count: number; materialFlags: number }[] = [];
  for (let run = 0; run < runCount; run++) {
    const at = runOffset + run * WWM_RUN_SIZE;
    const start = view.getUint32(at, true);
    const count = view.getUint32(at + 4, true);
    if (count === 0 || count % 3 !== 0 || start + count > indexCount) throw new Error("WMO group run does not fit its geometry");
    runs.push({ start, count, materialFlags: view.getUint8(at + 11) });
  }
  return { index, mesh: { positions, indices, runs } };
}

// ---- The table -----------------------------------------------------------------------------------------

/** The answer's shape; the request names it as `?v=`. */
export const WMO_LAMP_TABLE_VERSION = 1;
export const WMO_LAMP_TABLE_ROUTE = "/visual/wmo-lamps";
/** Lantern coordinates a table may carry (Stormwind: 645). */
const MAX_TABLE_NUMBERS = 300_000;

export interface WmoLampTable {
  readonly version: typeof WMO_LAMP_TABLE_VERSION;
  /** The root's group count: a table for another generation of the model is not this one's. */
  readonly groupCount: number;
  /** Every open-air group with triangles, and its lanterns (model space, x/y/z each). */
  readonly groups: readonly (readonly [number, readonly number[]])[];
}

/**
 * Builds a model's table from its published root and, for a group whose block the root does not carry,
 * `readGroup` (the gateway reads `<hash>.gNNN.bin`). `pause` runs between groups that were read (the
 * gateway yields its event loop there). Throws when a group's block is missing or does not match.
 */
export async function buildWmoLampTable(root: ArrayBuffer, readGroup: (index: number) => Promise<ArrayBuffer>,
  pause?: () => Promise<void>): Promise<WmoLampTable> {
  const groups = readWwmLampGroups(root);
  const out: [number, number[]][] = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (!wmoFlagsOpenAir(group.flags) || group.triangleCount === 0) continue;
    const { index: named, mesh } = readWwmLampMesh(group.block ?? await readGroup(index));
    if (named !== index || mesh.positions.length / 3 !== group.vertexCount || mesh.indices.length / 3 !== group.triangleCount) {
      throw new Error(`WMO group ${index} does not match its root`);
    }
    out.push([index, Array.from(findWmoLanterns(mesh))]);
    if (pause) await pause();
  }
  return { version: WMO_LAMP_TABLE_VERSION, groupCount: groups.length, groups: out };
}

/** A table out of the route's JSON; undefined for a body that is not one (version 1 only). */
export function parseWmoLampTable(value: unknown): WmoLampTable | undefined {
  const body = value as { version?: unknown; groupCount?: unknown; groups?: unknown } | null;
  if (!body || typeof body !== "object" || body.version !== WMO_LAMP_TABLE_VERSION) return undefined;
  const groupCount = body.groupCount;
  if (typeof groupCount !== "number" || !Number.isInteger(groupCount) || groupCount < 1 || groupCount > 65_535
    || !Array.isArray(body.groups)) return undefined;
  let numbers = 0;
  let last = -1;
  for (const entry of body.groups as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [index, positions] = entry as [unknown, unknown];
    // Ascending and in range: one entry per group.
    if (typeof index !== "number" || !Number.isInteger(index) || index <= last || index >= groupCount) return undefined;
    last = index;
    if (!Array.isArray(positions) || positions.length % 3 !== 0) return undefined;
    numbers += positions.length;
    if (numbers > MAX_TABLE_NUMBERS) return undefined;
    for (const number of positions as unknown[]) if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
  }
  return body as WmoLampTable;
}
