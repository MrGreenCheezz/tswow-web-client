/**
 * The grass, and everything else that grows on a detail cell.
 *
 * Nothing in this client had ever read a ground effect: `tools/generate-terrain-splat.mjs` read
 * MCLY at +0, +4 and +8 and stopped four bytes short of the `GroundEffectTexture` id at +12, so
 * the ground was bare everywhere. The data is complete and healthy — across Azeroth, Kalimdor,
 * Outland and Northrend 1,749,939 of 2,055,671 layers carry a non-zero effect id and **0** of them
 * fail to resolve — and the 892 rows that grow anything name 484 of 485 models the client ships,
 * 3,026 triangles in total over 74 textures.
 *
 * They cannot be published as placements and that was measured: the live gateway answers a visual
 * tile at 370.5 bytes per object, and the Goldshire tile carries 101,036 ground doodads, which is
 * 37.4 MB for one tile and 337 MB over the ring the client streams. So the tile publishes the
 * artists' own recipe — `<x>-<y>.cover.bin`, 40 bytes a chunk, see `tools/ground-cover.mjs` — and
 * this scatters from it inside its own short radius. Everything here is a pure function of the
 * recipe and the position, so two rebuilds of the same ground produce the same field: nothing is
 * seeded on the frame, the camera, or the order the tiles landed in.
 */

import { TERRAIN_GRID_SIZE, type TerrainGrid } from "./Terrain.js";
import type { RetainedResourceVisitor } from "./ResourceAccounting.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";
import { withGeneration } from "./GatewayGeneration.js";

/** The file's magic, which is also its version: a later layout is `WGC2`. */
export const GROUND_COVER_MAGIC = "WGC1";
export const GROUND_COVER_VERSION = 1;
export const GROUND_COVER_HEADER = 8;
export const GROUND_COVER_STRIDE = 40;
export const GROUND_COVER_CHUNKS = 256;
export const GROUND_COVER_SIZE = GROUND_COVER_HEADER + GROUND_COVER_CHUNKS * GROUND_COVER_STRIDE;

/** A tile is 16 chunks of 8 cells, so a detail cell is 533.33333/128 = 4.16667 yards. */
export const DETAIL_CELLS_PER_TILE = 128;
export const DETAIL_CELL_SIZE = TERRAIN_GRID_SIZE / DETAIL_CELLS_PER_TILE;
/** The world's northern and western edge, from which the cell grid is counted. */
const WORLD_ORIGIN = 32 * TERRAIN_GRID_SIZE;

/**
 * How far the ground cover is drawn, and how far it is *built*.
 *
 * Ground cover has a ceiling of its own rather than a share of the doodad range, which is the
 * reference client's own arrangement: "grass stops between 70 and 140 yards in the original client
 * while doodads run to the horizon" (`wowee/include/rendering/m2_renderer.hpp:566-575`, and the
 * same sentence at `include/rendering/m2_view_distance.hpp:29-35`, where it is applied as a
 * ceiling and not as a scale). The web camera exposes pop-in more readily than the reference's
 * fog, so this client allows a wider 180-yard ceiling and fades the outer twenty yards by scale.
 */
export const GROUND_COVER_MAX_RADIUS = 180;
/** Spatial band in which a tuft shrinks to nothing instead of crossing a binary draw boundary. */
export const GROUND_COVER_FADE_WIDTH = 20;
/**
 * How much wider than the drawn radius the field is generated.
 *
 * The field is rebuilt on the same four-yard step the environment ranking uses, so at its stalest
 * the window's centre lags the player by a whole step: generating exactly to the radius would end
 * the field at a visible edge on the side the player is walking towards and pop it forward on
 * every rebuild. The reference client states the same invariant as `windowRadius = drawDistance +
 * rebuildStep` (`wowee/src/rendering/renderer.cpp:2064-2081`).
 */
export const GROUND_COVER_MARGIN = 4;
/**
 * A hard ceiling on one field, so that no arrangement of chunks can spike a frame.
 *
 * Measured over the nine tiles around Goldshire, the densest field holds 3,525 doodads within 50
 * yards and about 9,000 within the new 80-yard default. Keep the cap above that default so the
 * distance fade, not a budget cliff, owns its visible edge; the cap still bounds wider settings.
 */
export const GROUND_COVER_BUDGET = 10_000;
/** Lifted off the ground by the same hair the reference client uses, so a base does not z-fight. */
const GROUND_COVER_LIFT = 0.01;
/** The reference client's own range for a tuft's size (`wowee/terrain_manager.cpp:2031-2033`). */
const SCALE_MINIMUM = 0.8;
const SCALE_RANGE = 0.35;

/** One `GroundEffectTexture` row as `/dbc/ground-effects` publishes it. */
export interface GroundEffect {
  density: number;
  terrain: number;
  doodads: Array<[model: number, weight: number]>;
}

export interface GroundEffectTable {
  models: string[];
  effects: Record<number, GroundEffect>;
}

/**
 * One tile's recipe, flattened: four effect ids, eight winner words and eight mask bytes per
 * chunk, in the order `chunkRow * 16 + chunkColumn`.
 */
export interface GroundCoverRecipe {
  effects: Uint32Array;
  winner: Uint16Array;
  noDoodad: Uint8Array;
}

