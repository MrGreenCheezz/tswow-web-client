import type { MapAreaInfo } from "../gateway/AreaMetadata.js";
import { worldMapWorld } from "./MinimapGeometry.js";
import { TERRAIN_GRID_SIZE } from "./Terrain.js";

/**
 * The authored continent hit map used by the original 3.3.5 client.
 *
 * A `.zmp` has no header: it is a 128×128 row-major grid of little-endian `uint32` AreaTable
 * ids. Each ADT contributes four cells, one for each 8×8-chunk quadrant. This is more than a
 * coarse optimisation over WorldMapArea rectangles: those rectangles overlap, while this grid is
 * the authored answer to `UpdateMapHighlight` and `ProcessMapClick` at every point.
 */
export const WORLD_MAP_ZONE_MAP_SIZE = 128;
export const WORLD_MAP_ZONE_MAP_BYTES = WORLD_MAP_ZONE_MAP_SIZE * WORLD_MAP_ZONE_MAP_SIZE * 4;

export interface WorldMapZonePoint {
  u: number;
  v: number;
}

export type WorldMapZoneHit =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; areaId: number };

export class WorldMapZoneMap {
  readonly #areaIds: Uint32Array;

  constructor(areaIds: Uint32Array) {
    if (areaIds.length !== WORLD_MAP_ZONE_MAP_SIZE * WORLD_MAP_ZONE_MAP_SIZE) {
      throw new RangeError(`World-map zone map must contain ${WORLD_MAP_ZONE_MAP_SIZE ** 2} area ids`);
    }
    this.#areaIds = areaIds;
  }

  /** A raw authored cell. Out-of-range coordinates are empty rather than clamped onto land. */
  areaId(row: number, column: number): number {
    if (!Number.isInteger(row) || !Number.isInteger(column)
      || row < 0 || row >= WORLD_MAP_ZONE_MAP_SIZE
      || column < 0 || column >= WORLD_MAP_ZONE_MAP_SIZE) return 0;
    return this.#areaIds[row * WORLD_MAP_ZONE_MAP_SIZE + column] ?? 0;
  }

  /** AreaTable id under one normalised point of a continent WorldMapArea picture. */
  areaIdAt(mapArea: MapAreaInfo, u: number, v: number): number {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const world = worldMapWorld(mapArea, { u, v });
    // World origin is between ADT 31 and 32. Two ZMP cells cover one 533.33-yard ADT: columns
    // grow east as world Y falls; rows grow south as world X falls.
    const column = Math.floor(2 * (32 - world.y / TERRAIN_GRID_SIZE));
    const row = Math.floor(2 * (32 - world.x / TERRAIN_GRID_SIZE));
    return this.areaId(row, column);
  }
}

/** Decode without relying on the host machine's endian order. */
export function decodeWorldMapZoneMap(bytes: ArrayBuffer): WorldMapZoneMap {
  if (bytes.byteLength !== WORLD_MAP_ZONE_MAP_BYTES) {
    throw new RangeError(`World-map zone map must be ${WORLD_MAP_ZONE_MAP_BYTES} bytes, got ${bytes.byteLength}`);
  }
  const source = new DataView(bytes);
  const areaIds = new Uint32Array(WORLD_MAP_ZONE_MAP_SIZE * WORLD_MAP_ZONE_MAP_SIZE);
  for (let index = 0; index < areaIds.length; index++) {
    areaIds[index] = source.getUint32(index * 4, true);
  }
  return new WorldMapZoneMap(areaIds);
}

/** Exact centre of a ZMP cell, expressed as UV on a particular continent picture. */
export function worldMapZoneCellCenter(
  mapArea: MapAreaInfo,
  row: number,
  column: number,
): WorldMapZonePoint {
  const worldX = (32 - (row + 0.5) / 2) * TERRAIN_GRID_SIZE;
  const worldY = (32 - (column + 0.5) / 2) * TERRAIN_GRID_SIZE;
  return {
    u: (mapArea.left - worldY) / (mapArea.left - mapArea.right),
    v: (mapArea.top - worldX) / (mapArea.top - mapArea.bottom),
  };
}

/**
 * Lazy reader for the gateway's deliberately narrow ZMP endpoint.
 *
 * The tri-state is load-bearing. `ready` with area id zero is authored ocean and must suppress a
 * rectangle guess; only `unavailable` allows the caller to fall back to WorldMapArea rectangles.
 */
