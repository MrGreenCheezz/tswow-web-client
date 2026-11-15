import { TERRAIN_GRID_SIZE, terrainGridIndex, type TerrainGrid } from "./Terrain.js";

/** Start the next row roughly fourteen seconds before reaching it at normal running speed. */
export const TERRAIN_PREPARE_MARGIN = 96;
/** Includes the visible nine, up to seven approaching tiles, and recently visited tiles. */
export const TERRAIN_RETAINED_LIMIT = 25;

export interface TerrainStreamingPlan {
  readonly key: string;
  readonly center: TerrainGrid;
  readonly visible: readonly TerrainGrid[];
  readonly prepare: readonly TerrainGrid[];
  readonly retained: readonly TerrainGrid[];
  readonly dependencies: readonly TerrainGrid[];
  readonly visibleKeys: ReadonlySet<string>;
  readonly retainedKeys: ReadonlySet<string>;
  /** P1-13a: `terrainTileKey(map, visible[i])`, built once per plan. */
  readonly visibleTileKeys: readonly string[];
  /** P1-13a: `terrainTileKey(map, prepare[i])`, built once per plan. */
  readonly prepareTileKeys: readonly string[];
  /**
   * 15.11 (7.08 slice B): the detailed window's tiles past the near 3×3 (TerrainDetailWindow.ts). They are built
   * cooperatively like the prepared tiles (and are listed in `prepare` after them), and drawn once built and
   * splatted. Empty without a window.
   */
  readonly far: readonly TerrainGrid[];
  readonly farKeys: ReadonlySet<string>;
  /** `terrainTileKey(map, far[i])`. */
  readonly farTileKeys: readonly string[];
  /** A far tile's key by `x * 64 + y` (the horizon's stand-ins ask by grid). */
  readonly farIndex: ReadonlyMap<number, string>;
  /** The window's tiles past `fullReach`: drawn by the mid-detail ring from their own heights, never built. */
  readonly lod: readonly TerrainGrid[];
  /** `far` then `lod`: every window tile the horizon's ring stands in for until (or instead of) its terrain. */
  readonly standIns: readonly TerrainGrid[];
}

/** 15.11 (7.08 slice B): a tile rectangle (inclusive), as TerrainDetailWindow.ts `chunkRectTiles` gives it. */
export interface TerrainTileRect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

const NO_FAR: ReadonlySet<string> = new Set();

export function terrainTileKey(map: number, grid: TerrainGrid): string {
  return map + "/" + grid.x + "/" + grid.y;
}

/** -1, 0 or 1: toward which neighbouring row the player is within the prepare margin. */
function streamingEdge(fraction: number, margin: number, speculative: boolean): number {
  return !speculative ? 0 : fraction < margin ? -1 : fraction > 1 - margin ? 1 : 0;
}

/** One owner chooses both mesh and splat lifetime. Hidden tiles are never draw admission. */
export class TerrainStreamingWindow {
  readonly #recent = new Map<string, TerrainGrid>();
  #map: number | undefined;
  #plan: TerrainStreamingPlan | undefined;
  /** P1-13a: what `#plan` was made for, as numbers — compared each frame instead of a joined key. */
  #planMap = 0;
  #planCell = -1;
  #planDx = 0;
  #planDy = 0;
  #planSpeculative = false;
  /** 15.11 (7.08 slice B): the far rectangle `#plan` was made for, as one number (-1: none). */
  #planFar = -1;

  clear(): void {
    this.#recent.clear();
    this.#map = undefined;
    this.#plan = undefined;
  }