export function decodeGroundCover(data: ArrayBuffer): GroundCoverRecipe {
  if (data.byteLength !== GROUND_COVER_SIZE) {
    throw new Error(`Ground cover is ${data.byteLength} bytes, expected ${GROUND_COVER_SIZE}`);
  }
  const view = new DataView(data);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== GROUND_COVER_MAGIC) throw new Error(`Ground cover has magic ${JSON.stringify(magic)}`);
  if (view.getUint8(4) !== GROUND_COVER_VERSION) throw new Error(`Ground cover has version ${view.getUint8(4)}`);
  if (view.getUint8(5) !== GROUND_COVER_STRIDE || view.getUint16(6, true) !== GROUND_COVER_CHUNKS) {
    throw new Error("Ground cover header does not describe this layout");
  }
  const effects = new Uint32Array(GROUND_COVER_CHUNKS * 4);
  const winner = new Uint16Array(GROUND_COVER_CHUNKS * 8);
  const noDoodad = new Uint8Array(GROUND_COVER_CHUNKS * 8);
  for (let chunk = 0; chunk < GROUND_COVER_CHUNKS; chunk++) {
    const at = GROUND_COVER_HEADER + chunk * GROUND_COVER_STRIDE;
    for (let slot = 0; slot < 4; slot++) effects[chunk * 4 + slot] = view.getUint32(at + slot * 4, true);
    for (let row = 0; row < 8; row++) {
      winner[chunk * 8 + row] = view.getUint16(at + 0x10 + row * 2, true);
      noDoodad[chunk * 8 + row] = view.getUint8(at + 0x20 + row);
    }
  }
  return { effects, winner, noDoodad };
}

/** One model's share of a field, ready to be written into an instanced draw. */
export interface GroundCoverBatch {
  /** World x, world y and world z of each doodad, in placement order. */
  x: number[];
  y: number[];
  z: number[];
  /** Turn about the vertical, in radians, and the size the model is drawn at. */
  yaw: number[];
  scale: number[];
}

export interface GroundCoverField {
  /** By model path, exactly as `/visual/model` wants it. */
  models: Map<string, GroundCoverBatch>;
  total: number;
  /** Cells the budget refused, so the status line can say the field was clipped. */
  cellsDropped: number;
  /** Points whose tile has not landed yet, which is a reason to rebuild when it does. */
  withoutHeight: number;
}

export interface ScatterOptions {
  /** The recipes in hand, by the grid they belong to. */
  recipe: (grid: TerrainGrid) => GroundCoverRecipe | undefined;
  table: GroundEffectTable;
  centre: { x: number; y: number };
  /** Build/prefetch radius. Use `drawRadius` when this includes a rebuild margin. */
  radius: number;
  /**
   * Whether `Density` counts doodads per 4.16667-yard detail cell or per 33.3-yard chunk.
   *
   * **This is not settled offline and the difference is 64×.** What is certain is where cover goes
   * — the winner map and the mask are per cell, and both readings were measured against the art.
   * What is not certain is how many. Per cell the Goldshire tile carries 101,036 doodads
   * (0.355/yd², one clump every 1.7 yards), which reads as a grass field; per chunk it carries
   * 1,579, one clump every 11.8 yards, which is not what the artists can have meant by a meadow.
   * The reference client does not settle it either: it reads the density as attempts spread over a
   * whole chunk (`wowee/src/rendering/terrain_manager.cpp:1956-1960`) and then caps the result at
   * three per chunk (`:1864-1865`), so its own number is a budget rather than a reading, and its
   * grass path uses the density as a yes-or-no only (`src/pipeline/grass_terrain.cpp:106`).
   *
   * So the per-cell reading is the default, the per-chunk one is «Густая трава» turned off, and
   * thirty seconds in Elwynn settles it: a field of clumps you can walk through is the first, a
   * lawn with no ground showing (or a frame that collapses) is the second.
   */
  perCell: boolean;
  cap?: number;
  /**
   * Multiplier over the authored `Density`, 1 for the artists' own count.
   *
   * Applied before the per-cell/per-chunk reading, so both modes scale the same field shape —
   * a denser meadow, not a different one. Positions stay a pure function of cell and index;
   * the extra doodads take higher indexes in the same cell.
   */
  densityScale?: number;
  /** The visible radius when `radius` includes a rebuild/prefetch margin. */
  drawRadius?: number;
  /** Keep full-size placements out to the build radius; the shader applies the live distance fade. */
  deferDistanceFade?: boolean;
  /** The drawn ground's own height, or undefined while its tile is still on the way. */
  heightAt: (x: number, y: number) => number | undefined;
  /**
   * Cells an earlier scatter already grew. Reusing them yields exactly the field a fresh scatter
   * would; the caller must hand over a new cache whenever the recipes, the effect table, `perCell`
   * or `densityScale` change. It is edited in place to hold the cells this scatter visited: the
   * ones that left the window are forgotten and the ones grown for the first time are added.
   */
  cells?: GroundCoverCellCache;
  /**
   * The field the previous scatter returned, to be written over instead of allocated again.
   *
   * The returned field *is* this object, mutated in place: its `models` map, its batches and their
   * arrays are overwritten, a model that no longer grows is dropped from the map, and the counts
   * are replaced. Nothing read from it before the call survives the call, so a caller that needs
   * last rebuild's tufts must copy them out first. The values are exactly a fresh scatter's —
   * models, their order, every tuft — only the storage is kept; a model's arrays keep their
   * capacity, which is what spares the five number arrays per model regrowing tuft by tuft.
   * Undefined, as the renderer holds it before its first field, scatters into a new one.
   */
  reuse?: GroundCoverField | undefined;
}

/**
 * Every doodad one detail cell grows, before any window clips it.
 *
 * A doodad is a pure function of its cell, the recipe, the table and the density reading, so the
 * field four yards on shares almost all of its cells with the last one; only the window's clip,
 * its budget and the distance fade depend on where the player stands.
 */
