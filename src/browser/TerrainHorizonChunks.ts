/**
 * 15.11 (7.54, 7.53): the terrain chunks of the loaded tiles as Wow.exe feeds them to its horizon (`TerrainHorizon.ts`).
 *
 * A chunk is 8 x 8 cells of the tile's 128 x 128 (`TerrainTile.horizonHeight`), the same outer heights as the ADT's
 * MCVT that Wow.exe reads. Per frame, front to back by bucket (`0x799d40`):
 * - a chunk is tested in the bucket of its nearest corner: its box against the view and against the horizon;
 * - one that passes and has no holes is filled in the bucket of its farthest corner, with its far row and far column
 *   (`0x7cfb10`), unless its own bucket is the last one (`0x799d40` keeps buckets up to 62 for the fill);
 * - one with holes resets the columns of its far edges; this client does that for every holed chunk the horizon does
 *   not hide, in every bucket from its nearest to its farthest corner, view or no view, so that its horizon never stands
 *   higher than Wow.exe's.
 * Boxes are cached per tile; the far edges are read per frame (18 heights a chunk).
 */

import type { TerrainTile } from "./Terrain.js";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";
import type { TerrainHorizon } from "./TerrainHorizon.js";

/** One loaded tile and its grid position (`terrainGridAxis` of world X, then of world Y). */
export interface HorizonTile {
  readonly tile: TerrainTile;
  readonly gridX: number;
  readonly gridY: number;
}

interface ChunkBoxes {
  /** Six floats per chunk (256 of them): minX, minY, minZ, maxX, maxY, maxZ in Wow world axes. */
  readonly boxes: Float64Array;
  readonly holes: Uint16Array;
}

const BOXES = new WeakMap<TerrainTile, Map<string, ChunkBoxes>>();
const CHUNK = TERRAIN_GRID_SIZE / 16;

function worldX(gridX: number, row: number): number {
  return TERRAIN_GRID_SIZE * (32 - gridX - row / 128);
}

function worldY(gridY: number, column: number): number {
  return TERRAIN_GRID_SIZE * (32 - gridY - column / 128);
}

function chunkBoxes(entry: HorizonTile): ChunkBoxes {
  let byGrid = BOXES.get(entry.tile);
  if (!byGrid) BOXES.set(entry.tile, byGrid = new Map());
  const key = `${entry.gridX},${entry.gridY}`;
  const known = byGrid.get(key);
  if (known) return known;
  const boxes = new Float64Array(256 * 6);
  const holes = new Uint16Array(256);
  for (let chunkRow = 0; chunkRow < 16; chunkRow++) {
    for (let chunkColumn = 0; chunkColumn < 16; chunkColumn++) {
      let low = Infinity;
      let high = -Infinity;
      for (let row = 0; row <= 8; row++) {
        for (let column = 0; column <= 8; column++) {
          const height = Math.max(-500, entry.tile.horizonHeight(chunkRow * 8 + row, chunkColumn * 8 + column));
          if (height < low) low = height;
          if (height > high) high = height;
          if (row < 8 && column < 8) {
            const inner = Math.max(-500, entry.tile.horizonHeight(chunkRow * 8 + row, chunkColumn * 8 + column, true));
            if (inner < low) low = inner;
            if (inner > high) high = inner;
          }
        }
      }
      const at = (chunkRow * 16 + chunkColumn) * 6;
      // Rows grow towards lower world X, columns towards lower world Y.
      boxes[at] = worldX(entry.gridX, chunkRow * 8 + 8);
      boxes[at + 1] = worldY(entry.gridY, chunkColumn * 8 + 8);
      boxes[at + 2] = low;
      boxes[at + 3] = boxes[at]! + CHUNK;
      boxes[at + 4] = boxes[at + 1]! + CHUNK;
      boxes[at + 5] = high;
      holes[chunkRow * 16 + chunkColumn] = entry.tile.chunkHoles(chunkRow, chunkColumn);
    }
  }
  const made = { boxes, holes };
  byGrid.set(key, made);
  return made;
}

/** Whether a box is in the view: not wholly outside any of the six planes of `clip` (column-major, Wow world axes). */
export function horizonBoxInView(box: Float64Array, at: number, m: ArrayLike<number>): boolean {
  let left = 0, right = 0, bottom = 0, top = 0, near = 0, far = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = box[at + ((corner & 1) !== 0 ? 3 : 0)]!;
    const y = box[at + ((corner & 2) !== 0 ? 4 : 1)]!;
    const z = box[at + ((corner & 4) !== 0 ? 5 : 2)]!;
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (cx < -w) left++;
    if (cx > w) right++;
    if (cy < -w) bottom++;
    if (cy > w) top++;
    if (cz < -w) near++;
    if (cz > w) far++;
  }
  return left < 8 && right < 8 && bottom < 8 && top < 8 && near < 8 && far < 8;
}

