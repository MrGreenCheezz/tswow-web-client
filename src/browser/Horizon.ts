import * as THREE from "three";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";
import type { RetainedResourceVisitor } from "./ResourceAccounting.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";
import { withGeneration } from "./GatewayGeneration.js";
import { RetryLadder } from "./RetryLadder.js"; // 05.10-A7b-0 1.24
import { lightingClassicLook } from "./LightingQuality.js"; // 05.10-7.20

/**
 * The world beyond the tiles that are really loaded, out of the client's own `.wdl`.
 *
 * Three tiles of real ground is 533 to 1,067 yards of it, and past that the ground simply ended —
 * the sky dome met nothing. The client has always shipped the whole continent at one vertex per 33
 * yards for exactly this, and it is not an approximation of the terrain so much as the same field
 * rounded: measured against the server's height field on 40 tiles per continent, an outer vertex
 * is never more than 1.01 yards out.
 *
 * What is drawn is only what the near ring does not cover. Underlaying it would put two surfaces a
 * yard apart at a distance where the depth buffer resolves 2.15 yards, and they would trade places
 * across the join at random.
 */

/** 17 outer heights across a tile, one every 33.3 yards. */
const OUTER = 17;
/** 16 inner heights, each at the middle of an outer cell — the same shape as the terrain's V8. */
const INNER = 16;
const MARE_BYTES = (OUTER * OUTER + INNER * INNER) * 2;

/**
 * How far the horizon reaches, in yards.
 *
 * The fog is what decides this, not the geometry: of the 715 light rows this client resolves, the
 * ninety-ninth percentile closes its fog at 2,083 yards and the furthest at 2,778. Four tiles out
 * covers all but the last of those, and costs 41 tiles and about 42,000 triangles against the near
 * ring's 294,912.
 */
export const HORIZON_RANGE = 4 * TERRAIN_GRID_SIZE;
/**
 * How far the camera can see at all.
 *
 * 900 yards used to be the far plane, which is inside the fog of 53 of those 715 rows — the
 * horizon would have been built and then clipped. The near plane is what decides depth precision,
 * not the far one: at 0.25 near, a point 800 yards out resolves to 0.153 yards either way.
 */
export const HORIZON_FAR_PLANE = 4000;

export interface HorizonTile {
  gridX: number;
  gridY: number;
  /** 17×17 outer heights, row-major: row runs south, column runs east. */
  outer: Int16Array;
  /** 16×16 inner heights, one at the middle of each outer cell. */
  inner: Int16Array;
}

export interface HorizonMap {
  tiles: Map<number, HorizonTile>;
}

/** `MAOF` is indexed the way the server names its tiles: the x of `%03u%02u%02u.map` first. */
function tileKey(gridX: number, gridY: number): number {
  return gridX * 64 + gridY;
}

/** 05.10-A7b-7 (7.08): one tile of a decoded map, or `undefined` where the map has none. */
export function horizonTileAt(map: HorizonMap, gridX: number, gridY: number): HorizonTile | undefined {
  return map.tiles.get(tileKey(gridX, gridY));
}

/** 05.10-A7b-7 (7.08): texels of the colour picture per tile side, and its side (64 tiles). */
export const HORIZON_COLOUR_TEXELS = 16;
export const HORIZON_COLOUR_SIDE = 64 * HORIZON_COLOUR_TEXELS;

/**
 * 05.10-A7b-7 (7.08): whether the horizon draws lit and coloured. The classic path (lighting quality
 * 0) follows the client: the far ground is lit by the world's own light and carries the zone's
 * colour. The enhanced and cinematic presets keep the owner's look — the flat aerial-fogged green
 * they were tuned with — until the owner says otherwise.
 */
export function horizonColourWanted(lightingQuality: number, hasColour: boolean): boolean {
  return lightingClassicLook(lightingQuality) && hasColour; // 05.10-7.20: and the comparison level
}

/**
 * Reads a `.wdl`: a table of 4,096 file offsets, and a `MARE` block for each tile that exists.
 *
 * The offsets point at the chunk header rather than at its payload, and a zero means the map has
 * no tile there — 40 of the client's 106 files are nothing but an empty table.
 */