interface GrownCell {
  /** Model path per doodad in index order; undefined where the roll named a slot without one. */
  readonly paths: readonly (string | undefined)[];
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Ground height plus lift; NaN where the tile had no height yet (such a cell is never kept). */
  readonly z: Float64Array;
  readonly yaw: Float64Array;
  /** Natural size, before the distance fade a CPU-faded field multiplies in. */
  readonly scale: Float64Array;
}

/** Grown cells by global cell index; `null` is a cell that grows nothing. */
export interface GroundCoverCellCache {
  cells: Map<number, GrownCell | null>;
}

export function createGroundCoverCellCache(): GroundCoverCellCache {
  return { cells: new Map() };
}

/** Global cell index; rows and columns are each below 64 tiles of 128 cells. */
const CELLS_PER_WORLD_ROW = DETAIL_CELLS_PER_TILE * 64;

/**
 * What one cell grows, or null for nothing, or undefined when the answer depends on data that has
 * not landed (its recipe) and must not be remembered.
 */
function growCell(
  row: number,
  column: number,
  recipe: GroundCoverRecipe,
  table: GroundEffectTable,
  perCell: boolean,
  densityScale: number,
  heightAt: (x: number, y: number) => number | undefined,
): GrownCell | null {
  const chunk = (((row >> 3) & 15) * 16 + ((column >> 3) & 15));
  const cellRow = row & 7;
  const cellColumn = column & 7;
  // The artist's own "nothing grows here": it covers the roads and every ADT hole.
  if (((recipe.noDoodad[chunk * 8 + cellRow]! >> cellColumn) & 1) !== 0) return null;
  const layer = (recipe.winner[chunk * 8 + cellRow]! >> (cellColumn * 2)) & 3;
  const effect = table.effects[recipe.effects[chunk * 4 + layer]!];
  if (!effect || effect.doodads.length === 0) return null;

  // A cell's key is global, so the same ground grows the same field from any window.
  const seed = mix((row * CELLS_PER_WORLD_ROW + column) | 0);
  let count = Math.max(0, Math.round(effect.density * densityScale));
  if (!perCell) {
    // The per-chunk reading of the same number: a chunk is 64 cells, so each cell carries a
    // sixty-fourth of the row's density and the fraction is spent as a coin the cell tosses for
    // itself. A cell either grows its share or does not, and which it does never changes.
    const share = (effect.density * densityScale) / 64;
    count = Math.floor(share);
    if (random01(seed, 0) < share - count) count++;
  }
  if (count <= 0) return null;

  // Weights are shares among the slots that name a model. The total has to be taken over those
  // slots alone: 36 weights in this dataset sit on a slot whose doodad id is zero, and counting
  // them would drop that share of every roll into a hole.
  let weight = 0;
  for (const [, share] of effect.doodads) weight += share;
  // A row whose live slots all carry weight zero would never pick anything, so they share
  // equally instead — the reference client substitutes 1 for the same reason
  // (`wowee/src/rendering/terrain_manager.cpp:1995-2007`). No row in this dataset needs it: 0 of
  // the 892 published rows has a live slot of weight 0.
  const equal = weight <= 0;
  if (equal) weight = effect.doodads.length;

  const paths: (string | undefined)[] = new Array(count);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  const yaw = new Float64Array(count);
  const scale = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const point = mix(seed + Math.imul(index + 1, 0x85ebca6b));
    x[index] = WORLD_ORIGIN - (row + random01(point, 1)) * DETAIL_CELL_SIZE;
    y[index] = WORLD_ORIGIN - (column + random01(point, 2)) * DETAIL_CELL_SIZE;
    const height = heightAt(x[index]!, y[index]!);
    z[index] = height === undefined ? Number.NaN : height + GROUND_COVER_LIFT;
    let roll = random01(point, 3) * weight;
    let model = effect.doodads[0]![0];
    for (const [candidate, share] of effect.doodads) {
      model = candidate;
      roll -= equal ? 1 : share;
      if (roll < 0) break;
    }
    paths[index] = table.models[model];
    yaw[index] = random01(point, 4) * Math.PI * 2;
    scale[index] = SCALE_MINIMUM + random01(point, 5) * SCALE_RANGE;
  }
  return { paths, x, y, z, yaw, scale };
}

/**
 * Turns the recipe into a field of doodads around a point.
 *
 * Cells are visited nearest first and the budget stops the walk, so what a cap takes away is
 * always the far edge of the field and never a hole in the middle of it. Every doodad's position,
 * model, turn and size is a pure function of its own cell and its index within it, which is what
 * makes two overlapping windows agree on every doodad they share — the property that stops the
 * whole field shuffling every time the player walks four yards.
 *
 * It runs on that four-yard step, so a rebuild that has only moved allocates nothing but the cells
 * it grows for the first time. At the owner's settings (130 yards, density ×4, a 40,000-tuft cap)
 * a Node walk through an Elwynn-like field allocated 8.1 MB a rebuild before — five number arrays
 * per model regrown by `push`, an object per cell for a comparator sort that boxed every
 * comparison, a new map of kept cells, a boxed double out of every `Math.hypot`, and a boxed height
 * for every tuft of every kept cell out of `some(Number.isNaN)` — and on the bench route that was
 * 21% of everything a walking frame allocated. The window is now listed in typed arrays the module
 * keeps and sorted natively, the cell cache is edited in place, and `reuse` writes over the last
 * field's own arrays: 164 KB a rebuild, all of it the sixty-odd cells a step grows, and 1.6 ms
 * against 2.6. The fields, their model order, the cache and the recipes asked for are the same.
 */
