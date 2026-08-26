/**
 * How a collision model crosses the wire.
 *
 * The server's own `.vmo` files are the geometry, and they are the whole point of the slice: if
 * the client walks on the same triangles the server does, there is no such thing as the server
 * thinking the player is inside a wall. But they are files meant to be memory-mapped by a C++
 * process on the same machine — Stormwind is 724,760 triangles, some eighteen megabytes of raw
 * floats — so what a browser gets is not the file.
 *
 * A model is sent as its groups, because that is how a WMO is already stored: a room, a wing, a
 * floor, each with the box it lives in. The header lists every group's box and size whether or not
 * its geometry came with it, so the browser can decide which handful of a city's groups it is
 * standing in and ask for only those. Small models — which is nearly all of them — arrive whole on
 * the first request.
 *
 * Encoder and decoder live together on purpose: a format written in two places is a format that
 * drifts.
 */

const MAGIC = "VCOL0003";
const HEADER_BYTES = 8 + 4;
/**
 * Per group: six bounds floats, vertex count, triangle count, whether geometry followed, the
 * group's own `MOGP` flags, its authored group id, and the liquid payload size.
 *
 * The flags were being parsed on the gateway and dropped on the wire, which left the browser
 * guessing from artwork at something the server answers from this number. `0x8` is the bit
 * `Map::IsOutdoors` reads, and it is four bytes for a whole city: 286 groups is 1,144 of them.
 */
const GROUP_HEADER_BYTES = 6 * 4 + 4 + 4 + 4 + 4 + 4 + 4;

/**
 * A liquid surface inside a model, in the model's own space.
 *
 * The same grid the WMO's `MLIQ` holds and the extractor copies into `LIQU`, unchanged: cells
 * across and along, the corner it starts at, the `LiquidType.dbc` row, a height per corner and a
 * byte per cell whose low nibble reads `0x0f` when the cell is dry.
 */
export interface CollisionLiquid {
  tilesX: number;
  tilesY: number;
  cornerX: number;
  cornerY: number;
  cornerZ: number;
  type: number;
  heights: Float32Array;
  flags: Uint8Array;
}

/** Bytes one liquid grid takes on the wire: the header, a height per corner, a byte per cell. */
function liquidBytes(liquid: CollisionLiquid | undefined): number {
  if (!liquid) return 0;
  return 24 + (liquid.tilesX + 1) * (liquid.tilesY + 1) * 4 + liquid.tilesX * liquid.tilesY;
}

export interface CollisionBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface CollisionModelGroup {
  /** Model-space bounds, as the `.vmo` records them. */
  bounds: CollisionBounds;
  vertexCount: number;
  triangleCount: number;
  /** `MOGP`'s own flags. `0x8` marks a group that is open to the sky. */
  flags: number;
  /** The WMO's authored group id, copied by the vmap extractor; not the array index. */
  groupId: number;
  /**
   * The group's own liquid grid, when it has one.
   *
   * Sent whether or not the geometry was asked for, and that is the point: a city arrives as a
   * 38 KB header and its rooms are fetched one at a time, but its water is 47 KB for the whole of
   * Stormwind and the player can see the canals from the far end of the city. Waiting for a room
   * to be requested before knowing there is water in it would draw a dry city until the player
   * walked into it.
   */
  liquid?: CollisionLiquid;
  /** Present only when this group's geometry was asked for and sent. */
  vertices?: Float32Array;
  indices?: Uint32Array;
}

export interface CollisionModel {
  groups: CollisionModelGroup[];
}

/** How much geometry a single response carries before the caller has to ask group by group. */
export const COLLISION_TRIANGLE_BUDGET = 50_000;

