import { withGeneration } from "./GatewayGeneration.js";

/**
 * 22.10 (7.44): the far ground's detail pictures — the client's own minimap bakes, one 256×256
 * top-down picture per ADT tile, fetched for the tiles of the horizon's inner rings.
 *
 * The routes are the ones the in-game minimap already uses (MinimapTiles.ts): `/minimap/<map>/
 * index.json` resolves a cell to the md5 of its bake, and `/texture?path=textures\Minimap\<md5>.blp`
 * publishes the bake as a PNG. Nothing new is asked of the gateway, so an older gateway serves this
 * as well; a map with no index (instances, or a gateway without the route) simply has no detail and
 * the horizon keeps its 16-texel colour map.
 *
 * The source PNG of a cell is kept (bounded) so a cell that moves from the outer level into the
 * inner one is decoded again at the larger size without a second request. Decoding is
 * `createImageBitmap` with a resize, off the main thread in every supporting browser.
 */

/** Cells whose PNG is kept: the outer level's window (9×9) with a margin for a tile crossing. */
export const HORIZON_DETAIL_SOURCE_LIMIT = 112;

export interface HorizonDetailTileStats {
  readonly pending: number;
  readonly success: number;
  readonly error: number;
  readonly requests: number;
}

type IndexState = ReadonlyMap<string, string> | null;

export class HorizonDetailTiles {
  readonly #baseUrl: string;
  readonly #indexes = new Map<number, IndexState>();
  readonly #indexLoading = new Set<number>();
  /** md5 → PNG bytes (`null`: asked and missing, never asked again). Insertion order is LRU. */
  readonly #sources = new Map<string, Blob | null>();
  readonly #sourceLoading = new Map<string, Promise<Blob | null>>();
  #pending = 0;
  #success = 0;
  #error = 0;
  #requests = 0;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  get stats(): HorizonDetailTileStats {
    return { pending: this.#pending, success: this.#success, error: this.#error, requests: this.#requests };
  }

  /** The map's cell → md5 table; `undefined` while it loads, `null` when the map has none. */
  index(map: number): IndexState | undefined {
    const known = this.#indexes.get(map);
    if (known !== undefined) return known;
    if (!this.#indexLoading.has(map)) {
      this.#indexLoading.add(map);
      void this.#loadIndex(map);
    }
    return undefined;
  }

  /** The md5 of a cell's bake, `null` when the cell has none (or the map no index), `undefined` while unknown. */
  hash(map: number, gridX: number, gridY: number): string | null | undefined {
    const index = this.index(map);
    if (index === undefined) return undefined;
    if (index === null) return null;
    return index.get(`${gridX}-${gridY}`) ?? null;
  }

  /**
   * One cell's picture at `size`×`size`, or `null` when there is none. Resolves once; the caller
   * owns (and closes) the bitmap.
   */
  async picture(hash: string, size: number): Promise<ImageBitmap | null> {
    const source = await this.#source(hash);
    if (!source || typeof createImageBitmap !== "function") return null;
    try {
      return await createImageBitmap(source, {
        resizeWidth: size, resizeHeight: size, resizeQuality: "high",
        premultiplyAlpha: "none", colorSpaceConversion: "none",
      });
    } catch {
      return null;
    }
  }

  clear(): void {
    this.#sources.clear();
    this.#indexes.clear();
  }

  #source(hash: string): Promise<Blob | null> {
    const known = this.#sources.get(hash);
    if (known !== undefined) {
      // LRU touch.
      this.#sources.delete(hash);
      this.#sources.set(hash, known);
      return Promise.resolve(known);
    }
    const loading = this.#sourceLoading.get(hash);
    if (loading) return loading;
    const task = this.#loadSource(hash);
    this.#sourceLoading.set(hash, task);
    void task.finally(() => this.#sourceLoading.delete(hash));
    return task;
  }

  async #loadSource(hash: string): Promise<Blob | null> {
    this.#pending++;
    this.#requests++;
    try {
      const path = `textures\\Minimap\\${hash}.blp`;
      // Low priority, as the minimap's own pictures: the near world's skins come first.
      const response = await fetch(`${this.#baseUrl}/texture?path=${encodeURIComponent(path)}`, { priority: "low" });
      const blob = response.ok ? await response.blob() : null;
      if (blob) this.#success++;
      else this.#error++;
      this.#remember(hash, blob);
      return blob;
    } catch {
      this.#error++;
      // A failed request is not remembered: the next window update asks again.
      return null;
    } finally {
      this.#pending--;
    }
  }

  #remember(hash: string, blob: Blob | null): void {
    this.#sources.set(hash, blob);
    while (this.#sources.size > HORIZON_DETAIL_SOURCE_LIMIT) {
      const oldest = this.#sources.keys().next();
      if (oldest.done) break;
      this.#sources.delete(oldest.value);
    }
  }

  async #loadIndex(map: number): Promise<void> {
    this.#pending++;
    this.#requests++;
    try {
      const response = await fetch(withGeneration(`${this.#baseUrl}/minimap/${map}/index.json`));
      if (!response.ok) {
        this.#indexes.set(map, null);
        return;
      }
      const value: unknown = await response.json();
      const tiles = (value as { tiles?: Record<string, unknown> } | null)?.tiles;
      const index = new Map<string, string>();
      if (tiles && typeof tiles === "object") {
        for (const [cell, hash] of Object.entries(tiles)) {
          if (typeof hash === "string" && /^[0-9a-f]{32}$/i.test(hash)) index.set(cell, hash);
        }
      }
      this.#indexes.set(map, index);
      this.#success++;
    } catch {
      this.#indexes.set(map, null);
      this.#error++;
    } finally {
      this.#indexLoading.delete(map);
      this.#pending--;
    }
  }
}