export function scatterGroundCover(options: ScatterOptions): GroundCoverField {
  const field = options.reuse ?? { models: new Map(), total: 0, cellsDropped: 0, withoutHeight: 0 };
  // The window arrays are shared by every scatter; one started from inside a callback of another
  // (nothing does that) gets arrays of its own rather than the ones its caller is walking.
  const window = sharedWindowBusy ? new WindowScratch() : sharedWindow;
  const shared = window === sharedWindow;
  if (shared) sharedWindowBusy = true;
  try {
    scatterInto(field, options, window);
    return field;
  } catch (error) {
    // Half written over, a reused field is neither the last field nor the new one; empty is honest.
    batchesOf(field).empty(field);
    throw error;
  } finally {
    window.release();
    if (shared) sharedWindowBusy = false;
  }
}

function scatterInto(field: GroundCoverField, options: ScatterOptions, window: WindowScratch): void {
  const { centre, radius, table, perCell } = options;
  // A caller may widen `radius` for prefetching, but the visible field must never widen with it.
  const requestedDrawRadius = options.drawRadius ?? radius;
  const drawRadius = Number.isFinite(requestedDrawRadius)
    ? Math.max(0, Math.min(radius, requestedDrawRadius))
    : 0;
  const cap = options.cap ?? GROUND_COVER_BUDGET;
  const batches = batchesOf(field);
  const pass = batches.begin();
  let total = 0;
  let cellsDropped = 0;
  let withoutHeight = 0;
  // Written as the negation of the old early return so that a NaN radius or cap still walks.
  if (!(radius <= 0 || cap <= 0)) {
    const centreX = centre.x;
    const centreY = centre.y;
    // The cell grid is counted from the world's own north-west corner, so a cell index is global
    // and a tile is only where the recipe for it is looked up.
    const rowFrom = firstCell(centreX + radius);
    const rowTo = firstCell(centreX - radius);
    const columnFrom = firstCell(centreY + radius);
    const columnTo = firstCell(centreY - radius);
    const count = windowCells(window, centreX, centreY, radius, rowFrom, rowTo, columnFrom, columnTo);
    const cache = options.cells?.cells;
    if (cache) forgetOutside(cache, window, count, rowFrom, rowTo, columnFrom, columnTo);

    const densityScale = Number.isFinite(options.densityScale) && (options.densityScale ?? 1) > 0
      ? options.densityScale ?? 1
      : 1;
    // GPU fade keeps the build margin here and applies the live draw radius in the shader; CPU
    // fade retains the original visible-radius cutoff.
    const deferFade = Boolean(options.deferDistanceFade);
    const clip = deferFade ? radius : drawRadius;
    const clipSquared = clip * clip;
    const heightAt = options.heightAt;
    const order = window.order;
    // Consecutive tufts often repeat a model, and then the last lookup answers without the map.
    let lastPath: string | undefined;
    let lastSlot: BatchSlot | undefined;
    for (let position = 0; position < count; position++) {
      const cellKey = order[position]!;
      if (total >= cap) {
        // Still inside the window, so a cell it grew before stays cached for the next, less
        // crowded scatter.
        cellsDropped++;
        continue;
      }
      let grown = cache?.get(cellKey);
      if (grown === undefined) {
        const row = Math.floor(cellKey / CELLS_PER_WORLD_ROW);
        const column = cellKey - row * CELLS_PER_WORLD_ROW;
        const recipe = window.recipe(options, row >> 7, column >> 7);
        if (!recipe) continue;
        grown = growCell(row, column, recipe, table, perCell, densityScale, heightAt);
        // A cell that met ground without a height is grown again once its tile lands.
        if (cache && (grown === null || !hasNaN(grown.z))) cache.set(cellKey, grown);
      }
      if (grown === null) continue;

      const { paths, x, y, z, yaw, scale } = grown;
      for (let index = 0; index < x.length && total < cap; index++) {
        // Clip each doodad, not just its cell. Squared, because this runs for every tuft of a
        // forty-thousand-tuft field on each rebuild and a square root is not needed to compare.
        const dx = x[index]! - centreX;
        const dy = y[index]! - centreY;
        if (dx * dx + dy * dy > clipSquared) continue;
        const height = z[index]!;
        if (Number.isNaN(height)) {
          withoutHeight++;
          continue;
        }
        const path = paths[index];
        if (path === undefined) continue;
        let slot = lastSlot;
        if (slot === undefined || path !== lastPath) {
          slot = batches.slot(path);
          lastPath = path;
          lastSlot = slot;
        }
        if (slot.pass !== pass) batches.open(slot);
        // Written by index, never pushed: a reused array keeps its storage and is trimmed once.
        const at = slot.count++;
        const batch = slot.batch;
        batch.x[at] = x[index]!;
        batch.y[at] = y[index]!;
        batch.z[at] = height;
        batch.yaw[at] = yaw[index]!;
        batch.scale[at] = deferFade
          ? scale[index]!
          : scale[index]! * groundCoverDistanceScale(hypot2(dx, dy), drawRadius);
        total++;
      }
    }
  }
  batches.finish(field.models);
  field.total = total;
  field.cellsDropped = cellsDropped;
  field.withoutHeight = withoutHeight;
}

/** The first row (column) of cells a window edge at `value` reaches, clamped to the world. */
function firstCell(value: number): number {
  return Math.max(0, Math.min(CELLS_PER_WORLD_ROW - 1, Math.floor((WORLD_ORIGIN - value) / DETAIL_CELL_SIZE)));
}

