import { PacketReader } from "../protocol/PacketReader.js";

const MAGIC = "VMAP_4.8";
const HAS_BOUND = 1 << 2;
const IS_M2 = 1;
const WORLD_MID = 0.5 * 64 * 533.33333333;
const decoder = new TextDecoder();

export interface EnvironmentBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface EnvironmentObject {
  id: number;
  kind: "m2" | "wmo";
  name: string;
  x: number;
  y: number;
  z: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scale: number;
  /** Set on a WMO's own doodads — a building's furniture rather than something on the ground. */
  interior?: boolean;
  doodadSet?: number;
  quaternionX?: number;
  quaternionY?: number;
  quaternionZ?: number;
  quaternionW?: number;
  /** Optional display-order RGBA albedo multiplier retained for legacy/general placements. */
  tint?: [red: number, green: number, blue: number, alpha: number];
  /** Authored indoor WMO doodad illumination; independent of the outdoor world-light sample. */
  localLight?: [red: number, green: number, blue: number, alpha: number];
  /** Source M2 vertex radius around its placement origin; only safe static scenery carries it. */
  admissionRadius?: number;
  bounds?: EnvironmentBounds;
  /** 05.10-A7b-1 (7.13): a WMO placement's MOHD.wmoID (visual-tile-v5); absent on older tiles and vmap spawns. */
  wmoId?: number;
  /** 05.10-A7b-1 (7.13): a WMO placement's MODF.nameSet (visual-tile-v5), WMOAreaTable NameSetID. */
  nameSet?: number;
}

export function parseVMapTile(payload: Uint8Array): EnvironmentObject[] {
  const reader = new PacketReader(payload);
  if (decoder.decode(reader.bytes(8)) !== MAGIC) throw new Error("Unsupported VMAP tile");
  const count = reader.u32();
  if (count > 10_000) throw new RangeError(`VMAP tile contains too many objects: ${count}`);

  const objects: EnvironmentObject[] = [];
  for (let index = 0; index < count; index++) {
    objects.push(readModelSpawn(reader));
    // The spawn's index in the map's tree, which only the server's own lookup needs.
    reader.u32();
  }
  reader.assertFinished();
  return objects;
}

/**
 * The one model a non-tiled map is made of, out of its `<map>.vmtree`, or undefined for a tiled map.
 *
 * Thirty-nine maps of this client are a single WMO named in the WDT, with no ADT at all — Wailing
 * Caverns (43), Blackrock Depths (230), Molten Core (409), the Nexus (576) among them. The vmap
 * extractor writes no `.vmtile` for those; TrinityCore's `StaticMapTree::InitMap` reads the spawn
 * straight after the tree (`MapTree.cpp`: "only non-tiled maps have them, and if so exactly one").
 * Without this the gateway answered 404 for every tile of such a map and the player stood in a
 * dungeon with nothing drawn and nothing to collide with.
 *
 * Layout (`VMAP_4.8`): magic, one `tiled` byte, "NODE" and the BIH (`BIH::readFromFile`: bounds as
 * six floats, a u32 count of tree words and the words, a u32 count of object indices and the
 * indices), "GOBJ", then one `ModelSpawn` in the same shape a tile carries, without the trailing
 * tree index.
 */
export function parseVMapGlobalSpawn(payload: Uint8Array): EnvironmentObject | undefined {
  const reader = new PacketReader(payload);
  if (decoder.decode(reader.bytes(8)) !== MAGIC) throw new Error("Unsupported VMAP tree");
  const tiled = reader.u8() !== 0;
  if (decoder.decode(reader.bytes(4)) !== "NODE") throw new Error("VMAP tree has no NODE chunk");
  reader.bytes(24);
  const treeWords = reader.u32();
  if (treeWords > payload.byteLength / 4) throw new RangeError(`VMAP tree claims ${treeWords} words`);
  reader.bytes(treeWords * 4);
  const objectCount = reader.u32();
  if (objectCount > payload.byteLength / 4) throw new RangeError(`VMAP tree claims ${objectCount} objects`);
  reader.bytes(objectCount * 4);
  if (decoder.decode(reader.bytes(4)) !== "GOBJ") throw new Error("VMAP tree has no GOBJ chunk");
  if (tiled) return undefined;
  return readModelSpawn(reader);
}

/** One `ModelSpawn::readFromFile` record, in world coordinates. */
function readModelSpawn(reader: PacketReader): EnvironmentObject {
  const flags = reader.u32();
  reader.u16();
  const id = reader.u32();
  const internalX = reader.f32();
  const internalY = reader.f32();
  const z = reader.f32();
  const rotationX = reader.f32();
  const rotationY = reader.f32();
  const rotationZ = reader.f32();
  const scale = reader.f32();
  let bounds: EnvironmentBounds | undefined;
  if (flags & HAS_BOUND) {
    const lowX = reader.f32();
    const lowY = reader.f32();
    const minZ = reader.f32();
    const highX = reader.f32();
    const highY = reader.f32();
    const maxZ = reader.f32();
    bounds = {
      minX: WORLD_MID - highX,
      minY: WORLD_MID - highY,
      minZ,
      maxX: WORLD_MID - lowX,
      maxY: WORLD_MID - lowY,
      maxZ,
    };
  }
  const nameLength = reader.u32();
  if (nameLength > 500) throw new RangeError(`VMAP model name is too long: ${nameLength}`);
  // The stored length counts the terminator on 1,005 of the 3,482 names in this dataset, so
  // decoding it whole left a NUL on the end of every one of those. Nothing downstream survives
  // that: it is not in any path character class, so the model route answered 400 and the
  // fallback route did not match its own regex and answered 404.
  const name = decoder.decode(reader.bytes(nameLength)).replace(/\0+$/, "");
  return {
    id,
    kind: flags & IS_M2 ? "m2" : "wmo",
    name,
    x: WORLD_MID - internalX,
    y: WORLD_MID - internalY,
    z,
    rotationX,
    rotationY,
    rotationZ,
    scale,
    ...(bounds ? { bounds } : {}),
  };
}

/** The edge of one ADT grid cell, in yards: 64 cells span the map. */
const GRID_SIZE = 533.33333333;

/**
 * Whether an object's box reaches into grid cell (gridX, gridY) — the cell `terrainGrid` puts a
 * world point in: gridX = ⌊32 − x/533⅓⌋, gridY = ⌊32 − y/533⅓⌋. An object with no box is placed
 * by its origin.
 */
export function environmentObjectInGrid(object: EnvironmentObject, gridX: number, gridY: number): boolean {
  const cellMinX = (32 - gridX - 1) * GRID_SIZE;
  const cellMaxX = (32 - gridX) * GRID_SIZE;
  const cellMinY = (32 - gridY - 1) * GRID_SIZE;
  const cellMaxY = (32 - gridY) * GRID_SIZE;
  const box = object.bounds ?? { minX: object.x, maxX: object.x, minY: object.y, maxY: object.y };
  return box.maxX >= cellMinX && box.minX <= cellMaxX && box.maxY >= cellMinY && box.minY <= cellMaxY;
}
