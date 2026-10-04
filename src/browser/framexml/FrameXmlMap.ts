import type {
  AreaData, AreaInfo, AreaPoiInfo, DungeonMapInfo, MapAreaInfo, MapOverlayInfo,
} from "../../gateway/AreaMetadata.js";
import { hasMapBounds, worldMapPoint } from "../MinimapGeometry.js";
import {
  WorldMapHierarchy, type AreaWorldMapNode, type WorldMapNode, type WorldMapNodeKey,
} from "../ui/WorldMapHierarchy.js";

/** The physical-map coordinates carried by the world object, not a fabricated map pixel. */
export interface FrameXmlMapLocation {
  readonly mapId: number;
  readonly areaId: number;
  readonly x: number;
  readonly y: number;
  /** World-object facing in radians; the stock arrow texture rotates with the character. */
  readonly orientation?: number;
}

export type FrameXmlMapAreaHit =
  | { readonly status: "loading" | "unavailable" }
  | { readonly status: "ready"; readonly mapArea?: MapAreaInfo };

export interface FrameXmlMapSource {
  /** A session snapshot of the client's 3.3.5 DBC tables; absent until the area endpoint lands. */
  readonly metadata: () => Readonly<AreaData> | undefined;
  readonly location: () => FrameXmlMapLocation | undefined;
  readonly positionOfUnit?: (unit: string) => FrameXmlMapLocation | undefined;
  /** The same authored ZMP used by the native map. A loading or empty ready cell is authoritative. */
  readonly areaAt?: (continent: MapAreaInfo, u: number, v: number) => FrameXmlMapAreaHit;
  /** The player's exploration mask; absent means only raw DBC geometry is available. */
  readonly isExploredArea?: (areaId: number) => boolean | undefined;
  /** Normalized battlefield map pins, when the world session actually supplies them. */
  readonly battlefieldPositions?: () => readonly {
    readonly x: number; readonly y: number; readonly name?: string;
  }[] | undefined;
  /** Explicitly absent (`null`) or server-reported corpse/release pins. */
  readonly corpseLocation?: () => FrameXmlMapLocation | null | undefined;
  readonly deathReleaseLocation?: () => FrameXmlMapLocation | null | undefined;
  /** The active battleground's authored flag/vehicle pins, if the world supplies them. */
  readonly battlefieldFlagPositions?: () => readonly {
    // L17 3.14: the token is nil when the carrier's side is unknown (Wow.exe 0x0054d010).
    readonly x: number; readonly y: number; readonly texture: string | undefined;
  }[] | undefined;
  readonly battlefieldVehicleCount?: () => number | undefined;
  /** L17 3.14: the vehicles GetBattlefieldVehicleInfo lists (Wow.exe 0x00be9f70, at most 40). */
  readonly battlefieldVehicles?: () => readonly FrameXmlBattlefieldVehicle[] | undefined;
  /** L17 3.14: Map.dbc MinimapIconScale of the running battlefield's map (0x00bea564), when known. */
  readonly battlefieldMapIconScale?: () => number | undefined;
}

/** L17 3.14: one in-sight vehicle as GetBattlefieldVehicleInfo (0x0054c4d0) reads it. */
export interface FrameXmlBattlefieldVehicle {
  /** Where the vehicle stands; projected onto the displayed map like the player's own position. */
  readonly location: FrameXmlMapLocation;
  /** The unit's name (0x0072a000). */
  readonly name: string | undefined;
  /** UNIT_FLAG_POSSESSED (UNIT_FIELD_FLAGS byte 3, bit 0). */
  readonly possessed: boolean;
  /** "Drive", "Fly", "Idle", "Airship Horde", "Airship Alliance" by UiLocomotionType; nil without the vehicle flag. */
  readonly type: string | undefined;
  /** The player rides it: the stock maps leave it to the player arrow. */
  readonly isPlayer: boolean;
  readonly alive: boolean;
}

export interface FrameXmlMapPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/**
 * The fewest ticks between two unchanged-selection WORLD_MAP_UPDATEs owed by SetMapToCurrentZone
 * (see `FrameXmlMap.setMapToCurrentZone`). Six frames is 0.1 s at 60 fps, the stock's own
 * BATTLEFIELD_MINIMAP_UPDATE_RATE, the throttle BattlefieldMinimap_OnUpdate meant to apply.
 */
export const FRAMEXML_MAP_REANNOUNCE_TICKS = 6;

type MapValues = readonly (string | number | boolean | undefined)[];
const NOTHING: readonly [] = Object.freeze([]);
const OFF_MAP: readonly [number, number] = Object.freeze([0, 0]);

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The original WorldMapFrame's C API, backed by the same DBC rows as the native canvas map.
 *
 * `WorldMapArea.ID` is not the value returned by `GetCurrentMapAreaID`: the stock Lua subtracts
 * one before passing it to `SetMapByID`, and its Wintergrasp constant is 502 for DBC row 501.
 * Floor indices are a different namespace again: `DefaultDungeonFloor` references a DungeonMap
 * row ID (Dalaran 27), whose `FloorIndex` is the display level (1).
 */