export function decodeHorizon(data: ArrayBuffer): HorizonMap {
  const view = new DataView(data);
  const decoder = new TextDecoder();
  const bytes = new Uint8Array(data);
  let offset = 0;
  let table = 0;
  while (offset + 8 <= data.byteLength) {
    // Chunk tags are written back to front, as everywhere else in this format.
    const tag = [...bytes.subarray(offset, offset + 4)].reverse().map((value) => String.fromCharCode(value)).join("");
    const size = view.getUint32(offset + 4, true);
    if (tag === "MAOF") {
      table = offset + 8;
      break;
    }
    offset += 8 + size;
  }
  if (table === 0 || table + 4096 * 4 > data.byteLength) throw new Error("Horizon file has no tile table");
  void decoder;

  const tiles = new Map<number, HorizonTile>();
  for (let gridX = 0; gridX < 64; gridX++) {
    for (let gridY = 0; gridY < 64; gridY++) {
      const at = view.getUint32(table + (gridX * 64 + gridY) * 4, true);
      if (at === 0) continue;
      // The offset names the chunk header; the heights start eight bytes later.
      const start = at + 8;
      if (start + MARE_BYTES > data.byteLength) continue;
      const outer = new Int16Array(OUTER * OUTER);
      for (let index = 0; index < outer.length; index++) outer[index] = view.getInt16(start + index * 2, true);
      const inner = new Int16Array(INNER * INNER);
      const innerStart = start + OUTER * OUTER * 2;
      for (let index = 0; index < inner.length; index++) inner[index] = view.getInt16(innerStart + index * 2, true);
      tiles.set(tileKey(gridX, gridY), { gridX, gridY, outer, inner });
    }
  }
  return { tiles };
}

/**
 * Which tiles the horizon draws from where the player stands.
 *
 * Never the nine the near ring holds — those are real ground, and a low-resolution copy of them
 * fighting for the depth buffer is the one way this can look worse than nothing.
 */
export function horizonTiles(map: HorizonMap, centre: { x: number; y: number }, rangeYards = HORIZON_RANGE): HorizonTile[] {
  const reach = Math.ceil(rangeYards / TERRAIN_GRID_SIZE);
  const found: HorizonTile[] = [];
  for (let gridX = centre.x - reach; gridX <= centre.x + reach; gridX++) {
    for (let gridY = centre.y - reach; gridY <= centre.y + reach; gridY++) {
      if (Math.abs(gridX - centre.x) <= 1 && Math.abs(gridY - centre.y) <= 1) continue;
      const tile = map.tiles.get(tileKey(gridX, gridY));
      if (tile) found.push(tile);
    }
  }
  return found;
}

/**
 * One mesh for every distant tile at once.
 *
 * Four triangles per cell around the inner vertex, which is the shape the terrain itself is
 * stored in: 545 vertices and 1,024 triangles a tile. Merged into one buffer because forty of them
 * as separate meshes is forty draw calls for something nobody looks at closely.
 */