  /**
   * `far` (15.11, 7.08 slice B): the detailed window's tile rectangle around the camera; its tiles outside the near
   * 3×3 become the plan's `far` tiles. Omitted, the plan is the near window alone, as before.
   */
  update(map: number, x: number, y: number, speculative = true, far?: TerrainTileRect,
    /** The window's tiles farther than this (Chebyshev, in tiles) are left to the mid-detail ring (lod). */
    fullReach = 64,
    /**
     * Which of the window's cells have ground (the WDL's tiles: Wow.exe loads only the ADTs its WDT lists,
     * 0x007b5950); none asked, all. existsRevision changes when that answer can (the WDL arriving).
     */
    exists?: (gridX: number, gridY: number) => boolean, existsRevision = 0): TerrainStreamingPlan | undefined {
    const cell = terrainGridIndex(x, y);
    if (cell < 0) {
      this.clear();
      return undefined;
    }
    if (map !== this.#map) this.clear();
    this.#map = map;
    const centerX = Math.floor(cell / 64);
    const centerY = cell % 64;
    const margin = TERRAIN_PREPARE_MARGIN / TERRAIN_GRID_SIZE;
    const dx = streamingEdge(32 - x / TERRAIN_GRID_SIZE - centerX, margin, speculative);
    const dy = streamingEdge(32 - y / TERRAIN_GRID_SIZE - centerY, margin, speculative);
    const farId = far === undefined ? -1
      : ((((far.x0 * 64 + far.x1) * 64 + far.y0) * 64 + far.y1) * 65 + Math.min(64, fullReach)) * 2 + (exists ? 1 : 0)
        + existsRevision * 2 ** 34;
    if (this.#plan !== undefined && map === this.#planMap && cell === this.#planCell
      && dx === this.#planDx && dy === this.#planDy && speculative === this.#planSpeculative
      && farId === this.#planFar) {
      return this.#plan;
    }
    const key = [map, centerX, centerY, dx, dy, speculative, ...(far === undefined ? [] : [farId])].join("/");
    const center: TerrainGrid = { x: centerX, y: centerY };
    // Formal captures retain their exact visible workload, including failure/readiness counts.
    if (!speculative) this.#recent.clear();
    const visible: TerrainGrid[] = [];
    const prepare: TerrainGrid[] = [];
    for (let ox = -1 + Math.min(0, dx); ox <= 1 + Math.max(0, dx); ox++) {
      for (let oy = -1 + Math.min(0, dy); oy <= 1 + Math.max(0, dy); oy++) {
        const grid = { x: center.x + ox, y: center.y + oy };
        if (grid.x < 0 || grid.x >= 64 || grid.y < 0 || grid.y >= 64) continue;
        (Math.abs(ox) <= 1 && Math.abs(oy) <= 1 ? visible : prepare).push(grid);
      }
    }
    const distance = (grid: TerrainGrid): number =>
      Math.abs(grid.x - center.x) + Math.abs(grid.y - center.y);
    visible.sort((a, b) => distance(a) - distance(b));
    prepare.sort((a, b) => distance(a) - distance(b));
    // 15.11 (7.08 slice B): the window's other tiles, nearest first, after the speculative row.
    const farTiles: TerrainGrid[] = [];
    const lodTiles: TerrainGrid[] = [];
    if (far !== undefined) {
      for (let gx = Math.max(0, far.x0); gx <= Math.min(63, far.x1); gx++) {
        for (let gy = Math.max(0, far.y0); gy <= Math.min(63, far.y1); gy++) {
          if (Math.abs(gx - center.x) <= 1 && Math.abs(gy - center.y) <= 1) continue;
          if (exists && !exists(gx, gy)) continue;
          if (Math.max(Math.abs(gx - center.x), Math.abs(gy - center.y)) > fullReach) {
            lodTiles.push({ x: gx, y: gy });
            continue;
          }
          // A speculative row's tile inside the window is a far tile too (drawn once ready), listed once.
          farTiles.push(prepare.find(grid => grid.x === gx && grid.y === gy) ?? { x: gx, y: gy });
        }
      }
      farTiles.sort((a, b) => Math.max(Math.abs(a.x - center.x), Math.abs(a.y - center.y))
        - Math.max(Math.abs(b.x - center.x), Math.abs(b.y - center.y)) || distance(a) - distance(b));
    }
    const wanted = new Set<string>();
    for (const grid of new Set([...farTiles, ...prepare, ...visible])) {
      const tileKey = terrainTileKey(map, grid);
      wanted.add(tileKey);
      this.#recent.delete(tileKey);
      this.#recent.set(tileKey, grid);
    }
    // The near window keeps its 25; a far window keeps all of itself and the same sixteen of history.
    const retainedLimit = farTiles.length === 0 ? TERRAIN_RETAINED_LIMIT
      : Math.max(TERRAIN_RETAINED_LIMIT, wanted.size + TERRAIN_RETAINED_LIMIT - 9);
    for (const tileKey of this.#recent.keys()) {
      if (this.#recent.size <= retainedLimit) break;
      if (!wanted.has(tileKey)) this.#recent.delete(tileKey);
    }
    const retained = [...this.#recent.values()];
    const dependencies = new Map<string, TerrainGrid>();
    // Preserve the old tiles' own data too; their meshes should not rebuild solely due to LRU.
    for (const grid of retained) dependencies.set(terrainTileKey(map, grid), grid);
    // The mid-detail ring reads its tiles' own heights (and the WDL across their outer edges).
    for (const grid of lodTiles) dependencies.set(terrainTileKey(map, grid), grid);
    const nearCount = visible.length + prepare.length;
    const pinned = [...visible, ...prepare, ...farTiles];
    for (let index = 0; index < pinned.length; index++) {
      const grid = pinned[index]!;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const neighbour = { x: grid.x + ox, y: grid.y + oy };
          // A far tile's neighbour with no ground is not asked for (the near window's are, as before).
          if (index >= nearCount && exists && !exists(neighbour.x, neighbour.y)) continue;
          if (neighbour.x >= 0 && neighbour.x < 64 && neighbour.y >= 0 && neighbour.y < 64) {
            dependencies.set(terrainTileKey(map, neighbour), neighbour);
          }
        }
      }
    }
    const visibleTileKeys = visible.map(grid => terrainTileKey(map, grid));
    const farTileKeys = farTiles.map(grid => terrainTileKey(map, grid));
    const farKeys = farTiles.length === 0 ? NO_FAR : new Set(farTileKeys);
    const farIndex = new Map<number, string>();
    for (let index = 0; index < farTiles.length; index++) farIndex.set(farTiles[index]!.x * 64 + farTiles[index]!.y, farTileKeys[index]!);
    const prepareAll = farTiles.length === 0 ? prepare : [...prepare, ...farTiles.filter(grid => !prepare.includes(grid))];
    this.#plan = {
      key, center, visible, prepare: prepareAll, retained, dependencies: [...dependencies.values()],
      visibleKeys: new Set(visibleTileKeys),
      retainedKeys: new Set(this.#recent.keys()),
      visibleTileKeys,
      prepareTileKeys: prepareAll.map(grid => terrainTileKey(map, grid)),
      far: farTiles, farKeys, farTileKeys, farIndex, lod: lodTiles,
      standIns: lodTiles.length === 0 ? farTiles : [...farTiles, ...lodTiles],
    };
    this.#planFar = farId;
    this.#planMap = map;
    this.#planCell = cell;
    this.#planDx = dx;
    this.#planDy = dy;
    this.#planSpeculative = speculative;
    return this.#plan;
  }
}