/**
 * Lists every cell whose nearest point lies within `radius` into `window.order`, nearest first,
 * and returns how many there are.
 *
 * The order has to be exactly the one a stable sort of the row-major listing by distance gives,
 * ties included, because the order cells are visited in is the order their tufts are written in,
 * and ties are common: about any centre with equal offsets inside its cell, a cell and its mirror
 * across the diagonal are the same distance to the last bit. So the distances are sorted natively
 * (no comparator to call, nothing boxed), each cell finds the first sorted slot of its own
 * distance by binary search, and the cells of one distance take those slots in listing order.
 */
function windowCells(
  window: WindowScratch,
  centreX: number,
  centreY: number,
  radius: number,
  rowFrom: number,
  rowTo: number,
  columnFrom: number,
  columnTo: number,
): number {
  const rows = rowTo - rowFrom + 1;
  const columns = columnTo - columnFrom + 1;
  // A NaN centre or radius makes NaN bounds, which the listing loop never entered.
  if (!(rows > 0 && columns > 0)) return 0;
  window.reserve(rows * columns, columns);
  const { keys, distances, sorted, inside, columnOutside } = window;
  for (let column = 0; column < columns; column++) {
    const maxY = WORLD_ORIGIN - (columnFrom + column) * DETAIL_CELL_SIZE;
    columnOutside[column] = Math.max(maxY - DETAIL_CELL_SIZE - centreY, 0, centreY - maxY);
  }
  let count = 0;
  let box = 0;
  for (let row = rowFrom; row <= rowTo; row++) {
    const maxX = WORLD_ORIGIN - row * DETAIL_CELL_SIZE;
    const outsideX = Math.max(maxX - DETAIL_CELL_SIZE - centreX, 0, centreX - maxX);
    for (let column = 0; column < columns; column++, box++) {
      const distance = hypot2(outsideX, columnOutside[column]!);
      if (distance <= radius) {
        keys[count] = row * CELLS_PER_WORLD_ROW + columnFrom + column;
        distances[count] = distance;
        sorted[count] = distance;
        count++;
        inside[box] = 1;
      } else {
        inside[box] = 0;
      }
    }
  }
  if (count === 0) return 0;
  sorted.subarray(0, count).sort();
  const { placed, order } = window;
  placed.fill(0, 0, count);
  for (let cell = 0; cell < count; cell++) {
    const distance = distances[cell]!;
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle]! < distance) low = middle + 1;
      else high = middle;
    }
    const slot = low + placed[low]!;
    placed[low] = placed[low]! + 1;
    order[slot] = keys[cell]!;
  }
  return count;
}

/**
 * Forgets every cached cell outside the window, which leaves the cache holding what building it
 * anew from the visited cells used to: every known cell inside the window, whether or not the
 * budget reached it, and nothing outside. Edited in place, the map keeps its table; rebuilt, it
 * regrew one through every power of two to its two thousand-odd entries on each step.
 */
function forgetOutside(
  cache: Map<number, GrownCell | null>,
  window: WindowScratch,
  count: number,
  rowFrom: number,
  rowTo: number,
  columnFrom: number,
  columnTo: number,
): void {
  if (count === 0) {
    if (cache.size > 0) cache.clear();
    return;
  }
  const columns = columnTo - columnFrom + 1;
  const inside = window.inside;
  for (const key of cache.keys()) {
    const row = Math.floor(key / CELLS_PER_WORLD_ROW);
    const column = key - row * CELLS_PER_WORLD_ROW;
    if (row < rowFrom || row > rowTo || column < columnFrom || column > columnTo
      || inside[(row - rowFrom) * columns + (column - columnFrom)] === 0) {
      cache.delete(key);
    }
  }
}

function hasNaN(values: Float64Array): boolean {
  for (let index = 0; index < values.length; index++) if (Number.isNaN(values[index]!)) return true;
  return false;
}

/**
 * The arrays a scatter lists and sorts its window in, kept between scatters.
 *
 * Sized to the largest window seen and never shrunk. At the 180-yard ceiling plus its margin a
 * window's bounding box is about 8,100 cells, 29 bytes each across these arrays: 235 KB, or half as
 * much again once a shifted centre has grown them.
 */
class WindowScratch {
  /** Global key of each cell inside the radius, in row-major order. */
  keys = new Int32Array(0);
  /** Its distance from the centre, exactly as `Math.hypot` gives it. */
  distances = new Float64Array(0);
  /** The same distances, sorted. */
  sorted = new Float64Array(0);
  /** Per sorted position, how many cells of that distance have been placed from it on. */
  placed = new Int32Array(0);
  /** The window's cell keys, nearest first. */
  order = new Int32Array(0);
  /** Per cell of the bounding box, row-major, 1 where it lies inside the radius. */
  inside = new Uint8Array(0);
  /** Per column of the bounding box, how far its cells lie from the centre along y. */
  columnOutside = new Float64Array(0);
  /** The recipes this scatter asked for, by tile (x * 64 + y), an absent recipe included. */
  readonly recipeTiles: number[] = [];
  readonly recipeValues: (GroundCoverRecipe | undefined)[] = [];
  recipeCount = 0;

  reserve(cells: number, columns: number): void {
    if (cells > this.inside.length) {
      // A window changes size only with the radius, and by a row or a column with its centre;
      // half again as much keeps that row from reallocating everything on alternate steps.
      const capacity = Math.max(cells, Math.ceil(this.inside.length * 1.5));
      this.keys = new Int32Array(capacity);
      this.distances = new Float64Array(capacity);
      this.sorted = new Float64Array(capacity);
      this.placed = new Int32Array(capacity);
      this.order = new Int32Array(capacity);
      this.inside = new Uint8Array(capacity);
    }
    if (columns > this.columnOutside.length) {
      this.columnOutside = new Float64Array(Math.max(columns, Math.ceil(this.columnOutside.length * 1.5)));
    }
  }

