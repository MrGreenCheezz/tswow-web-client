import * as THREE from "three";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";
import type { RetainedResourceVisitor } from "./ResourceAccounting.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

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
export function buildHorizonGeometry(tiles: readonly HorizonTile[]): THREE.BufferGeometry {
  const cellsPerTile = INNER * INNER;
  const vertexCount = tiles.length * (OUTER * OUTER + cellsPerTile);
  const positions = new Float32Array(vertexCount * 3);
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
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The horizon uses MeshBasicMaterial: vertex normals have no effect on its lighting or fog.
  // Computing them on every tile crossing scans all triangles and allocates another full buffer.
  geometry.computeBoundingSphere();
  return geometry;
}

/** One map's `.wdl`, fetched once and kept: 780 KB for a continent, and it never changes. */
export class HorizonClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #maps = new Map<number, HorizonMap | null>();
  readonly #requested = new Set<number>();
  readonly #loading = new Set<number>();
  readonly #errors = new Set<number>();
  #revision = 0;
  #success = 0;
  #error = 0;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Bumped when a map's horizon lands, so a scene built without one knows to build it. */
  get revision(): number {
    return this.#revision;
  }

  get generation(): number {
    return this.#revision;
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
    this.#requested.add(map);
    this.#loading.add(map);
    void this.#load(map);
    return undefined;
  }

  /** Adds the outer and inner height arrays from every successful cached map. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
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
      const response = await fetch(`${this.#baseUrl}/horizon/${map}`);
      if (response.status === 404) {
        // A map without a WDL is a normal absence (instances/battlegrounds), not a failed load.
        this.#maps.set(map, null);
        this.#errors.delete(map);
        settle(true);
        return;
      }
      if (!response.ok) throw new Error(`Horizon gateway returned ${response.status}`);
      const decoded = decodeHorizon(await response.arrayBuffer());
      this.#maps.set(map, decoded);
      this.#errors.delete(map);
      settle(true);
      this.onStatus?.(`Горизонт: ${decoded.tiles.size} тайлов`, false);
    } catch (error) {
      // Null and never again: a map with no `.wdl` — an instance, a battleground — has no horizon
      // to draw, and asking once a frame for a file that is not there is a request storm.
      this.#maps.set(map, null);
      this.#errors.add(map);
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }
}
