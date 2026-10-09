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
}

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

  clear(): void {
    this.#recent.clear();
    this.#map = undefined;
    this.#plan = undefined;
  }

  update(map: number, x: number, y: number, speculative = true): TerrainStreamingPlan | undefined {
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
    if (this.#plan !== undefined && map === this.#planMap && cell === this.#planCell
      && dx === this.#planDx && dy === this.#planDy && speculative === this.#planSpeculative) {
      return this.#plan;
    }
    const key = [map, centerX, centerY, dx, dy, speculative].join("/");
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
    const wanted = new Set<string>();
    for (const grid of [...prepare, ...visible]) {
      const tileKey = terrainTileKey(map, grid);
      wanted.add(tileKey);
      this.#recent.delete(tileKey);
      this.#recent.set(tileKey, grid);
    }
    for (const tileKey of this.#recent.keys()) {
      if (this.#recent.size <= TERRAIN_RETAINED_LIMIT) break;
      if (!wanted.has(tileKey)) this.#recent.delete(tileKey);
    }
    const retained = [...this.#recent.values()];
    const dependencies = new Map<string, TerrainGrid>();
    // Preserve the old tiles' own data too; their meshes should not rebuild solely due to LRU.
    for (const grid of retained) dependencies.set(terrainTileKey(map, grid), grid);
    for (const grid of [...visible, ...prepare]) {
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const neighbour = { x: grid.x + ox, y: grid.y + oy };
          if (neighbour.x >= 0 && neighbour.x < 64 && neighbour.y >= 0 && neighbour.y < 64) {
            dependencies.set(terrainTileKey(map, neighbour), neighbour);
          }
        }
      }
    }
    const visibleTileKeys = visible.map(grid => terrainTileKey(map, grid));
    this.#plan = {
      key, center, visible, prepare, retained, dependencies: [...dependencies.values()],
      visibleKeys: new Set(visibleTileKeys),
      retainedKeys: new Set(this.#recent.keys()),
      visibleTileKeys,
      prepareTileKeys: prepare.map(grid => terrainTileKey(map, grid)),
    };
    this.#planMap = map;
    this.#planCell = cell;
    this.#planDx = dx;
    this.#planDy = dy;
    this.#planSpeculative = speculative;
    return this.#plan;
  }
}
