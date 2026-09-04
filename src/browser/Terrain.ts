export const TERRAIN_GRID_SIZE = 533.3333333333334;
export const ENVIRONMENT_RANGE = 400;
/** Production cap for completed CPU terrain tiles; active renderer pins may exceed it. */
export const TERRAIN_TILE_CACHE_LIMIT = 64;
/**
 * Production cap for completed environment tiles. The active footprint is allowed to exceed this
 * cap so a frame never evicts a tile it is currently asking the scene to draw.
 */
export const ENVIRONMENT_TILE_CACHE_LIMIT = 64;
/** Completed decoded model entries retained by the CPU cache; current-frame pins may exceed it. */
export const ENVIRONMENT_MODEL_CACHE_LIMIT = 256;
/** Completed decoded animation entries retained by the CPU cache; current-frame pins may exceed it. */
export const ENVIRONMENT_ANIMATION_CACHE_LIMIT = 128;
/** Queued model requests retained between resource-frame commits. */
export const ENVIRONMENT_MODEL_QUEUE_LIMIT = 256;
/** Animation sidecar requests allowed on the wire at once. */
export const ENVIRONMENT_ANIMATION_LOAD_CONCURRENCY = 2;
/** Queued animation sidecar requests retained between resource-frame commits. */
export const ENVIRONMENT_ANIMATION_QUEUE_LIMIT = 256;
/** Queued WMO group requests retained while the four group lanes are active. */
export const ENVIRONMENT_MODEL_GROUP_QUEUE_LIMIT = 256;
/** Soft decoded-residency budgets; exact active-frame pins may temporarily exceed them. */
export const ENVIRONMENT_MODEL_TYPED_BACKING_BUDGET_BYTES = 64 * 1024 * 1024;
export const ENVIRONMENT_MODEL_NUMERIC_ARRAY_BUDGET_ELEMENTS = 8_000_000;
export const ENVIRONMENT_ANIMATION_TYPED_BACKING_BUDGET_BYTES = 64 * 1024 * 1024;
/** Hard decoded-entry limits. Unlike soft budgets, active pins never bypass these. */
export const ENVIRONMENT_MODEL_ENTRY_TYPED_BACKING_LIMIT_BYTES = 32 * 1024 * 1024;
export const ENVIRONMENT_MODEL_ENTRY_NUMERIC_ARRAY_LIMIT_ELEMENTS = 4_000_000;
/**
 * HD character rigs retain more decoded keyframe backing than their stock counterparts. The
 * installed visual corpus peaks at 18.1 MB, so 24 MiB admits it while the 64 MiB aggregate budget
 * still limits how many large rigs can remain resident.
 */
export const ENVIRONMENT_ANIMATION_ENTRY_TYPED_BACKING_LIMIT_BYTES = 24 * 1024 * 1024;
/** Hard response-body limits applied before production decoders are entered. */
export const VISUAL_MODEL_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
export const WMO_GROUP_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
/** HD animation sidecars in the installed corpus peak at 13.3 MB; keep a bounded 16 MiB ceiling. */
export const WVA_ANIMATION_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
export const COLLISION_HULL_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const GRID_CENTER = 32;
const GRID_COUNT = 64;
const MAP_MIN = -GRID_CENTER * TERRAIN_GRID_SIZE;
const MAP_MAX = GRID_CENTER * TERRAIN_GRID_SIZE;
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

export interface TerrainStats {
  readonly resident: number;
  readonly failed: number;
  readonly active: number;
  readonly typedPayloadBytes: number;
}

export interface EnvironmentStats {
  readonly residentTiles: number;
  readonly knownMissingTiles: number;
  readonly failedTiles: number;
  readonly activeTiles: number;
  readonly residentObjects: number;
  readonly residentModels: number;
  readonly knownMissingModels: number;
  readonly deferredModels: number;
  readonly failedModels: number;
  readonly queuedModels: number;
  readonly activeModels: number;
  readonly queuedGroups: number;
  readonly activeGroups: number;
  readonly deferredGroups: number;
  readonly failedGroups: number;
  readonly residentAnimations: number;
  readonly failedAnimations: number;
  readonly deferredAnimations: number;
  readonly queuedAnimations: number;
  readonly activeAnimations: number;
  /** Exact decoded payload units. Object/scalar overhead is intentionally outside this metric. */
  readonly modelDecodedTypedBackingBytes: number;
  readonly modelDecodedNumericArrayElements: number;
  readonly modelDecodedTypedBackingOverflowBytes: number;
  readonly modelDecodedNumericArrayOverflowElements: number;
  readonly animationDecodedTypedBackingBytes: number;
  readonly animationDecodedNumericArrayElements: number;
  readonly animationDecodedTypedBackingOverflowBytes: number;
}

/** Exact, cycle-safe cost of decoded data retained by one cache entry. */
export interface DecodedResidencyCost {
  readonly typedBackingBytes: number;
  readonly numericArrayElements: number;
}

/** Optional overrides appended to the legacy EnvironmentClient constructor arguments. */
export interface EnvironmentResidencyBudgetOptions {
  readonly modelTypedBackingBytes?: number;
  readonly modelNumericArrayElements?: number;
  readonly animationTypedBackingBytes?: number;
  readonly modelEntryTypedBackingBytes?: number;
  readonly modelEntryNumericArrayElements?: number;
  readonly animationEntryTypedBackingBytes?: number;
  readonly visualModelResponseBytes?: number;
  readonly modelGroupResponseBytes?: number;
  readonly animationResponseBytes?: number;
  readonly collisionHullResponseBytes?: number;
}

/**
 * How urgently an environment model is needed by the current frame.
 *
 * Background scenery can enqueue hundreds of distinct paths before the unit and spell passes run.
 * Priority changes only the queued order: the four requests already on the wire are never
 * interrupted, and every path still has one request/backoff record regardless of how many callers
 * ask for it.
 */
export type ModelLoadPriority = "background" | "normal" | "critical";

interface AnimationLoadJob {
  readonly key: string;
  readonly name: string;
  readonly bones: number;
  priority: ModelLoadPriority;
}

interface AnimationFailure {
  readonly attempts: number;
  readonly after: number;
  readonly reload: boolean;
}

type ModelGroupState =
  | { status: "queued" | "active" | "complete" | "missing"; attempts: number; after: number }
  | { status: "deferred" | "failed"; attempts: number; after: number };

const MODEL_LOAD_PRIORITY: Readonly<Record<ModelLoadPriority, number>> = {
  background: 0,
  normal: 1,
  critical: 2,
};

const MODEL_LOAD_CONCURRENCY = 4;
const MODEL_GROUP_LOAD_CONCURRENCY = 4;
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
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || x < MAP_MIN || x > MAP_MAX || y < MAP_MIN || y > MAP_MAX) return undefined;
  const grid = {
    x: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(GRID_CENTER - x / TERRAIN_GRID_SIZE))),
    y: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(GRID_CENTER - y / TERRAIN_GRID_SIZE))),
  };
  return grid.x >= 0 && grid.x < GRID_COUNT && grid.y >= 0 && grid.y < GRID_COUNT ? grid : undefined;
}

/** The clipped 5x5 CPU dependency ring around a player's current terrain tile. */
export function terrainGridDependencyFootprint(x: number, y: number): TerrainGrid[] {
  const center = terrainGrid(x, y);
  if (!center) return [];
  const grids: TerrainGrid[] = [];
  for (let offsetX = -2; offsetX <= 2; offsetX++) {
    for (let offsetY = -2; offsetY <= 2; offsetY++) {
      const gridX = center.x + offsetX;
      const gridY = center.y + offsetY;
      if (gridX >= 0 && gridX < GRID_COUNT && gridY >= 0 && gridY < GRID_COUNT) {
        grids.push({ x: gridX, y: gridY });
      }
    }
  }
  return grids;
}

/**
 * Grid tiles whose closed world-space AABBs intersect a circle. The map has 64 tiles on either
 * axis; the candidate ranges are clamped before the exact circle/AABB check so a circle at a map
 * edge never requests an out-of-range tile, while shared tile edges are not dropped.
 */