  /**
   * One tile's recipe, asked of the caller at most once per scatter and only when a cell the cache
   * does not know needs it — which is when, and how often, the caller was asked before.
   */
  recipe(options: ScatterOptions, tileX: number, tileY: number): GroundCoverRecipe | undefined {
    const tile = tileX * 64 + tileY;
    for (let index = 0; index < this.recipeCount; index++) {
      if (this.recipeTiles[index] === tile) return this.recipeValues[index];
    }
    const recipe = options.recipe({ x: tileX, y: tileY });
    this.recipeTiles[this.recipeCount] = tile;
    this.recipeValues[this.recipeCount] = recipe;
    this.recipeCount++;
    return recipe;
  }

  /** Lets go of this scatter's recipes, so the scratch does not keep a tile the client dropped. */
  release(): void {
    for (let index = 0; index < this.recipeCount; index++) this.recipeValues[index] = undefined;
    this.recipeCount = 0;
  }
}

const sharedWindow = new WindowScratch();
let sharedWindowBusy = false;

/** One model's batch as a field keeps it from one scatter to the next. */
interface BatchSlot {
  readonly path: string;
  readonly batch: GroundCoverBatch;
  /** Tufts this scatter has written into the batch so far. */
  count: number;
  /** The scatter that last opened the batch; any other number means it holds an older field. */
  pass: number;
}

/**
 * The batches behind one field, kept so that the next scatter can write over them.
 *
 * Held beside the field in a WeakMap rather than on it, so that a field stays the plain record
 * callers compare, and lives exactly as long as the field does. Its slots are the field's models
 * after every scatter; a model that stops growing takes its arrays with it.
 */
class FieldBatches {
  readonly slots = new Map<string, BatchSlot>();
  /** The batches this scatter opened, in the order it opened them: the field's model order. */
  readonly order: BatchSlot[] = [];
  used = 0;
  pass = 0;

  constructor(models: Map<string, GroundCoverBatch>) {
    // A field this module did not fill still lends its arrays.
    for (const [path, batch] of models) this.slots.set(path, { path, batch, count: 0, pass: 0 });
  }

  begin(): number {
    this.used = 0;
    return ++this.pass;
  }

  slot(path: string): BatchSlot {
    let slot = this.slots.get(path);
    if (slot === undefined) {
      slot = { path, batch: { x: [], y: [], z: [], yaw: [], scale: [] }, count: 0, pass: 0 };
      this.slots.set(path, slot);
    }
    return slot;
  }

  /** The first tuft of this model in this scatter: the batch starts over and takes its place. */
  open(slot: BatchSlot): void {
    slot.pass = this.pass;
    slot.count = 0;
    this.order[this.used++] = slot;
  }

  finish(models: Map<string, GroundCoverBatch>): void {
    const { order, used } = this;
    for (let index = 0; index < used; index++) {
      const { batch, count } = order[index]!;
      // Whatever a longer field left past this one's end. Only shortened, never emptied first:
      // V8 frees a double array's storage when its length is set to zero.
      if (batch.x.length !== count) batch.x.length = count;
      if (batch.y.length !== count) batch.y.length = count;
      if (batch.z.length !== count) batch.z.length = count;
      if (batch.yaw.length !== count) batch.yaw.length = count;
      if (batch.scale.length !== count) batch.scale.length = count;
    }
    if (order.length !== used) order.length = used;
    // Models appear in the order the walk first wrote them, as a fresh map's insertions put them.
    // Walking four yards seldom changes that order, so the map is only rebuilt when it did.
    if (!modelsInOrder(models, order, used)) {
      if (models.size > 0) models.clear();
      for (let index = 0; index < used; index++) models.set(order[index]!.path, order[index]!.batch);
    }
    if (this.slots.size !== used) {
      for (const slot of this.slots.values()) if (slot.pass !== this.pass) this.slots.delete(slot.path);
    }
  }

  empty(field: GroundCoverField): void {
    this.slots.clear();
    this.order.length = 0;
    this.used = 0;
    field.models.clear();
    field.total = 0;
    field.cellsDropped = 0;
    field.withoutHeight = 0;
  }
}

const fieldBatches = new WeakMap<GroundCoverField, FieldBatches>();

function batchesOf(field: GroundCoverField): FieldBatches {
  let batches = fieldBatches.get(field);
  if (batches === undefined) {
    batches = new FieldBatches(field.models);
    fieldBatches.set(field, batches);
  }
  return batches;
}

function modelsInOrder(models: Map<string, GroundCoverBatch>, order: readonly BatchSlot[], used: number): boolean {
  if (models.size !== used) return false;
  let index = 0;
  for (const path of models.keys()) {
    const slot = order[index++]!;
    if (slot.path !== path || models.get(path) !== slot.batch) return false;
  }
  return true;
}

/** Smooth outer-radius scale; deterministic and independent of rebuild cadence. */
export function groundCoverDistanceScale(distance: number, drawRadius: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(drawRadius) || drawRadius <= 0) return 0;
  const linear = Math.max(0, Math.min(1, (drawRadius - distance) / GROUND_COVER_FADE_WIDTH));
  return linear * linear * (3 - 2 * linear);
}

/**
 * `Math.hypot(a, b)` as V8 computes it, double for double, without what V8's costs.
 *
 * The builtin (`src/builtins/math.tq`) is not inlined: every call copies its arguments into a new
 * FixedDoubleArray and boxes its result, 80 bytes and 36 ns a call measured in Node 22, against
 * 10 ns and nothing for this. For two arguments its Kahan loop reduces to one sum of the squares
 * normalised by the larger magnitude, which is all this computes, and a NaN or an infinity is
 * answered first exactly as there. Held to `Math.hypot` over 400,000 inputs by a test (and two
 * million once, offline), so a V8 that changes its formula fails there rather than reordering the
 * field quietly; in another engine the field is ordered by V8's formula, not that engine's own.
 */
