import * as THREE from "three";
import { OUTER, buildHorizonGeometry, horizonTileAt, writeNormal, writeUv, type HorizonMap, type HorizonTile } from "./Horizon.js";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";

/**
 * 22.10 (7.44): the first ring of tiles past the near 3×3 window, drawn from the real terrain
 * heights at a reduced LOD instead of the WDL, on the enhanced path.
 *
 * The WDL is the terrain rounded to one vertex per 33 yards; at 1,000–1,600 yards a ridge drawn
 * from it is visibly faceted, and the minimap detail (HorizonDetail.ts) is then painted on the
 * wrong shapes. The server's own `.map` tile of every one of these sixteen cells is already
 * resident — the near ring's edge normals sample one step into them, which fetched them — so the
 * ring reads them through `TerrainClient.residentHeightAt` and never asks for anything more.
 *
 * One mesh per tile, 64 cells a side (8.3 yards, four times the WDL's resolution), 8,192
 * triangles plus a skirt. Tiles share their exact edge heights; against the near ring (128 cells
 * a side) and the outer WDL ring (16) the edges differ by the surface's own curvature between two
 * vertices, under a yard at these distances, so every edge carries a {@link HORIZON_LOD_SKIRT}-
 * yard skirt that closes the hairline instead of a sky-coloured crack. No surface underlays
 * another: the WDL ring leaves these tiles out on the enhanced path (`horizonTiles`'s inner reach).
 *
 * A tile whose terrain is not resident (yet) is the WDL's own geometry for that tile — the same
 * shape the ring drew before — and is upgraded on a later frame, at most
 * {@link HORIZON_LOD_BUILDS_PER_FRAME} a frame, so a tile crossing never stacks the builds.
 */

/** Cells per tile side. */
export const HORIZON_LOD_SUBDIVISIONS = 64;
/** How far the skirt hangs below each edge, in yards. */
export const HORIZON_LOD_SKIRT = 4;
/** Terrain-height builds per frame (≈0.2 ms each); WDL stand-ins are not counted (≈0.02 ms). */
export const HORIZON_LOD_BUILDS_PER_FRAME = 1;
/** The ring's Chebyshev distance from the player's tile. */
export const HORIZON_LOD_REACH = 2;

export type HeightSample = (x: number, y: number) => number | undefined;

/** The WDL's height at a world point: bilinear over the tile's outer grid; `undefined` off the map. */
export function wdlHeightAt(world: HorizonMap, x: number, y: number): number | undefined {
  const rows = 32 - x / TERRAIN_GRID_SIZE;
  const columns = 32 - y / TERRAIN_GRID_SIZE;
  const gridX = Math.floor(rows);
  const gridY = Math.floor(columns);
  const tile = horizonTileAt(world, gridX, gridY);
  if (!tile) return undefined;
  const r = Math.min(OUTER - 1 - 1e-9, (rows - gridX) * (OUTER - 1));
  const c = Math.min(OUTER - 1 - 1e-9, (columns - gridY) * (OUTER - 1));
  const r0 = Math.floor(r);
  const c0 = Math.floor(c);
  const fr = r - r0;
  const fc = c - c0;
  const o = tile.outer;
  const top = o[r0 * OUTER + c0]! * (1 - fc) + o[r0 * OUTER + c0 + 1]! * fc;
  const bottom = o[(r0 + 1) * OUTER + c0]! * (1 - fc) + o[(r0 + 1) * OUTER + c0 + 1]! * fc;
  return top * (1 - fr) + bottom * fr;
}

/**
 * One tile's mesh from a height sampler: (n+1)² vertices on the tile's own heights (sampled a hair
 * inside the edge, as the near terrain does), normals by central differences that look across
 * the edge through `outside`, the horizon's colour-map UVs, and a skirt on all four edges.
 */
