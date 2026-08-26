import { PacketReader } from "../protocol/PacketReader.js";
import type { EnvironmentBounds } from "./VMapProtocol.js";
import type { WvmModel } from "../browser/Wvm.js";
import type { WmoModel } from "../browser/WmoModel.js";

const decoder = new TextDecoder();

/** One animated bone track: `kind` follows M2 — 0 translation, 1 rotation, 2 scale. */
export interface ModelChannel {
  bone: number;
  kind: 0 | 1 | 2;
  /** Key times in seconds, ready for THREE.KeyframeTrack. */
  times: Float32Array;
  /** Translation and scale hold three components per key, rotation holds a unit quaternion. */
  values: Float32Array;
}

export interface ModelClip {
  /** AnimationData.dbc id: 0 stand, 1 death, 4 walk, 5 run, 6 dead, 16/17 attacks. */
  animationId: number;
  duration: number;
  looping: boolean;
  channels: ModelChannel[];
}

export interface ModelSkeleton {
  /** Parent bone index, or -1 for a root. Parents always come before their children. */
  parents: Int16Array;
  /** Rotation centre of each bone in model space. */
  pivots: Float32Array;
  skinIndices: Uint8Array;
  skinWeights: Float32Array;
  clips: ModelClip[];
}

export interface EnvironmentModel {
  vertices: number[];
  indices: number[];
  uvs?: number[];
  textureUrl?: string;
  textureUrls?: string[];
  /**
   * One run of triangles drawn with one material: `material` names the texture, `blendMode` and
   * `flags` are the WMO's own MOMT state for it.
   */
  groups?: Array<{ start: number; count: number; material: number; blendMode?: number; flags?: number }>;
  visual?: boolean;
  skeleton?: ModelSkeleton;
  /**
   * A WVM5 model: the M2 as its file describes it, with geosets labelled, materials intact and
   * nothing about appearance resolved. When present it is the only description worth using — the
   * legacy fields above stay empty for it.
   */
  wvm?: WvmModel;
  /**
   * A WWM1 model: a WMO as the rooms it is made of, each with its own box and its own geometry.
   * Like `wvm` it replaces the legacy fields rather than filling them, and unlike anything else
   * here it can arrive incomplete on purpose — a city sends its boxes and waits to be asked.
   */
  wmo?: WmoModel;
}

export function encodeVMapModel(model: EnvironmentModel): Uint8Array {
  const data = new Uint8Array(8 + (model.vertices.length + model.indices.length) * 4);
  const view = new DataView(data.buffer);
  view.setUint32(0, model.vertices.length / 3, true);
  view.setUint32(4, model.indices.length, true);
  let offset = 8;
  for (const vertex of model.vertices) {
    view.setFloat32(offset, vertex, true);
    offset += 4;
  }
  for (const index of model.indices) {
    view.setUint32(offset, index, true);
    offset += 4;
  }
  return data;
}

const MAGIC = "VMAP_4.8";

function chunk(reader: PacketReader, expected: string): void {
  const actual = decoder.decode(reader.bytes(expected.length));
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}

function skipBih(reader: PacketReader): void {
  reader.bytes(6 * 4);
  const treeSize = reader.u32();
  reader.bytes(treeSize * 4);
  const objectCount = reader.u32();
  reader.bytes(objectCount * 4);
}

/**
 * One group of a collision model, with the bounds the file itself records for it.
 *
 * A WMO is stored group by group — a room, a wing, a floor — and each group carries its own box.
 * Stormwind is 724,760 triangles in one file and there is no sending that to a browser, but there
 * is sending the six groups a player is standing in.
 */
/**
 * A group's liquid: the `MLIQ` grid of the WMO, as the extractor rewrote it into `LIQU`.
 *
 * A WMO carries its own water, and it is not the water of the tile underneath. Stormwind's canals
 * are five of these grids and 2,702 wet tiles; the map file has no liquid under the city at all,
 * and what it does have nearby sits twenty-four yards lower. Anything reading only the tile's
 * liquid draws a dry city.
 *
 * The layout is checked against the recorded chunk size on every grid read — `24 + (x+1)(y+1)*4 +
 * x*y` — because a silent misread here would put water across a city at a plausible height.
 */
export interface CollisionLiquid {
  /** Cells across and along. Heights are one more of each: they sit on the corners. */
  tilesX: number;
  tilesY: number;
  /** The grid's own corner in model space. */
  cornerX: number;
  cornerY: number;
  cornerZ: number;
  /**
   * `LiquidType.dbc` row, already translated out of the old numbering by the extractor.
   *
   * Worth saying because `MOGP` disagrees: of the three models on this dataset that carry liquid,
   * two say 15 there — «Green Lava» — while `LIQU` says 13, «WMO Water», which is what they are.
   * Reading the group's own field would put a lava slab in the gate of Northshire Abbey.
   */
  type: number;
  /** Corner heights, `(tilesX + 1) * (tilesY + 1)` of them, row by row. */
  heights: Float32Array;
  /** One byte a cell. The low nibble reading `0x0f` means the cell is dry. */
  flags: Uint8Array;
}

export interface CollisionGroup {
  /** Model-space bounds, exactly as the file records them. */
  bounds: EnvironmentBounds;
  /** Group flags, `MOGP`'s own: the server reads these to tell an interior from the open air. */
  flags: number;
  /** The authored WMO group id copied into the `.vmo`, distinct from its array index. */
  groupId: number;
  /** Present only on the few groups that have water, lava or slime in them. */
  liquid?: CollisionLiquid;
  vertices: Float32Array;
  indices: Uint32Array;
}