export function hypot2(a: number, b: number): number {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  // A NaN never becomes the largest, and an infinity outranks a NaN.
  let max = 0;
  if (absA > max) max = absA;
  if (absB > max) max = absB;
  if (max === Infinity) return Infinity;
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  if (max === 0) return 0;
  const n = absA / max;
  const m = absB / max;
  return Math.sqrt(n * n + m * m) * max;
}

/**
 * `ADT_MODEL_TO_SCENE` (WorldRenderer3D.ts), worked out the way three's
 * `Quaternion.setFromRotationMatrix` works it out of `VMAP_TO_THREE`. That matrix's trace is -1 and
 * no diagonal entry is larger than the last, so three takes its final branch with
 * s = 2·√(1 + m33 − m11 − m22) = 2·√2; the same operations give the same doubles here, y is
 * (m23 + m32) / s, z is s / 4, and x and w are (0 + 0) / s = +0.
 */
const MODEL_TO_SCENE_S = 2.0 * Math.sqrt(1.0 + 0 - -1 - 0);
const MODEL_TO_SCENE_Y = (1 + 1) / MODEL_TO_SCENE_S;
const MODEL_TO_SCENE_Z = 0.25 * MODEL_TO_SCENE_S;

/**
 * Writes one instance matrix per tuft of `batch` into `target`, sixteen floats a tuft from
 * `offset` on (an index into `target`, as `Matrix4.toArray` takes it), and returns how many it
 * wrote — `batch.x.length`, which is the instanced mesh's `count`.
 *
 * The floats are the ones `groundCoverMatrix` (WorldRenderer3D.ts) composes and `setMatrixAt`
 * stores, bit for bit, `-0` included, but with no three.js object and no call per tuft: the turn
 * is only about the vertical, the scale is uniform, and the product with `ADT_MODEL_TO_SCENE` has
 * two zero components, so three's quaternion product folds to four terms. The composition that
 * follows is kept operation for operation — its rounding is in the floats three writes, and a
 * closed form in the yaw's own sine and cosine would round differently. A 40,000-tuft field takes
 * 1.0 ms and 432 bytes this way against 1.6 ms and 560 KB through three, in Node 22; what is left
 * is mostly the sine and cosine each tuft needs.
 */
export function writeGroundCoverInstanceMatrices(batch: GroundCoverBatch, target: Float32Array, offset = 0): number {
  const count = batch.x.length;
  if (!Number.isInteger(offset) || offset < 0 || offset + count * 16 > target.length) {
    throw new RangeError(`${count} ground cover matrices from float ${offset} do not fit ${target.length} floats`);
  }
  const { x, y, z, yaw, scale } = batch;
  for (let index = 0, at = offset; index < count; index++, at += 16) {
    // `setFromAxisAngle((0, 1, 0), yaw)`: the turn is (0·s, s, 0·s, c).
    const halfAngle = yaw[index]! / 2;
    const s = Math.sin(halfAngle);
    const c = Math.cos(halfAngle);
    // `.multiply(ADT_MODEL_TO_SCENE)` with (+0, Y, Z, +0): every other product is a zero, and
    // adding a zero to a non-zero term changes nothing, cos never being zero for a finite angle.
    // All a folded zero could still decide is the sign of a zero result, which only happens at
    // s = ±0, where three's sums come out +0 — the `+ 0` and `0 -` below give +0 there too.
    const qx = s * MODEL_TO_SCENE_Z + 0;
    const qy = c * MODEL_TO_SCENE_Y;
    const qz = c * MODEL_TO_SCENE_Z;
    const qw = 0 - s * MODEL_TO_SCENE_Y;
    // `Matrix4.compose` with a uniform scale, as three writes it.
    const x2 = qx + qx;
    const y2 = qy + qy;
    const z2 = qz + qz;
    const xx = qx * x2;
    const xy = qx * y2;
    const xz = qx * z2;
    const yy = qy * y2;
    const yz = qy * z2;
    const zz = qz * z2;
    const wx = qw * x2;
    const wy = qw * y2;
    const wz = qw * z2;
    const size = scale[index]!;
    target[at] = (1 - (yy + zz)) * size;
    target[at + 1] = (xy + wz) * size;
    target[at + 2] = (xz - wy) * size;
    target[at + 3] = 0;
    target[at + 4] = (xy - wz) * size;
    target[at + 5] = (1 - (xx + zz)) * size;
    target[at + 6] = (yz + wx) * size;
    target[at + 7] = 0;
    target[at + 8] = (xz + wy) * size;
    target[at + 9] = (yz - wx) * size;
    target[at + 10] = (1 - (xx + yy)) * size;
    target[at + 11] = 0;
    // World (x, y, z) is the scene's (x, z, -y).
    target[at + 12] = x[index]!;
    target[at + 13] = z[index]!;
    target[at + 14] = -y[index]!;
    target[at + 15] = 1;
  }
  return count;
}

/** A 32-bit finalising mix, so that neighbouring cells do not produce neighbouring fields. */
function mix(value: number): number {
  let hash = value | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return (hash ^ (hash >>> 15)) >>> 0;
}

/** One value in [0, 1) from a seed and a salt, the salt naming which question is being asked. */
function random01(seed: number, salt: number): number {
  return mix((seed + Math.imul(salt, 0x9e3779b1)) | 0) / 4294967296;
}

