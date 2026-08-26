import type { AreaData, AreaInfo, ContinentInfo, MapAreaInfo, MapInfo, MapOverlayInfo } from "../gateway/AreaMetadata.js";

export type { AreaData, AreaInfo, ContinentInfo, MapAreaInfo, MapInfo, MapOverlayInfo };

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
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
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
        const response = await fetch(`${this.#baseUrl}/dbc/areas?v=4`);
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