export function buildHorizonGeometry(
  tiles: readonly HorizonTile[],
  /** 05.10-A7b-7 (7.08): the map's other tiles, so a normal on a tile's edge sees across the join. */
  neighbour?: (gridX: number, gridY: number) => HorizonTile | undefined,
): THREE.BufferGeometry {
  const cellsPerTile = INNER * INNER;
  const vertexCount = tiles.length * (OUTER * OUTER + cellsPerTile);
  const positions = new Float32Array(vertexCount * 3);
  // 05.10-A7b-7 (7.08): lit and coloured on the classic path — a normal and a colour-map UV a vertex.
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  // The production ring is at most 72 tiles (39,240 vertices), so its indices fit in 16 bits.
  // Retain the wide path for callers that build a larger arbitrary tile collection.
  const indices = vertexCount <= 0x10000
    ? new Uint16Array(tiles.length * cellsPerTile * 12)
    : new Uint32Array(tiles.length * cellsPerTile * 12);
  let vertex = 0;
  let index = 0;
  for (const tile of tiles) {
    const base = vertex;
    const step = TERRAIN_GRID_SIZE / INNER;
    const originX = (32 - tile.gridX) * TERRAIN_GRID_SIZE;
    const originY = (32 - tile.gridY) * TERRAIN_GRID_SIZE;
    for (let row = 0; row < OUTER; row++) {
      for (let column = 0; column < OUTER; column++) {
        const at = (base + row * OUTER + column) * 3;
        positions[at] = originX - row * step;
        positions[at + 1] = tile.outer[row * OUTER + column]!;
        positions[at + 2] = -(originY - column * step);
        // 05.10-A7b-7: central differences over the outer grid, across the tile edge when the
        // neighbour is known (both tiles then agree on the shared vertex's normal).
        const southward = outerSlope(tile, row, column, 1, 0, neighbour);
        const eastward = outerSlope(tile, row, column, 0, 1, neighbour);
        writeNormal(normals, at, southward, eastward, step);
        writeUv(uvs, (base + row * OUTER + column) * 2, tile, row, column);
        vertex++;
      }
    }
    const innerBase = vertex;
    for (let row = 0; row < INNER; row++) {
      for (let column = 0; column < INNER; column++) {
        const at = (innerBase + row * INNER + column) * 3;
        positions[at] = originX - (row + 0.5) * step;
        positions[at + 1] = tile.inner[row * INNER + column]!;
        positions[at + 2] = -(originY - (column + 0.5) * step);
        // 05.10-A7b-7: the four outer corners of its cell.
        const o = tile.outer;
        const southward = (o[(row + 1) * OUTER + column]! + o[(row + 1) * OUTER + column + 1]!)
          - (o[row * OUTER + column]! + o[row * OUTER + column + 1]!);
        const eastward = (o[row * OUTER + column + 1]! + o[(row + 1) * OUTER + column + 1]!)
          - (o[row * OUTER + column]! + o[(row + 1) * OUTER + column]!);
        writeNormal(normals, at, southward / 2, eastward / 2, step);
        writeUv(uvs, (innerBase + row * INNER + column) * 2, tile, row + 0.5, column + 0.5);
        vertex++;
      }
    }
    for (let row = 0; row < INNER; row++) {
      for (let column = 0; column < INNER; column++) {
        const middle = innerBase + row * INNER + column;
        const topLeft = base + row * OUTER + column;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + OUTER;
        const bottomRight = bottomLeft + 1;
        // Wound so the four triangles face up in the scene's frame, which is the winding the near
        // terrain uses: rows run along −x and columns along −z.
        indices[index++] = middle;
        indices[index++] = topRight;
        indices[index++] = topLeft;
        indices[index++] = middle;
        indices[index++] = bottomRight;
        indices[index++] = topRight;
        indices[index++] = middle;
        indices[index++] = bottomLeft;
        indices[index++] = bottomRight;
        indices[index++] = middle;
        indices[index++] = topLeft;
        indices[index++] = bottomLeft;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // 05.10-A7b-7 (7.08): analytic normals from the height grid (no `computeVertexNormals` scan over
  // every triangle) and the colour picture's UVs; the flat basic material ignores both.
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * 05.10-A7b-7: an outer height by (row, column) of `tile`, stepping into the neighbour tile when
 * the index leaves it (rows run south with gridX, columns east with gridY); `undefined` past the
 * edge when that neighbour is not known.
 */
function outerHeight(
  tile: HorizonTile, row: number, column: number,
  neighbour: ((gridX: number, gridY: number) => HorizonTile | undefined) | undefined,
): number | undefined {
  if (row >= 0 && row < OUTER && column >= 0 && column < OUTER) return tile.outer[row * OUTER + column]!;
  const dx = row < 0 ? -1 : row > OUTER - 1 ? 1 : 0;
  const dy = column < 0 ? -1 : column > OUTER - 1 ? 1 : 0;
  const next = neighbour?.(tile.gridX + dx, tile.gridY + dy);
  return next?.outer[(row - dx * (OUTER - 1)) * OUTER + column - dy * (OUTER - 1)];
}

/**
 * 05.10-A7b-7: height change per grid step along (dRow, dColumn) at an outer vertex — the central
 * difference, or the one-sided one at a map edge with no neighbour.
 */
function outerSlope(
  tile: HorizonTile, row: number, column: number, dRow: number, dColumn: number,
  neighbour: ((gridX: number, gridY: number) => HorizonTile | undefined) | undefined,
): number {
  const centre = tile.outer[row * OUTER + column]!;
  const ahead = outerHeight(tile, row + dRow, column + dColumn, neighbour);
  const behind = outerHeight(tile, row - dRow, column - dColumn, neighbour);
  if (ahead !== undefined && behind !== undefined) return (ahead - behind) / 2;
  if (ahead !== undefined) return ahead - centre;
  if (behind !== undefined) return centre - behind;
  return 0;
}

/**
 * 05.10-A7b-7: the up-facing unit normal of a height field whose height grows by `southward` per
 * row and `eastward` per column, rows `step` yards apart along −x and columns along +z.
 */
function writeNormal(normals: Float32Array, at: number, southward: number, eastward: number, step: number): void {
  // dh/dx = southward / −step, dh/dz = eastward / step; the normal is (−dh/dx, 1, −dh/dz).
  const x = southward / step;
  const z = 0 - eastward / step; // not -0 on flat ground
  const length = Math.hypot(x, 1, z);
  normals[at] = x / length;
  normals[at + 1] = 1 / length;
  normals[at + 2] = z / length;
}

/** 05.10-A7b-7: where (row, column) of `tile` lies on the map's colour picture (row 0 at v = 0). */
function writeUv(uvs: Float32Array, at: number, tile: HorizonTile, row: number, column: number): void {
  uvs[at] = (tile.gridY * HORIZON_COLOUR_TEXELS + column) / HORIZON_COLOUR_SIDE;
  uvs[at + 1] = (tile.gridX * HORIZON_COLOUR_TEXELS + row) / HORIZON_COLOUR_SIDE;
}

/** One map's `.wdl`, fetched once and kept: 780 KB for a continent, and it never changes. */
export class HorizonClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #maps = new Map<number, HorizonMap | null>();
  readonly #requested = new Set<number>();
  readonly #loading = new Set<number>();
  readonly #errors = new Set<number>();
  /** 05.10-A7b-0 1.24: a failed request (network, 5xx) is asked again after 2 s, 8 s, 30 s. */
  readonly #failures: RetryLadder<number>;
  /**
   * 05.10-A7b-7 (7.08): the colour picture of the map being drawn (`null`: the map has none, or
   * the gateway is older than the route — the horizon stays flat green). Only the current map's
   * texture is kept: 1024² with mipmaps is 5.6 MB of GPU memory.
   */
  readonly #colours = new Map<number, THREE.Texture | null>();
  readonly #colourLoading = new Set<number>();
  readonly #colourFailures: RetryLadder<number>;
  #colourWanted: number | undefined;
  #revision = 0;
  #success = 0;
  #error = 0;

  /** `now` (05.10-A7b-0 1.24) is the retry ladder's clock; tests inject their own. */
  constructor(gatewayWebSocketUrl: string, now?: () => number) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#failures = new RetryLadder<number>(undefined, now);
    this.#colourFailures = new RetryLadder<number>(undefined, now); // 05.10-A7b-7
  }

  /**
   * 05.10-A7b-7 (7.08): the map's colour picture once it is in; asks for it the first time, after the
   * map's `.wdl` itself has landed. 404 is final (no minimap, or an older gateway); other failures
   * retry on the ladder. Switching maps releases the previous map's texture.
   */
  colour(map: number | undefined): THREE.Texture | undefined {
    if (map === undefined || !this.#maps.get(map)) return undefined;
    if (this.#colourWanted !== map) {
      this.#colourWanted = map;
      for (const [other, texture] of this.#colours) {
        if (other === map || !texture) continue;
        texture.dispose();
        this.#colours.delete(other);
      }
    }
    const known = this.#colours.get(map);
    if (known !== undefined) return known ?? undefined;
    if (this.#colourLoading.has(map) || !this.#colourFailures.ready(map)) return undefined;
    this.#colourLoading.add(map);
    void this.#loadColour(map);
    return undefined;
  }

  async #loadColour(map: number): Promise<void> {
    try {
      // Without a bitmap decoder (no supported browser lacks one) the horizon simply stays flat.
      if (typeof createImageBitmap !== "function") {
        this.#colours.set(map, null);
        return;
      }
      const response = await fetch(withGeneration(`${this.#baseUrl}/horizon/${map}/colour.png`));
      if (response.status === 404) {
        this.#colourFailures.clear(map);
        this.#colours.set(map, null);
        return;
      }
      if (!response.ok) throw new Error(`Horizon colour gateway returned ${response.status}`);
      // Not flipped: picture row 0 is UV v = 0 (`writeUv`), with `flipY` off below.
      const bitmap = await createImageBitmap(await response.blob(), {
        premultiplyAlpha: "none", colorSpaceConversion: "none",
      });
      if (this.#colourWanted !== map) {
        bitmap.close();
        return;
      }
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.addEventListener("dispose", () => bitmap.close());
      texture.needsUpdate = true;
      this.#colourFailures.clear(map);
      this.#colours.set(map, texture);
    } catch (error) {
      this.#colourFailures.failed(map);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#colourLoading.delete(map);
    }
  }

  /** Bumped when a map's horizon lands, so a scene built without one knows to build it. */
  get revision(): number {
    return this.#revision;
  }

  get generation(): number {
    return this.#revision;
  }

  /** 05.10-A7b-9 (7.18): horizon meshes and colour pictures waiting for a retry (1.24). */
  get retrying(): number {
    return this.#failures.retryingCount() + this.#colourFailures.retryingCount();
  }

  /** Immutable exact request counters; the lifetime requested set is not an active queue. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    return Object.freeze({
      pending: this.#loading.size,
      success: this.#success,
      error: this.#errors.size,
      generation: this.#revision,
    });
  }

  get(map: number | undefined): HorizonMap | undefined {
    if (map === undefined) return undefined;
    const known = this.#maps.get(map);
    if (known) return known;
    if (known === null || this.#requested.has(map)) return undefined;
    if (!this.#failures.ready(map)) return undefined; // 05.10-A7b-0 1.24: waiting for its retry
    this.#requested.add(map);
    this.#loading.add(map);
    void this.#load(map);
    return undefined;
  }

  /** Adds the outer and inner height arrays from every successful cached map. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const texture of this.#colours.values()) if (texture) visitor.referenceGpuTexture(this, texture); // 05.10-A7b-7
    for (const map of this.#maps.values()) {
      if (!map) continue;
      for (const tile of map.tiles.values()) {
        visitor.referenceCpu(tile, tile.outer);
        visitor.referenceCpu(tile, tile.inner);
      }
    }
  }

  async #load(map: number): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#loading.delete(map);
      this.#revision++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(withGeneration(`${this.#baseUrl}/horizon/${map}`));
      if (response.status === 404) {
        // A map without a WDL is a normal absence (instances/battlegrounds), not a failed load.
        this.#maps.set(map, null);
        this.#errors.delete(map);
        this.#failures.clear(map); // 05.10-A7b-0 1.24
        settle(true);
        return;
      }
      if (!response.ok) throw new Error(`Horizon gateway returned ${response.status}`);
      const body = await response.arrayBuffer();
      let decoded: HorizonMap;
      try {
        decoded = decodeHorizon(body);
      } catch (error) {
        // 05.10-A7b-0 1.24: a file that arrived whole and does not decode will not decode next time.
        this.#failures.clear(map);
        this.#maps.set(map, null);
        this.#errors.add(map);
        settle(false);
        this.onStatus?.(error instanceof Error ? error.message : String(error), true);
        return;
      }
      this.#failures.clear(map); // 05.10-A7b-0 1.24
      this.#maps.set(map, decoded);
      this.#errors.delete(map);
      settle(true);
      this.onStatus?.(`Горизонт: ${decoded.tiles.size} тайлов`, false);
    } catch (error) {
      // 05.10-A7b-0 1.24: a map with no `.wdl` is the 404 above and stays final; this is a failed
      // request (network, 5xx), asked again on the ladder — `get` holds it off while it waits, so
      // there is no request storm. Exhausted after the fourth failure.
      this.#requested.delete(map);
      this.#failures.failed(map);
      this.#errors.add(map);
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }
}