/** Reads the liquid chunk's payload, or nothing when the group has none. */
function readLiquid(payload: Uint8Array): CollisionLiquid | undefined {
  if (payload.byteLength === 0) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tilesX = view.getUint32(0, true);
  const tilesY = view.getUint32(4, true);
  if (tilesX === 0 || tilesY === 0 || tilesX > 1024 || tilesY > 1024) return undefined;
  const corners = (tilesX + 1) * (tilesY + 1);
  if (24 + corners * 4 + tilesX * tilesY !== payload.byteLength) return undefined;
  const heights = new Float32Array(corners);
  for (let index = 0; index < corners; index++) heights[index] = view.getFloat32(24 + index * 4, true);
  return {
    tilesX,
    tilesY,
    cornerX: view.getFloat32(8, true),
    cornerY: view.getFloat32(12, true),
    cornerZ: view.getFloat32(16, true),
    type: view.getUint32(20, true),
    heights,
    flags: payload.slice(24 + corners * 4),
  };
}

/**
 * The same file as `parseVMapModel`, kept in its groups.
 *
 * Collision wants the groups apart and rendering wants them together, so this is the one that
 * reads and the merging one is expressed in terms of it.
 */
export function parseVMapModelGroups(payload: Uint8Array): CollisionGroup[] {
  const reader = new PacketReader(payload);
  const magic = decoder.decode(reader.bytes(8));
  if (magic !== MAGIC) throw new Error(`Unsupported VMAP model ${JSON.stringify(magic)}`);
  chunk(reader, "WMOD");
  reader.u32();
  reader.u32();
  chunk(reader, "GMOD");
  const groupCount = reader.u32();
  if (groupCount > 10_000) throw new RangeError(`VMAP model has too many groups: ${groupCount}`);

  const groups: CollisionGroup[] = [];
  let totalVertices = 0;
  let totalTriangles = 0;
  for (let group = 0; group < groupCount; group++) {
    const lowX = reader.f32();
    const lowY = reader.f32();
    const lowZ = reader.f32();
    const highX = reader.f32();
    const highY = reader.f32();
    const highZ = reader.f32();
    const flags = reader.u32();
    // `GroupModel::writeToFile` stores the root WMO's authored group id after its MOGP flags.
    // Keeping it is what lets a collision floor identify the matching visual WMO group without
    // relying on overlapping AABBs or on whichever placement happened to be visited last.
    const groupId = reader.u32();
    chunk(reader, "VERT");
    reader.u32();
    const vertexCount = reader.u32();
    totalVertices += vertexCount;
    if (totalVertices > 2_000_000) throw new RangeError("VMAP model has too many vertices");
    const vertices = new Float32Array(vertexCount * 3);
    for (let index = 0; index < vertexCount * 3; index++) vertices[index] = reader.f32();
    // A group with no vertices carries no mesh chunks at all, not empty ones.
    if (vertexCount === 0) {
      groups.push({ bounds: { minX: lowX, minY: lowY, minZ: lowZ, maxX: highX, maxY: highY, maxZ: highZ }, flags, groupId, vertices, indices: new Uint32Array(0) });
      continue;
    }

    chunk(reader, "TRIM");
    reader.u32();
    const triangleCount = reader.u32();
    totalTriangles += triangleCount;
    if (totalTriangles > 4_000_000) throw new RangeError("VMAP model has too many triangles");
    const indices = new Uint32Array(triangleCount * 3);
    for (let index = 0; index < triangleCount * 3; index++) indices[index] = reader.u32();
    chunk(reader, "MBIH");
    skipBih(reader);
    chunk(reader, "LIQU");
    const liquid = readLiquid(reader.bytes(reader.u32()));
    groups.push({
      bounds: { minX: lowX, minY: lowY, minZ: lowZ, maxX: highX, maxY: highY, maxZ: highZ },
      flags,
      groupId,
      ...(liquid ? { liquid } : {}),
      vertices,
      indices,
    });
  }
  chunk(reader, "GBIH");
  skipBih(reader);
  reader.assertFinished();
  return groups;
}

export function parseVMapModel(payload: Uint8Array): EnvironmentModel {
  const reader = new PacketReader(payload);
  const magic = decoder.decode(reader.bytes(8));
  if (magic !== MAGIC) throw new Error(`Unsupported VMAP model ${JSON.stringify(magic)}`);
  chunk(reader, "WMOD");
  reader.u32();
  reader.u32();
  chunk(reader, "GMOD");
  const groupCount = reader.u32();
  if (groupCount > 10_000) throw new RangeError(`VMAP model has too many groups: ${groupCount}`);

  const vertices: number[] = [];
  const indices: number[] = [];
  for (let group = 0; group < groupCount; group++) {
    reader.bytes(6 * 4);
    reader.u32();
    reader.u32();
    chunk(reader, "VERT");
    reader.u32();
    const vertexCount = reader.u32();
    if (vertices.length / 3 + vertexCount > 1_000_000) throw new RangeError("VMAP model has too many vertices");
    const base = vertices.length / 3;
    for (let index = 0; index < vertexCount; index++) vertices.push(reader.f32(), reader.f32(), reader.f32());
    if (vertexCount === 0) continue;

    chunk(reader, "TRIM");
    reader.u32();
    const triangleCount = reader.u32();
    if (indices.length / 3 + triangleCount > 2_000_000) throw new RangeError("VMAP model has too many triangles");
    for (let index = 0; index < triangleCount; index++) indices.push(base + reader.u32(), base + reader.u32(), base + reader.u32());
    chunk(reader, "MBIH");
    skipBih(reader);
    chunk(reader, "LIQU");
    reader.bytes(reader.u32());
  }
  chunk(reader, "GBIH");
  skipBih(reader);
  reader.assertFinished();
  return { vertices, indices };
}
