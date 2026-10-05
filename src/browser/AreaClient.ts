import type { AreaData, AreaInfo, AreaPoiInfo, ContinentInfo, DungeonMapInfo, MapAreaInfo, MapInfo, MapOverlayInfo } from "../gateway/AreaMetadata.js";
import { WorldMapHierarchy } from "./ui/WorldMapHierarchy.js";
import { WorldMapZoneMapClient, type WorldMapZoneHit } from "./WorldMapZoneMap.js";

export type { AreaData, AreaInfo, AreaPoiInfo, ContinentInfo, DungeonMapInfo, MapAreaInfo, MapInfo, MapOverlayInfo };

export type WorldMapAreaHit =
  | Exclude<WorldMapZoneHit, { status: "ready" }>
  | { status: "ready"; areaId: number; mapArea?: MapAreaInfo };

/**
 * Zones, their rectangles and their pictures, fetched once for the session.
 *
 * The same arrangement `TalentClient` uses, and for the same reason: the server names an area with
 * a number and nothing else, so every label, every rectangle and every exploration overlay on a map
 * is answered from here, on every repaint.
 */
export class AreaClient {
  readonly #baseUrl: string;
  #data: AreaData | undefined;
  #pending: Promise<void> | undefined;
  readonly #areaById = new Map<number, AreaInfo>();
  readonly #areaByBit = new Map<number, AreaInfo>();
  readonly #mapAreaById = new Map<number, MapAreaInfo>();
  readonly #mapAreaByAreaId = new Map<number, MapAreaInfo>();
  readonly #mapAreasByMap = new Map<number, MapAreaInfo[]>();
  readonly #overlaysByMapArea = new Map<number, MapOverlayInfo[]>();
  readonly #continentByMap = new Map<number, ContinentInfo>();
  readonly #mapById = new Map<number, MapInfo>();
  readonly #worldMapZoneMaps: WorldMapZoneMapClient;
  #worldMapHierarchy: WorldMapHierarchy | undefined;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;
  onWorldMapZoneMapChanged: ((mapId: number) => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#worldMapZoneMaps = new WorldMapZoneMapClient(gatewayWebSocketUrl);
    this.#worldMapZoneMaps.onStatus = (message, error) => this.onStatus?.(message, error);
    this.#worldMapZoneMaps.onChanged = (mapId) => this.onWorldMapZoneMapChanged?.(mapId);
  }