export interface EncodableGroup {
  bounds: CollisionBounds;
  flags: number;
  groupId: number;
  liquid?: CollisionLiquid;
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * Writes the model, including the geometry of the groups named in `include`.
 *
 * `include` of `undefined` means all of them, which is what a model under the budget gets.
 */
export function encodeCollisionModel(groups: readonly EncodableGroup[], include?: ReadonlySet<number>): Uint8Array {
  let size = HEADER_BYTES + groups.length * GROUP_HEADER_BYTES;
  for (const [index, group] of groups.entries()) {
    size += liquidBytes(group.liquid);
    if (include && !include.has(index)) continue;
    size += group.vertices.byteLength + group.indices.byteLength;
  }

  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  for (let index = 0; index < MAGIC.length; index++) data[index] = MAGIC.charCodeAt(index);
  view.setUint32(8, groups.length, true);

  let cursor = HEADER_BYTES;
  for (const [index, group] of groups.entries()) {
    const included = !include || include.has(index);
    view.setFloat32(cursor, group.bounds.minX, true);
    view.setFloat32(cursor + 4, group.bounds.minY, true);
    view.setFloat32(cursor + 8, group.bounds.minZ, true);
    view.setFloat32(cursor + 12, group.bounds.maxX, true);
    view.setFloat32(cursor + 16, group.bounds.maxY, true);
    view.setFloat32(cursor + 20, group.bounds.maxZ, true);
    view.setUint32(cursor + 24, group.vertices.length / 3, true);
    view.setUint32(cursor + 28, group.indices.length / 3, true);
    view.setUint32(cursor + 32, included ? 1 : 0, true);
    view.setUint32(cursor + 36, group.flags, true);
    view.setUint32(cursor + 40, group.groupId, true);
    view.setUint32(cursor + 44, liquidBytes(group.liquid), true);
    cursor += GROUP_HEADER_BYTES;
  }
  for (const group of groups) {
    const liquid = group.liquid;
    if (!liquid) continue;
    view.setUint32(cursor, liquid.tilesX, true);
    view.setUint32(cursor + 4, liquid.tilesY, true);
    view.setFloat32(cursor + 8, liquid.cornerX, true);
    view.setFloat32(cursor + 12, liquid.cornerY, true);
    view.setFloat32(cursor + 16, liquid.cornerZ, true);
    view.setUint32(cursor + 20, liquid.type, true);
    cursor += 24;
    for (let index = 0; index < liquid.heights.length; index++) {
      view.setFloat32(cursor + index * 4, liquid.heights[index]!, true);
    }
    cursor += liquid.heights.length * 4;
    data.set(liquid.flags, cursor);
    cursor += liquid.flags.length;
  }
  for (const [index, group] of groups.entries()) {
    if (include && !include.has(index)) continue;
    // Copied through a byte view rather than a typed-array set, because the destination offset is
    // only four-byte aligned when every group before it happened to be.
    data.set(new Uint8Array(group.vertices.buffer, group.vertices.byteOffset, group.vertices.byteLength), cursor);
    cursor += group.vertices.byteLength;
    data.set(new Uint8Array(group.indices.buffer, group.indices.byteOffset, group.indices.byteLength), cursor);
    cursor += group.indices.byteLength;
  }
  return data;
}

export function decodeCollisionModel(payload: ArrayBuffer): CollisionModel {
  const bytes = new Uint8Array(payload);
  const view = new DataView(payload);
  if (bytes.byteLength < HEADER_BYTES) throw new Error("Collision model is truncated");
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC.charCodeAt(index)) throw new Error("Not a collision model");
  }
  const groupCount = view.getUint32(8, true);
  if (groupCount > 10_000) throw new RangeError(`Collision model has too many groups: ${groupCount}`);
  if (bytes.byteLength < HEADER_BYTES + groupCount * GROUP_HEADER_BYTES) throw new Error("Collision model header is truncated");

  const groups: CollisionModelGroup[] = [];
  const included: boolean[] = [];
  const liquidSizes: number[] = [];
  let cursor = HEADER_BYTES;
  for (let index = 0; index < groupCount; index++) {
    groups.push({
      bounds: {
        minX: view.getFloat32(cursor, true),
        minY: view.getFloat32(cursor + 4, true),
        minZ: view.getFloat32(cursor + 8, true),
        maxX: view.getFloat32(cursor + 12, true),
        maxY: view.getFloat32(cursor + 16, true),
        maxZ: view.getFloat32(cursor + 20, true),
      },
      vertexCount: view.getUint32(cursor + 24, true),
      triangleCount: view.getUint32(cursor + 28, true),
      flags: view.getUint32(cursor + 36, true),
      groupId: view.getUint32(cursor + 40, true),
    });
    liquidSizes.push(view.getUint32(cursor + 44, true));
    included.push(view.getUint32(cursor + 32, true) === 1);
    cursor += GROUP_HEADER_BYTES;
  }

  for (const [index, group] of groups.entries()) {
    const size = liquidSizes[index]!;
    if (size === 0) continue;
    if (cursor + size > bytes.byteLength) throw new Error("Collision model liquid is truncated");
    const tilesX = view.getUint32(cursor, true);
    const tilesY = view.getUint32(cursor + 4, true);
    const corners = (tilesX + 1) * (tilesY + 1);
    if (24 + corners * 4 + tilesX * tilesY !== size) throw new Error("Collision model liquid does not match its size");
    const heights = new Float32Array(corners);
    for (let corner = 0; corner < corners; corner++) heights[corner] = view.getFloat32(cursor + 24 + corner * 4, true);
    group.liquid = {
      tilesX,
      tilesY,
      cornerX: view.getFloat32(cursor + 8, true),
      cornerY: view.getFloat32(cursor + 12, true),
      cornerZ: view.getFloat32(cursor + 16, true),
      type: view.getUint32(cursor + 20, true),
      heights,
      flags: bytes.slice(cursor + 24 + corners * 4, cursor + size),
    };
    cursor += size;
  }

  for (const [index, group] of groups.entries()) {
    if (!included[index]) continue;
    const vertexBytes = group.vertexCount * 3 * 4;
    const indexBytes = group.triangleCount * 3 * 4;
    if (cursor + vertexBytes + indexBytes > bytes.byteLength) throw new Error("Collision model geometry is truncated");
    // Sliced rather than viewed: the payload's own offsets are not guaranteed to be aligned to
    // four bytes, and a Float32Array cannot be built over one that is not.
    group.vertices = new Float32Array(payload.slice(cursor, cursor + vertexBytes));
    cursor += vertexBytes;
    group.indices = new Uint32Array(payload.slice(cursor, cursor + indexBytes));
    cursor += indexBytes;
  }
  return { groups };
}

/** Total triangles a model holds, whether or not its geometry has been fetched. */
export function collisionTriangleCount(model: CollisionModel): number {
  return model.groups.reduce((sum, group) => sum + group.triangleCount, 0);
}