export class FrameXmlMap {
  readonly #source: FrameXmlMapSource;
  #data: Readonly<AreaData> | undefined;
  #hierarchy: WorldMapHierarchy | undefined;
  #areaById = new Map<number, AreaInfo>();
  #mapAreaById = new Map<number, MapAreaInfo>();
  #mapAreaByAreaId = new Map<number, MapAreaInfo>();
  #dungeonById = new Map<number, DungeonMapInfo>();
  #dungeonByMap = new Map<number, DungeonMapInfo[]>();
  #overlaysByArea = new Map<number, MapOverlayInfo[]>();
  #poisByMap = new Map<number, AreaPoiInfo[]>();
  #selectedKey: WorldMapNodeKey | undefined;
  #floor = 0;
  #explicitSelection = false;
  #locationKey = "";
  #revision = 0;
  #sentRevision = -1;
  #pump: FrameXmlMapPump | undefined;
  #wasReady = false;
  /** SetMapToCurrentZone left the selection alone but still owes a WORLD_MAP_UPDATE. */
  #reannouncePending = false;
  /** Ticks since such an owed, unchanged-selection WORLD_MAP_UPDATE last went out. */
  #ticksSinceReannounce = Number.POSITIVE_INFINITY;

  constructor(source: FrameXmlMapSource) {
    this.#source = source;
  }

  attach(pump: FrameXmlMapPump): void {
    this.#pump = pump;
    this.#sentRevision = -1;
    this.#wasReady = false;
  }

  detach(): void {
    this.#pump = undefined;
    this.#sentRevision = -1;
    this.#wasReady = false;
  }

