/**
 * 05.10-A7b-3 (7.14, data): a building's baked minimap tiles, from the gateway's `/minimap/wmo`.
 *
 * The client bakes a top-down picture of each WMO group and keeps it under the same MD5 index as
 * the ADT minimap (`tools/minimap-index.mjs`, `wmoTilesOf`): `<root>_<group>_<x>_<y>.blp`, x along
 * the group's model X, 128 yards a tile from the group box's minimum corner. This is only the
 * lookup — which hash draws which cell of which group. The picture is the same `/texture` the ADT
 * minimap uses (`textures\Minimap\<hash>.blp`, `MinimapTiles.ts`), and drawing a group in the
 * minimap circle is slice 4 (`ui/Minimap.ts`), which still has to settle the picture's orientation
 * inside a tile against a frame.
 *
 * One request per building per session. A 404 — a building without bakes, which most are, or a
 * gateway older than the route — is final; any other failure climbs the retry ladder
 * (`RetryLadder.ts`: 2 s, 8 s, 30 s, then never). Asking is a `Map` lookup, safe every frame.
 */

import { RetryLadder } from "./RetryLadder.js";
import { withGeneration } from "./GatewayGeneration.js";

/** The route's answer shape (`WMO_MINIMAP_ROUTE_VERSION` in `gateway/WmoMinimapRoute.ts`). */
export const WMO_MINIMAP_VERSION = 1;
/** Yards per WMO minimap tile (`WMO_MINIMAP_TILE_YARDS` in `tools/minimap-index.mjs`). */
export const WMO_MINIMAP_TILE_SIZE = 128;

/** The group's cells: `"<x>-<y>"` → md5 hash of the bake. */
export type WmoMinimapGroupTiles = ReadonlyMap<string, string>;

/** The cell of a model-space point inside a group: 128-yard squares from the box's minimum corner. */
export function wmoMinimapCell(bounds: { readonly minX: number; readonly minY: number }, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.floor((x - bounds.minX) / WMO_MINIMAP_TILE_SIZE),
    y: Math.floor((y - bounds.minY) / WMO_MINIMAP_TILE_SIZE),
  };
}

const EMPTY: ReadonlyMap<number, WmoMinimapGroupTiles> = new Map();

export class WmoMinimapTileClient {
  readonly #baseUrl: string;
  /** By the path as asked; `EMPTY` once a 404 says there is nothing. */
  readonly #buildings = new Map<string, ReadonlyMap<number, WmoMinimapGroupTiles>>();
  readonly #loading = new Set<string>();
  readonly #ladder: RetryLadder<string>;
  #revision = 0;

  constructor(gatewayWebSocketUrl: string, now: () => number = () => performance.now()) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#ladder = new RetryLadder<string>(undefined, now);
  }

  /** Bumped whenever a building's answer lands, so a composite knows to redraw. */
  get revision(): number {
    return this.#revision;
  }

  /** One group's cells, or undefined until the building's answer lands (asking starts it). */
  groupTiles(wmoPath: string, group: number): WmoMinimapGroupTiles | undefined {
    return this.#building(wmoPath)?.get(group);
  }

  /** Whether the building has any bake, once known. */
  hasTiles(wmoPath: string): boolean {
    return (this.#building(wmoPath)?.size ?? 0) > 0;
  }

  /** Dropped on leaving a realm. */
  clear(): void {
    this.#buildings.clear();
    this.#loading.clear();
    this.#ladder.reset();
    this.#revision++;
  }

  #building(wmoPath: string): ReadonlyMap<number, WmoMinimapGroupTiles> | undefined {
    const known = this.#buildings.get(wmoPath);
    if (known !== undefined) return known;
    if (!this.#loading.has(wmoPath) && this.#ladder.ready(wmoPath)) {
      this.#loading.add(wmoPath);
      void this.#load(wmoPath);
    }
    return undefined;
  }

  async #load(wmoPath: string): Promise<void> {
    try {
      const response = await fetch(withGeneration(
        `${this.#baseUrl}/minimap/wmo?path=${encodeURIComponent(wmoPath)}&v=${WMO_MINIMAP_VERSION}`));
      if (response.status === 404) {
        await response.arrayBuffer().catch(() => undefined);
        this.#buildings.set(wmoPath, EMPTY);
        this.#ladder.clear(wmoPath);
        this.#revision++;
        return;
      }
      if (!response.ok) throw new Error(`WMO minimap gateway returned ${response.status}`);
      const value: unknown = await response.json();
      const groups = (value as { groups?: unknown } | null)?.groups;
      if (!groups || typeof groups !== "object") throw new Error("WMO minimap answer is malformed");
      const building = new Map<number, WmoMinimapGroupTiles>();
      for (const [group, cells] of Object.entries(groups as Record<string, unknown>)) {
        const index = Number(group);
        if (!Number.isInteger(index) || index < 0 || index > 65_535 || !cells || typeof cells !== "object") continue;
        const tiles = new Map<string, string>();
        for (const [cell, hash] of Object.entries(cells as Record<string, unknown>)) {
          if (/^\d{1,2}-\d{1,2}$/.test(cell) && typeof hash === "string" && /^[0-9a-f]{32}$/i.test(hash)) tiles.set(cell, hash);
        }
        if (tiles.size > 0) building.set(index, tiles);
      }
      this.#buildings.set(wmoPath, building);
      this.#ladder.clear(wmoPath);
      this.#revision++;
    } catch {
      this.#ladder.failed(wmoPath);
      // Out of ladder: nothing for the session, like a 404.
      if (this.#ladder.exhausted(wmoPath)) {
        this.#buildings.set(wmoPath, EMPTY);
        this.#revision++;
      }
    } finally {
      this.#loading.delete(wmoPath);
    }
  }
}
