export const TERRAIN_GRID_SIZE = 533.3333333333334;
const GRID_CENTER = 32;
const RESOLUTION = 128;
const V9_COUNT = 129 * 129;
const V8_COUNT = 128 * 128;
const NO_HEIGHT = 0x01;
/**
 * What the map extractor writes where a liquid rectangle covers no liquid.
 *
 * `map_liquidHeight` is a rectangle around everything wet in a chunk, and the corners of that
 * rectangle are usually dry. TrinityCore fills them with this rather than with a mask.
 */
export const LIQUID_ABSENT = -500;
const AS_UINT16 = 0x02;
const AS_UINT8 = 0x04;

type HeightFormat = "flat" | "float" | "uint16" | "uint8";

export interface TerrainGrid {
  x: number;
  y: number;
}

export type { EnvironmentBounds, EnvironmentModel, EnvironmentObject };

/**
 * How urgently an environment model is needed by the current frame.
 *
 * Background scenery can enqueue hundreds of distinct paths before the unit and spell passes run.
 * Priority changes only the queued order: the four requests already on the wire are never
 * interrupted, and every path still has one request/backoff record regardless of how many callers
 * ask for it.
 */
export type ModelLoadPriority = "background" | "normal" | "critical";

const MODEL_LOAD_PRIORITY: Readonly<Record<ModelLoadPriority, number>> = {
  background: 0,
  normal: 1,
  critical: 2,
};

const MODEL_LOAD_CONCURRENCY = 4;
/**
 * During the first cold scenery/normal wave, leave one request lane available for a critical unit
 * or self model. The reservation disappears as soon as critical work starts, or shortly after the
 * first non-critical request even if nothing urgent arrives.
 */
export const MODEL_BACKGROUND_RESERVATION_MS = 750;

