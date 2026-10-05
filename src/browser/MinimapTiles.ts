import { TextureBitmapCache } from "./TextureBitmaps.js";
import { withGeneration } from "./GatewayGeneration.js";

/**
 * The baked minimap pictures, fetched by grid cell.
 *
 * Two lookups, not one. The client keeps every bake under an MD5 of its own path, so a cell is
 * first resolved to a hash through the map's index — published by `tools/generate-minimap-index.mjs`
 * out of `md5translate.trs`, which lives in the archives the gateway process never opens — and only
 * then to a picture, through the ordinary `/texture` route every model texture already uses.
 *
 * The picture cache is keyed by hash rather than by cell, which is the point of the hash: of
 * Azeroth's 687 cells only 520 are distinct pictures, because every square of open ocean is the
 * same bake, and keying by cell would hold that ocean in memory a hundred and sixty times over.
 *
 * A cell with no tile is normal and not an error: instance maps built entirely out of buildings
 * have none at all, and 77 of the 135 maps in this dataset are like that.
 */

export type MinimapTileIndex = ReadonlyMap<string, string>;

export class MinimapTileClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #pictures: TextureBitmapCache;
  readonly #indexes = new Map<number, MinimapTileIndex | null>();
  readonly #loadingIndexes = new Set<number>();
  #revision = 0;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#pictures = new TextureBitmapCache(gatewayWebSocketUrl);
    this.#pictures.onStatus = (message, error) => this.onStatus?.(message, error);
  }

  /** Bumped by every index and every picture that lands, so a composite knows to redraw. */
  get revision(): number {
    return this.#revision + this.#pictures.revision;
  }

  /**
   * The map's cell-to-hash table, or undefined until it lands. Asking starts the download; asking
   * again while it is in flight does not.
   */
  index(map: number): MinimapTileIndex | undefined {
    const known = this.#indexes.get(map);
    if (known !== undefined) return known ?? undefined;
    if (!this.#loadingIndexes.has(map)) {
      this.#loadingIndexes.add(map);
      void this.#loadIndex(map);
    }
    return undefined;
  }

  /** The picture for one cell, or undefined until it lands. */
  tile(map: number, gridX: number, gridY: number): ImageBitmap | undefined {
    const hash = this.index(map)?.get(`${gridX}-${gridY}`);
    // No entry means the cell has no bake at all: nothing to ask the gateway for.
    if (!hash) return undefined;
    return this.#pictures.bitmap(`textures\\Minimap\\${hash}.blp`);
  }

  /**
   * 05.10-A7b-4 (7.14): a bake by its md5 alone — a WMO group's cell (WmoMinimapDraw.ts). The same cache as
   * the ADT cells, so a picture both use is held once.
   */
  picture(hash: string): ImageBitmap | undefined {
    return this.#pictures.bitmap(`textures\\Minimap\\${hash}.blp`);
  }

  /** Whether the map has any minimap at all, once its index is known. */
  hasTiles(map: number): boolean {
    return (this.index(map)?.size ?? 0) > 0;
  }

  /** Dropped on leaving a realm: the pictures hold GPU memory until they are closed. */
  clear(): void {
    this.#pictures.clear();
    this.#indexes.clear();
    this.#loadingIndexes.clear();
    this.#revision++;
  }

  async #loadIndex(map: number): Promise<void> {
    try {
      const response = await fetch(withGeneration(`${this.#baseUrl}/minimap/${map}/index.json`));
      if (!response.ok) throw new Error(`Minimap gateway returned ${response.status}`);
      const value: unknown = await response.json();
      const tiles = (value as { tiles?: Record<string, unknown> } | null)?.tiles;
      if (!tiles || typeof tiles !== "object") throw new Error("Minimap index is malformed");
      const index = new Map<string, string>();
      for (const [cell, hash] of Object.entries(tiles)) {
        if (typeof hash === "string" && /^[0-9a-f]{32}$/i.test(hash)) index.set(cell, hash);
      }
      this.#indexes.set(map, index);
      this.#revision++;
      this.onStatus?.(`Миникарта: ${index.size} тайлов на карте ${map}`, false);
    } catch (error) {
      // A map with no index is drawn without a base rather than not drawn: the blips, the zone
      // name and the clock are worth having over a bare frame.
      this.#indexes.set(map, null);
      this.#revision++;
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#loadingIndexes.delete(map);
    }
  }
}