export class WorldMapZoneMapClient {
  readonly #baseUrl: string;
  readonly #retryBaseMs: number;
  readonly #maps = new Map<number, WorldMapZoneMap | null>();
  readonly #loading = new Set<number>();
  readonly #failed = new Set<number>();
  readonly #retryAttempts = new Map<number, number>();
  readonly #retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  #revision = 0;
  onChanged: ((mapId: number) => void) | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;

  constructor(gatewayWebSocketUrl: string, retryBaseMs = 1_000) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#retryBaseMs = Math.max(1, retryBaseMs);
  }

  get revision(): number {
    return this.#revision;
  }

  hit(mapId: number, mapArea: MapAreaInfo, u: number, v: number): WorldMapZoneHit {
    const known = this.#maps.get(mapId);
    if (known) return { status: "ready", areaId: known.areaIdAt(mapArea, u, v) };
    if (known === null) return { status: "unavailable" };
    if (!this.#loading.has(mapId) && !this.#retryTimers.has(mapId)) {
      this.#loading.add(mapId);
      void this.#load(mapId);
    }
    return { status: "loading" };
  }

  clear(): void {
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#maps.clear();
    this.#loading.clear();
    this.#failed.clear();
    this.#retryAttempts.clear();
    this.#retryTimers.clear();
    this.#revision++;
  }

  async #load(mapId: number): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/world-map/${mapId}/zones.bin`);
      if (!response.ok) {
        if (response.status === 404) {
          // A truthful absence is the sole permission to use overlapping WorldMapArea boxes.
          this.#maps.set(mapId, null);
          this.#resetRetry(mapId);
          if (this.#failed.delete(mapId)) {
            this.onStatus?.(`Карта областей ${mapId}: точная разметка отсутствует`, false);
          }
        } else {
          // A stock ZMP still exists when the gateway has a transient 500/403. Keep the answer
          // non-clickable and retry with backoff; caching this as `unavailable` would silently
          // restore the exact wrong-region bug this data path exists to remove.
          this.#reportFailure(mapId, `шлюз вернул ${response.status}`);
          this.#scheduleRetry(mapId);
        }
      } else {
        this.#maps.set(mapId, decodeWorldMapZoneMap(await response.arrayBuffer()));
        this.#resetRetry(mapId);
        if (this.#failed.delete(mapId)) {
          this.onStatus?.(`Карта областей ${mapId}: точная разметка загружена`, false);
        }
      }
    } catch (error) {
      this.#reportFailure(mapId, error instanceof Error ? error.message : String(error));
      // Even a wrong-length 200 may be a truncated proxy response or interrupted cache publish.
      // Only a truthful 404 proves the source is absent; every other failure remains non-clickable
      // and retryable instead of authorising the overlapping rectangle heuristic.
      this.#scheduleRetry(mapId);
    } finally {
      this.#loading.delete(mapId);
      this.#revision++;
      this.onChanged?.(mapId);
    }
  }

  #scheduleRetry(mapId: number): void {
    if (this.#retryTimers.has(mapId) || this.#maps.has(mapId)) return;
    const attempt = (this.#retryAttempts.get(mapId) ?? 0) + 1;
    this.#retryAttempts.set(mapId, attempt);
    const delay = Math.min(30_000, this.#retryBaseMs * 2 ** Math.min(attempt - 1, 5));
    const timer = setTimeout(() => {
      this.#retryTimers.delete(mapId);
      if (this.#maps.has(mapId) || this.#loading.has(mapId)) return;
      this.#loading.add(mapId);
      void this.#load(mapId);
    }, delay);
    // Node's focused tests must not be held open by a deliberately retryable network failure.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.#retryTimers.set(mapId, timer);
  }

  #reportFailure(mapId: number, detail: string): void {
    if (!this.#failed.has(mapId)) this.onStatus?.(`Карта областей ${mapId}: ${detail}`, true);
    this.#failed.add(mapId);
  }

  #resetRetry(mapId: number): void {
    this.#retryAttempts.delete(mapId);
    const timer = this.#retryTimers.get(mapId);
    if (timer !== undefined) clearTimeout(timer);
    this.#retryTimers.delete(mapId);
  }
}
