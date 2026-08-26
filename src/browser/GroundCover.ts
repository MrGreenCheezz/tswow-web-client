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
 * ceiling and not as a scale). It clamps its own setting to 0..500 yards; this one stops at 140,
 * the top of the range that sentence names.
 */
export const GROUND_COVER_MAX_RADIUS = 140;
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
 * Measured over the nine tiles around Goldshire, the densest 40-yard window on the tile holds
 * 3,525 doodads within 50 yards and 6,305 within 70. The cap is above the first and below the
 * second on purpose: at the default radius it is never reached, and it is what stops a radius the
 * player has wound up to 140 from asking for 24,396.
 */
export const GROUND_COVER_BUDGET = 6000;
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
  /** The visible radius when `radius` includes a rebuild/prefetch margin. */
  drawRadius?: number;
  /** The drawn ground's own height, or undefined while its tile is still on the way. */
  heightAt: (x: number, y: number) => number | undefined;
}

/**
 * Turns the recipe into a field of doodads around a point.
 *
 * Cells are visited nearest first and the budget stops the walk, so what a cap takes away is
 * always the far edge of the field and never a hole in the middle of it. Every doodad's position,
 * model, turn and size is a pure function of its own cell and its index within it, which is what
 * makes two overlapping windows agree on every doodad they share — the property that stops the
 * whole field shuffling every time the player walks four yards.
 */
