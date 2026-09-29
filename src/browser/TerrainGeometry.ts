import type { WorldPosition } from "../world/WorldState.js";
import type { HeightSampler } from "./SimpleScene.js";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";

const TERRAIN_SUBDIVISIONS = 128;
const TERRAIN_EDGE_EPSILON = 1e-6;
const ROWS_PER_STEP = 4;

function complete<T>(steps: Generator<void, T, void>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

/**
 * One tile's height field, plus a one-vertex skirt around it for the normals to lean on.
 * The four skirt corners are never sampled.
 */
export function terrainHeightField(
  grid: { x: number; y: number },
  player: WorldPosition,
  heightAt: HeightSampler | undefined,
): Float32Array {
  return complete(terrainHeightFieldSteps(grid, player, heightAt));
}

function* terrainHeightFieldSteps(
  grid: { x: number; y: number },
  player: WorldPosition,
  heightAt: HeightSampler | undefined,
): Generator<void, Float32Array, void> {
  const side = TERRAIN_SUBDIVISIONS + 1;
  const step = TERRAIN_GRID_SIZE / TERRAIN_SUBDIVISIONS;
  const inside = 1 - TERRAIN_EDGE_EPSILON;
  const skirt = side + 2;
  const heights = new Float32Array(skirt * skirt);
  const at = (row: number, column: number) => (row + 1) * skirt + (column + 1);
  for (let row = -1; row <= side; row++) {
    const outsideRow = row < 0 || row > TERRAIN_SUBDIVISIONS;
    const u = row === 0 ? TERRAIN_EDGE_EPSILON
      : row === TERRAIN_SUBDIVISIONS ? 1 + TERRAIN_EDGE_EPSILON
        : row / TERRAIN_SUBDIVISIONS;
    const sampleX = outsideRow
      ? (32 - grid.x) * TERRAIN_GRID_SIZE - row * step
      : (32 - grid.x - u) * TERRAIN_GRID_SIZE;
    for (let column = -1; column <= side; column++) {
      const outsideColumn = column < 0 || column > TERRAIN_SUBDIVISIONS;
      if (outsideRow && outsideColumn) continue;
      const v = column === 0 ? TERRAIN_EDGE_EPSILON
        : column === TERRAIN_SUBDIVISIONS ? 1 + TERRAIN_EDGE_EPSILON
          : column / TERRAIN_SUBDIVISIONS;
      const sampleY = outsideColumn
        ? (32 - grid.y) * TERRAIN_GRID_SIZE - column * step
        : (32 - grid.y - v) * TERRAIN_GRID_SIZE;
      let height = heightAt?.(sampleX, sampleY);
      // A shared edge uses the canonical far-side owner. Its own-tile copy is a temporary fallback.
      if (height === undefined && !outsideRow && !outsideColumn
        && (row === TERRAIN_SUBDIVISIONS || column === TERRAIN_SUBDIVISIONS)) {
        const ownX = row === TERRAIN_SUBDIVISIONS
          ? (32 - grid.x - inside) * TERRAIN_GRID_SIZE
          : sampleX;
        const ownY = column === TERRAIN_SUBDIVISIONS
          ? (32 - grid.y - inside) * TERRAIN_GRID_SIZE
          : sampleY;
        if (row === TERRAIN_SUBDIVISIONS && column === TERRAIN_SUBDIVISIONS) {
          height = heightAt?.(sampleX, ownY) ?? heightAt?.(ownX, sampleY);
        }
        height ??= heightAt?.(ownX, ownY);
      }
      heights[at(row, column)] = height ?? (outsideRow || outsideColumn ? Number.NaN : player.z);
    }
    if ((row + 2) % ROWS_PER_STEP === 0) yield;
  }
  for (let index = 0; index < side; index++) {
    fillOutside(heights, at(-1, index), at(0, index), at(1, index));
    fillOutside(heights, at(side, index), at(side - 1, index), at(side - 2, index));
    fillOutside(heights, at(index, -1), at(index, 0), at(index, 1));
    fillOutside(heights, at(index, side), at(index, side - 1), at(index, side - 2));
    if ((index + 1) % 16 === 0) yield;
  }
  return heights;
}

export function terrainNormals(heights: Float32Array): Float32Array {
  return complete(terrainNormalsSteps(heights));
}

function* terrainNormalsSteps(heights: Float32Array): Generator<void, Float32Array, void> {
  const side = TERRAIN_SUBDIVISIONS + 1;
  const step = TERRAIN_GRID_SIZE / TERRAIN_SUBDIVISIONS;
  const skirt = side + 2;
  const heightOf = (row: number, column: number) => heights[(row + 1) * skirt + (column + 1)]!;
  const normals = new Float32Array(side * side * 3);
  const twiceStep = 2 * step;
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const slopeX = (heightOf(row - 1, column) - heightOf(row + 1, column)) / twiceStep;
      const slopeY = (heightOf(row, column - 1) - heightOf(row, column + 1)) / twiceStep;
      const length = Math.sqrt(slopeX * slopeX + 1 + slopeY * slopeY) || 1;
      const at = (row * side + column) * 3;
      normals[at] = -slopeX / length;
      normals[at + 1] = 1 / length;
      normals[at + 2] = slopeY / length;
    }
    if ((row + 1) % ROWS_PER_STEP === 0) yield;
  }
  return normals;
}

