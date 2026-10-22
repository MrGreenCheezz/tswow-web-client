import * as THREE from "three";
import {
  HORIZON_RANGE, INNER, OUTER, horizonTileAt, outerSlope, writeNormal, writeUv,
  type HorizonMap, type HorizonTile,
} from "./Horizon.js";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";

/**
 * 22.10 (7.39): the far view's outer horizon — the WDL tiles past the client's four-tile ring, out
 * to the enhanced path's range (DistanceFog.ts `DISTANCE_HORIZON_RANGE`), at half resolution.
 *
 * Past 2,000 yards a 33-yard grid buys nothing a 67-yard one does not, and the full grid for 160
 * tiles cost 5.7 ms in the frame that crossed a tile (2.3 ms for the 72-tile ring alone, measured
 * in Node on Azeroth's `.wdl`). Every second outer height is kept; the middle of each coarse cell
 * is the full grid's own outer vertex there, so no height is invented. Normals and colour UVs come
 * from the full grid. The band is a mesh of its own, built on a frame after the ring's rebuild,
 * so a tile crossing never pays for both.
 */

/** Outer grid steps per coarse step. */
export const HORIZON_BAND_STRIDE = 2;
const COARSE_OUTER = (OUTER - 1) / HORIZON_BAND_STRIDE + 1;
const COARSE_INNER = INNER / HORIZON_BAND_STRIDE;

/** The tiles of the band: within `outerRange` of the centre tile, outside the ring's `innerRange`. */
export function horizonBandTiles(
  map: HorizonMap, centre: { x: number; y: number }, outerRange: number, innerRange = HORIZON_RANGE,
): HorizonTile[] {
  const inner = Math.ceil(innerRange / TERRAIN_GRID_SIZE);
  const reach = Math.ceil(outerRange / TERRAIN_GRID_SIZE);
  const found: HorizonTile[] = [];
  for (let gridX = centre.x - reach; gridX <= centre.x + reach; gridX++) {
    for (let gridY = centre.y - reach; gridY <= centre.y + reach; gridY++) {
      if (Math.max(Math.abs(gridX - centre.x), Math.abs(gridY - centre.y)) <= inner) continue;
      const tile = horizonTileAt(map, gridX, gridY);
      if (tile) found.push(tile);
    }
  }
  return found;
}

/** One mesh for the band's tiles, every second outer height, the same winding as the ring. */
export function buildHorizonBandGeometry(
  tiles: readonly HorizonTile[],
  neighbour?: (gridX: number, gridY: number) => HorizonTile | undefined,
): THREE.BufferGeometry {
  const perTile = COARSE_OUTER * COARSE_OUTER + COARSE_INNER * COARSE_INNER;
  const vertexCount = tiles.length * perTile;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const cells = COARSE_INNER * COARSE_INNER;
  const indices = vertexCount <= 0x10000
    ? new Uint16Array(tiles.length * cells * 12)
    : new Uint32Array(tiles.length * cells * 12);
  const step = TERRAIN_GRID_SIZE / INNER;
  let vertex = 0;
  let index = 0;
  const put = (tile: HorizonTile, row: number, column: number, originX: number, originY: number): void => {
    const at = vertex * 3;
    positions[at] = originX - row * step;
    positions[at + 1] = tile.outer[row * OUTER + column]!;
    positions[at + 2] = -(originY - column * step);
    writeNormal(normals, at, outerSlope(tile, row, column, 1, 0, neighbour),
      outerSlope(tile, row, column, 0, 1, neighbour), step);
    writeUv(uvs, vertex * 2, tile, row, column);
    vertex++;
  };
  for (const tile of tiles) {
    const base = vertex;
    const originX = (32 - tile.gridX) * TERRAIN_GRID_SIZE;
    const originY = (32 - tile.gridY) * TERRAIN_GRID_SIZE;
    for (let row = 0; row < COARSE_OUTER; row++) {
      for (let column = 0; column < COARSE_OUTER; column++) {
        put(tile, row * HORIZON_BAND_STRIDE, column * HORIZON_BAND_STRIDE, originX, originY);
      }
    }
    const innerBase = vertex;
    for (let row = 0; row < COARSE_INNER; row++) {
      for (let column = 0; column < COARSE_INNER; column++) {
        // The middle of a coarse cell is the full grid's outer vertex at odd indices.
        put(tile, row * HORIZON_BAND_STRIDE + 1, column * HORIZON_BAND_STRIDE + 1, originX, originY);
      }
    }
    for (let row = 0; row < COARSE_INNER; row++) {
      for (let column = 0; column < COARSE_INNER; column++) {
        const middle = innerBase + row * COARSE_INNER + column;
        const topLeft = base + row * COARSE_OUTER + column;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + COARSE_OUTER;
        const bottomRight = bottomLeft + 1;
        indices[index++] = middle; indices[index++] = topRight; indices[index++] = topLeft;
        indices[index++] = middle; indices[index++] = bottomRight; indices[index++] = topRight;
        indices[index++] = middle; indices[index++] = bottomLeft; indices[index++] = bottomRight;
        indices[index++] = middle; indices[index++] = topLeft; indices[index++] = bottomLeft;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The band's mesh and what it was built for; the renderer owns one. */
export class HorizonBand {
  #mesh: THREE.Mesh | undefined;
  #tile = -1;
  #revision = -1;
  #range = 0;

  get mesh(): THREE.Mesh | undefined {
    return this.#mesh;
  }

  /**
   * Called on frames the ring did not rebuild. `range` at or inside the ring's own (the faithful
   * levels) takes the band down; otherwise it is rebuilt when the tile, the map's horizon or the
   * range changed, and shown again.
   */
  update(scene: THREE.Scene, map: HorizonMap, tile: number, revision: number, range: number, material: THREE.Material): void {
    if (range <= HORIZON_RANGE) {
      this.clear(scene);
      return;
    }
    if (this.#mesh && this.#mesh.material !== material) this.#mesh.material = material;
    if (this.#mesh && this.#tile === tile && this.#revision === revision && this.#range === range) {
      this.#mesh.visible = true;
      return;
    }
    this.clear(scene);
    const cell = tile % 4096;
    const tiles = horizonBandTiles(map, { x: Math.floor(cell / 64), y: cell % 64 }, range);
    this.#tile = tile;
    this.#revision = revision;
    this.#range = range;
    if (tiles.length === 0) return;
    const mesh = new THREE.Mesh(buildHorizonBandGeometry(tiles, (x, y) => horizonTileAt(map, x, y)), material);
    mesh.renderOrder = 0; // after the sky dome, like the ring (WorldRenderer3D #updateHorizon)
    mesh.name = "horizon-band";
    this.#mesh = mesh;
    scene.add(mesh);
  }

  /** Hide a band built around another tile: it would overlap the ring just rebuilt there. */
  hideUnless(tile: number): void {
    if (this.#mesh && this.#tile !== tile) this.#mesh.visible = false;
  }

  clear(scene: THREE.Scene): void {
    if (this.#mesh) {
      scene.remove(this.#mesh);
      this.#mesh.geometry.dispose();
      this.#mesh = undefined;
    }
    this.#tile = -1;
    this.#revision = -1;
    this.#range = 0;
  }
}