  /** Starts the one fetch this needs. Safe to call repeatedly; only the first does anything. */
  load(): void {
    if (this.#data || this.#pending) return;
    this.#pending = (async () => {
      try {
        // `v` is the cache-buster this route has instead of a hash: the reply is held for an hour,
        // and a field added to `AreaInfo` would otherwise be missing for that hour. Bumped to 3 by
        // М6, which added `MapInfo.instanceType`: without it a module window asking «am I in an
        // instance» would read `undefined` for an hour after an upgrade and answer «no». Bumped to
        // 4 by Н1а, which added `AreaInfo.ambienceId`: a reply cached from before it leaves every
        // zone without wind for that hour, which is silence rather than a wrong answer.
        // Bumped to 5 for `ContinentInfo.worldMapId` and WorldMapTransforms: without them the
        // hierarchy collapses every continent onto Cosmic and projects virtual-map zones in the
        // wrong coordinate space until the hour-old response expires.
        // Version 6 adds DungeonMap floors, AreaPOIs and WorldMapOverlay map points for stock FrameXML.
        // Version 7 adds `ContinentInfo.taxiMin/taxiMax`, the square the stock TaxiFrame's TAXIMAP
        // pictures are drawn for; an older reply leaves the flight map on its WorldMapArea stand-in.
        // Version 8 adds `AreaInfo.flags` and `factionGroupMask` (AreaTable columns 4 and 28) for
        // GetZonePVPInfo. The route ignores `v`, so a gateway not yet restarted answers the version-7
        // shape to this request: without the two fields the zone banner and the minimap label carry
        // no PvP status (FrameXmlZoneInfo.ts) and everything else reads as before.
        // 05.10-L17t: version 9 adds `MapInfo.minimapIconScale` (Map.dbc column 58) for
        // GetBattlefieldMapIconScale; a version-8 reply leaves it 1.0 (FrameXmlBattlefieldMapSource.ts).
        // 05.10-A7b-4: the same unreleased version 9 also carries `MapInfo.areaTableId` (Map.dbc column 22),
        // the zone of a single-WMO dungeon (AreaLocator.ts); without it the label stays the map's name.
        const response = await fetch(`${this.#baseUrl}/dbc/areas?v=9`);
        if (!response.ok) throw new Error(`Area gateway returned ${response.status}`);
        const value = await response.json() as AreaData;
        if (!Array.isArray(value.areas) || !Array.isArray(value.mapAreas)) throw new Error("malformed area data");
        this.#index(value);
        this.onLoaded?.();
      } catch (error) {
        // Left unfetched rather than retried: without it the minimap draws its tiles and its blips
        // and says nothing about the zone, which is what it did before this slice.
        this.onStatus?.(`зоны: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    })();
  }

  get ready(): boolean {
    return this.#data !== undefined;
  }

  /** Immutable-by-convention DBC snapshot for the stock FrameXML world-map C API. */
  snapshot(): Readonly<AreaData> | undefined {
    return this.#data;
  }

  #index(value: AreaData): void {
    this.#data = value;
    for (const area of value.areas) {
      this.#areaById.set(area.id, area);
      // A zero bit is "this area has no bit", not "bit zero" — one row in the shipped table
      // carries a zero, and indexing the exploration mask with it would mark it explored the
      // moment anything else on word zero was.
      if (area.areaBit > 0 && !this.#areaByBit.has(area.areaBit)) this.#areaByBit.set(area.areaBit, area);
    }
    for (const mapArea of value.mapAreas) {
      this.#mapAreaById.set(mapArea.id, mapArea);
      if (mapArea.areaId > 0) this.#mapAreaByAreaId.set(mapArea.areaId, mapArea);
      const list = this.#mapAreasByMap.get(mapArea.mapId) ?? [];
      list.push(mapArea);
      this.#mapAreasByMap.set(mapArea.mapId, list);
    }
    for (const list of this.#mapAreasByMap.values()) list.sort((left, right) => left.name.localeCompare(right.name));
    for (const overlay of value.overlays) {
      const list = this.#overlaysByMapArea.get(overlay.mapAreaId) ?? [];
      list.push(overlay);
      this.#overlaysByMapArea.set(overlay.mapAreaId, list);
    }
    for (const continent of value.continents) this.#continentByMap.set(continent.mapId, continent);
    for (const map of value.maps) this.#mapById.set(map.id, map);
    this.#worldMapHierarchy = new WorldMapHierarchy(value);
  }

  area(areaId: number): AreaInfo | undefined {
    return this.#areaById.get(areaId);
  }

  /** The area holding one exploration bit, or undefined for a bit no area claims. */
  areaOfBit(areaBit: number): AreaInfo | undefined {
    return this.#areaByBit.get(areaBit);
  }

  /**
   * The zone an area belongs to: itself when it is already a zone, otherwise its parent.
   *
   * The chain is walked rather than followed once because the table nests — a building inside a
   * district inside a city — and the caller wants the name on the map, which is the top of it.
   */
  zoneOf(areaId: number): AreaInfo | undefined {
    let area = this.#areaById.get(areaId);
    for (let depth = 0; area && area.parentId !== 0 && depth < 8; depth++) {
      const parent = this.#areaById.get(area.parentId);
      if (!parent) break;
      area = parent;
    }
    return area;
  }

  mapArea(id: number): MapAreaInfo | undefined {
    return this.#mapAreaById.get(id);
  }

  /** The drawable rectangle for an area, walking up to the zone when the area has none of its own. */
  mapAreaOfArea(areaId: number): MapAreaInfo | undefined {
    const direct = this.#mapAreaByAreaId.get(areaId);
    if (direct) return direct;
    const zone = this.zoneOf(areaId);
    return zone ? this.#mapAreaByAreaId.get(zone.id) : undefined;
  }

  mapAreasOf(mapId: number): readonly MapAreaInfo[] {
    return this.#mapAreasByMap.get(mapId) ?? [];
  }

  overlaysOf(mapAreaId: number): readonly MapOverlayInfo[] {
    return this.#overlaysByMapArea.get(mapAreaId) ?? [];
  }

  continentOf(mapId: number): ContinentInfo | undefined {
    return this.#continentByMap.get(mapId);
  }

  map(mapId: number): MapInfo | undefined {
    return this.#mapById.get(mapId);
  }

  worldMapHierarchy(): WorldMapHierarchy | undefined {
    return this.#worldMapHierarchy;
  }

  /** Bumped when an authored continent hit map either lands or proves unavailable. */
  get worldMapZoneMapRevision(): number {
    return this.#worldMapZoneMaps.revision;
  }

  /**
   * Exact original-client hit under one point of a continent map.
   *
   * A ZMP cell names an AreaTable row, often a sub-area rather than the drawable zone. Walk the
   * parent chain until it reaches a WorldMapArea on this physical continent. `ready` without a
   * `mapArea` is still a complete authored answer (ocean is area id zero); callers must only use
   * rectangle fallback for `unavailable`, never for that case.
   */
  worldMapAreaAt(continent: MapAreaInfo, u: number, v: number): WorldMapAreaHit {
    const hit = this.#worldMapZoneMaps.hit(continent.mapId, continent, u, v);
    if (hit.status !== "ready") return hit;
    let areaId = hit.areaId;
    for (let depth = 0; areaId > 0 && depth < 16; depth++) {
      const mapArea = this.#mapAreaByAreaId.get(areaId);
      // Blood-elf and draenei starting zones physically live on map 530, but their authored
      // WorldMapArea rows name Azeroth/Kalimdor through DisplayMapID and their ids are present in
      // those continents' ZMPs. Treat that display edge as belonging to the picture too; requiring
      // physical map equality would make those islands precise no-target holes.
      if (mapArea && (mapArea.mapId === continent.mapId || mapArea.displayMapId === continent.mapId)) {
        return { ...hit, mapArea };
      }
      const area = this.#areaById.get(areaId);
      if (!area || area.parentId <= 0 || area.parentId === areaId) break;
      areaId = area.parentId;
    }
    return hit;
  }

  /**
   * The continent-wide rectangle of a map: the row whose `areaId` is zero.
   *
   * That is what "Azeroth" and "Kalimdor" are in `WorldMapArea` — a rectangle covering everything,
   * with the picture of the whole continent behind it.
   */
  continentMapArea(mapId: number): MapAreaInfo | undefined {
    return this.#mapAreasByMap.get(mapId)?.find((area) => area.areaId === 0);
  }
}