export interface TerrainGeometryData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array;
}

/** Build the V9 corners, V8 cell centres, four-triangle fans, and border normals in bounded steps. */
export function terrainGeometryData(
  grid: { x: number; y: number },
  player: WorldPosition,
  heightAt: HeightSampler | undefined,
  isHole?: (x: number, y: number) => boolean,
): TerrainGeometryData {
  return complete(terrainGeometrySteps(grid, player, heightAt, isHole));
}

export function* terrainGeometrySteps(
  grid: { x: number; y: number },
  player: WorldPosition,
  heightAt: HeightSampler | undefined,
  isHole?: (x: number, y: number) => boolean,
): Generator<void, TerrainGeometryData, void> {
  const side = TERRAIN_SUBDIVISIONS + 1;
  const cornerCount = side * side;
  const vertexCount = cornerCount + TERRAIN_SUBDIVISIONS * TERRAIN_SUBDIVISIONS;
  const worldX = (row: number) =>
    (32 - grid.x - row / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
  const worldY = (column: number) =>
    (32 - grid.y - column / TERRAIN_SUBDIVISIONS) * TERRAIN_GRID_SIZE;
  const heights = yield* terrainHeightFieldSteps(grid, player, heightAt);
  const heightOf = (row: number, column: number) =>
    heights[(row + 1) * (side + 2) + column + 1]!;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const setVertex = (index: number, x: number, height: number, y: number, u: number, v: number) => {
    positions[index * 3] = x;
    positions[index * 3 + 1] = height;
    positions[index * 3 + 2] = -y;
    uvs[index * 2] = u;
    uvs[index * 2 + 1] = v;
  };

  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      setVertex(
        row * side + column,
        worldX(row), heightOf(row, column), worldY(column),
        column / TERRAIN_SUBDIVISIONS, 1 - row / TERRAIN_SUBDIVISIONS,
      );
    }
    if ((row + 1) % ROWS_PER_STEP === 0) yield;
  }
  for (let row = 0; row < TERRAIN_SUBDIVISIONS; row++) {
    for (let column = 0; column < TERRAIN_SUBDIVISIONS; column++) {
      const x = worldX(row + 0.5);
      const y = worldY(column + 0.5);
      setVertex(
        cornerCount + row * TERRAIN_SUBDIVISIONS + column,
        x, heightAt?.(x, y) ?? player.z, y,
        (column + 0.5) / TERRAIN_SUBDIVISIONS,
        1 - (row + 0.5) / TERRAIN_SUBDIVISIONS,
      );
    }
    if ((row + 1) % ROWS_PER_STEP === 0) yield;
  }

  const normals = new Float32Array(vertexCount * 3);
  // 33,025 vertices fit in uint16. Fill the final GPU backing directly instead of growing
  // a 196,608-element JS array and copying it again during mesh installation.
  const indices = new Uint16Array(TERRAIN_SUBDIVISIONS * TERRAIN_SUBDIVISIONS * 12);
  let indexCount = 0;
  const addTriangleNormal = (a: number, b: number, c: number) => {
    const ap = a * 3;
    const bp = b * 3;
    const cp = c * 3;
    const abx = positions[bp]! - positions[ap]!;
    const aby = positions[bp + 1]! - positions[ap + 1]!;
    const abz = positions[bp + 2]! - positions[ap + 2]!;
    const acx = positions[cp]! - positions[ap]!;
    const acy = positions[cp + 1]! - positions[ap + 1]!;
    const acz = positions[cp + 2]! - positions[ap + 2]!;
    const x = aby * acz - abz * acy;
    const y = abz * acx - abx * acz;
    const z = abx * acy - aby * acx;
    normals[ap] = normals[ap]! + x;
    normals[ap + 1] = normals[ap + 1]! + y;
    normals[ap + 2] = normals[ap + 2]! + z;
    normals[bp] = normals[bp]! + x;
    normals[bp + 1] = normals[bp + 1]! + y;
    normals[bp + 2] = normals[bp + 2]! + z;
    normals[cp] = normals[cp]! + x;
    normals[cp + 1] = normals[cp + 1]! + y;
    normals[cp + 2] = normals[cp + 2]! + z;
  };
  for (let row = 0; row < TERRAIN_SUBDIVISIONS; row++) {
    for (let column = 0; column < TERRAIN_SUBDIVISIONS; column++) {
      const a = row * side + column;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      const centre = cornerCount + row * TERRAIN_SUBDIVISIONS + column;
      const x = worldX(row + 0.5);
      const y = worldY(column + 0.5);
      if (isHole?.(x, y)) continue;
      addTriangleNormal(a, c, centre);
      addTriangleNormal(c, d, centre);
      addTriangleNormal(d, b, centre);
      addTriangleNormal(b, a, centre);
      indices[indexCount++] = a;
      indices[indexCount++] = c;
      indices[indexCount++] = centre;
      indices[indexCount++] = c;
      indices[indexCount++] = d;
      indices[indexCount++] = centre;
      indices[indexCount++] = d;
      indices[indexCount++] = b;
      indices[indexCount++] = centre;
      indices[indexCount++] = b;
      indices[indexCount++] = a;
      indices[indexCount++] = centre;
    }
    if ((row + 1) % ROWS_PER_STEP === 0) yield;
  }
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const at = vertex * 3;
    const length = Math.hypot(normals[at]!, normals[at + 1]!, normals[at + 2]!);
    if (length > 1e-12) {
      normals[at] = normals[at]! / length;
      normals[at + 1] = normals[at + 1]! / length;
      normals[at + 2] = normals[at + 2]! / length;
    } else {
      normals[at] = 0;
      normals[at + 1] = 1;
      normals[at + 2] = 0;
    }
    if ((vertex + 1) % 1024 === 0) yield;
  }
  // Border V9 vertices use the same canonical neighbour samples on both touching meshes.
  const borderNormals = yield* terrainNormalsSteps(heights);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      if (row !== 0 && row !== TERRAIN_SUBDIVISIONS
        && column !== 0 && column !== TERRAIN_SUBDIVISIONS) continue;
      const vertex = row * side + column;
      normals.set(borderNormals.subarray(vertex * 3, vertex * 3 + 3), vertex * 3);
    }
    if ((row + 1) % ROWS_PER_STEP === 0) yield;
  }
  return { positions, normals, uvs, indices: indices.subarray(0, indexCount) };
}

/** Continue a missing neighbour's sample along the tile's own slope. */
function fillOutside(heights: Float32Array, outside: number, edge: number, inward: number): void {
  if (!Number.isNaN(heights[outside]!)) return;
  heights[outside] = 2 * heights[edge]! - heights[inward]!;
}

/** The scene-space normal of a height field, from its four neighbours. */
export function surfaceNormal(north: number, south: number, west: number, east: number, step: number): [number, number, number] {
  const slopeX = (north - south) / (2 * step);
  const slopeY = (west - east) / (2 * step);
  const length = Math.hypot(slopeX, 1, slopeY) || 1;
  return [-slopeX / length, 1 / length, slopeY / length];
}