  /** Match client map-update edges without firing an event recursively from a C API call. */
  tick(): void {
    this.#ensureData();
    const location = this.#source.location();
    const key = location ? `${location.mapId}:${location.areaId}` : "";
    if (key !== this.#locationKey) {
      this.#locationKey = key;
      if (!this.#explicitSelection) this.#selectCurrentZone(false);
      this.#revision++;
    }
    // Stock WorldMapButton_OnUpdate dereferences corpse and battleground positions without nil
    // guards. Close a previously usable map when those live coordinates become unresolved (for
    // example, while the server is answering a new corpse query) before the widget's next update.
    // A pending first load has no selected map to announce and must not perturb other listeners.
    if (!this.ready) {
      if (this.#wasReady) this.#pump?.fire("CLOSE_WORLD_MAP");
      this.#wasReady = false;
      this.#sentRevision = this.#revision;
      return;
    }
    if (!this.#wasReady) this.#sentRevision = -1;
    this.#wasReady = true;
    this.#ticksSinceReannounce++;
    if (this.#reannouncePending && this.#sentRevision === this.#revision
      && this.#ticksSinceReannounce >= FRAMEXML_MAP_REANNOUNCE_TICKS) {
      this.#ticksSinceReannounce = 0;
      this.#revision++;
    }
    if (!this.#pump || this.#sentRevision === this.#revision) return;
    this.#sentRevision = this.#revision;
    // Any WORLD_MAP_UPDATE answers an owed one, whatever moved the revision.
    this.#reannouncePending = false;
    this.#pump.fire("WORLD_MAP_UPDATE");
  }

  /** Current selected map node and 1-based floor, useful for host UI synchronization. */
  get selection(): Readonly<{ key: WorldMapNodeKey; floor: number }> {
    const node = this.#node();
    return { key: node?.key ?? "cosmic", floor: this.#floor };
  }

  get ready(): boolean {
    const data = this.#ensureData();
    if (!data || !this.#source.location()
      || this.#source.corpseLocation?.() === undefined
      || this.#source.deathReleaseLocation?.() === undefined) return false;
    return !this.#isBattlegroundMap()
      || (this.#source.battlefieldPositions?.() !== undefined
        && this.#source.battlefieldFlagPositions?.() !== undefined
        && this.#source.battlefieldVehicleCount?.() !== undefined);
  }

  get playerFacing(): number | undefined {
    const angle = this.#source.location()?.orientation;
    return angle !== undefined && Number.isFinite(angle) ? angle : undefined;
  }

  getMapInfo(): MapValues {
    const node = this.#node();
    return node?.kind === "area" ? [node.mapArea.name] : NOTHING;
  }

  getCurrentMapAreaId(): number {
    const node = this.#node();
    return node?.kind === "area" ? node.mapArea.id + 1 : 0;
  }

  getCurrentMapContinent(): number {
    const node = this.#node();
    if (!node || node.kind === "cosmic") return -1;
    if (node.kind === "world") return 0;
    return this.#continentOf(node.mapArea)?.id ?? 0;
  }

  getCurrentMapZone(): number {
    const node = this.#node();
    if (node?.kind !== "area" || node.mapArea.areaId === 0) return 0;
    const continent = this.#continentOf(node.mapArea);
    if (!continent) return 0;
    const rows = this.#zones(continent.mapId);
    const index = rows.findIndex((area) => area.id === node.mapArea.id);
    if (index >= 0) return index + 1;
    const parent = this.#parent(node);
    return parent?.kind === "area" ? rows.findIndex((area) => area.id === parent.mapArea.id) + 1 : 0;
  }

  getMapContinents(): readonly string[] {
    const data = this.#ensureData();
    if (!data) return NOTHING;
    return [...data.continents]
      .sort((left, right) => left.id - right.id)
      .map((continent) => data.maps.find((map) => map.id === continent.mapId)?.name ?? "")
      .filter(Boolean);
  }

  getMapZones(continentIndex: number): readonly string[] {
    this.#ensureData();
    const continent = this.#data?.continents.find((row) => row.id === continentIndex);
    return continent ? this.#zones(continent.mapId).map((area) => this.#areaById.get(area.areaId)?.name ?? area.name) : NOTHING;
  }

  setMapZoom(continentIndex: number, zoneIndex?: number): void {
    const data = this.#ensureData();
    if (!data || !this.#hierarchy) return;
    if (continentIndex === -1) return this.#select(this.#hierarchy.root.key, true);
    if (continentIndex === 0) {
      const world = this.#hierarchy.all.find((node) => node.kind === "world");
      if (world) this.#select(world.key, true);
      return;
    }
    const continent = data.continents.find((row) => row.id === continentIndex);
    if (!continent) return;
    const area = zoneIndex === undefined
      ? data.mapAreas.find((row) => row.mapId === continent.mapId && row.areaId === 0)
      : this.#zones(continent.mapId)[zoneIndex - 1];
    if (area) this.#select(`area:${area.id}`, true);
  }

  setMapById(mapAreaId: number): void {
    this.#ensureData();
    if (this.#mapAreaById.has(mapAreaId)) this.#select(`area:${mapAreaId}`, true);
  }

  /**
   * The client raises WORLD_MAP_UPDATE for every SetMapToCurrentZone, even when the selection does
   * not move (the stock comment in WorldMapFrame_OnHide, WorldMapFrame.lua:164-165, relies on it).
   * WorldMapFrame_OnShow (:132-146) calls this and waits for that event to size and fill the
   * continent/zone dropdowns; opening the map in the zone already selected — the normal case —
   * left them 40 units wide and empty because an unchanged selection bumped no revision.
   *
   * A moved selection goes out on the next tick. An unchanged one is owed, never dropped, but goes
   * out at most once per `FRAMEXML_MAP_REANNOUNCE_TICKS`: BattlefieldMinimap_OnUpdate
   * (Blizzard_BattlefieldMinimap.lua:249-262) calls this on every frame while
   * GetPlayerMapPosition is (0,0), because its throttle never returns. Measured headless in Node
   * with the vertical TOC plus the zone map, the player in Shadowfang Keep (no map floor), and
   * three alternating runs of 1200 frames each: an event on every frame meant 2.3-2.7 ms per frame,
   * one every six ticks 1.5-2.0 ms, and no event 1.4-1.6 ms.
   */
  setMapToCurrentZone(): void {
    this.#ensureData();
    const revision = this.#revision;
    this.#selectCurrentZone(true);
    if (this.#revision === revision) this.#reannouncePending = true;
  }

  zoomOut(): void {
    const node = this.#node();
    const parent = node && this.#parent(node);
    if (parent) this.#select(parent.key, true);
  }

  isZoomOutAvailable(): boolean {
    const node = this.#node();
    return !!(node && this.#parent(node));
  }

  getCurrentMapDungeonLevel(): number {
    this.#node();
    return this.#floor;
  }

  getNumDungeonMapLevels(): number {
    const node = this.#node();
    return node?.kind === "area" ? this.#floorCount(node.mapArea) : 0;
  }

  dungeonUsesTerrainMap(): boolean {
    const node = this.#node();
    return node?.kind === "area" && node.mapArea.defaultDungeonFloor === -1
      && this.#floorRows(node.mapArea).length > 0;
  }

  setDungeonMapLevel(level: number): void {
    const node = this.#node();
    if (node?.kind !== "area" || !Number.isInteger(level)
      || level < 1 || level > this.#floorCount(node.mapArea) || level === this.#floor) return;
    this.#floor = level;
    this.#revision++;
  }

  getNumMapOverlays(): number {
    return this.#visibleOverlays().length;
  }

  getMapOverlayInfo(index: number): MapValues {
    const node = this.#node();
    const overlay = this.#visibleOverlays()[index - 1];
    if (node?.kind !== "area" || !overlay) return NOTHING;
    return [
      `Interface\\WorldMap\\${node.mapArea.name}\\${overlay.textureName}`,
      overlay.width, overlay.height, overlay.offsetX, overlay.offsetY,
      overlay.mapPointX, overlay.mapPointY,
    ];
  }

  getNumMapLandmarks(): number {
    return this.#landmarks().length;
  }

  getNumBattlefieldPositions(): number | undefined {
    return this.#battlefieldPositions()?.length;
  }

  getBattlefieldPosition(index: number): MapValues {
    const positions = this.#battlefieldPositions();
    if (!positions) return NOTHING;
    const position = positions[index - 1];
    // WorldMapButton_OnUpdate loops all 40 raid slots even when this count is zero. Stock Lua
    // treats the exact pair (0,0) as its no-team-marker sentinel for each unoccupied slot.
    return position ? [position.x, position.y, position.name] : OFF_MAP;
  }

  getNumBattlefieldFlagPositions(): number | undefined {
    if (!this.#isBattlegroundMap()) return 0;
    return this.#source.battlefieldFlagPositions?.()?.length;
  }

  getBattlefieldFlagPosition(index: number): MapValues {
    const position = this.#source.battlefieldFlagPositions?.()?.[index - 1];
    return position ? [position.x, position.y, position.texture] : NOTHING;
  }

  getNumBattlefieldVehicles(): number | undefined {
    // L17 3.14: Wow.exe 0x0054a140 answers the list's length whatever map is shown (Wintergrasp's
    // vehicles too); the stock maps hide them on world and continent maps themselves.
    const vehicles = this.#source.battlefieldVehicles?.();
    if (vehicles) return vehicles.length;
    return this.#isBattlegroundMap() ? this.#source.battlefieldVehicleCount?.() : 0;
  }

  /**
   * L17 3.14: `GetBattlefieldVehicleInfo(index)`, 0x0054c4d0 — the index-th listed vehicle in view,
   * projected onto the displayed map (0x00544140): x, y, name, isPossessed, vehicleType, orientation,
   * isPlayer, isAlive; nothing for an index past the list or a vehicle off the shown map (a (0, 0)
   * answer, which the client tests for).
   */
  getBattlefieldVehicleInfo(index: number): MapValues {
    const vehicle = this.#source.battlefieldVehicles?.()?.[index - 1];
    const node = this.#node();
    if (!vehicle || node?.kind !== "area") return NOTHING;
    const point = this.#pointOnMap(node.mapArea, vehicle.location);
    if (!point || !(point.u > 0 && point.u <= 1) || !(point.v > 0 && point.v <= 1)) return NOTHING;
    return [point.u, point.v, vehicle.name, vehicle.possessed, vehicle.type,
      vehicle.location.orientation ?? 0, vehicle.isPlayer, vehicle.alive];
  }

  /** L17 3.14: `GetBattlefieldMapIconScale()`, 0x0054c740 — the battlefield map's MinimapIconScale, else 1. */
  getBattlefieldMapIconScale(): number {
    const scale = this.#source.battlefieldMapIconScale?.();
    return scale !== undefined && Number.isFinite(scale) ? scale : 1;
  }

  getCorpseMapPosition(): MapValues {
    return this.#markerPosition(this.#source.corpseLocation?.());
  }

  getDeathReleasePosition(): MapValues {
    return this.#markerPosition(this.#source.deathReleaseLocation?.());
  }

  /** The release browser exposes no GM/developer debug map-object stream. */
  getNumMapDebugObjects(): number {
    return 0;
  }

  /** The authored ZMP used for clicks is distinct from the client developer's debug-zone overlay. */
  hasDebugZoneMap(): boolean {
    return false;
  }

  getMapLandmarkInfo(index: number): MapValues {
    const marker = this.#landmarks()[index - 1];
    return marker
      ? [marker.poi.name, marker.poi.description, marker.poi.icons[0], marker.u, marker.v, marker.poi.worldMapLink]
      : NOTHING;
  }

  /** The original client uses the exact pair (0,0) as its off-map arrow sentinel. */
  getPlayerMapPosition(unit: string): readonly [number, number] {
    const node = this.#node();
    if (node?.kind !== "area") return OFF_MAP;
    const location = unit === "player" ? this.#source.location() : this.#source.positionOfUnit?.(unit);
    const point = location && this.#pointOnMap(node.mapArea, location);
    return point && point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1
      ? [point.u, point.v] : OFF_MAP;
  }

  /** 3.13c: whether the area tables are here, so a quest POI can be placed on the displayed map. */
  get hasAreaData(): boolean {
    return this.#ensureData() !== undefined;
  }

  /**
   * 3.13c: where a world position of a quest POI blob falls on the displayed map, by Wow.exe's tests
   * (0x5e0110 / 0x5e0180 → 0x544140): on a dungeon floor the blob's map and floor must be the floor's;
   * otherwise its map must be the displayed area's and — with flags 0x4 — its WorldMapArea the
   * displayed one. Outside [0, 1]² (or on no area map) there is no point.
   */
  questPoiPoint(
    blob: { readonly map: number; readonly worldMapAreaId: number; readonly floor: number; readonly flags?: number },
    x: number, y: number,
  ): { u: number; v: number } | undefined {
    const node = this.#node();
    if (node?.kind !== "area" || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    const area = node.mapArea;
    const floor = this.#floor;
    const row = floor > 0 ? this.#floorRows(area).find((entry) => entry.floorIndex
      === floor - (area.defaultDungeonFloor === -1 ? 1 : 0)) : undefined;
    if (row) {
      if (blob.map !== row.mapId || blob.floor !== row.floorIndex) return undefined;
    } else if (blob.map !== area.mapId || (((blob.flags ?? 0) & 4) !== 0 && blob.worldMapAreaId !== area.id)) {
      return undefined;
    }
    const point = this.#pointOnMap(area, { mapId: blob.map, areaId: 0, x, y });
    return point && point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1 ? point : undefined;
  }

  /**
   * 3.13d (L6): the displayed WorldMapArea's |LocLeft − LocRight| in yards, which sizes the quest icon
   * spread (Wow.exe 0x5e3224); undefined on a dungeon floor or without an area map, where the client
   * spreads nothing.
   */
  questPoiMapWidth(): number | undefined {
    const node = this.#node();
    if (node?.kind !== "area") return undefined;
    const area = node.mapArea;
    const floor = this.#floor;
    if (floor > 0 && this.#floorRows(area).some((entry) => entry.floorIndex
      === floor - (area.defaultDungeonFloor === -1 ? 1 : 0))) return undefined;
    return Math.abs(area.left - area.right);
  }

  processMapClick(u: number, v: number): void {
    const node = this.#node();
    if (!node || !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return;
    const target = this.#targetAt(node, u, v);
    if (target) this.#select(target.key, true);
  }

  /** Name is truthful even where the original highlight texture's dimensions are not in DBC. */
  updateMapHighlight(u: number, v: number): MapValues {
    const node = this.#node();
    const target = node && this.#targetAt(node, u, v);
    return target ? [target.name] : NOTHING;
  }

  #ensureData(): Readonly<AreaData> | undefined {
    const data = this.#source.metadata();
    if (data === this.#data) return data;
    this.#data = data;
    this.#hierarchy = data ? new WorldMapHierarchy(data) : undefined;
    this.#areaById = new Map(data?.areas.map((area) => [area.id, area]) ?? []);
    this.#mapAreaById = new Map(data?.mapAreas.map((area) => [area.id, area]) ?? []);
    this.#mapAreaByAreaId = new Map(data?.mapAreas.filter((area) => area.areaId > 0)
      .map((area) => [area.areaId, area]) ?? []);
    this.#dungeonById = new Map(data?.dungeonMaps.map((floor) => [floor.id, floor]) ?? []);
    this.#dungeonByMap = new Map();
    for (const floor of data?.dungeonMaps ?? []) {
      const rows = this.#dungeonByMap.get(floor.mapId) ?? [];
      rows.push(floor);
      this.#dungeonByMap.set(floor.mapId, rows);
    }
    this.#overlaysByArea = new Map();
    for (const overlay of data?.overlays ?? []) {
      const rows = this.#overlaysByArea.get(overlay.mapAreaId) ?? [];
      rows.push(overlay);
      this.#overlaysByArea.set(overlay.mapAreaId, rows);
    }
    this.#poisByMap = new Map();
    for (const poi of data?.areaPois ?? []) {
      const rows = this.#poisByMap.get(poi.mapId) ?? [];
      rows.push(poi);
      this.#poisByMap.set(poi.mapId, rows);
    }
    if (!this.#selectedKey || !this.#hierarchy?.find(this.#selectedKey)) {
      this.#selectedKey = this.#hierarchy?.root.key;
      this.#explicitSelection = false;
    }
    if (!this.#explicitSelection) this.#selectCurrentZone(false);
    this.#revision++;
    return data;
  }

  #node(): WorldMapNode | undefined {
    this.#ensureData();
    return this.#hierarchy?.find(this.#selectedKey ?? "cosmic");
  }

  #select(key: WorldMapNodeKey, explicit: boolean): void {
    this.#ensureData();
    const node = this.#hierarchy?.find(key);
    if (!node) return;
    if (explicit) this.#explicitSelection = true;
    const nextFloor = node.kind === "area" ? this.#defaultFloor(node.mapArea) : 0;
    if (this.#selectedKey === key && this.#floor === nextFloor) return;
    this.#selectedKey = key;
    this.#floor = nextFloor;
    this.#revision++;
  }

  #selectCurrentZone(explicit: boolean): void {
    const data = this.#data;
    const location = this.#source.location();
    if (!data || !location) return;
    let area = this.#mapAreaByAreaId.get(location.areaId);
    let areaId = location.areaId;
    for (let depth = 0; !area && depth < 16; depth++) {
      const parent = this.#areaById.get(areaId)?.parentId;
      if (!parent || parent === areaId) break;
      areaId = parent;
      area = this.#mapAreaByAreaId.get(areaId);
    }
    area ??= data.mapAreas.find((row) => row.mapId === location.mapId && row.areaId === 0);
    if (!area) {
      const sameMap = data.mapAreas.filter((row) => row.mapId === location.mapId);
      // An instance has a single WorldMapArea even when its live AreaTable id is a room rather
      // than the DBC zone. Do not pick arbitrarily when a physical map has several candidates.
      if (sameMap.length === 1) area = sameMap[0];
    }
    if (!area || !this.#hierarchy?.area(area.id)) return;
    const floor = this.#floorAtLocation(area, location) ?? this.#defaultFloor(area);
    if (explicit) this.#explicitSelection = false;
    if (this.#selectedKey === `area:${area.id}` && this.#floor === floor) return;
    this.#selectedKey = `area:${area.id}`;
    this.#floor = floor;
    this.#revision++;
  }

  #continentOf(area: MapAreaInfo): Readonly<AreaData>["continents"][number] | undefined {
    const data = this.#data;
    if (!data) return undefined;
    const mapId = area.displayMapId >= 0 ? area.displayMapId : area.mapId;
    const direct = data.continents.find((continent) => continent.mapId === mapId);
    if (direct) return direct;
    const parentId = area.parentWorldMapId || this.#floorRows(area)[0]?.parentWorldMapId;
    const parent = parentId ? this.#mapAreaById.get(parentId) : undefined;
    return parent && parent.id !== area.id ? this.#continentOf(parent) : undefined;
  }

  #zones(continentMapId: number): MapAreaInfo[] {
    const data = this.#ensureData();
    if (!data) return [];
    return data.mapAreas.filter((area) => area.areaId > 0
      && (area.displayMapId >= 0 ? area.displayMapId : area.mapId) === continentMapId
      && (data.maps.find((map) => map.id === area.mapId)?.instanceType ?? 0) === 0)
      .sort((left, right) => {
        const leftName = this.#areaById.get(left.areaId)?.name ?? left.name;
        const rightName = this.#areaById.get(right.areaId)?.name ?? right.name;
        return leftName.localeCompare(rightName) || left.id - right.id;
      });
  }

  #parent(node: WorldMapNode): WorldMapNode | undefined {
    const regular = this.#hierarchy?.parent(node);
    if (regular || node.kind !== "area") return regular;
    const mapArea = node.mapArea;
    const parentId = mapArea.parentWorldMapId || this.#floorRows(mapArea)[0]?.parentWorldMapId;
    if (parentId && parentId !== mapArea.id) return this.#hierarchy?.area(parentId);
    return undefined;
  }

  #floorRows(area: MapAreaInfo): readonly DungeonMapInfo[] {
    const data = this.#data;
    if (!data) return NOTHING;
    const map = data.maps.find((row) => row.id === area.mapId);
    if (area.defaultDungeonFloor === 0 && (!map || map.instanceType === 0)) return NOTHING;
    return this.#dungeonByMap.get(area.mapId) ?? NOTHING;
  }

  #floorCount(area: MapAreaInfo): number {
    const floors = new Set(this.#floorRows(area).map((row) => row.floorIndex).filter((level) => level > 0));
    return floors.size + (area.defaultDungeonFloor === -1 && floors.size > 0 ? 1 : 0);
  }

  #defaultFloor(area: MapAreaInfo): number {
    const count = this.#floorCount(area);
    if (!count) return 0;
    if (area.defaultDungeonFloor === -1) return 1;
    const row = this.#dungeonById.get(area.defaultDungeonFloor);
    return row?.mapId === area.mapId ? row.floorIndex : 1;
  }

  #floorAtLocation(area: MapAreaInfo, location: FrameXmlMapLocation): number | undefined {
    if (location.mapId !== area.mapId) return undefined;
    const row = this.#floorRows(area).find((floor) => this.#insideFloor(floor, location));
    return row ? row.floorIndex + (area.defaultDungeonFloor === -1 ? 1 : 0) : undefined;
  }

  #insideFloor(floor: DungeonMapInfo, location: FrameXmlMapLocation): boolean {
    // DungeonMap's X axis is the map's horizontal/world-Y axis; Y is vertical/world-X.
    return location.y >= Math.min(floor.minX, floor.maxX)
      && location.y <= Math.max(floor.minX, floor.maxX)
      && location.x >= Math.min(floor.minY, floor.maxY)
      && location.x <= Math.max(floor.minY, floor.maxY);
  }

  #pointOnMap(area: MapAreaInfo, location: FrameXmlMapLocation): { u: number; v: number } | undefined {
    const floor = this.#floor;
    const row = floor > 0 ? this.#floorRows(area).find((entry) => entry.floorIndex
      === floor - (area.defaultDungeonFloor === -1 ? 1 : 0)) : undefined;
    if (row && row.mapId === location.mapId && this.#insideFloor(row, location)) {
      const width = row.maxX - row.minX;
      const height = row.maxY - row.minY;
      if (width && height) return {
        u: (row.maxX - location.y) / width,
        v: (row.maxY - location.x) / height,
      };
    }
    if (!hasMapBounds(area) || !this.#hierarchy) return undefined;
    return this.#hierarchy.displayPoint(area, location.mapId, location.x, location.y);
  }

  #visibleOverlays(): readonly MapOverlayInfo[] {
    const node = this.#node();
    if (node?.kind !== "area") return NOTHING;
    const rows = this.#overlaysByArea.get(node.mapArea.id) ?? NOTHING;
    const explored = this.#source.isExploredArea;
    return explored ? rows.filter((row) => row.areaIds.some((id) => explored(id) === true)) : rows;
  }

  #markerPosition(location: FrameXmlMapLocation | null | undefined): MapValues {
    if (location === undefined) return NOTHING;
    const node = this.#node();
    const point = location && node?.kind === "area" ? this.#pointOnMap(node.mapArea, location) : undefined;
    return point && point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1
      ? [point.u, point.v] : OFF_MAP;
  }

  #isBattlegroundMap(): boolean {
    const node = this.#node();
    const instanceType = node?.kind === "area"
      ? this.#data?.maps.find((row) => row.id === node.mapArea.mapId)?.instanceType : 0;
    return instanceType === 3 || instanceType === 4;
  }

  #battlefieldPositions(): readonly { readonly x: number; readonly y: number; readonly name?: string }[] | undefined {
    const positions = this.#source.battlefieldPositions?.();
    if (positions) return positions;
    // Open-world maps have no battleground roster, so all fixed UI slots are vacant. A selected
    // battleground/arena needs live positions; an absent source must not silently erase its team.
    return this.#isBattlegroundMap() ? undefined : NOTHING;
  }

  #landmarks(): readonly { poi: AreaPoiInfo; u: number; v: number }[] {
    const node = this.#node();
    if (node?.kind !== "area") return NOTHING;
    const selected = node.mapArea;
    const rows = this.#poisByMap.get(selected.mapId) ?? NOTHING;
    const continent = selected.areaId === 0;
    const output: { poi: AreaPoiInfo; u: number; v: number }[] = [];
    for (const poi of rows) {
      // World-state and faction-gated markers require their own live condition answers. These
      // unconditionally visible rows can be read straight from the DBC without inventing state.
      if (!poi.icons[0] || poi.worldStateId !== 0 || poi.factionId !== 0) continue;
      if (!(poi.flags & (continent ? 1 : 4))) continue;
      const point = this.#pointOnMap(selected, { mapId: poi.mapId, areaId: poi.areaId, x: poi.x, y: poi.y });
      if (!point || point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1) continue;
      output.push({ poi, ...point });
    }
    return output;
  }