export function scatterGroundCover(options: ScatterOptions): GroundCoverField {
  const { centre, radius, table, perCell } = options;
  // A caller may widen `radius` for prefetching, but the visible field must never widen with it.
  const requestedDrawRadius = options.drawRadius ?? radius;
  const drawRadius = Number.isFinite(requestedDrawRadius)
    ? Math.max(0, Math.min(radius, requestedDrawRadius))
    : 0;
  const cap = options.cap ?? GROUND_COVER_BUDGET;
  const field: GroundCoverField = { models: new Map(), total: 0, cellsDropped: 0, withoutHeight: 0 };
  if (radius <= 0 || cap <= 0) return field;

  // The cell grid is counted from the world's own north-west corner, so a cell index is global and
  // a tile is only where the recipe for it is looked up.
  const first = (value: number) => Math.max(0, Math.min(DETAIL_CELLS_PER_TILE * 64 - 1,
    Math.floor((WORLD_ORIGIN - value) / DETAIL_CELL_SIZE)));
  const rowFrom = first(centre.x + radius);
  const rowTo = first(centre.x - radius);
  const columnFrom = first(centre.y + radius);
  const columnTo = first(centre.y - radius);

  const cells: Array<{ row: number; column: number; distance: number }> = [];
  for (let row = rowFrom; row <= rowTo; row++) {
    const maxX = WORLD_ORIGIN - row * DETAIL_CELL_SIZE;
    const outsideX = Math.max(maxX - DETAIL_CELL_SIZE - centre.x, 0, centre.x - maxX);
    for (let column = columnFrom; column <= columnTo; column++) {
      const maxY = WORLD_ORIGIN - column * DETAIL_CELL_SIZE;
      const outsideY = Math.max(maxY - DETAIL_CELL_SIZE - centre.y, 0, centre.y - maxY);
      const distance = Math.hypot(outsideX, outsideY);
      if (distance <= radius) cells.push({ row, column, distance });
    }
  }
  cells.sort((left, right) => left.distance - right.distance);

  const recipes = new Map<string, GroundCoverRecipe | undefined>();
  for (const cell of cells) {
    if (field.total >= cap) {
      field.cellsDropped++;
      continue;
    }
    const grid = { x: cell.row >> 7, y: cell.column >> 7 };
    const key = `${grid.x}/${grid.y}`;
    let recipe = recipes.get(key);
    if (recipe === undefined && !recipes.has(key)) {
      recipe = options.recipe(grid);
      recipes.set(key, recipe);
    }
    if (!recipe) continue;

    const chunk = (((cell.row >> 3) & 15) * 16 + ((cell.column >> 3) & 15));
    const cellRow = cell.row & 7;
    const cellColumn = cell.column & 7;
    // The artist's own "nothing grows here": it covers the roads and every ADT hole.
    if (((recipe.noDoodad[chunk * 8 + cellRow]! >> cellColumn) & 1) !== 0) continue;
    const layer = (recipe.winner[chunk * 8 + cellRow]! >> (cellColumn * 2)) & 3;
    const effect = table.effects[recipe.effects[chunk * 4 + layer]!];
    if (!effect || effect.doodads.length === 0) continue;

    // A cell's key is global, so the same ground grows the same field from any window.
    const seed = mix((cell.row * DETAIL_CELLS_PER_TILE * 64 + cell.column) | 0);
    let count = effect.density;
    if (!perCell) {
      // The per-chunk reading of the same number: a chunk is 64 cells, so each cell carries a
      // sixty-fourth of the row's density and the fraction is spent as a coin the cell tosses for
      // itself. A cell either grows its share or does not, and which it does never changes.
      const share = effect.density / 64;
      count = Math.floor(share);
      if (random01(seed, 0) < share - count) count++;
    }
    if (count <= 0) continue;

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

    for (let index = 0; index < count && field.total < cap; index++) {
      const point = mix(seed + Math.imul(index + 1, 0x85ebca6b));
      const x = WORLD_ORIGIN - (cell.row + random01(point, 1)) * DETAIL_CELL_SIZE;
      const y = WORLD_ORIGIN - (cell.column + random01(point, 2)) * DETAIL_CELL_SIZE;
      // Clipped per doodad rather than per cell: a cell straddling the edge would otherwise reach
      // most of a cell past it, and drawRadius is what the player is asked to name.
      if (Math.hypot(x - centre.x, y - centre.y) > drawRadius) continue;
      const height = options.heightAt(x, y);
      if (height === undefined) {
        field.withoutHeight++;
        continue;
      }
      let roll = random01(point, 3) * weight;
      let model = effect.doodads[0]![0];
      for (const [candidate, share] of effect.doodads) {
        model = candidate;
        roll -= equal ? 1 : share;
        if (roll < 0) break;
      }
      const path = table.models[model];
      if (path === undefined) continue;
      let batch = field.models.get(path);
      if (!batch) {
        batch = { x: [], y: [], z: [], yaw: [], scale: [] };
        field.models.set(path, batch);
      }
      batch.x.push(x);
      batch.y.push(y);
      batch.z.push(height + GROUND_COVER_LIFT);
      batch.yaw.push(random01(point, 4) * Math.PI * 2);
      batch.scale.push(SCALE_MINIMUM + random01(point, 5) * SCALE_RANGE);
      field.total++;
    }
  }
  return field;
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
  #table: GroundEffectTable | null | undefined;
  #tableRequested = false;
  #generation = 0;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /** Bumped whenever a recipe or the table lands, so the renderer knows to scatter again. */
  get generation(): number {
    return this.#generation;
  }

  /** The effect table, once it is here; the first call asks for it. */
  table(): GroundEffectTable | undefined {
    if (this.#table) return this.#table;
    if (!this.#tableRequested) {
      this.#tableRequested = true;
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

  async #loadTable(): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/dbc/ground-effects`);
      if (!response.ok) throw new Error(`Ground effect gateway returned ${response.status}`);
      const value = await response.json() as GroundEffectTable;
      if (!isGroundEffectTable(value)) {
        throw new Error("Ground effect gateway returned an invalid table");
      }
      this.#table = value;
      this.#generation++;
      this.onStatus?.(`Ground effects: ${Object.keys(value.effects).length} растущих слоёв, ${value.models.length} моделей`, false);
    } catch (error) {
      // Null, not a retry: with no table there is nothing to grow, and asking again every frame
      // would be a request storm over ground that is simply going to stay bare.
      this.#table = null;
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    }
  }

  async #load(map: number, grid: TerrainGrid, key: string): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/terrain-splat/${map}/${grid.x}/${grid.y}/cover.bin`);
      if (!response.ok) throw new Error(`Ground cover gateway returned ${response.status}`);
      this.#tiles.set(key, decodeGroundCover(await response.arrayBuffer()));
      this.#generation++;
    } catch (error) {
      this.#tiles.set(key, null);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#loading.delete(key);
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