function gatewayBaseUrl(gatewayWebSocketUrl: string): string {
  const url = new URL(gatewayWebSocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export function terrainGrid(x: number, y: number): TerrainGrid | undefined {
  const grid = {
    x: Math.trunc(GRID_CENTER - x / TERRAIN_GRID_SIZE),
    y: Math.trunc(GRID_CENTER - y / TERRAIN_GRID_SIZE),
  };
  return grid.x >= 0 && grid.x < 64 && grid.y >= 0 && grid.y < 64 ? grid : undefined;
}

export class TerrainTile {
  readonly #view: DataView;
  readonly #format: HeightFormat;
  readonly #baseHeight: number;
  readonly #multiplier: number;
  readonly #stride: number;
  readonly #v9Offset: number;
  readonly #v8Offset: number;
  readonly #holesOffset: number;
  /** `map_areaHeader`: the 16×16 grid of area ids, or 0 when the whole tile is one area. */
  readonly #areaMapOffset: number;
  readonly #gridArea: number;
  readonly #liquid: { flagsOffset: number; entriesOffset: number; globalFlags: number; globalEntry: number; offsetX: number; offsetY: number; width: number; height: number; level: number; heightsOffset: number } | undefined;

  constructor(data: ArrayBuffer) {
    if (data.byteLength < 60 || data.byteLength > 2 * 1024 * 1024) throw new RangeError("Invalid TrinityCore map tile size");
    this.#view = new DataView(data);
    if (fourCC(this.#view, 0) !== "MAPS" || this.#view.getUint32(4, true) !== 10) throw new Error("Unsupported TrinityCore map tile");
    const heightOffset = this.#view.getUint32(20, true);
    const holesOffset = this.#view.getUint32(36, true);
    const holesSize = this.#view.getUint32(40, true);
    this.#holesOffset = holesOffset && holesSize >= 16 * 16 * 2 && holesOffset + 16 * 16 * 2 <= data.byteLength ? holesOffset : 0;
    // `map_fileheader.areaMapOffset` at 12, which nothing in this client had ever read. The
    // section is the only offline answer to "what area is the character standing in": the server
    // sends `SMSG_INIT_WORLD_STATES` on a zone change and nothing at all on a sub-area change, and
    // it ignores `CMSG_ZONEUPDATE`, so a live area name has to be counted from the position.
    const areaOffset = this.#view.getUint32(12, true);
    const areaSize = this.#view.getUint32(16, true);
    let areaMapOffset = 0;
    let gridArea = 0;
    if (areaOffset && areaSize >= 8 && areaOffset + 8 <= data.byteLength && fourCC(this.#view, areaOffset) === "AREA") {
      gridArea = this.#view.getUint16(areaOffset + 6, true);
      // `MAP_AREA_NO_AREA` means the extractor found one area over the whole tile and wrote no grid.
      const noArea = (this.#view.getUint16(areaOffset + 4, true) & 0x0001) !== 0;
      if (!noArea && areaOffset + 8 + 16 * 16 * 2 <= data.byteLength) areaMapOffset = areaOffset + 8;
    }
    this.#areaMapOffset = areaMapOffset;
    this.#gridArea = gridArea;
    const liquidOffset = this.#view.getUint32(28, true);
    const liquidSize = this.#view.getUint32(32, true);
    if (liquidOffset && liquidSize >= 16 && liquidOffset + liquidSize <= data.byteLength && fourCC(this.#view, liquidOffset) === "MLIQ") {
      const flags = this.#view.getUint8(liquidOffset + 4);
      const width = this.#view.getUint8(liquidOffset + 10);
      const height = this.#view.getUint8(liquidOffset + 11);
      let cursor = liquidOffset + 16;
      let flagsOffset = 0;
      let entriesOffset = 0;
      if (!(flags & 0x01)) {
        if (cursor + 16 * 16 * 3 > liquidOffset + liquidSize) throw new RangeError("Truncated TrinityCore liquid type map");
        // `liquid_entry[16][16]` first, then `liquid_flags[16][16]`. The entries are the client's
        // own `LiquidType.dbc` ids and used to be stepped straight over: the reader took the four-
        // way flag 512 bytes later and threw away which liquid this actually is.
        entriesOffset = cursor;
        flagsOffset = cursor + 16 * 16 * 2;
        cursor += 16 * 16 * 3;
      }
      let heightsOffset = 0;
      if (!(flags & 0x02)) {
        if (!width || !height || cursor + width * height * 4 > liquidOffset + liquidSize) throw new RangeError("Truncated TrinityCore liquid height map");
        heightsOffset = cursor;
      }
      this.#liquid = {
        flagsOffset,
        entriesOffset,
        // Byte 5 is the flag word and byte 6 the id, and each is only written on the tiles that
        // have no per-chunk arrays: on a tile that does carry them, byte 5 reads 2 (ocean) on all
        // 1,635 of them whatever the water is, because the extractor never initialised it.
        globalFlags: this.#view.getUint8(liquidOffset + 5),
        globalEntry: this.#view.getUint16(liquidOffset + 6, true),
        offsetX: this.#view.getUint8(liquidOffset + 8),
        offsetY: this.#view.getUint8(liquidOffset + 9),
        width,
        height,
        level: this.#view.getFloat32(liquidOffset + 12, true),
        heightsOffset,
      };
    }
    if (heightOffset === 0 || heightOffset + 16 > data.byteLength || fourCC(this.#view, heightOffset) !== "MHGT") {
      throw new Error("Map tile has no valid height section");
    }

    const flags = this.#view.getUint32(heightOffset + 4, true);
    this.#baseHeight = this.#view.getFloat32(heightOffset + 8, true);
    const maxHeight = this.#view.getFloat32(heightOffset + 12, true);
    this.#v9Offset = heightOffset + 16;

    if (flags & NO_HEIGHT) {
      this.#format = "flat";
      this.#stride = 0;
      this.#multiplier = 0;
      this.#v8Offset = this.#v9Offset;
      return;
    }

    if (flags & AS_UINT16) {
      this.#format = "uint16";
      this.#stride = 2;
      this.#multiplier = (maxHeight - this.#baseHeight) / 65535;
    } else if (flags & AS_UINT8) {
      this.#format = "uint8";
      this.#stride = 1;
      this.#multiplier = (maxHeight - this.#baseHeight) / 255;
    } else {
      this.#format = "float";
      this.#stride = 4;
      this.#multiplier = 1;
    }
    this.#v8Offset = this.#v9Offset + V9_COUNT * this.#stride;
    if (this.#v8Offset + V8_COUNT * this.#stride > data.byteLength) throw new RangeError("Truncated TrinityCore height section");
  }

  heightAt(worldX: number, worldY: number): number {
    if (this.#format === "flat") return this.#baseHeight;
    let x = RESOLUTION * (GRID_CENTER - worldX / TERRAIN_GRID_SIZE);
    let y = RESOLUTION * (GRID_CENTER - worldY / TERRAIN_GRID_SIZE);
    let xIndex = Math.trunc(x);
    let yIndex = Math.trunc(y);
    x -= xIndex;
    y -= yIndex;
    xIndex &= RESOLUTION - 1;
    yIndex &= RESOLUTION - 1;

    const h1 = this.#height(this.#v9Offset, xIndex * 129 + yIndex);
    const h2 = this.#height(this.#v9Offset, (xIndex + 1) * 129 + yIndex);
    const h3 = this.#height(this.#v9Offset, xIndex * 129 + yIndex + 1);
    const h4 = this.#height(this.#v9Offset, (xIndex + 1) * 129 + yIndex + 1);
    const h5 = 2 * this.#height(this.#v8Offset, xIndex * 128 + yIndex);
    let a: number;
    let b: number;
    let c: number;

    if (x + y < 1) {
      if (x > y) {
        a = h2 - h1;
        b = h5 - h1 - h2;
        c = h1;
      } else {
        a = h5 - h1 - h3;
        b = h3 - h1;
        c = h1;
      }
    } else if (x > y) {
      a = h2 + h4 - h5;
      b = h4 - h2;
      c = h5 - h4;
    } else {
      a = h4 - h3;
      b = h3 + h4 - h5;
      c = h5 - h4;
    }
    return (a * x + b * y + c) * this.#multiplier + this.#baseHeight;
  }

  /**
   * The area id under a position, exactly as `GridMap::getArea` reads it: sixteen cells across the
   * tile, world X the major index and world Y the minor.
   *
   * This is the ground half of `Map::GetAreaId`. Indoors the server answers from `WMOAreaTable`
   * instead, and that table has no vendored definition, so a character inside a building can be
   * told the area it is standing over rather than the room it is in.
   */
  areaAt(worldX: number, worldY: number): number {
    if (!this.#areaMapOffset) return this.#gridArea;
    const row = Math.trunc(16 * (GRID_CENTER - worldX / TERRAIN_GRID_SIZE)) & 15;
    const column = Math.trunc(16 * (GRID_CENTER - worldY / TERRAIN_GRID_SIZE)) & 15;
    return this.#view.getUint16(this.#areaMapOffset + (row * 16 + column) * 2, true);
  }

  isHole(worldX: number, worldY: number): boolean {
    if (!this.#holesOffset) return false;
    const row = Math.trunc(RESOLUTION * (GRID_CENTER - worldX / TERRAIN_GRID_SIZE)) & (RESOLUTION - 1);
    const column = Math.trunc(RESOLUTION * (GRID_CENTER - worldY / TERRAIN_GRID_SIZE)) & (RESOLUTION - 1);
    const cellRow = Math.trunc(row / 8);
    const cellColumn = Math.trunc(column / 8);
    const holeRow = Math.trunc((row % 8) / 2);
    const holeColumn = Math.trunc((column % 8) / 2);
    const hole = this.#view.getUint16(this.#holesOffset + (cellRow * 16 + cellColumn) * 2, true);
    return (hole & [0x1111, 0x2222, 0x4444, 0x8888][holeColumn]! & [0x000f, 0x00f0, 0x0f00, 0xf000][holeRow]!) !== 0;
  }

  /**
   * The liquid over a point: how high it stands, which of the four families it is, and which
   * `LiquidType.dbc` row it actually is.
   *
   * `entry` is the row and `type` the four-way flag, and they are not the same answer. Row 181,
   * "Orange Slime", is sound bank 0 — water — and its texture is `XTEXTURES\LavaOrange`; drawn by
   * the flag it is a blue river, on 49 chunks in Northrend. The flag stays because 1,561 of the
   * 3,196 tiles with liquid carry no per-chunk arrays at all, and there the header's own id is all
   * there is.
   *
   * `cells` says whether the answer came from a per-cell height or from one level for the whole
   * tile, which decides how much the caller may trust it: see the sentinel below.
   */
  liquidAt(worldX: number, worldY: number): { height: number; type: number; entry: number; cells: boolean } | undefined {
    const liquid = this.#liquid;
    if (!liquid) return undefined;
    const row = Math.trunc(RESOLUTION * (GRID_CENTER - worldX / TERRAIN_GRID_SIZE)) & (RESOLUTION - 1);
    const column = Math.trunc(RESOLUTION * (GRID_CENTER - worldY / TERRAIN_GRID_SIZE)) & (RESOLUTION - 1);
    const chunk = (row >> 3) * 16 + (column >> 3);
    const type = liquid.flagsOffset ? this.#view.getUint8(liquid.flagsOffset + chunk) : liquid.globalFlags;
    if (!type) return undefined;
    const entry = liquid.entriesOffset ? this.#view.getUint16(liquid.entriesOffset + chunk * 2, true) : liquid.globalEntry;
    const liquidRow = row - liquid.offsetY;
    const liquidColumn = column - liquid.offsetX;
    if (liquidRow < 0 || liquidRow >= liquid.height || liquidColumn < 0 || liquidColumn >= liquid.width) return undefined;
    const height = liquid.heightsOffset
      ? this.#view.getFloat32(liquid.heightsOffset + (liquidRow * liquid.width + liquidColumn) * 4, true)
      : liquid.level;
    // The extractor writes exactly -500 over every cell of the rectangle that a water body does not
    // actually cover, so the sentinel is the per-cell mask — the only one the file has. Tested for
    // equality and not for "very low": the lava in Azjol-Nerub genuinely sits at about -476, and a
    // threshold at -400 would drain 6,666 of its cells.
    if (height === LIQUID_ABSENT) return undefined;
    return Number.isFinite(height) ? { height, type, entry, cells: liquid.heightsOffset !== 0 } : undefined;
  }

  #height(offset: number, index: number): number {
    const position = offset + index * this.#stride;
    if (this.#format === "uint8") return this.#view.getUint8(position);
    if (this.#format === "uint16") return this.#view.getUint16(position, true);
    return this.#view.getFloat32(position, true);
  }
}

export class TerrainClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #tiles = new Map<string, TerrainTile | null>();
  readonly #loading = new Set<string>();
  readonly #tileRevisions = new Map<string, number>();
  #revision = 0;

  constructor(gatewayWebSocketUrl: string) {
    this.#baseUrl = gatewayBaseUrl(gatewayWebSocketUrl);
  }

  get revision(): number {
    return this.#revision;
  }

  /** How many times this tile alone has changed: only that moves a vertex or reopens a hole. */
  ownRevision(map: number, grid: TerrainGrid): number {
    return this.#tileRevisions.get(`${map}/${grid.x}/${grid.y}`) ?? 0;
  }

  /**
   * How many times this tile — or a tile whose ground/liquid corners it borrows — has changed.
   *
   * All eight neighbours, not just the four sides. Terrain normals borrow the four cardinal sides,
   * while water corner smoothing also reads the diagonal cell at a tile corner. Leaving the
   * diagonals out means a late corner tile can arrive without invalidating the water surface that
   * sampled it as missing.
   *
   * This is only an invalidation dependency: the renderer still loads the nine visible tiles, and
   * the corner tiles are already in that ring. It does not add downloads.
   */
  tileRevision(map: number, grid: TerrainGrid): number {
    let revision = this.ownRevision(map, grid);
    for (const [x, y] of [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ] as const) {
      revision += this.#tileRevisions.get(`${map}/${grid.x + x}/${grid.y + y}`) ?? 0;
    }
    return revision;
  }

  heightAt(map: number | undefined, x: number, y: number): number | undefined {
    if (map === undefined) return undefined;
    const grid = terrainGrid(x, y);
    if (!grid) return undefined;
    const key = `${map}/${grid.x}/${grid.y}`;
    const tile = this.#tiles.get(key);
    if (tile) return tile.heightAt(x, y);
    if (tile === undefined && !this.#loading.has(key)) {
      this.#loading.add(key);
      void this.#load(map, grid, key);
    }
    return undefined;
  }

  /**
   * Whether the tile containing a point has answered, including a deliberate 404.
   *
   * `heightAt` cannot express that distinction: a missing tile and a tile which is still on the
   * wire both return `undefined`.  The transfer curtain needs the distinction so it can wait for
   * the real tile, while still allowing an empty or partially extracted map through its timeout
   * degradation path.
   */
  isReady(map: number | undefined, x: number, y: number): boolean {
    if (map === undefined) return false;
    const grid = terrainGrid(x, y);
    if (!grid) return false;
    const key = `${map}/${grid.x}/${grid.y}`;
    if (this.#tiles.has(key)) return true;
    // Keep this method useful as the one readiness probe: asking it is enough to start the fetch.
    this.heightAt(map, x, y);
    return false;
  }

  isHole(map: number | undefined, x: number, y: number): boolean {
    if (map === undefined) return false;
    const grid = terrainGrid(x, y);
    if (!grid) return false;
    return this.#tiles.get(`${map}/${grid.x}/${grid.y}`)?.isHole(x, y) ?? false;
  }

  /**
   * The area id under a position, or undefined until the tile holding it has landed.
   *
   * Unlike `heightAt` this does not start a load: the tile the character stands on is already
   * being fetched for the ground it walks on, and a zone label that triggers downloads of its own
   * would fetch a tile per frame while the character runs along a border.
   */
  areaAt(map: number | undefined, x: number, y: number): number | undefined {
    if (map === undefined) return undefined;
    const grid = terrainGrid(x, y);
    if (!grid) return undefined;
    return this.#tiles.get(`${map}/${grid.x}/${grid.y}`)?.areaAt(x, y);
  }

  liquidAt(map: number | undefined, x: number, y: number): { height: number; type: number; entry: number; cells: boolean } | undefined {
    if (map === undefined) return undefined;
    const grid = terrainGrid(x, y);
    if (!grid) return undefined;
    return this.#tiles.get(`${map}/${grid.x}/${grid.y}`)?.liquidAt(x, y);
  }

  async #load(map: number, grid: TerrainGrid, key: string): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/terrain/${map}/${grid.x}/${grid.y}`);
      if (response.status === 404) {
        this.#resolve(key, null);
        this.onStatus?.(`Terrain tile ${key} не найден`, true);
        return;
      }
      if (!response.ok) throw new Error(`Terrain gateway returned ${response.status}`);
      this.#resolve(key, new TerrainTile(await response.arrayBuffer()));
      this.onStatus?.(`Terrain tiles загружено: ${[...this.#tiles.values()].filter(Boolean).length}`, false);
    } catch (error) {
      this.#resolve(key, null);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#loading.delete(key);
    }
  }

  #resolve(key: string, tile: TerrainTile | null): void {
    this.#tiles.set(key, tile);
    this.#revision++;
    this.#tileRevisions.set(key, this.#revision);
  }
}

export class EnvironmentClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #tiles = new Map<string, EnvironmentObject[] | null>();
  readonly #loading = new Set<string>();
  readonly #models = new Map<string, EnvironmentModel | null>();
  readonly #animations = new Map<string, WvmSkeletonClip[] | null>();
  readonly #requestedAnimations = new Set<string>();
  /** Queued, but not active, models. Map order is FIFO among entries of equal priority. */
  readonly #modelQueue = new Map<string, ModelLoadPriority>();
  readonly #requestedModels = new Set<string>();
  readonly #groupQueue: Array<{ key: string; name: string; group: number }> = [];
  readonly #requestedGroups = new Set<string>();
  #activeGroups = 0;
  #activeModels = 0;
  #backgroundReservationStartedAt: number | undefined;
  #backgroundReservationReleased = false;
  #backgroundReservationTimer: ReturnType<typeof setTimeout> | undefined;
  #modelDrainScheduled = false;
  #generation = 0;
  #objectsKey = "";
  #objectsCache: EnvironmentObject[] = [];
  /**
   * Models whose request did not come back: how many times it has been made, and when to make it
   * again. `after` is `Infinity` for one that will not be made again.
   *
   * The ledger Т6 gave the body textures and the appearance route, and this path did not get. A
   * model was written off on the *first* failure of any kind — `#models.set(key, null)`, and
   * `#requestedModels` then blocking it from ever being queued again — so a generation lane that
   * was busy for a second cost a building for the life of the tab. Orgrimmar's 92 models were
   * published over 130.8 s of the owner's own session at 1.42 s apiece, which is a long time to be
   * one dead child away from a permanent hole in the city.
   */
  readonly #modelFailures = new Map<string, { attempts: number; after: number }>();
  readonly #now: () => number;

  /**
   * @param now the clock the model backoff is measured against. Injected for the same reason the
   * atlas injects one: a test must be able to spend forty seconds of waiting in no time at all.
   */
  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    this.#baseUrl = gatewayBaseUrl(gatewayWebSocketUrl);
    this.#now = now;
  }

  /**
   * Called once per frame by both renderers, so the merged result is cached. It only has to be
   * rebuilt when the player walks into a different set of tiles or another tile finishes loading.
   */
  objectsAround(map: number | undefined, x: number, y: number): EnvironmentObject[] {
    if (map === undefined) return [];
    const grids = new Map<string, TerrainGrid>();
    for (const offsetX of [-140, 0, 140]) {
      for (const offsetY of [-140, 0, 140]) {
        const grid = terrainGrid(x + offsetX, y + offsetY);
        if (grid) grids.set(`${grid.x}/${grid.y}`, grid);
      }
    }

    const cacheKey = `${map}:${this.#generation}:${[...grids.keys()].sort().join(",")}`;
    if (cacheKey === this.#objectsKey) return this.#objectsCache;

    const objects = new Map<number, EnvironmentObject>();
    for (const grid of grids.values()) {
      const key = `${map}/${grid.x}/${grid.y}`;
      const tile = this.#tiles.get(key);
      if (tile) for (const object of tile) objects.set(object.id, object);
      else if (tile === undefined && !this.#loading.has(key)) {
        this.#loading.add(key);
        void this.#load(map, grid, key);
      }
    }
    this.#objectsKey = cacheKey;
    this.#objectsCache = [...objects.values()];
    return this.#objectsCache;
  }

  /** Where the gateway lives, for the texture URLs a model resolves for itself. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * One model, keyed on its path alone. The artifact carries no appearance, so every skin and
   * hair combination of a race shares this download.
   *
   * Asked for again after a wait when the last answer was one that could change. `null` is the
   * gateway saying the client does not hold this file — `/visual/model` now says that with a 404
   * and says everything else with a 500 — and asking three more times gets three more 404s.
   */
  model(name: string, priority: ModelLoadPriority = "normal"): EnvironmentModel | undefined {
    const key = modelKey(name);
    const value = this.#models.get(key);
    if (value) return value;
    if (value === null) return undefined;
    if (this.#requestedModels.has(key)) {
      // An active request has already left the queue and is deliberately not pre-empted. A queued
      // one can still become urgent when, for example, scenery first named a model and a spell or
      // unit asks for the same path later in the frame.
      const queued = this.#modelQueue.get(key);
      if (queued !== undefined && MODEL_LOAD_PRIORITY[priority] > MODEL_LOAD_PRIORITY[queued]) {
        this.#modelQueue.set(key, priority);
      }
      // A reserved fourth lane may have become eligible by priority promotion or elapsed time.
      if (queued !== undefined) this.#scheduleModelDrain();
      return undefined;
    }
    const failure = this.#modelFailures.get(key);
    if (failure && this.#now() < failure.after) return undefined;
    this.#requestedModels.add(key);
    this.#modelQueue.set(key, priority);
    if (priority !== "critical") this.#startBackgroundReservation();
    this.#scheduleModelDrain();
    return undefined;
  }

  /**
   * The geometry of the WMO groups a big building held back.
   *
   * Asked for once per group and never again. A group whose block never arrives is a room the
   * player sees through, which is bad; a group asked for every frame is a request storm, which is
   * worse. The same rule the collision client follows for the same reason.
   */
  requestModelGroups(name: string, groups: readonly number[]): void {
    const key = modelKey(name);
    const missing = groups.filter((group) => !this.#requestedGroups.has(`${key}#${group}`));
    if (missing.length === 0) return;
    for (const group of missing) this.#requestedGroups.add(`${key}#${group}`);
    for (const group of missing) this.#groupQueue.push({ key, name, group });
    this.#drainGroups();
  }

  /**
   * The animations that did not travel with the model, once something needs one.
   *
   * A character model holds around 1.5 MiB of keyframes and a tenth of that is locomotion, so the
   * rest is a second request rather than a tax on every wolf that walks into view. Asked for at
   * most once per model: the answer is cached either way, and a model with nothing held back
   * answers with an empty block rather than a 404, so this cannot turn into a request per frame.
   */
  animations(name: string, bones: number): WvmSkeletonClip[] | undefined {
    const key = modelKey(name);
    const value = this.#animations.get(key);
    if (value) return value;
    if (value === null || this.#requestedAnimations.has(key)) return undefined;
    this.#requestedAnimations.add(key);
    void this.#loadAnimations(key, name, bones);
    return undefined;
  }

  async #loadAnimations(key: string, name: string, bones: number): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/visual/animations?path=${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(`Animation gateway returned ${response.status}`);
      this.#animations.set(key, decodeWvaAnimations(await response.arrayBuffer(), bones));
    } catch (error) {
      // Null, not a retry: the model keeps whatever poses it arrived with.
      this.#animations.set(key, null);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** Let every `model()` call in this JavaScript turn enter the priority queue first. */
  #scheduleModelDrain(): void {
    if (this.#modelDrainScheduled) return;
    this.#modelDrainScheduled = true;
    queueMicrotask(() => {
      this.#modelDrainScheduled = false;
      this.#drainModels();
    });
  }

  #drainModels(): void {
    while (this.#activeModels < MODEL_LOAD_CONCURRENCY) {
      const criticalOnly = this.#backgroundReservationActive()
        && this.#activeModels >= MODEL_LOAD_CONCURRENCY - 1;
      const wanted = this.#nextModel(criticalOnly);
      if (wanted === undefined) return;
      if (wanted.priority === "critical") this.#releaseBackgroundReservation();
      this.#activeModels++;
      void this.#loadModel(wanted.name).finally(() => {
        this.#activeModels--;
        this.#scheduleModelDrain();
      });
    }
  }

  /** Highest priority first, retaining insertion order between equal-priority requests. */
  #nextModel(criticalOnly: boolean): { name: string; priority: ModelLoadPriority } | undefined {
    let selected: string | undefined;
    let selectedPriority = -1;
    for (const [name, priority] of this.#modelQueue) {
      if (criticalOnly && priority !== "critical") continue;
      const rank = MODEL_LOAD_PRIORITY[priority];
      if (rank <= selectedPriority) continue;
      selected = name;
      selectedPriority = rank;
    }
    if (selected === undefined) return undefined;
    const priority = this.#modelQueue.get(selected)!;
    this.#modelQueue.delete(selected);
    return { name: selected, priority };
  }

  #backgroundReservationActive(): boolean {
    return !this.#backgroundReservationReleased
      && this.#backgroundReservationStartedAt !== undefined
      && this.#now() - this.#backgroundReservationStartedAt < MODEL_BACKGROUND_RESERVATION_MS;
  }

  #startBackgroundReservation(): void {
    if (this.#backgroundReservationStartedAt !== undefined || this.#backgroundReservationReleased) return;
    this.#backgroundReservationStartedAt = this.#now();
    this.#backgroundReservationTimer = setTimeout(() => {
      this.#backgroundReservationTimer = undefined;
      this.#backgroundReservationReleased = true;
      this.#scheduleModelDrain();
    }, MODEL_BACKGROUND_RESERVATION_MS);
  }

  #releaseBackgroundReservation(): void {
    if (this.#backgroundReservationReleased) return;
    this.#backgroundReservationReleased = true;
    if (this.#backgroundReservationTimer !== undefined) clearTimeout(this.#backgroundReservationTimer);
    this.#backgroundReservationTimer = undefined;
  }

  #drainGroups(): void {
    while (this.#activeGroups < 4) {
      const wanted = this.#groupQueue.shift();
      if (!wanted) return;
      this.#activeGroups++;
      void this.#loadGroup(wanted).finally(() => {
        this.#activeGroups--;
        this.#drainGroups();
      });
    }
  }

  async #loadGroup(wanted: { key: string; name: string; group: number }): Promise<void> {
    try {
      const response = await fetch(`${this.#baseUrl}/visual/model?path=${encodeURIComponent(wanted.name)}&group=${wanted.group}`);
      if (!response.ok) throw new Error(`Visual model gateway returned ${response.status}`);
      const block = decodeWwmGroup(await response.arrayBuffer());
      const model = this.#models.get(wanted.key);
      const group = model?.wmo?.groups[wanted.group];
      // The block says which group it is; a mismatch means a stale artifact, and drawing one
      // room's walls in another room's place is worse than leaving the room empty.
      if (!group || block.index !== wanted.group) return;
      group.mesh = block.mesh;
    } catch (error) {
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    }
  }

  async #loadModel(key: string): Promise<void> {
    const separator = key.indexOf("|");
    const name = separator < 0 ? key : key.slice(0, separator);
    try {
      const response = await fetch(`${this.#baseUrl}/visual/model?path=${encodeURIComponent(name)}`);
      if (response.ok) {
        this.#models.set(key, decodeVisualModel(await response.arrayBuffer(), this.#baseUrl));
        this.#modelFailures.delete(key);
        this.#report();
        return;
      }
      // 404 is the gateway saying the archives do not hold this model, and that does not change
      // inside a session; anything else — a generation lane busy, a child that died, a decoder
      // that threw — is a fact about this second, and Т6's ladder is what it is for. The route
      // could not tell the two apart until this same slice, which is why this ledger is worth
      // having only now.
      if (response.status === 404) {
        const basename = name.replaceAll("\\", "/").split("/").at(-1) ?? name;
        const hull = await fetch(`${this.#baseUrl}/environment/model/${encodeURIComponent(basename)}`);
        // The server's own collision hull, and it is no longer drawn: `drawableModel` in the
        // renderer refuses anything carrying no `visual` flag, because painting Orgrimmar's shell
        // — 379,079 triangles, 7.6 MiB, flat tan — is not painting Orgrimmar. What it still does
        // is answer the question: a placement whose model resolved to a hull stops showing a
        // stand-in that is not on its way to becoming anything.
        if (hull.ok) this.#models.set(key, decodeEnvironmentModel(await hull.arrayBuffer()));
        // The client simply does not ship this model; the placement keeps its stand-in, or, for a
        // building, nothing at all. Counted so a wave of them shows up in diagnostics instead of
        // passing unnoticed.
        else this.#models.set(key, null);
        this.#modelFailures.delete(key);
        this.#report();
        return;
      }
      throw new Error(`Visual model gateway returned ${response.status}`);
    } catch (error) {
      this.#deferModel(key);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    }
  }

  /**
   * Remembers a model that did not come, and when it is worth asking for again.
   *
   * Three retries after the first attempt — four requests over forty seconds — and then the path
   * is left alone, which is the atlas's ladder to the millisecond because it is the same failure:
   * an artifact the gateway has to build out of the archives on demand. The key comes back out of
   * `#requestedModels` so that the frame past the deadline really does ask again; nothing else
   * would, because `objectsAround` only calls `model()` for placements that are already on screen.
   */
  #deferModel(key: string): void {
    const attempt = (this.#modelFailures.get(key)?.attempts ?? 0) + 1;
    const wait = IMAGE_RETRY_BACKOFF_MS[attempt - 1];
    this.#requestedModels.delete(key);
    this.#modelFailures.set(key, {
      attempts: attempt,
      after: wait === undefined ? Infinity : this.#now() + wait,
    });
  }

  async #load(map: number, grid: TerrainGrid, key: string): Promise<void> {
    try {
      let response = await fetch(`${this.#baseUrl}/visual/environment/${map}/${grid.x}/${grid.y}`);
      if (!response.ok) response = await fetch(`${this.#baseUrl}/environment/${map}/${grid.x}/${grid.y}`);
      if (response.status === 404) {
        this.#resolve(key, null);
        this.onStatus?.(`VMAP tile ${key} не найден`, false);
        return;
      }
      if (!response.ok) throw new Error(`Environment gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value) || value.length > 10_000 || !value.every(isEnvironmentObject)) {
        throw new Error("Environment gateway returned invalid objects");
      }
      this.#resolve(key, value);
      const loaded = [...this.#tiles.values()].filter((tile): tile is EnvironmentObject[] => Array.isArray(tile));
      this.onStatus?.(`VMAP tiles: ${loaded.length} · объектов: ${loaded.reduce((sum, tile) => sum + tile.length, 0)}`, false);
    } catch (error) {
      this.#resolve(key, null);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#loading.delete(key);
    }
  }

  #report(): void {
    const models = [...this.#models.values()];
    const loaded = models.filter((model): model is EnvironmentModel => model !== null);
    const missing = models.length - loaded.length;
    this.onStatus?.(
      `3D-моделей: ${loaded.length} · visual: ${loaded.filter((model) => model.visual).length}${missing ? ` · нет в клиенте: ${missing}` : ""}`,
      false,
    );
  }

  #resolve(key: string, tile: EnvironmentObject[] | null): void {
    this.#tiles.set(key, tile);
    this.#generation++;
  }
}

/** Cache key for one model in one set of textures; matches the query the gateway hashes on. */
export function modelKey(name: string, textures = ""): string {
  return textures ? `${name}|${textures}` : name;
}

export function decodeVisualModel(data: ArrayBuffer, baseUrl: string): EnvironmentModel {
  if (data.byteLength < 16) throw new Error("Visual model is truncated");
  const bytes = new Uint8Array(data);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  // A WMO comes as its groups. Which of them carry geometry is the artifact's business, not this
  // one's: a tavern arrives whole, a city arrives as boxes and is asked for a room at a time.
  if (magic === "WWM1") return { vertices: [], indices: [], visual: true, wmo: decodeWwm(data, baseUrl) };
  // WVM9 carries the model whole and resolves nothing, so it is handed straight through: which
  // geosets and which textures this appearance uses are decided when it is drawn.
  if (magic === "WVM9") return { vertices: [], indices: [], visual: true, wvm: decodeWvm9(data) };
  if (magic === "WVM3") {
    const skeletonOffset = new DataView(data).getUint32(16, true);
    if (skeletonOffset < 20 || skeletonOffset > data.byteLength) throw new Error("Visual model skeleton offset is invalid");
    const model = decodeVisualModelV2(data.slice(0, skeletonOffset), bytes.subarray(0, skeletonOffset), baseUrl);
    return { ...model, skeleton: decodeModelSkeleton(data, skeletonOffset, model.vertices.length / 3) };
  }
  if (magic === "WVM2") return decodeVisualModelV2(data, bytes, baseUrl);
  if (magic !== "WVM1") throw new Error("Visual model has an invalid header");
  const view = new DataView(data);
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const textureLength = view.getUint16(12, true);
  const expected = 16 + vertexCount * 5 * 4 + indexCount * 4 + textureLength;
  if (vertexCount > 1_000_000 || indexCount > 6_000_000 || indexCount % 3 !== 0 || data.byteLength !== expected) throw new Error("Visual model has invalid counts");
  const vertices = new Array<number>(vertexCount * 3);
  const uvs = new Array<number>(vertexCount * 2);
  const indices = new Array<number>(indexCount);
  let offset = 16;
  for (let index = 0; index < vertices.length; index++, offset += 4) vertices[index] = view.getFloat32(offset, true);
  for (let index = 0; index < uvs.length; index++, offset += 4) uvs[index] = view.getFloat32(offset, true);
  for (let index = 0; index < indices.length; index++, offset += 4) {
    indices[index] = view.getUint32(offset, true);
    if (indices[index]! >= vertexCount) throw new Error("Visual model index is out of range");
  }
  const texture = new TextDecoder().decode(bytes.subarray(offset));
  return { vertices, indices, uvs, ...(texture ? { textureUrl: `${baseUrl}${texture}` } : {}), visual: true };
}

function decodeVisualModelV2(data: ArrayBuffer, bytes: Uint8Array, baseUrl: string): EnvironmentModel {
  if (data.byteLength < 20) throw new Error("Visual model material header is truncated");
  const view = new DataView(data);
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const materialCount = view.getUint16(12, true);
  const groupCount = view.getUint16(14, true);
  const fixedLength = 20 + vertexCount * 5 * 4 + indexCount * 4 + groupCount * 12;
  if (vertexCount > 1_000_000 || indexCount > 6_000_000 || indexCount % 3 !== 0 || materialCount === 0 || materialCount > 1000
    || groupCount === 0 || groupCount > 1000 || fixedLength > data.byteLength) throw new Error("Visual model has invalid material counts");
  const vertices = new Array<number>(vertexCount * 3);
  const uvs = new Array<number>(vertexCount * 2);
  const indices = new Array<number>(indexCount);
  let offset = 20;
  for (let index = 0; index < vertices.length; index++, offset += 4) vertices[index] = view.getFloat32(offset, true);
  for (let index = 0; index < uvs.length; index++, offset += 4) uvs[index] = view.getFloat32(offset, true);
  for (let index = 0; index < indices.length; index++, offset += 4) {
    indices[index] = view.getUint32(offset, true);
    if (indices[index]! >= vertexCount) throw new Error("Visual model index is out of range");
  }
  const groups = [];
  for (let index = 0; index < groupCount; index++, offset += 12) {
    const group = {
      start: view.getUint32(offset, true),
      count: view.getUint32(offset + 4, true),
      material: view.getUint16(offset + 8, true),
      blendMode: view.getUint8(offset + 10),
      flags: view.getUint8(offset + 11),
    };
    if (group.count === 0 || group.count % 3 !== 0 || group.start + group.count > indexCount || group.material >= materialCount) {
      throw new Error("Visual model material group is invalid");
    }
    groups.push(group);
  }
  const textureUrls = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < materialCount; index++) {
    if (offset + 2 > data.byteLength) throw new Error("Visual model texture table is truncated");
    const length = view.getUint16(offset, true);
    offset += 2;
    if (length > 1000 || offset + length > data.byteLength) throw new Error("Visual model texture URL is invalid");
    const url = decoder.decode(bytes.subarray(offset, offset + length));
    textureUrls.push(url ? `${baseUrl}${url}` : "");
    offset += length;
  }
  if (offset !== data.byteLength) throw new Error("Visual model has trailing material data");
  return { vertices, indices, uvs, groups, textureUrls, visual: true };
}

/** M2 stores rotation keys as four int16; this is the client's own decompression. */
function decompressQuaternionPart(value: number): number {
  return (value < 0 ? value + 32768 : value - 32767) / 32767;
}

function decodeModelSkeleton(data: ArrayBuffer, start: number, vertexCount: number): ModelSkeleton {
  const view = new DataView(data);
  const limit = data.byteLength;
  if (start + 4 > limit) throw new Error("Visual model skeleton is truncated");
  const boneCount = view.getUint16(start, true);
  const clipCount = view.getUint16(start + 2, true);
  if (boneCount === 0 || boneCount > 1024 || clipCount === 0 || clipCount > 64) throw new Error("Visual model skeleton is out of range");
  let offset = start + 4;
  if (offset + vertexCount * 8 + boneCount * 16 > limit) throw new Error("Visual model skeleton is truncated");

  const skinIndices = new Uint8Array(data.slice(offset, offset + vertexCount * 4));
  offset += vertexCount * 4;
  const rawWeights = new Uint8Array(data, offset, vertexCount * 4);
  offset += vertexCount * 4;
  const skinWeights = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let total = 0;
    for (let slot = 0; slot < 4; slot++) total += rawWeights[vertex * 4 + slot]!;
    // A vertex with no weight at all is pinned to bone 0 so it does not collapse to the origin.
    if (total === 0) skinWeights[vertex * 4] = 1;
    else for (let slot = 0; slot < 4; slot++) skinWeights[vertex * 4 + slot] = rawWeights[vertex * 4 + slot]! / total;
    for (let slot = 0; slot < 4; slot++) {
      if (skinIndices[vertex * 4 + slot]! >= boneCount) skinIndices[vertex * 4 + slot] = 0;
    }
  }

  const parents = new Int16Array(boneCount);
  const pivots = new Float32Array(boneCount * 3);
  for (let bone = 0; bone < boneCount; bone++) {
    const parent = view.getInt16(offset, true);
    parents[bone] = parent >= 0 && parent < bone ? parent : -1;
    for (let axis = 0; axis < 3; axis++) pivots[bone * 3 + axis] = view.getFloat32(offset + 4 + axis * 4, true);
    offset += 16;
  }

  const clips: ModelClip[] = [];
  for (let clip = 0; clip < clipCount; clip++) {
    if (offset + 12 > limit) throw new Error("Visual model animation is truncated");
    const animationId = view.getUint16(offset, true);
    const looping = (view.getUint16(offset + 2, true) & 1) !== 0;
    const duration = view.getUint32(offset + 4, true);
    const channelCount = view.getUint32(offset + 8, true);
    offset += 12;
    if (duration === 0 || duration > 600_000 || channelCount > boneCount * 3) throw new Error("Visual model animation is out of range");

    const channels: ModelChannel[] = [];
    for (let index = 0; index < channelCount; index++) {
      if (offset + 8 > limit) throw new Error("Visual model animation channel is truncated");
      const bone = view.getUint16(offset, true);
      const kind = view.getUint8(offset + 2);
      const keyCount = view.getUint32(offset + 4, true);
      offset += 8;
      const components = kind === 1 ? 4 : 3;
      const valueBytes = keyCount * components * (kind === 1 ? 2 : 4);
      if (bone >= boneCount || kind > 2 || keyCount === 0 || keyCount > 20_000 || offset + keyCount * 4 + valueBytes > limit) {
        throw new Error("Visual model animation channel is out of range");
      }
      const times = new Float32Array(keyCount);
      for (let key = 0; key < keyCount; key++) times[key] = view.getUint32(offset + key * 4, true) / 1000;
      offset += keyCount * 4;
      const values = new Float32Array(keyCount * components);
      for (let key = 0; key < keyCount; key++) {
        for (let part = 0; part < components; part++) {
          values[key * components + part] = kind === 1
            ? decompressQuaternionPart(view.getInt16(offset + (key * 4 + part) * 2, true))
            : view.getFloat32(offset + (key * 3 + part) * 4, true);
        }
      }
      offset += valueBytes;
      channels.push({ bone, kind: kind as 0 | 1 | 2, times, values });
    }
    if (channels.length > 0) clips.push({ animationId, duration: duration / 1000, looping, channels });
  }
  if (offset !== limit) throw new Error("Visual model has trailing skeleton data");
  if (clips.length === 0) throw new Error("Visual model skeleton has no animations");
  return { parents, pivots, skinIndices, skinWeights, clips };
}

function decodeEnvironmentModel(data: ArrayBuffer): EnvironmentModel {
  if (data.byteLength < 8) throw new Error("Environment model is truncated");
  const view = new DataView(data);
  const vertexCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);
  if (vertexCount > 1_000_000 || indexCount > 6_000_000 || indexCount % 3 !== 0 || data.byteLength !== 8 + (vertexCount * 3 + indexCount) * 4) {
    throw new Error("Environment model has an invalid header");
  }
  const vertices = new Array<number>(vertexCount * 3);
  const indices = new Array<number>(indexCount);
  let offset = 8;
  for (let index = 0; index < vertices.length; index++, offset += 4) vertices[index] = view.getFloat32(offset, true);
  for (let index = 0; index < indices.length; index++, offset += 4) {
    const value = view.getUint32(offset, true);
    if (value >= vertexCount) throw new Error("Environment model index is out of range");
    indices[index] = value;
  }
  return { vertices, indices };
}

function isEnvironmentObject(value: unknown): value is EnvironmentObject {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const numbers = ["id", "x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale"];
  if (!numbers.every((key) => typeof object[key] === "number" && Number.isFinite(object[key]))) return false;
  if ((object.kind !== "m2" && object.kind !== "wmo") || typeof object.name !== "string") return false;
  if (object.interior !== undefined && typeof object.interior !== "boolean") return false;
  if (object.doodadSet !== undefined && (!Number.isInteger(object.doodadSet) || (object.doodadSet as number) < 0)) return false;
  const quaternion = [object.quaternionX, object.quaternionY, object.quaternionZ, object.quaternionW];
  if (quaternion.some((value) => value !== undefined) && !quaternion.every((value) => typeof value === "number" && Number.isFinite(value))) return false;
  if (object.bounds === undefined) return true;
  if (!object.bounds || typeof object.bounds !== "object") return false;
  const bounds = object.bounds as Record<string, unknown>;
  return ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"]
    .every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]));
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}
import type { EnvironmentBounds, EnvironmentObject } from "../gateway/VMapProtocol.js";
// The same ladder, from the file that measured it: a model the gateway has to build out of the
// archives fails in exactly the way a body texture does, and two different waits would be two
// numbers to keep in step for no reason.
import { IMAGE_RETRY_BACKOFF_MS } from "./CharacterAtlas.js";
import { decodeWvaAnimations, decodeWvm9, type WvmSkeletonClip } from "./Wvm.js";
import { decodeWwm, decodeWwmGroup } from "./WmoModel.js";
import type { EnvironmentModel, ModelChannel, ModelClip, ModelSkeleton } from "../gateway/VMapModel.js";