export function buildHorizonLodGeometry(
  gridX: number, gridY: number, inside: HeightSample, outside: HeightSample,
  subdivisions = HORIZON_LOD_SUBDIVISIONS, skirt = HORIZON_LOD_SKIRT,
): THREE.BufferGeometry | undefined {
  const side = subdivisions + 1;
  const step = TERRAIN_GRID_SIZE / subdivisions;
  const edge = 1e-6;
  const worldX = (row: number) => (32 - gridX - Math.min(1 - edge, Math.max(edge, row / subdivisions))) * TERRAIN_GRID_SIZE;
  const worldY = (column: number) => (32 - gridY - Math.min(1 - edge, Math.max(edge, column / subdivisions))) * TERRAIN_GRID_SIZE;
  // Heights with a one-vertex border for the normals (the border's corners are never read).
  const border = side + 2;
  const heights = new Float32Array(border * border);
  const at = (row: number, column: number) => (row + 1) * border + column + 1;
  for (let row = 0; row < side; row++) {
    const x = worldX(row);
    for (let column = 0; column < side; column++) {
      const height = inside(x, worldY(column));
      if (height === undefined) return undefined;
      heights[at(row, column)] = height;
    }
  }
  const originX = (32 - gridX) * TERRAIN_GRID_SIZE;
  const originY = (32 - gridY) * TERRAIN_GRID_SIZE;
  for (let index = 0; index < side; index++) {
    const along = index * step;
    const fill = (target: number, x: number, y: number, inner: number, innerNext: number) => {
      // Outside: the neighbour's own height, else continue the slope inward.
      heights[target] = outside(x, y) ?? 2 * heights[inner]! - heights[innerNext]!;
    };
    fill(at(-1, index), originX + step, originY - along, at(0, index), at(1, index));
    fill(at(side, index), originX - TERRAIN_GRID_SIZE - step, originY - along, at(side - 1, index), at(side - 2, index));
    fill(at(index, -1), originX - along, originY + step, at(index, 0), at(index, 1));
    fill(at(index, side), originX - along, originY - TERRAIN_GRID_SIZE - step, at(index, side - 1), at(index, side - 2));
  }
  const skirtVertices = 4 * side;
  const vertexCount = side * side + skirtVertices;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tile = { gridX, gridY } as HorizonTile;
  const uvScale = (OUTER - 1) / subdivisions;
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const vertex = row * side + column;
      const p = vertex * 3;
      positions[p] = originX - row * step;
      positions[p + 1] = heights[at(row, column)]!;
      positions[p + 2] = -(originY - column * step);
      const southward = (heights[at(row + 1, column)]! - heights[at(row - 1, column)]!) / 2;
      const eastward = (heights[at(row, column + 1)]! - heights[at(row, column - 1)]!) / 2;
      writeNormal(normals, p, southward, eastward, step);
      writeUv(uvs, vertex * 2, tile, row * uvScale, column * uvScale);
    }
  }
  // Skirt vertices: each edge's vertices again, `skirt` yards lower, with the edge's normal and UV.
  const edges: Array<(index: number) => number> = [
    (index) => index, // row 0
    (index) => (side - 1) * side + index, // last row
    (index) => index * side, // column 0
    (index) => index * side + side - 1, // last column
  ];
  let next = side * side;
  const skirtStart: number[] = [];
  for (const vertexOf of edges) {
    skirtStart.push(next);
    for (let index = 0; index < side; index++) {
      const source = vertexOf(index);
      positions[next * 3] = positions[source * 3]!;
      positions[next * 3 + 1] = positions[source * 3 + 1]! - skirt;
      positions[next * 3 + 2] = positions[source * 3 + 2]!;
      normals.copyWithin(next * 3, source * 3, source * 3 + 3);
      uvs.copyWithin(next * 2, source * 2, source * 2 + 2);
      next++;
    }
  }
  const cells = subdivisions * subdivisions;
  const indices = new Uint16Array(cells * 6 + 4 * subdivisions * 12);
  let index = 0;
  for (let row = 0; row < subdivisions; row++) {
    for (let column = 0; column < subdivisions; column++) {
      const topLeft = row * side + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + side;
      const bottomRight = bottomLeft + 1;
      // Up-facing in the scene's frame, the horizon's own winding (rows along −x, columns along +z).
      indices[index++] = bottomRight; indices[index++] = topRight; indices[index++] = topLeft;
      indices[index++] = bottomRight; indices[index++] = topLeft; indices[index++] = bottomLeft;
    }
  }
  // Skirts face both ways (two triangles each side): which side the camera sees depends on the edge.
  for (let edgeIndex = 0; edgeIndex < 4; edgeIndex++) {
    const vertexOf = edges[edgeIndex]!;
    const low = skirtStart[edgeIndex]!;
    for (let along = 0; along < subdivisions; along++) {
      const a = vertexOf(along);
      const b = vertexOf(along + 1);
      const c = low + along;
      const d = low + along + 1;
      indices[index++] = a; indices[index++] = b; indices[index++] = c;
      indices[index++] = b; indices[index++] = d; indices[index++] = c;
      indices[index++] = a; indices[index++] = c; indices[index++] = b;
      indices[index++] = b; indices[index++] = c; indices[index++] = d;
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

/** The cells of the ring around a centre tile: Chebyshev distance exactly {@link HORIZON_LOD_REACH}. */
export function horizonLodCells(centreX: number, centreY: number): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let x = centreX - HORIZON_LOD_REACH; x <= centreX + HORIZON_LOD_REACH; x++) {
    for (let y = centreY - HORIZON_LOD_REACH; y <= centreY + HORIZON_LOD_REACH; y++) {
      if (Math.max(Math.abs(x - centreX), Math.abs(y - centreY)) === HORIZON_LOD_REACH) cells.push({ x, y });
    }
  }
  return cells;
}