export function terrainGridFootprint(x: number, y: number, range: number): TerrainGrid[] {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(range)) return [];
  const radius = Math.max(0, range);
  const outsideX = Math.max(MAP_MIN - x, 0, x - MAP_MAX);
  const outsideY = Math.max(MAP_MIN - y, 0, y - MAP_MAX);
  if (outsideX * outsideX + outsideY * outsideY > radius * radius) return [];

  // Include one index on either side of each extent so a circle tangent to a shared tile edge is
  // considered by both tiles despite floating-point boundaries in the grid calculation.
  const minGridX = Math.max(0, Math.min(GRID_COUNT - 1,
    Math.floor(GRID_CENTER - (x + radius) / TERRAIN_GRID_SIZE) - 1));
  const maxGridX = Math.min(GRID_COUNT - 1, Math.max(0,
    Math.floor(GRID_CENTER - (x - radius) / TERRAIN_GRID_SIZE) + 1));
  const minGridY = Math.max(0, Math.min(GRID_COUNT - 1,
    Math.floor(GRID_CENTER - (y + radius) / TERRAIN_GRID_SIZE) - 1));
  const maxGridY = Math.min(GRID_COUNT - 1, Math.max(0,
    Math.floor(GRID_CENTER - (y - radius) / TERRAIN_GRID_SIZE) + 1));
  const radiusSquared = radius * radius;
  const grids: TerrainGrid[] = [];
  for (let gridX = minGridX; gridX <= maxGridX; gridX++) {
    const minX = (GRID_CENTER - gridX - 1) * TERRAIN_GRID_SIZE;
    const maxX = (GRID_CENTER - gridX) * TERRAIN_GRID_SIZE;
    const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
    for (let gridY = minGridY; gridY <= maxGridY; gridY++) {
      const minY = (GRID_CENTER - gridY - 1) * TERRAIN_GRID_SIZE;
      const maxY = (GRID_CENTER - gridY) * TERRAIN_GRID_SIZE;
      const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
      if (dx * dx + dy * dy <= radiusSquared) grids.push({ x: gridX, y: gridY });
    }
  }
  return grids;
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

  /** Exact size of the retained source payload backing this parsed tile. */
  get byteLength(): number {
    return this.#view.byteLength;
  }

  /** Contributes the exact retained map payload without exposing the mutable DataView itself. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    visitor.referenceCpu(this, this.#view);
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
  readonly #tileLimit: number;
  readonly #tiles = new Map<string, TerrainTile | null>();
  readonly #loading = new Set<string>();
  readonly #tileRevisions = new Map<string, number>();
  #activeTiles = new Set<string>();
  #activeTilesTracked = false;
  #revision = 0;

  constructor(gatewayWebSocketUrl: string, tileLimit: number = TERRAIN_TILE_CACHE_LIMIT) {
    if (!Number.isSafeInteger(tileLimit) || tileLimit <= 0) {
      throw new RangeError("Terrain tile cache limit must be a positive safe integer");
    }
    this.#baseUrl = gatewayBaseUrl(gatewayWebSocketUrl);
    this.#tileLimit = tileLimit;
  }

  get stats(): TerrainStats {
    let resident = 0;
    let failed = 0;
    let typedPayloadBytes = 0;
    for (const tile of this.#tiles.values()) {
      if (tile === null) {
        failed++;
      } else {
        resident++;
        typedPayloadBytes += tile.byteLength;
      }
    }
    return Object.freeze({
      resident,
      failed,
      active: this.#loading.size,
      typedPayloadBytes,
    });
  }

  /** Adds every resident tile payload to one capture-wide identity ledger. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const tile of this.#tiles.values()) tile?.visitRetainedResources(visitor);
  }

  get revision(): number {
    return this.#revision;
  }

  /** Replaces the CPU tiles protected by the renderer's current terrain dependency footprint. */
  setActiveTiles(map: number | undefined, grids: Iterable<TerrainGrid>): void {
    this.#activeTilesTracked = true;
    const active = new Set<string>();
    if (map !== undefined) {
      for (const grid of grids) {
        if (!Number.isSafeInteger(grid.x) || grid.x < 0 || grid.x >= GRID_COUNT
          || !Number.isSafeInteger(grid.y) || grid.y < 0 || grid.y >= GRID_COUNT) continue;
        active.add(`${map}/${grid.x}/${grid.y}`);
      }
    }
    this.#activeTiles = active;
    for (const key of active) this.#touchTile(key);
    this.#evictTiles();
  }

  /** How many times this tile alone changed: this replaces its interior and reopens its holes. */
  ownRevision(map: number, grid: TerrainGrid): number {
    return this.#tileRevisions.get(`${map}/${grid.x}/${grid.y}`) ?? 0;
  }

  /**
   * How many times this tile — or a tile whose ground/liquid corners it borrows — has changed.
   *
   * All eight neighbours, not just the four sides. Terrain normals borrow the cardinal skirt and a
   * shared far-edge endpoint is canonically owned by the diagonal tile; water corner smoothing also
   * reads that diagonal cell. Leaving diagonals out means a late corner tile can arrive without
   * replacing the edge position/normal or the water surface that sampled it as missing.
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
    const tile = this.#tile(key);
    if (tile !== undefined) return tile?.heightAt(x, y);
    if (!this.#loading.has(key)) {
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
    if (this.#tiles.has(key)) {
      this.#touchTile(key);
      return true;
    }
    // Keep this method useful as the one readiness probe: asking it is enough to start the fetch.
    this.heightAt(map, x, y);
    return false;
  }

  isHole(map: number | undefined, x: number, y: number): boolean {
    if (map === undefined) return false;
    const grid = terrainGrid(x, y);
    if (!grid) return false;
    return this.#tile(`${map}/${grid.x}/${grid.y}`)?.isHole(x, y) ?? false;
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
    return this.#tile(`${map}/${grid.x}/${grid.y}`)?.areaAt(x, y);
  }

  liquidAt(map: number | undefined, x: number, y: number): { height: number; type: number; entry: number; cells: boolean } | undefined {
    if (map === undefined) return undefined;
    const grid = terrainGrid(x, y);
    if (!grid) return undefined;
    return this.#tile(`${map}/${grid.x}/${grid.y}`)?.liquidAt(x, y);
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
    // Reinsert at the newest end and enforce the bound here: an old request can resolve after the
    // renderer has moved its pins, and must not be allowed to displace their completed payloads.
    this.#tiles.delete(key);
    this.#tiles.set(key, tile);
    this.#revision++;
    this.#tileRevisions.set(key, this.#revision);
    this.#evictTiles();
  }

  /** Return and LRU-touch one completed answer, including a terminal null. */
  #tile(key: string): TerrainTile | null | undefined {
    if (!this.#tiles.has(key)) return undefined;
    const tile = this.#tiles.get(key)!;
    this.#tiles.delete(key);
    this.#tiles.set(key, tile);
    return tile;
  }

  #touchTile(key: string): void {
    if (this.#tiles.has(key)) this.#tile(key);
  }

  #deleteTile(key: string): void {
    this.#tiles.delete(key);
    this.#tileRevisions.delete(key);
  }

  #evictTiles(): void {
    // A null is a retryable degraded answer, not useful residency. Before active tracking starts,
    // retain it for the standalone readiness contract; afterwards keep it only while the current
    // renderer footprint needs its readiness answer, even when the ordinary cap is not full.
    for (const [key, tile] of this.#tiles) {
      if (tile === null && this.#activeTilesTracked && !this.#activeTiles.has(key)) this.#deleteTile(key);
    }
    for (const key of this.#tiles.keys()) {
      if (this.#tiles.size <= this.#tileLimit) break;
      if (this.#activeTiles.has(key)) continue;
      this.#deleteTile(key);
    }
  }
}

export class EnvironmentClient {
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #tileLimit: number;
  readonly #modelLimit: number;
  readonly #animationLimit: number;
  readonly #modelTypedBackingBudget: number;
  readonly #modelNumericArrayBudget: number;
  readonly #animationTypedBackingBudget: number;
  readonly #modelEntryTypedBackingLimit: number;
  readonly #modelEntryNumericArrayLimit: number;
  readonly #animationEntryTypedBackingLimit: number;
  readonly #visualModelResponseLimit: number;
  readonly #modelGroupResponseLimit: number;
  readonly #animationResponseLimit: number;
  readonly #collisionHullResponseLimit: number;
  readonly #tiles = new Map<string, EnvironmentObject[] | null>();
  readonly #knownMissingTiles = new Set<string>();
  readonly #failedTiles = new Set<string>();
  readonly #loading = new Set<string>();
  /** Keys in the exact footprint most recently requested by `objectsAround`. */
  #activeTiles = new Set<string>();
  readonly #models = new Map<string, EnvironmentModel | null>();
  /** Terminal decoded/source-limit failures cached separately from genuine archive absence. */
  readonly #failedModelEntries = new Set<string>();
  readonly #animations = new Map<string, WvmSkeletonClip[] | null>();
  readonly #modelCosts = new Map<string, DecodedResidencyCost>();
  readonly #animationCosts = new Map<string, DecodedResidencyCost>();
  #modelTypedBackingBytes = 0;
  #modelNumericArrayElements = 0;
  #animationTypedBackingBytes = 0;
  #animationNumericArrayElements = 0;
  #resourceFrameOpen = false;
  #frameModelKeys = new Set<string>();
  #frameAnimationKeys = new Set<string>();
  /** Exact WMO group demands made by the currently open frame, keyed by decoded parent identity. */
  #frameGroupDemands = new Map<EnvironmentModel, Set<number>>();
  #activeModelKeys = new Set<string>();
  #activeAnimationKeys = new Set<string>();
  /** Exact WMO group demands committed by the most recent frame. */
  #activeGroupDemands = new Map<EnvironmentModel, Set<number>>();
  /** Queued sidecars, ordered FIFO among equal priorities. */
  readonly #animationQueue = new Map<string, AnimationLoadJob>();
  readonly #animationInflight = new Map<string, AnimationLoadJob>();
  readonly #animationFailures = new Map<string, AnimationFailure>();
  #animationDrainScheduled = false;
  #activeAnimations = 0;
  /** Queued, but not active, models. Map order is FIFO among entries of equal priority. */
  readonly #modelQueue = new Map<string, ModelLoadPriority>();
  readonly #requestedModels = new Set<string>();
  readonly #groupQueue: Array<{ name: string; group: number; model: EnvironmentModel }> = [];
  #requestedGroups = new WeakMap<EnvironmentModel, Map<number, ModelGroupState>>();
  #deferredGroups = 0;
  #failedGroups = 0;
  #activeGroups = 0;
  #activeModels = 0;
  #backgroundReservationStartedAt: number | undefined;
  #backgroundReservationReleased = false;
  #backgroundReservationTimer: ReturnType<typeof setTimeout> | undefined;
  #modelDrainScheduled = false;
  #generation = 0;
  #objectsKey = "";
  #objectsCache: EnvironmentObject[] = [];
  #resourceFrameCommitted = false;
  #disposed = false;
  readonly #loadControllers = new Set<AbortController>();
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
  constructor(
    gatewayWebSocketUrl: string,
    now: () => number = Date.now,
    tileLimit: number = ENVIRONMENT_TILE_CACHE_LIMIT,
    modelLimit: number = ENVIRONMENT_MODEL_CACHE_LIMIT,
    animationLimit: number = ENVIRONMENT_ANIMATION_CACHE_LIMIT,
    budgets: EnvironmentResidencyBudgetOptions = {},
  ) {
    if (!Number.isSafeInteger(tileLimit) || tileLimit <= 0) {
      throw new RangeError("Environment tile cache limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(modelLimit) || modelLimit <= 0) {
      throw new RangeError("Environment model cache limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(animationLimit) || animationLimit <= 0) {
      throw new RangeError("Environment animation cache limit must be a positive safe integer");
    }
    const resolvedBudgets = {
      modelTypedBackingBytes: budgets.modelTypedBackingBytes ?? ENVIRONMENT_MODEL_TYPED_BACKING_BUDGET_BYTES,
      modelNumericArrayElements: budgets.modelNumericArrayElements ?? ENVIRONMENT_MODEL_NUMERIC_ARRAY_BUDGET_ELEMENTS,
      animationTypedBackingBytes: budgets.animationTypedBackingBytes ?? ENVIRONMENT_ANIMATION_TYPED_BACKING_BUDGET_BYTES,
      modelEntryTypedBackingBytes: budgets.modelEntryTypedBackingBytes ?? ENVIRONMENT_MODEL_ENTRY_TYPED_BACKING_LIMIT_BYTES,
      modelEntryNumericArrayElements: budgets.modelEntryNumericArrayElements ?? ENVIRONMENT_MODEL_ENTRY_NUMERIC_ARRAY_LIMIT_ELEMENTS,
      animationEntryTypedBackingBytes: budgets.animationEntryTypedBackingBytes ?? ENVIRONMENT_ANIMATION_ENTRY_TYPED_BACKING_LIMIT_BYTES,
      visualModelResponseBytes: budgets.visualModelResponseBytes ?? VISUAL_MODEL_RESPONSE_LIMIT_BYTES,
      modelGroupResponseBytes: budgets.modelGroupResponseBytes ?? WMO_GROUP_RESPONSE_LIMIT_BYTES,
      animationResponseBytes: budgets.animationResponseBytes ?? WVA_ANIMATION_RESPONSE_LIMIT_BYTES,
      collisionHullResponseBytes: budgets.collisionHullResponseBytes ?? COLLISION_HULL_RESPONSE_LIMIT_BYTES,
    };
    for (const [name, limit] of Object.entries(resolvedBudgets)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError(`Environment ${name} must be a positive safe integer`);
      }
    }
    this.#baseUrl = gatewayBaseUrl(gatewayWebSocketUrl);
    this.#now = now;
    this.#tileLimit = tileLimit;
    this.#modelLimit = modelLimit;
    this.#animationLimit = animationLimit;
    this.#modelTypedBackingBudget = resolvedBudgets.modelTypedBackingBytes;
    this.#modelNumericArrayBudget = resolvedBudgets.modelNumericArrayElements;
    this.#animationTypedBackingBudget = resolvedBudgets.animationTypedBackingBytes;
    this.#modelEntryTypedBackingLimit = resolvedBudgets.modelEntryTypedBackingBytes;
    this.#modelEntryNumericArrayLimit = resolvedBudgets.modelEntryNumericArrayElements;
    this.#animationEntryTypedBackingLimit = resolvedBudgets.animationEntryTypedBackingBytes;
    this.#visualModelResponseLimit = resolvedBudgets.visualModelResponseBytes;
    this.#modelGroupResponseLimit = resolvedBudgets.modelGroupResponseBytes;
    this.#animationResponseLimit = resolvedBudgets.animationResponseBytes;
    this.#collisionHullResponseLimit = resolvedBudgets.collisionHullResponseBytes;
  }

  /** Starts one atomic collection of the decoded resources demanded by the live frame. */
  beginResourceFrame(): void {
    if (this.#disposed) return;
    if (this.#resourceFrameOpen) throw new Error("Environment resource frame is already open");
    this.#resourceFrameOpen = true;
    this.#frameModelKeys = new Set();
    this.#frameAnimationKeys = new Set();
    this.#frameGroupDemands = new Map();
  }

  /** Commits the exact frame footprint, then evicts only entries outside that footprint. */
  endResourceFrame(): void {
    if (this.#disposed) return;
    if (!this.#resourceFrameOpen) return;
    this.#resourceFrameOpen = false;
    this.#activeModelKeys = this.#frameModelKeys;
    this.#activeAnimationKeys = this.#frameAnimationKeys;
    this.#activeGroupDemands = this.#frameGroupDemands;
    this.#frameModelKeys = new Set();
    this.#frameAnimationKeys = new Set();
    this.#frameGroupDemands = new Map();
    this.#resourceFrameCommitted = true;
    this.#pruneModelWork();
    this.#pruneGroupWork();
    this.#pruneAnimationWork();
    this.#evictModels();
    this.#evictAnimations();
  }

  /** Relinquishes only this client's references; renderer-owned decoded payloads are not mutated. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const controller of this.#loadControllers) controller.abort();
    this.#loadControllers.clear();
    if (this.#backgroundReservationTimer !== undefined) clearTimeout(this.#backgroundReservationTimer);
    this.#backgroundReservationTimer = undefined;
    this.#resourceFrameOpen = false;
    this.#resourceFrameCommitted = false;
    this.#frameModelKeys.clear();
    this.#frameAnimationKeys.clear();
    this.#frameGroupDemands.clear();
    this.#activeModelKeys.clear();
    this.#activeAnimationKeys.clear();
    this.#activeGroupDemands.clear();
    this.#activeTiles.clear();
    this.#tiles.clear();
    this.#knownMissingTiles.clear();
    this.#failedTiles.clear();
    this.#loading.clear();
    this.#models.clear();
    this.#failedModelEntries.clear();
    this.#animations.clear();
    this.#modelCosts.clear();
    this.#animationCosts.clear();
    this.#modelTypedBackingBytes = 0;
    this.#modelNumericArrayElements = 0;
    this.#animationTypedBackingBytes = 0;
    this.#animationNumericArrayElements = 0;
    this.#modelQueue.clear();
    this.#requestedModels.clear();
    this.#modelFailures.clear();
    this.#groupQueue.length = 0;
    this.#requestedGroups = new WeakMap();
    this.#animationQueue.clear();
    this.#animationInflight.clear();
    this.#animationFailures.clear();
    this.#activeModels = 0;
    this.#activeGroups = 0;
    this.#activeAnimations = 0;
    this.#deferredGroups = 0;
    this.#failedGroups = 0;
    this.#modelDrainScheduled = false;
    this.#animationDrainScheduled = false;
    this.#objectsKey = "";
    this.#objectsCache = [];
    this.onStatus = undefined;
  }

  get stats(): EnvironmentStats {
    let residentTiles = 0;
    const residentObjectIds = new Set<number>();
    for (const tile of this.#tiles.values()) {
      if (tile !== null) {
        residentTiles++;
        for (const object of tile) residentObjectIds.add(object.id);
      }
    }

    let residentModels = 0;
    let knownMissingModels = 0;
    let failedModels = 0;
    for (const [key, model] of this.#models) {
      if (model === null && this.#failedModelEntries.has(key)) {
        if (!this.#resourceFrameCommitted || this.#activeModelKeys.has(key)) failedModels++;
      } else if (model === null) knownMissingModels++;
      else residentModels++;
    }
    let deferredModels = 0;
    for (const [key, { after }] of this.#modelFailures) {
      // A retry keeps its prior failure record while it is queued or active. The request ledger
      // is the authoritative ownership bit for that state, so don't report it as deferred/failed
      // at the same time as a live model job.
      if (this.#requestedModels.has(key)) continue;
      if (after === Number.POSITIVE_INFINITY) failedModels++;
      else deferredModels++;
    }

    let residentAnimations = 0;
    let failedAnimations = 0;
    for (const [key, animation] of this.#animations) {
      // Before the first committed frame there is no authoritative footprint, so preserve the
      // standalone diagnostic behavior. Once tracking is active, only a terminal null that was
      // touched by the exact current frame may block readiness; an old scene's cached failure is
      // retained for cheap re-entry but must not poison a different scene.
      if (animation === null && (!this.#resourceFrameCommitted || this.#activeAnimationKeys.has(key))) {
        failedAnimations++;
      } else if (animation !== null) {
        residentAnimations++;
      }
    }

    return Object.freeze({
      residentTiles,
      knownMissingTiles: this.#knownMissingTiles.size,
      failedTiles: this.#failedTiles.size,
      activeTiles: this.#loading.size,
      residentObjects: residentObjectIds.size,
      residentModels,
      knownMissingModels,
      deferredModels,
      failedModels,
      queuedModels: this.#modelQueue.size,
      activeModels: this.#activeModels,
      ...this.#groupStats(),
      residentAnimations,
      failedAnimations,
      deferredAnimations: this.#deferredAnimationCount(),
      queuedAnimations: this.#animationQueue.size,
      activeAnimations: this.#activeAnimations,
      modelDecodedTypedBackingBytes: this.#modelTypedBackingBytes,
      modelDecodedNumericArrayElements: this.#modelNumericArrayElements,
      modelDecodedTypedBackingOverflowBytes: Math.max(
        0,
        this.#modelTypedBackingBytes - this.#modelTypedBackingBudget,
      ),
      modelDecodedNumericArrayOverflowElements: Math.max(
        0,
        this.#modelNumericArrayElements - this.#modelNumericArrayBudget,
      ),
      animationDecodedTypedBackingBytes: this.#animationTypedBackingBytes,
      animationDecodedNumericArrayElements: this.#animationNumericArrayElements,
      animationDecodedTypedBackingOverflowBytes: Math.max(
        0,
        this.#animationTypedBackingBytes - this.#animationTypedBackingBudget,
      ),
    });
  }

  /** Adds only successful model/animation cache payloads, without inventing sizes for JS arrays. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const model of this.#models.values()) {
      if (model !== null) visitArrayBufferViewLeaves(model, model, visitor);
    }
    for (const animations of this.#animations.values()) {
      if (animations !== null) visitArrayBufferViewLeaves(animations, animations, visitor);
    }
  }

  /**
   * Called once per frame by both renderers, so the merged result is cached. It only has to be
   * rebuilt when the player walks into a different set of tiles or another tile finishes loading.
   */
  objectsAround(map: number | undefined, x: number, y: number, range: number = ENVIRONMENT_RANGE): EnvironmentObject[] {
    if (this.#disposed) return [];
    if (map === undefined) {
      this.#activeTiles = new Set();
      this.#evictTiles();
      return [];
    }
    const grids = new Map<string, TerrainGrid>();
    for (const grid of terrainGridFootprint(x, y, range)) grids.set(`${grid.x}/${grid.y}`, grid);
    this.#activeTiles = new Set([...grids.keys()].map((grid) => `${map}/${grid}`));

    // A terminal answer is a real cache entry even when it is null (404 or failed fallback). Move
    // every such entry to the back before admitting any new response so the oldest unpinned tile
    // is the one that leaves first.
    for (const key of this.#activeTiles) this.#touchTile(key);
    this.#evictTiles();

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
    if (this.#disposed) return undefined;
    const key = modelKey(name);
    this.#touchModelDemand(key);
    const value = this.#models.get(key);
    if (value) {
      this.#touchModel(key);
      return value;
    }
    if (value === null) {
      this.#touchModel(key);
      return undefined;
    }
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
    if (!this.#enqueueModel(key, priority)) return undefined;
    if (priority !== "critical") this.#startBackgroundReservation();
    this.#scheduleModelDrain();
    return undefined;
  }

  /**
   * The geometry of the WMO groups a big building held back.
   *
   * Asked for once per group of one decoded parent identity. A group whose block never arrives is a room the
   * player sees through, which is bad; a group asked for every frame is a request storm, which is
   * worse. The same rule the collision client follows for the same reason.
   */
  requestModelGroups(name: string, groups: readonly number[]): void {
    if (this.#disposed) return;
    const key = modelKey(name);
    this.#touchModelDemand(key);
    const model = this.#models.get(key);
    if (!model?.wmo) return;
    this.#touchModel(key);
    if (this.#resourceFrameOpen) {
      let demanded = this.#frameGroupDemands.get(model);
      if (!demanded) {
        demanded = new Set<number>();
        this.#frameGroupDemands.set(model, demanded);
      }
      for (const group of groups) {
        if (model.wmo.groups[group] !== undefined) demanded.add(group);
      }
    }
    const missing: number[] = [];
    const seen = new Set<number>();
    for (const group of groups) {
      if (model.wmo.groups[group] === undefined) continue;
      if (seen.has(group)) continue;
      seen.add(group);
      const state = this.#groupState(model, group);
      if (state === undefined) {
        missing.push(group);
      } else if (state.status === "deferred" && this.#now() >= state.after) {
        missing.push(group);
      }
    }
    if (missing.length === 0) return;
    // The queue item deliberately owns the exact decoded parent. Cache eviction can rearm the base
    // key, but queued or in-flight work remains safe and can never mutate that replacement.
    const available = Math.max(0, ENVIRONMENT_MODEL_GROUP_QUEUE_LIMIT - this.#groupQueue.length);
    for (const group of missing.slice(0, available)) {
      const state = this.#groupState(model, group);
      this.#setGroupState(model, group, state?.status === "deferred"
        ? { ...state, status: "queued" }
        : { status: "queued", attempts: 0, after: 0 });
      this.#groupQueue.push({ name, group, model });
    }
    this.#drainGroups();
  }

  /**
   * The animations that did not travel with the model, once something needs one.
   *
   * A character model holds around 1.5 MiB of keyframes and a tenth of that is locomotion, so the
   * rest is a second request rather than a tax on every wolf that walks into view. It travels
   * through a two-lane priority scheduler. Terminal absence is cached per exact rig; transient
   * failures use demand-driven backoff, so this cannot turn into a request per frame.
   */
  animations(name: string, bones: number, priority: ModelLoadPriority = "normal"): WvmSkeletonClip[] | undefined {
    if (this.#disposed) return undefined;
    const key = animationKey(name, bones);
    this.#touchAnimationDemand(key);
    const value = this.#animations.get(key);
    if (value) {
      this.#touchAnimation(key);
      return value;
    }
    if (value === null) {
      this.#touchAnimation(key);
      return undefined;
    }
    const queued = this.#animationQueue.get(key);
    if (queued !== undefined) {
      if (MODEL_LOAD_PRIORITY[priority] > MODEL_LOAD_PRIORITY[queued.priority]) queued.priority = priority;
      this.#scheduleAnimationDrain();
      return undefined;
    }
    if (this.#animationInflight.has(key)) return undefined;
    const failure = this.#animationFailures.get(key);
    if (failure && this.#now() < failure.after) return undefined;
    if (!this.#enqueueAnimation({ key, name, bones, priority })) return undefined;
    this.#scheduleAnimationDrain();
    return undefined;
  }

  /**
   * Whether this exact rig's sidecar is queued or actually being fetched right now.
   *
   * The renderer's action queue needs one fact it could not previously get: the difference between
   * "the keyframes are not here" and "the keyframes are on the wire". Without it an action is
   * dropped on the same terms whether nothing is coming or its own 9.4 MiB download is in
   * progress behind two lanes. Two map lookups; safe to call per frame.
   */
  animationsInFlight(name: string, bones: number): boolean {
    if (this.#disposed) return false;
    const key = animationKey(name, bones);
    return this.#animationQueue.has(key) || this.#animationInflight.has(key);
  }

  async #loadAnimations(job: AnimationLoadJob): Promise<void> {
    const controller = this.#beginLoad();
    if (!controller) return;
    const failure = this.#animationFailures.get(job.key);
    try {
      const response = await fetch(
        visualAnimationsUrl(this.#baseUrl, job.name),
        { signal: controller.signal, ...(failure?.reload ? { cache: "reload" as const } : {}) },
      );
      if (this.#disposed) return;
      if (!response.ok) {
        if (animationHttpFailureIsTerminal(response.status)) {
          this.#completeAnimationFailure(job.key, new Error(`Animation gateway returned ${response.status}`));
          return;
        }
        throw new Error(`Animation gateway returned ${response.status}`);
      }
      const data = await readBoundedResponse(response, this.#animationResponseLimit, "Animation");
      if (this.#disposed) return;
      if (animationRigMismatch(data, job.bones)) {
        this.#completeAnimationFailure(
          job.key,
          new Error(`Animation sidecar does not match the ${job.bones}-bone rig`),
        );
        return;
      }
      let animations: WvmSkeletonClip[];
      try {
        animations = decodeWvaAnimations(data, job.bones);
      } catch (error) {
        this.#deferAnimation(job.key, true);
        this.#statusError(error);
        return;
      }
      this.#animationFailures.delete(job.key);
      this.#storeAnimations(job.key, animations);
    } catch (error) {
      if (this.#disposed) return;
      if (error instanceof DeterministicEnvironmentResourceError) {
        this.#completeAnimationFailure(job.key, error);
      } else {
        this.#deferAnimation(job.key, false);
        this.#statusError(error);
      }
    } finally {
      this.#finishLoad(controller);
    }
  }

  #scheduleAnimationDrain(): void {
    if (this.#disposed || this.#animationDrainScheduled) return;
    this.#animationDrainScheduled = true;
    queueMicrotask(() => {
      if (this.#disposed) return;
      this.#animationDrainScheduled = false;
      this.#drainAnimations();
    });
  }

  #drainAnimations(): void {
    if (this.#disposed) return;
    while (this.#activeAnimations < ENVIRONMENT_ANIMATION_LOAD_CONCURRENCY) {
      const job = this.#nextAnimation();
      if (!job) return;
      this.#animationInflight.set(job.key, job);
      this.#activeAnimations++;
      void this.#loadAnimations(job).finally(() => {
        if (this.#disposed) return;
        this.#animationInflight.delete(job.key);
        this.#activeAnimations--;
        this.#pruneAnimationFailures();
        this.#scheduleAnimationDrain();
      });
    }
  }

  #enqueueAnimation(job: AnimationLoadJob): boolean {
    if (this.#animationQueue.size >= ENVIRONMENT_ANIMATION_QUEUE_LIMIT) {
      let evicted: string | undefined;
      let evictedPriority = Number.POSITIVE_INFINITY;
      for (const [key, queued] of this.#animationQueue) {
        const rank = MODEL_LOAD_PRIORITY[queued.priority];
        if (rank < evictedPriority) {
          evicted = key;
          evictedPriority = rank;
        }
      }
      if (evicted === undefined || MODEL_LOAD_PRIORITY[job.priority] <= evictedPriority) return false;
      this.#animationQueue.delete(evicted);
    }
    this.#animationQueue.set(job.key, job);
    return true;
  }

  #nextAnimation(): AnimationLoadJob | undefined {
    let selected: AnimationLoadJob | undefined;
    let selectedPriority = -1;
    for (const job of this.#animationQueue.values()) {
      const rank = MODEL_LOAD_PRIORITY[job.priority];
      if (rank <= selectedPriority) continue;
      selected = job;
      selectedPriority = rank;
    }
    if (!selected) return undefined;
    this.#animationQueue.delete(selected.key);
    return selected;
  }

  #completeAnimationFailure(key: string, error: unknown): void {
    if (this.#disposed) return;
    this.#animationFailures.delete(key);
    this.#storeAnimations(key, null);
    this.#statusError(error);
  }

  #deferAnimation(key: string, reload: boolean): void {
    if (this.#disposed) return;
    const previous = this.#animationFailures.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const wait = IMAGE_RETRY_BACKOFF_MS[attempts - 1];
    const demandedByCurrentFrame = this.#resourceFrameOpen
      ? this.#activeAnimationKeys.has(key) || this.#frameAnimationKeys.has(key)
      : this.#activeAnimationKeys.has(key);
    if (this.#resourceFrameCommitted && !demandedByCurrentFrame) {
      this.#animationFailures.delete(key);
      return;
    }
    if (wait === undefined) {
      this.#animationFailures.delete(key);
      this.#storeAnimations(key, null);
      return;
    }
    this.#animationFailures.delete(key);
    this.#animationFailures.set(key, {
      attempts,
      after: this.#now() + wait,
      reload: reload || previous?.reload === true,
    });
    this.#pruneAnimationFailures();
  }

  /** Let every `model()` call in this JavaScript turn enter the priority queue first. */
  #scheduleModelDrain(): void {
    if (this.#disposed || this.#modelDrainScheduled) return;
    this.#modelDrainScheduled = true;
    queueMicrotask(() => {
      if (this.#disposed) return;
      this.#modelDrainScheduled = false;
      this.#drainModels();
    });
  }

  #drainModels(): void {
    if (this.#disposed) return;
    while (this.#activeModels < MODEL_LOAD_CONCURRENCY) {
      const criticalOnly = this.#backgroundReservationActive()
        && this.#activeModels >= MODEL_LOAD_CONCURRENCY - 1;
      const wanted = this.#nextModel(criticalOnly);
      if (wanted === undefined) return;
      if (wanted.priority === "critical") this.#releaseBackgroundReservation();
      this.#activeModels++;
      void this.#loadModel(wanted.name).finally(() => {
        if (this.#disposed) return;
        this.#activeModels--;
        this.#scheduleModelDrain();
      });
    }
  }

  /** Admit one queued request, letting a more urgent path displace the oldest lower-priority work. */
  #enqueueModel(key: string, priority: ModelLoadPriority): boolean {
    if (this.#modelQueue.size >= ENVIRONMENT_MODEL_QUEUE_LIMIT) {
      let evicted: string | undefined;
      let evictedPriority = Number.POSITIVE_INFINITY;
      for (const [queuedKey, queuedPriority] of this.#modelQueue) {
        const rank = MODEL_LOAD_PRIORITY[queuedPriority];
        if (rank < evictedPriority) {
          evicted = queuedKey;
          evictedPriority = rank;
        }
      }
      if (evicted === undefined || MODEL_LOAD_PRIORITY[priority] <= evictedPriority) return false;
      this.#modelQueue.delete(evicted);
      this.#requestedModels.delete(evicted);
    }
    this.#requestedModels.add(key);
    this.#modelQueue.set(key, priority);
    return true;
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
    if (this.#disposed) return;
    while (this.#activeGroups < MODEL_GROUP_LOAD_CONCURRENCY) {
      const wanted = this.#groupQueue.shift();
      if (!wanted) return;
      this.#setGroupState(wanted.model, wanted.group, {
        status: "active",
        attempts: this.#groupState(wanted.model, wanted.group)?.attempts ?? 0,
        after: 0,
      });
      this.#activeGroups++;
      void this.#loadGroup(wanted).finally(() => {
        if (this.#disposed) return;
        this.#activeGroups--;
        this.#drainGroups();
      });
    }
  }

  #beginLoad(): AbortController | undefined {
    if (this.#disposed) return undefined;
    const controller = new AbortController();
    this.#loadControllers.add(controller);
    return controller;
  }

  #finishLoad(controller: AbortController): void {
    this.#loadControllers.delete(controller);
  }

  #statusError(error: unknown): void {
    if (this.#disposed) return;
    this.onStatus?.(error instanceof Error ? error.message : String(error), true);
  }

  async #loadGroup(wanted: { name: string; group: number; model: EnvironmentModel }): Promise<void> {
    const controller = this.#beginLoad();
    if (!controller) return;
    try {
      const response = await fetch(
        visualModelUrl(this.#baseUrl, wanted.name, wanted.group),
        { signal: controller.signal },
      );
      if (this.#disposed) return;
      if (!response.ok) {
        if (response.status === 404) {
          if (!this.#isCurrentGroupParent(wanted)) {
            this.#setGroupState(wanted.model, wanted.group, undefined);
            return;
          }
          this.#setGroupState(wanted.model, wanted.group, {
            status: "missing", attempts: this.#groupState(wanted.model, wanted.group)?.attempts ?? 0, after: Infinity,
          });
          return;
        }
        throw new Error(`Visual model gateway returned ${response.status}`);
      }
      const data = await readBoundedResponse(response, this.#modelGroupResponseLimit, "WMO group");
      if (this.#disposed) return;
      const block = decodeWwmGroup(data);
      const group = wanted.model.wmo?.groups[wanted.group];
      // The block says which group it is; a mismatch means a stale artifact, and drawing one
      // room's walls in another room's place is worse than leaving the room empty.
      if (!group || block.index !== wanted.group) {
        throw new Error(`Visual model group ${wanted.group} does not match its parent`);
      }
      if (block.mesh.positions.length / 3 !== group.vertexCount
        || block.mesh.indices.length / 3 !== group.triangleCount) {
        throw new Error(`Visual model group ${wanted.group} counts disagree with its parent`);
      }
      const nextCost = decodedResidencyCost([wanted.model, block.mesh]);
      const limitError = decodedEntryLimitError(
        "model",
        nextCost,
        this.#modelEntryTypedBackingLimit,
        this.#modelEntryNumericArrayLimit,
      );
      if (limitError) throw limitError;
      group.mesh = block.mesh;
      if (this.#isCurrentGroupParent(wanted)) {
        this.#replaceCurrentModelCost(modelKey(wanted.name), wanted.model, nextCost);
        this.#setGroupState(wanted.model, wanted.group, {
          status: "complete", attempts: this.#groupState(wanted.model, wanted.group)?.attempts ?? 0, after: Infinity,
        });
      } else this.#setGroupState(wanted.model, wanted.group, undefined);
    } catch (error) {
      if (this.#disposed) return;
      if (this.#isCurrentGroupParent(wanted)) {
        if (error instanceof DeterministicEnvironmentResourceError) {
          const previous = this.#groupState(wanted.model, wanted.group);
          this.#setGroupState(wanted.model, wanted.group, {
            status: "failed",
            attempts: previous?.attempts ?? 0,
            after: Infinity,
          });
        } else this.#deferGroup(wanted);
      } else this.#setGroupState(wanted.model, wanted.group, undefined);
      this.#statusError(error);
    } finally {
      this.#finishLoad(controller);
    }
  }

  #isCurrentGroupParent(wanted: { name: string; model: EnvironmentModel }): boolean {
    return this.#models.get(modelKey(wanted.name)) === wanted.model;
  }

  #deferGroup(wanted: { name: string; group: number; model: EnvironmentModel }): void {
    const previous = this.#groupState(wanted.model, wanted.group);
    const attempts = (previous?.attempts ?? 0) + 1;
    const wait = IMAGE_RETRY_BACKOFF_MS[attempts - 1];
    this.#setGroupState(wanted.model, wanted.group, {
      status: wait === undefined ? "failed" : "deferred",
      attempts,
      after: wait === undefined ? Infinity : this.#now() + wait,
    });
  }

  async #loadModel(key: string): Promise<void> {
    const controller = this.#beginLoad();
    if (!controller) return;
    const separator = key.indexOf("|");
    const name = separator < 0 ? key : key.slice(0, separator);
    try {
      const response = await fetch(
        visualModelUrl(this.#baseUrl, name),
        { signal: controller.signal },
      );
      if (this.#disposed) return;
      if (response.ok) {
        const data = await readBoundedResponse(response, this.#visualModelResponseLimit, "Visual model");
        if (this.#disposed) return;
        this.#storeModel(key, decodeVisualModel(data, this.#baseUrl));
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
        const hull = await fetch(
          `${this.#baseUrl}/environment/model/${encodeURIComponent(basename)}`,
          { signal: controller.signal },
        );
        if (this.#disposed) return;
        // The server's own collision hull, and it is no longer drawn: `drawableModel` in the
        // renderer refuses anything carrying no `visual` flag, because painting Orgrimmar's shell
        // — 379,079 triangles, 7.6 MiB, flat tan — is not painting Orgrimmar. What it still does
        // is answer the question: a placement whose model resolved to a hull stops showing a
        // stand-in that is not on its way to becoming anything.
        if (hull.ok) {
          const data = await readBoundedResponse(hull, this.#collisionHullResponseLimit, "Collision hull");
          if (this.#disposed) return;
          this.#storeModel(key, decodeEnvironmentModel(data));
        }
        else if (hull.status !== 404) throw new Error(`Environment model fallback returned ${hull.status}`);
        // The client simply does not ship this model; the placement keeps its stand-in, or, for a
        // building, nothing at all. Counted so a wave of them shows up in diagnostics instead of
        // passing unnoticed.
        else this.#storeModel(key, null);
        this.#modelFailures.delete(key);
        this.#report();
        return;
      }
      throw new Error(`Visual model gateway returned ${response.status}`);
    } catch (error) {
      if (this.#disposed) return;
      if (error instanceof DeterministicEnvironmentResourceError) this.#failModelTerminal(key);
      else this.#deferModel(key);
      this.#statusError(error);
    } finally {
      this.#finishLoad(controller);
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
    const demandedByCurrentFrame = this.#resourceFrameOpen
      ? this.#frameModelKeys.has(key)
      : this.#activeModelKeys.has(key);
    if (this.#resourceFrameCommitted && !demandedByCurrentFrame) {
      // A request that finishes after the renderer has moved on must not leave a retry ledger for
      // an unbounded stream of old scenery. Re-entry will make a fresh demand-driven request.
      this.#modelFailures.delete(key);
      return;
    }
    this.#modelFailures.set(key, {
      attempts: attempt,
      after: wait === undefined ? Infinity : this.#now() + wait,
    });
  }

  /** Records a deterministic failure for this exact cache identity without scheduling retries. */
  #failModelTerminal(key: string): void {
    this.#requestedModels.delete(key);
    this.#modelFailures.delete(key);
    this.#storeModel(key, null, "failed");
  }

  /** Commit-frame cleanup for queued work and retry records that are no longer in the exact view. */
  #pruneModelWork(): void {
    for (const key of this.#modelQueue.keys()) {
      if (this.#activeModelKeys.has(key)) continue;
      this.#modelQueue.delete(key);
      this.#requestedModels.delete(key);
    }
    for (const key of this.#modelFailures.keys()) {
      if (!this.#activeModelKeys.has(key)) this.#modelFailures.delete(key);
    }
  }

  /** Commit-frame cleanup for queued group requests outside the exact cached WMO/group footprint. */
  #pruneGroupWork(): void {
    for (let index = this.#groupQueue.length - 1; index >= 0; index--) {
      const wanted = this.#groupQueue[index]!;
      if (this.#isActiveGroupDemand(wanted)) continue;
      this.#groupQueue.splice(index, 1);
      const state = this.#groupState(wanted.model, wanted.group);
      if (state?.status === "queued") {
        this.#setGroupState(wanted.model, wanted.group,
          state.attempts > 0 ? { ...state, status: "deferred" } : undefined);
      }
    }
  }

  /** Commit-frame cleanup for queued sidecars and retry ledgers outside the exact rig footprint. */
  #pruneAnimationWork(): void {
    for (const key of this.#animationQueue.keys()) {
      if (this.#activeAnimationKeys.has(key)) continue;
      this.#animationQueue.delete(key);
    }
    for (const key of this.#animationFailures.keys()) {
      if (!this.#activeAnimationKeys.has(key)) this.#animationFailures.delete(key);
    }
  }

  #pruneAnimationFailures(): void {
    const protectedKeys = new Set(this.#activeAnimationKeys);
    if (this.#resourceFrameOpen) {
      for (const key of this.#frameAnimationKeys) protectedKeys.add(key);
    }
    const capacity = Math.max(this.#animationLimit, protectedKeys.size);
    for (const key of this.#animationFailures.keys()) {
      if (this.#animationFailures.size <= capacity) return;
      if (protectedKeys.has(key)) continue;
      if (this.#animationQueue.has(key) || this.#animationInflight.has(key)) continue;
      this.#animationFailures.delete(key);
    }
  }

  #deferredAnimationCount(): number {
    let count = 0;
    for (const key of this.#animationFailures.keys()) {
      if (this.#animationQueue.has(key) || this.#animationInflight.has(key)) continue;
      count++;
    }
    return count;
  }

  #groupStats(): Pick<EnvironmentStats, "queuedGroups" | "activeGroups" | "deferredGroups" | "failedGroups"> {
    if (!this.#resourceFrameCommitted) {
      return {
        queuedGroups: this.#groupQueue.length,
        activeGroups: this.#activeGroups,
        deferredGroups: this.#deferredGroups,
        failedGroups: this.#failedGroups,
      };
    }
    const stats = { queuedGroups: 0, activeGroups: this.#activeGroups, deferredGroups: 0, failedGroups: 0 };
    for (const key of this.#activeModelKeys) {
      const model = this.#models.get(key);
      if (!model) continue;
      const states = this.#requestedGroups.get(model);
      const demanded = this.#activeGroupDemands.get(model);
      if (!states || !demanded) continue;
      for (const group of demanded) {
        const state = states.get(group);
        if (!state) continue;
        if (state.status === "queued") stats.queuedGroups++;
        if (state.status === "deferred") stats.deferredGroups++;
        if (state.status === "failed") stats.failedGroups++;
      }
    }
    return stats;
  }

  #isActiveGroupDemand(wanted: { name: string; group: number; model: EnvironmentModel }): boolean {
    const key = modelKey(wanted.name);
    return this.#activeModelKeys.has(key)
      && this.#models.get(key) === wanted.model
      && this.#activeGroupDemands.get(wanted.model)?.has(wanted.group) === true;
  }

  #groupState(model: EnvironmentModel, group: number): ModelGroupState | undefined {
    return this.#requestedGroups.get(model)?.get(group);
  }

  #setGroupState(model: EnvironmentModel, group: number, state: ModelGroupState | undefined): void {
    let states = this.#requestedGroups.get(model);
    const previous = states?.get(group);
    if (previous?.status === "deferred") this.#deferredGroups--;
    if (previous?.status === "failed") this.#failedGroups--;
    if (state === undefined) {
      states?.delete(group);
      if (states?.size === 0) this.#requestedGroups.delete(model);
      return;
    }
    if (!states) {
      states = new Map();
      this.#requestedGroups.set(model, states);
    }
    states.set(group, state);
    if (state.status === "deferred") this.#deferredGroups++;
    if (state.status === "failed") this.#failedGroups++;
  }

  /** Drop queued/terminal state for an evicted identity; in-flight requests retain their exact parent. */
  #releaseEvictedModelGroups(model: EnvironmentModel): void {
    for (let index = this.#groupQueue.length - 1; index >= 0; index--) {
      const wanted = this.#groupQueue[index];
      if (wanted?.model !== model) continue;
      this.#groupQueue.splice(index, 1);
      this.#setGroupState(model, wanted.group, undefined);
    }
    const states = this.#requestedGroups.get(model);
    if (!states) return;
    // Deferred/terminal/successful records belong to the evicted cache identity too. Only an
    // already active request may retain that parent until its promise settles.
    for (const [group, state] of states) {
      if (state.status !== "active") this.#setGroupState(model, group, undefined);
    }
  }

  #touchModelDemand(key: string): void {
    if (this.#resourceFrameOpen) this.#frameModelKeys.add(key);
  }

  #touchAnimationDemand(key: string): void {
    if (this.#resourceFrameOpen) this.#frameAnimationKeys.add(key);
  }

  #touchModel(key: string): void {
    if (!this.#models.has(key)) return;
    const value = this.#models.get(key)!;
    this.#models.delete(key);
    this.#models.set(key, value);
  }

  #touchAnimation(key: string): void {
    if (!this.#animations.has(key)) return;
    const value = this.#animations.get(key)!;
    this.#animations.delete(key);
    this.#animations.set(key, value);
  }

  #storeModel(key: string, value: EnvironmentModel | null, outcome: "resident" | "missing" | "failed" = value === null ? "missing" : "resident"): void {
    if (this.#disposed) return;
    const cost = value === null ? undefined : decodedResidencyCost(value);
    if (cost) {
      const error = decodedEntryLimitError(
        "model",
        cost,
        this.#modelEntryTypedBackingLimit,
        this.#modelEntryNumericArrayLimit,
      );
      if (error) throw error;
    }
    this.#deleteModelEntry(key);
    this.#models.set(key, value);
    if (outcome === "failed") this.#failedModelEntries.add(key);
    if (cost) {
      this.#modelCosts.set(key, cost);
      this.#modelTypedBackingBytes += cost.typedBackingBytes;
      this.#modelNumericArrayElements += cost.numericArrayElements;
    }
    if (!this.#resourceFrameOpen) this.#evictModels();
  }

  #storeAnimations(key: string, value: WvmSkeletonClip[] | null): void {
    if (this.#disposed) return;
    const cost = value === null ? undefined : decodedResidencyCost(value);
    if (cost) {
      const error = decodedEntryLimitError(
        "animation",
        cost,
        this.#animationEntryTypedBackingLimit,
      );
      if (error) throw error;
    }
    this.#deleteAnimationEntry(key);
    this.#animations.set(key, value);
    if (cost) {
      this.#animationCosts.set(key, cost);
      this.#animationTypedBackingBytes += cost.typedBackingBytes;
      this.#animationNumericArrayElements += cost.numericArrayElements;
    }
    if (!this.#resourceFrameOpen) this.#evictAnimations();
  }

  #replaceCurrentModelCost(key: string, model: EnvironmentModel, cost: DecodedResidencyCost): void {
    if (this.#models.get(key) !== model) return;
    const previous = this.#modelCosts.get(key);
    if (previous) {
      this.#modelTypedBackingBytes -= previous.typedBackingBytes;
      this.#modelNumericArrayElements -= previous.numericArrayElements;
    }
    this.#modelCosts.set(key, cost);
    this.#modelTypedBackingBytes += cost.typedBackingBytes;
    this.#modelNumericArrayElements += cost.numericArrayElements;
    if (!this.#resourceFrameOpen) this.#evictModels();
  }

  #deleteModelEntry(key: string): EnvironmentModel | null | undefined {
    if (!this.#models.has(key)) return undefined;
    const model = this.#models.get(key)!;
    this.#models.delete(key);
    this.#failedModelEntries.delete(key);
    const cost = this.#modelCosts.get(key);
    if (cost) {
      this.#modelCosts.delete(key);
      this.#modelTypedBackingBytes -= cost.typedBackingBytes;
      this.#modelNumericArrayElements -= cost.numericArrayElements;
    }
    return model;
  }

  #deleteAnimationEntry(key: string): void {
    this.#animations.delete(key);
    const cost = this.#animationCosts.get(key);
    if (!cost) return;
    this.#animationCosts.delete(key);
    this.#animationTypedBackingBytes -= cost.typedBackingBytes;
    this.#animationNumericArrayElements -= cost.numericArrayElements;
  }

  #evictModels(): void {
    while (this.#models.size > this.#modelLimit
      || this.#modelTypedBackingBytes > this.#modelTypedBackingBudget
      || this.#modelNumericArrayElements > this.#modelNumericArrayBudget) {
      let removed = false;
      for (const key of this.#models.keys()) {
        if (this.#activeModelKeys.has(key)) continue;
        const model = this.#deleteModelEntry(key);
        this.#requestedModels.delete(key);
        this.#modelFailures.delete(key);
        if (model) this.#releaseEvictedModelGroups(model);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  #evictAnimations(): void {
    while (this.#animations.size > this.#animationLimit
      || this.#animationTypedBackingBytes > this.#animationTypedBackingBudget) {
      let removed = false;
      for (const key of this.#animations.keys()) {
        if (this.#activeAnimationKeys.has(key)) continue;
        this.#deleteAnimationEntry(key);
        this.#animationFailures.delete(key);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  async #load(map: number, grid: TerrainGrid, key: string): Promise<void> {
    const controller = this.#beginLoad();
    if (!controller) return;
    try {
      let response = await fetch(
        `${this.#baseUrl}/visual/environment/${map}/${grid.x}/${grid.y}`,
        { signal: controller.signal },
      );
      if (this.#disposed) return;
      const hadGatewayError = !response.ok && response.status !== 404;
      if (!response.ok) {
        response = await fetch(
          `${this.#baseUrl}/environment/${map}/${grid.x}/${grid.y}`,
          { signal: controller.signal },
        );
        if (this.#disposed) return;
      }
      if (response.status === 404) {
        const knownMissing = !hadGatewayError;
        this.#resolve(key, null, knownMissing ? "known-missing" : "failed");
        this.onStatus?.(
          knownMissing ? `VMAP tile ${key} не найден` : `Environment gateway failed for tile ${key}`,
          !knownMissing,
        );
        return;
      }
      if (!response.ok) throw new Error(`Environment gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (this.#disposed) return;
      if (!Array.isArray(value) || value.length > 10_000 || !value.every(isEnvironmentObject)) {
        throw new Error("Environment gateway returned invalid objects");
      }
      this.#resolve(key, value, "resident");
      const loaded = [...this.#tiles.values()].filter((tile): tile is EnvironmentObject[] => Array.isArray(tile));
      this.onStatus?.(`VMAP tiles: ${loaded.length} · объектов: ${loaded.reduce((sum, tile) => sum + tile.length, 0)}`, false);
    } catch (error) {
      if (this.#disposed) return;
      this.#resolve(key, null, "failed");
      this.#statusError(error);
    } finally {
      this.#finishLoad(controller);
      if (!this.#disposed) this.#loading.delete(key);
    }
  }

  #report(): void {
    if (this.#disposed) return;
    const models = [...this.#models.values()];
    const loaded = models.filter((model): model is EnvironmentModel => model !== null);
    const missing = models.length - loaded.length;
    this.onStatus?.(
      `3D-моделей: ${loaded.length} · visual: ${loaded.filter((model) => model.visual).length}${missing ? ` · нет в клиенте: ${missing}` : ""}`,
      false,
    );
  }

  #resolve(key: string, tile: EnvironmentObject[] | null, outcome: "resident" | "known-missing" | "failed"): void {
    if (this.#disposed) return;
    // Setting a key again moves it to the newest end of the insertion-ordered map. Eviction is
    // repeated here, rather than only in `objectsAround`, because a slow response from an old
    // footprint may arrive after the active pin set has moved on.
    this.#tiles.delete(key);
    this.#tiles.set(key, tile);
    this.#knownMissingTiles.delete(key);
    this.#failedTiles.delete(key);
    if (outcome === "known-missing") this.#knownMissingTiles.add(key);
    else if (outcome === "failed") this.#failedTiles.add(key);
    this.#generation++;
    this.#evictTiles();
  }

  /** Move a completed (including null) answer to the newest end of the LRU. */
  #touchTile(key: string): void {
    if (!this.#tiles.has(key)) return;
    const tile = this.#tiles.get(key)!;
    this.#tiles.delete(key);
    this.#tiles.set(key, tile);
  }

  /** Drop oldest completed, unpinned answers until the configured cap is satisfied. */
  #evictTiles(): void {
    const capacity = Math.max(this.#tileLimit, this.#activeTiles.size);
    let evicted = false;

    // A failed answer is a retryable, transient ledger rather than useful residency. Drop every
    // failed tile as soon as it leaves the active footprint, even when the ordinary cache cap is
    // not full, so a later re-entry can try both gateway routes again.
    for (const key of this.#failedTiles) {
      if (this.#activeTiles.has(key)) continue;
      this.#tiles.delete(key);
      this.#knownMissingTiles.delete(key);
      this.#failedTiles.delete(key);
      evicted = true;
    }

    for (const key of this.#tiles.keys()) {
      if (this.#tiles.size <= capacity) break;
      if (this.#activeTiles.has(key)) continue;
      this.#tiles.delete(key);
      this.#knownMissingTiles.delete(key);
      this.#failedTiles.delete(key);
      evicted = true;
    }
    if (!evicted) return;
    // A cached objects result may have been computed before this eviction. Force the next query to
    // rebuild it, and expose the transition through the same generation used by load completion.
    this.#generation++;
    this.#objectsKey = "";
    this.#objectsCache = [];
  }
}

/** Cache key for one model in one set of textures; matches the query the gateway hashes on. */
export function modelKey(name: string, textures = ""): string {
  return textures ? `${name}|${textures}` : name;
}

/** One sidecar belongs to one exact decoded rig, even when two rigs share the same archive path. */
export function animationKey(name: string, bones: number): string {
  const canonicalPath = name.replaceAll("/", "\\").toLowerCase();
  return `${canonicalPath}\u0000bones:${bones}`;
}

/**
 * Measures only data units JavaScript exposes exactly: unique typed-array backing stores and
 * number-valued slots in ordinary arrays. Object/scalar overhead is deliberately not estimated.
 */
export function decodedResidencyCost(value: unknown): Readonly<DecodedResidencyCost> {
  const seenObjects = new WeakSet<object>();
  const seenBackings = new Set<ArrayBufferLike>();
  let typedBackingBytes = 0;
  let numericArrayElements = 0;
  const visit = (member: unknown): void => {
    if (ArrayBuffer.isView(member)) {
      if (!seenBackings.has(member.buffer)) {
        seenBackings.add(member.buffer);
        typedBackingBytes += member.buffer.byteLength;
      }
      return;
    }
    if (member instanceof ArrayBuffer) {
      if (!seenBackings.has(member)) {
        seenBackings.add(member);
        typedBackingBytes += member.byteLength;
      }
      return;
    }
    if (Array.isArray(member)) {
      if (seenObjects.has(member)) return;
      seenObjects.add(member);
      for (const item of member) {
        if (typeof item === "number") numericArrayElements++;
        else visit(item);
      }
      return;
    }
    if (!isPlainRecord(member) || seenObjects.has(member)) return;
    seenObjects.add(member);
    for (const item of Object.values(member)) visit(item);
  };
  visit(value);
  return Object.freeze({ typedBackingBytes, numericArrayElements });
}

class DeterministicEnvironmentResourceError extends Error {}

function decodedEntryLimitError(
  kind: "model" | "animation",
  cost: DecodedResidencyCost,
  typedLimit: number,
  numericLimit?: number,
): DeterministicEnvironmentResourceError | undefined {
  if (cost.typedBackingBytes > typedLimit) {
    return new DeterministicEnvironmentResourceError(
      `Decoded ${kind} retains ${cost.typedBackingBytes} typed backing bytes; limit is ${typedLimit}`,
    );
  }
  if (numericLimit !== undefined && cost.numericArrayElements > numericLimit) {
    return new DeterministicEnvironmentResourceError(
      `Decoded ${kind} retains ${cost.numericArrayElements} numeric array elements; limit is ${numericLimit}`,
    );
  }
  return undefined;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  label: string,
): Promise<ArrayBuffer> {
  const header = response.headers?.get?.("content-length")?.trim();
  if (header !== undefined && /^[0-9]+$/.test(header) && Number(header) > limit) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already rejected; cancellation is best effort for test/polyfill streams.
    }
    throw new DeterministicEnvironmentResourceError(
      `${label} response declares ${header} bytes; limit is ${limit}`,
    );
  }

  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        length += value.byteLength;
        if (length > limit) {
          try {
            await reader.cancel();
          } catch {
            // Preserve the deterministic size error if the stream refuses cancellation.
          }
          throw new DeterministicEnvironmentResourceError(
            `${label} response exceeded ${limit} bytes while streaming`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined.buffer;
  }

  // Minimal test/polyfill responses often expose only arrayBuffer(). This path still checks the
  // resulting length, although such a polyfill cannot provide bounded allocation while reading.
  const data = await response.arrayBuffer();
  if (data.byteLength > limit) {
    throw new DeterministicEnvironmentResourceError(
      `${label} response contains ${data.byteLength} bytes; limit is ${limit}`,
    );
  }
  return data;
}

function animationHttpFailureIsTerminal(status: number): boolean {
  if (status === 404) return true;
  if (status === 408 || status === 429 || status >= 500) return false;
  return status >= 400 && status < 500;
}

function animationRigMismatch(data: ArrayBuffer, bones: number): boolean {
  if (data.byteLength < 12) return false;
  const bytes = new Uint8Array(data, 0, 4);
  if (bytes[0] !== 0x57 || bytes[1] !== 0x56 || bytes[2] !== 0x41 || bytes[3] !== 0x31) return false;
  const view = new DataView(data);
  if (view.getUint32(4, true) !== data.byteLength) return false;
  return view.getUint16(8, true) !== bones;
}

export function decodeVisualModel(data: ArrayBuffer, baseUrl: string): EnvironmentModel {
  if (data.byteLength < 16) throw new Error("Visual model is truncated");
  const bytes = new Uint8Array(data);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  // A WMO comes as its groups. Which of them carry geometry is the artifact's business, not this
  // one's: a tavern arrives whole, a city arrives as boxes and is asked for a room at a time.
  if (magic === "WWM1" || magic === "WWM2") return { vertices: [], indices: [], visual: true, wmo: decodeWwm(data, baseUrl) };
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
  if (object.tint !== undefined) {
    if (!Array.isArray(object.tint) || object.tint.length !== 4) return false;
    if (!object.tint.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) return false;
  }
  if (object.localLight !== undefined) {
    if (!Array.isArray(object.localLight) || object.localLight.length !== 4) return false;
    if (!object.localLight.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) return false;
  }
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

function visitArrayBufferViewLeaves(
  value: unknown,
  ownerId: object,
  visitor: RetainedResourceVisitor,
  seen = new WeakSet<object>(),
): void {
  if (ArrayBuffer.isView(value)) {
    visitor.referenceCpu(ownerId, value);
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) visitArrayBufferViewLeaves(item, ownerId, visitor, seen);
    return;
  }
  if (!isPlainRecord(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const member of Object.values(value)) visitArrayBufferViewLeaves(member, ownerId, visitor, seen);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

import type { EnvironmentBounds, EnvironmentObject } from "../gateway/VMapProtocol.js";
// The same ladder, from the file that measured it: a model the gateway has to build out of the
// archives fails in exactly the way a body texture does, and two different waits would be two
// numbers to keep in step for no reason.
import { IMAGE_RETRY_BACKOFF_MS } from "./CharacterAtlas.js";
import {
  decodeWvaAnimations, decodeWvm9, visualAnimationsUrl, visualModelUrl, type WvmSkeletonClip,
} from "./Wvm.js";
import { decodeWwm, decodeWwmGroup } from "./WmoModel.js";
import type { RetainedResourceVisitor } from "./ResourceAccounting.js";
import type { EnvironmentModel, ModelChannel, ModelClip, ModelSkeleton } from "../gateway/VMapModel.js";
