import { TERRAIN_GRID_SIZE, terrainGrid, type TerrainGrid } from "./Terrain.js";

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
}

export function terrainTileKey(map: number, grid: TerrainGrid): string {
  return map + "/" + grid.x + "/" + grid.y;
}

/** One owner chooses both mesh and splat lifetime. Hidden tiles are never draw admission. */
export class TerrainStreamingWindow {
  readonly #recent = new Map<string, TerrainGrid>();
  #map: number | undefined;
  #plan: TerrainStreamingPlan | undefined;

  clear(): void {
    this.#recent.clear();
    this.#map = undefined;
    this.#plan = undefined;
  }

  update(map: number, x: number, y: number, speculative = true): TerrainStreamingPlan | undefined {
    const center = terrainGrid(x, y);
    if (!center) {
      this.clear();
      return undefined;
    }
    if (map !== this.#map) this.clear();
    this.#map = map;
    const margin = TERRAIN_PREPARE_MARGIN / TERRAIN_GRID_SIZE;
    const edge = (fraction: number): number => !speculative ? 0
      : fraction < margin ? -1 : fraction > 1 - margin ? 1 : 0;
    const dx = edge(32 - x / TERRAIN_GRID_SIZE - center.x);
    const dy = edge(32 - y / TERRAIN_GRID_SIZE - center.y);
    const key = [map, center.x, center.y, dx, dy, speculative].join("/");
    if (this.#plan?.key === key) return this.#plan;
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
    this.#plan = {
      key, center, visible, prepare, retained, dependencies: [...dependencies.values()],
      visibleKeys: new Set(visible.map(grid => terrainTileKey(map, grid))),
      retainedKeys: new Set(this.#recent.keys()),
    };
    return this.#plan;
  }
}