/** The terrain side of the ring: resident heights and their revision, from the renderer's TerrainClient. */
export interface HorizonLodTerrain {
  residentHeightAt(map: number, x: number, y: number): number | undefined;
  ownRevision(map: number, grid: { x: number; y: number }): number;
}

interface LodTile {
  mesh: THREE.Mesh;
  /** 0: the WDL stand-in; otherwise the terrain tile's own revision it was built from. */
  revision: number;
}

/** The renderer's LOD ring: one mesh per tile, upgraded from the WDL stand-in as terrain lands. */
export class HorizonLodRing {
  readonly #tiles = new Map<number, LodTile>();
  readonly #wanted = new Set<number>();
  #map = -1;
  /** The ring's cells for {@link #cellsFor}: rebuilt only when the centre tile changes. */
  #cells: Array<{ x: number; y: number }> = [];
  #cellsFor = -1;
  /** Terrain builds done so far (tests and diagnostics). */
  builds = 0;

  get meshes(): THREE.Mesh[] {
    return [...this.#tiles.values()].map((tile) => tile.mesh);
  }

  /** How many of the ring's tiles are drawn from the terrain rather than the WDL stand-in. */
  get terrainTiles(): number {
    let count = 0;
    for (const tile of this.#tiles.values()) if (tile.revision > 0) count++;
    return count;
  }

  update(scene: THREE.Scene, map: number, centreX: number, centreY: number, world: HorizonMap,
    terrain: HorizonLodTerrain | undefined, material: THREE.Material): void {
    if (map !== this.#map) {
      this.clear(scene);
      this.#map = map;
    }
    if (this.#cellsFor !== centreX * 64 + centreY) {
      this.#cellsFor = centreX * 64 + centreY;
      this.#cells = horizonLodCells(centreX, centreY);
    }
    const wanted = this.#wanted;
    wanted.clear();
    let budget = HORIZON_LOD_BUILDS_PER_FRAME;
    for (const { x, y } of this.#cells) {
      const wdl = horizonTileAt(world, x, y);
      if (!wdl) continue; // no ground there at all
      const id = x * 64 + y;
      wanted.add(id);
      const existing = this.#tiles.get(id);
      if (existing && existing.mesh.material !== material) existing.mesh.material = material;
      const centreHeight = terrain?.residentHeightAt(map, (31.5 - x) * TERRAIN_GRID_SIZE, (31.5 - y) * TERRAIN_GRID_SIZE);
      const revision = centreHeight === undefined ? 0 : terrain!.ownRevision(map, { x, y });
      if (existing && existing.revision === revision) continue;
      if (existing && revision === 0) continue; // keep the terrain build until the tile is back
      let geometry: THREE.BufferGeometry | undefined;
      if (revision > 0 && budget > 0) {
        budget--;
        const inside: HeightSample = (px, py) => terrain!.residentHeightAt(map, px, py);
        const outside: HeightSample = (px, py) => terrain!.residentHeightAt(map, px, py) ?? wdlHeightAt(world, px, py);
        geometry = buildHorizonLodGeometry(x, y, inside, outside);
        if (geometry) this.builds++;
      }
      if (!geometry) {
        if (existing) continue; // a terrain build waits for its frame; the stand-in stays
        geometry = buildHorizonGeometry([wdl], (gx, gy) => horizonTileAt(world, gx, gy));
        this.#place(scene, id, geometry, material, 0);
        continue;
      }
      this.#place(scene, id, geometry, material, revision);
    }
    for (const [id, tile] of this.#tiles) {
      if (wanted.has(id)) continue;
      scene.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      this.#tiles.delete(id);
    }
  }

  #place(scene: THREE.Scene, id: number, geometry: THREE.BufferGeometry, material: THREE.Material, revision: number): void {
    const existing = this.#tiles.get(id);
    if (existing) {
      scene.remove(existing.mesh);
      existing.mesh.geometry.dispose();
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 0; // after the sky dome, like the ring (WorldRenderer3D #updateHorizon)
    mesh.name = "horizon-lod";
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    this.#tiles.set(id, { mesh, revision });
  }

  clear(scene: THREE.Scene): void {
    for (const tile of this.#tiles.values()) {
      scene.remove(tile.mesh);
      tile.mesh.geometry.dispose();
    }
    this.#tiles.clear();
    this.#map = -1;
  }
}