/**
 * The recipes and the effect table, fetched once each.
 *
 * A tile's recipe rides the splat family — same route, same generator, same stamp — so a tile
 * published before ground cover existed rebuilds itself the first time this asks for its cover
 * file. A tile the gateway cannot answer for is remembered as absent rather than asked for again.
 */
export class GroundCoverClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #tiles = new Map<string, GroundCoverRecipe | null>();
  readonly #loading = new Set<string>();
  readonly #errors = new Set<string>();
  #table: GroundEffectTable | null | undefined;
  #tableRequested = false;
  #loadingTable = false;
  #generation = 0;
  #success = 0;
  #error = 0;
  #tableError = false;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Bumped whenever a recipe or the table lands, so the renderer knows to scatter again. */
  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#generation;
  }

  /** Immutable exact request counters; requested tile keys are not active after settlement. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    return Object.freeze({
      pending: this.#loading.size + (this.#loadingTable ? 1 : 0),
      success: this.#success,
      error: this.#errors.size + (this.#tableError ? 1 : 0),
      generation: this.#generation,
    });
  }

  /** The effect table, once it is here; the first call asks for it. */
  table(): GroundEffectTable | undefined {
    if (this.#table) return this.#table;
    if (!this.#tableRequested) {
      this.#tableRequested = true;
      this.#loadingTable = true;
      void this.#loadTable();
    }
    return undefined;
  }

  /** One tile's recipe, once it is here; the first call asks for it. */
  get(map: number, grid: TerrainGrid): GroundCoverRecipe | undefined {
    const key = `${map}/${grid.x}/${grid.y}`;
    const tile = this.#tiles.get(key);
    if (tile) return tile;
    if (tile === undefined && !this.#loading.has(key)) {
      this.#loading.add(key);
      void this.#load(map, grid, key);
    }
    return undefined;
  }

  /** Adds the exact typed arrays retained by successful cover recipes; the effect table is JS data. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const recipe of this.#tiles.values()) {
      if (!recipe) continue;
      visitor.referenceCpu(recipe, recipe.effects);
      visitor.referenceCpu(recipe, recipe.winner);
      visitor.referenceCpu(recipe, recipe.noDoodad);
    }
  }

  async #loadTable(): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#loadingTable = false;
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(`${this.#baseUrl}/dbc/ground-effects`);
      if (!response.ok) throw new Error(`Ground effect gateway returned ${response.status}`);
      const value = await response.json() as GroundEffectTable;
      if (!isGroundEffectTable(value)) {
        throw new Error("Ground effect gateway returned an invalid table");
      }
      this.#table = value;
      this.#tableError = false;
      settle(true);
      this.onStatus?.(`Ground effects: ${Object.keys(value.effects).length} растущих слоёв, ${value.models.length} моделей`, false);
    } catch (error) {
      // Null, not a retry: with no table there is nothing to grow, and asking again every frame
      // would be a request storm over ground that is simply going to stay bare.
      this.#table = null;
      this.#tableError = true;
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }

  async #load(map: number, grid: TerrainGrid, key: string): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#loading.delete(key);
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      const response = await fetch(withGeneration(`${this.#baseUrl}/terrain-splat/${map}/${grid.x}/${grid.y}/cover.bin`));
      if (response.status === 404) {
        // Cover is an optional generated family member; older tiles legitimately have no recipe.
        this.#tiles.set(key, null);
        this.#errors.delete(key);
        settle(true);
        return;
      }
      if (!response.ok) throw new Error(`Ground cover gateway returned ${response.status}`);
      this.#tiles.set(key, decodeGroundCover(await response.arrayBuffer()));
      this.#errors.delete(key);
      settle(true);
    } catch (error) {
      this.#tiles.set(key, null);
      this.#errors.add(key);
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }
}

/** Reject malformed JSON before it can poison every scatter pass in a session. */
function isGroundEffectTable(value: unknown): value is GroundEffectTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { models?: unknown; effects?: unknown };
  if (!Array.isArray(record.models) || !record.models.every((model) => typeof model === "string" && model.length > 0)) return false;
  const models = record.models;
  if (typeof record.effects !== "object" || record.effects === null || Array.isArray(record.effects)) return false;
  for (const [id, effect] of Object.entries(record.effects as Record<string, unknown>)) {
    if (!/^\d+$/.test(id) || Number(id) <= 0) return false;
    if (typeof effect !== "object" || effect === null || Array.isArray(effect)) return false;
    const row = effect as { density?: unknown; terrain?: unknown; doodads?: unknown };
    if (typeof row.density !== "number" || !Number.isInteger(row.density) || row.density < 0) return false;
    if (typeof row.terrain !== "number" || !Number.isInteger(row.terrain) || row.terrain < 0) return false;
    if (!Array.isArray(row.doodads)) return false;
    if (!row.doodads.every((doodad) => Array.isArray(doodad) && doodad.length === 2
      && Number.isInteger(doodad[0]) && doodad[0] >= 0
      && doodad[0] < models.length
      && typeof doodad[1] === "number" && Number.isFinite(doodad[1]) && doodad[1] >= 0)) return false;
  }
  return true;
}

/** The nine tiles a field can reach into, which is what the renderer asks the client for. */
export function groundCoverRecipeSource(
  client: GroundCoverClient | undefined,
  map: number | undefined,
): (grid: TerrainGrid) => GroundCoverRecipe | undefined {
  if (!client || map === undefined) return () => undefined;
  return (grid) => (grid.x >= 0 && grid.x < 64 && grid.y >= 0 && grid.y < 64 ? client.get(map, grid) : undefined);
}