interface QueuedChunk {
  readonly entry: HorizonTile;
  readonly index: number;
  readonly boxes: Float64Array;
  readonly holes: number;
  readonly far: number;
}

/** What one frame's chunks did, for diagnostics and the census. */
export interface HorizonChunkCounts {
  /** Chunks whose box is in the view. */
  inView: number;
  /** Of those, hidden by the horizon (Wow.exe does not draw them). */
  hidden: number;
  filled: number;
  resets: number;
}

/**
 * Builds this frame's horizon from `tiles` and runs it. `visit(bucket)` is called in every bucket before its fill,
 * after the chunks of that bucket were tested, so the caller tests its own boxes there. `chunkHidden`, when given,
 * receives per tile (in `tiles` order) 256 flags: 1 = in the view and hidden, 2 = in the view and seen.
 */
export function runTerrainHorizon(
  horizon: TerrainHorizon,
  tiles: readonly HorizonTile[],
  clip: ArrayLike<number>,
  visit?: (bucket: number) => void,
  chunkHidden?: Uint8Array[],
): HorizonChunkCounts {
  const counts: HorizonChunkCounts = { inView: 0, hidden: 0, filled: 0, resets: 0 };
  if (!horizon.active) {
    horizon.run(visit);
    return counts;
  }
  const byBucket: QueuedChunk[][] = [];
  for (let bucket = 0; bucket < 64; bucket++) byBucket.push([]);
  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
    const entry = tiles[tileIndex]!;
    const { boxes, holes } = chunkBoxes(entry);
    for (let index = 0; index < 256; index++) {
      const at = index * 6;
      const bucket = horizon.bucketOf(boxes[at]!, boxes[at + 1]!, boxes[at + 2]!, boxes[at + 3]!, boxes[at + 4]!, boxes[at + 5]!);
      if (bucket < 0) continue;
      const far = horizon.farBucketOf(boxes[at]!, boxes[at + 1]!, boxes[at + 3]!, boxes[at + 4]!);
      byBucket[bucket]!.push({ entry, index, boxes, holes: holes[index]!, far });
      if (chunkHidden) (chunkHidden[tileIndex] ??= new Uint8Array(256))[index] = 0;
    }
  }
  const tileIndexOf = new Map(tiles.map((entry, index) => [entry, index]));
  horizon.run((bucket) => {
    for (const chunk of byBucket[bucket]!) {
      const at = chunk.index * 6;
      const b = chunk.boxes;
      const hidden = horizon.boxHidden(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!, b[at + 4]!, b[at + 5]!, bucket);
      const inView = horizonBoxInView(b, at, clip);
      if (inView) {
        counts.inView++;
        if (hidden) counts.hidden++;
        if (chunkHidden) chunkHidden[tileIndexOf.get(chunk.entry)!]![chunk.index] = hidden ? 1 : 2;
      }
      if (hidden) continue;
      if (chunk.holes !== 0) {
        horizon.queueReset(bucket, chunk.far, farEdges(horizon, chunk));
        counts.resets++;
      } else if (inView && bucket <= 62 && chunk.far >= 0) {
        horizon.queueFill(chunk.far, farEdges(horizon, chunk));
        counts.filled++;
      }
    }
    if (visit) visit(bucket);
  });
  return counts;
}

/** `0x7cfb10`: the far row, then the far column, nine points each, in Wow world axes. */
function farEdges(horizon: TerrainHorizon, chunk: QueuedChunk): Float64Array {
  const { tile, gridX, gridY } = chunk.entry;
  const chunkRow = chunk.index >> 4;
  const chunkColumn = chunk.index & 15;
  const row = chunkRow * 8 + (horizon.headingNegativeX ? 8 : 0);
  const column = chunkColumn * 8 + (horizon.headingNegativeY ? 8 : 0);
  const points = new Float64Array(18 * 3);
  for (let step = 0; step <= 8; step++) {
    points[step * 3] = worldX(gridX, row);
    points[step * 3 + 1] = worldY(gridY, chunkColumn * 8 + step);
    points[step * 3 + 2] = tile.horizonHeight(row, chunkColumn * 8 + step);
    const at = (9 + step) * 3;
    points[at] = worldX(gridX, chunkRow * 8 + step);
    points[at + 1] = worldY(gridY, column);
    points[at + 2] = tile.horizonHeight(chunkRow * 8 + step, column);
  }
  return points;
}