  #targetAt(node: WorldMapNode, u: number, v: number): AreaWorldMapNode | WorldMapNode | undefined {
    if (!this.#hierarchy) return undefined;
    if (node.kind === "area" && node.mapArea.areaId === 0 && this.#source.areaAt) {
      const hit = this.#source.areaAt(node.mapArea, u, v);
      if (hit.status === "loading" || hit.status === "ready" && !hit.mapArea) return undefined;
      if (hit.status === "ready" && hit.mapArea) return this.#hierarchy.area(hit.mapArea.id);
    }
    return this.#hierarchy.targets(node).find((target) => u >= target.rect.left
      && u <= target.rect.left + target.rect.width && v >= target.rect.top
      && v <= target.rect.top + target.rect.height)?.node;
  }
}

export interface FrameXmlMapHost {
  readonly map?: FrameXmlMap;
}

export type FrameXmlMapBinding = (host: FrameXmlMapHost, args: readonly unknown[]) => MapValues;

/** Register beside the ordinary seam bindings; missing metadata stays a real pending state. */
export const FRAMEXML_MAP_BINDINGS: Readonly<Record<string, FrameXmlMapBinding>> = Object.freeze({
  GetMapInfo: (host) => host.map?.getMapInfo() ?? NOTHING,
  GetCurrentMapAreaID: (host) => host.map ? [host.map.getCurrentMapAreaId()] : NOTHING,
  GetCurrentMapContinent: (host) => host.map ? [host.map.getCurrentMapContinent()] : NOTHING,
  GetCurrentMapZone: (host) => host.map ? [host.map.getCurrentMapZone()] : NOTHING,
  GetMapContinents: (host) => host.map?.getMapContinents() ?? NOTHING,
  GetMapZones: (host, args) => host.map?.getMapZones(integer(args[0]) ?? 0) ?? NOTHING,
  SetMapZoom: (host, args) => {
    const continent = integer(args[0]);
    if (continent !== undefined) host.map?.setMapZoom(continent, integer(args[1]));
    return NOTHING;
  },
  SetMapByID: (host, args) => {
    const id = integer(args[0]);
    if (id !== undefined) host.map?.setMapById(id);
    return NOTHING;
  },
  SetMapToCurrentZone: (host) => { host.map?.setMapToCurrentZone(); return NOTHING; },
  ZoomOut: (host) => { host.map?.zoomOut(); return NOTHING; },
  IsZoomOutAvailable: (host) => host.map ? [host.map.isZoomOutAvailable()] : NOTHING,
  GetCurrentMapDungeonLevel: (host) => host.map ? [host.map.getCurrentMapDungeonLevel()] : NOTHING,
  GetNumDungeonMapLevels: (host) => host.map ? [host.map.getNumDungeonMapLevels()] : NOTHING,
  DungeonUsesTerrainMap: (host) => host.map ? [host.map.dungeonUsesTerrainMap()] : NOTHING,
  SetDungeonMapLevel: (host, args) => {
    const level = integer(args[0]);
    if (level !== undefined) host.map?.setDungeonMapLevel(level);
    return NOTHING;
  },
  GetNumMapOverlays: (host) => host.map ? [host.map.getNumMapOverlays()] : NOTHING,
  GetMapOverlayInfo: (host, args) => host.map?.getMapOverlayInfo(integer(args[0]) ?? 0) ?? NOTHING,
  GetNumMapLandmarks: (host) => host.map ? [host.map.getNumMapLandmarks()] : NOTHING,
  GetNumBattlefieldPositions: (host) => host.map
    ? [host.map.getNumBattlefieldPositions()] : NOTHING,
  GetBattlefieldPosition: (host, args) => host.map?.getBattlefieldPosition(integer(args[0]) ?? 0) ?? NOTHING,
  GetNumBattlefieldFlagPositions: (host) => host.map
    ? [host.map.getNumBattlefieldFlagPositions()] : NOTHING,
  GetBattlefieldFlagPosition: (host, args) => host.map?.getBattlefieldFlagPosition(integer(args[0]) ?? 0) ?? NOTHING,
  GetNumBattlefieldVehicles: (host) => host.map ? [host.map.getNumBattlefieldVehicles()] : NOTHING,
  // L17 3.14: the index is rounded (0x0054c4d0), the scale is 1 without a battlefield (0x0054c740).
  GetBattlefieldVehicleInfo: (host, args) => {
    const index = finite(args[0]);
    return index === undefined ? NOTHING : host.map?.getBattlefieldVehicleInfo(Math.round(index)) ?? NOTHING;
  },
  GetBattlefieldMapIconScale: (host) => [host.map?.getBattlefieldMapIconScale() ?? 1],
  GetCorpseMapPosition: (host) => host.map?.getCorpseMapPosition() ?? NOTHING,
  GetDeathReleasePosition: (host) => host.map?.getDeathReleasePosition() ?? NOTHING,
  GetMapLandmarkInfo: (host, args) => host.map?.getMapLandmarkInfo(integer(args[0]) ?? 0) ?? NOTHING,
  HasDebugZoneMap: (host) => host.map ? [host.map.hasDebugZoneMap()] : NOTHING,
  GetNumMapDebugObjects: (host) => host.map ? [host.map.getNumMapDebugObjects()] : NOTHING,
  GetPlayerMapPosition: (host, args) => host.map?.getPlayerMapPosition(String(args[0] ?? "")) ?? NOTHING,
  ProcessMapClick: (host, args) => {
    const u = finite(args[0]);
    const v = finite(args[1]);
    if (u !== undefined && v !== undefined) host.map?.processMapClick(u, v);
    return NOTHING;
  },
  UpdateMapHighlight: (host, args) => {
    const u = finite(args[0]);
    const v = finite(args[1]);
    return u !== undefined && v !== undefined ? host.map?.updateMapHighlight(u, v) ?? NOTHING : NOTHING;
  },
});
