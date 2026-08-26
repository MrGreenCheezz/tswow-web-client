import { openDbcFile } from "./Dbc.js";

/**
 * The five tables a map is drawn from. None of them is on the wire.
 *
 * The server names a zone with a number and stops there: `SMSG_INIT_WORLD_STATES` carries a zone
 * and an area id, `SMSG_EXPLORATION_EXPERIENCE` carries an area id, and the exploration mask in
 * the update fields is a bit per area. What a zone is called, where it sits, what shape it is and
 * which picture shows it are all client data, which is why a map could not be drawn before this
 * endpoint existed.
 *
 * Everything is served at once and cached for the session, the same arrangement `/dbc/talents`
 * uses: a map repaint asks about every area it draws, and the tables are small.
 *
 * Two column names are worth stating because neither is what it looks like:
 *
 * * `AreaTable` has no `MapID`. The map an area belongs to is `ContinentID`.
 * * `WorldMapArea` has no `TextureName` in 3.3.5 — `AreaName` is both the name and the directory
 *   its twelve picture tiles live in, and it is a plain string rather than a localised one. The
 *   localised name is `AreaTable.AreaName_lang`, reached through `AreaID`.
 */

export interface AreaInfo {
  id: number;
  /** `ParentAreaID`: zero for a zone, the containing zone for a sub-area. */
  parentId: number;
  /** `ContinentID`, i.e. the map. Not called MapID in this table. */
  mapId: number;
  /**
   * The bit this area occupies in `PLAYER_EXPLORED_ZONES_1`.
   *
   * Zero means "no bit" and not "bit zero": exactly one row in this dataset carries a zero, and
   * indexing the mask with it would mark every unbitted area explored at once.
   */
  areaBit: number;
  explorationLevel: number;
  name: string;
  /**
   * `ZoneMusic::ID` — the pair of `SoundEntries` kits this zone plays, day and night.
   *
   * Zero means the zone inherits its parent's.
   */
  zoneMusic: number;
  /**
   * `SoundAmbience::ID` — the wind, the crickets and the surf, also as a day kit and a night one.
   *
   * A different column from `zoneMusic` and a different channel: music is a track that starts and
   * ends, ambience is the room tone underneath it. 445 of the 2,307 rows carry one, naming 86
   * distinct `SoundAmbience` rows, and not one of the 86 is missing from that table. A zero
   * inherits the parent zone's, which is the same walk the music does.
   */
  ambienceId: number;
  /** `ZoneIntroMusicTable::ID` — the sting on entering, once, before the zone's own track. */
  introSound: number;
}

export interface MapAreaInfo {
  id: number;
  mapId: number;
  /** The `AreaTable` row this rectangle belongs to; zero on a continent-wide row. */
  areaId: number;
  /** Both the label and the directory the twelve picture tiles live in. */
  name: string;
  /**
   * The rectangle, in world units and in WoW's axes rather than the screen's: `top` and `bottom`
   * bound world X, `left` and `right` bound world Y, and in every row that has a rectangle at all
   * `left > right` and `top > bottom`. All four are zero on the three rows that have none.
   */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** −1 on a ground row. It is a map id only where it is not −1, so truthiness is the wrong test. */
  displayMapId: number;
  defaultDungeonFloor: number;
  parentWorldMapId: number;
}

export interface MapOverlayInfo {
  id: number;
  /** The `WorldMapArea` this overlay is painted on. */
  mapAreaId: number;
  /** Up to four areas; the overlay is shown once any one of them has been explored. */
  areaIds: number[];
  /** The picture's own name. It lives in the *parent map area's* directory, not one of its own. */
  textureName: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export interface ContinentInfo {
  id: number;
  mapId: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface MapInfo {
  id: number;
  /** The archive directory: what the terrain and the minimap tiles are named after. */
  directory: string;
  name: string;
  /**
   * `Map.InstanceType`: 0 the open world, 1 a dungeon, 2 a raid, 3 a battleground, 4 an arena.
   *
   * Here because nothing on the wire ever says «you are in an instance». The original client
   * answers `IsInInstance()` out of this very column, and a module window's `inInstance` condition
   * is that question — so without the column the client would have to guess, and every signal
   * available to it (an engaged boss frame, a battlefield status) is a symptom of one kind of
   * instance rather than the fact. Measured on this dataset: 135 rows — 47 of type 0, 53 dungeons,
   * 24 raids, 6 battlegrounds, 5 arenas.
   */
  instanceType: number;
}

export interface AreaData {
  areas: AreaInfo[];
  mapAreas: MapAreaInfo[];
  overlays: MapOverlayInfo[];
  continents: ContinentInfo[];
  maps: MapInfo[];
}

/** `WorldMapOverlay.AreaID` is four wide, and most rows fill only the first. */
const OVERLAY_AREAS = 4;

export async function loadAreaData(dbcDirectory: string): Promise<AreaData> {
  const [areaTable, mapAreaTable, overlayTable, continentTable, mapTable] = await Promise.all([
    openDbcFile(dbcDirectory, "AreaTable"),
    openDbcFile(dbcDirectory, "WorldMapArea"),
    openDbcFile(dbcDirectory, "WorldMapOverlay"),
    openDbcFile(dbcDirectory, "WorldMapContinent"),
    openDbcFile(dbcDirectory, "Map"),
  ]);

  const areas: AreaInfo[] = [];
  for (const row of areaTable.rows()) {
    areas.push({
      id: areaTable.id(row),
      parentId: areaTable.int(row, "ParentAreaID"),
      mapId: areaTable.int(row, "ContinentID"),
      areaBit: areaTable.int(row, "AreaBit"),
      explorationLevel: areaTable.int(row, "ExplorationLevel"),
      name: areaTable.locstring(row, "AreaName_lang"),
      zoneMusic: areaTable.int(row, "ZoneMusic"),
      ambienceId: areaTable.int(row, "AmbienceID"),
      introSound: areaTable.int(row, "IntroSound"),
    });
  }

  const mapAreas: MapAreaInfo[] = [];
  for (const row of mapAreaTable.rows()) {
    mapAreas.push({
      id: mapAreaTable.id(row),
      mapId: mapAreaTable.int(row, "MapID"),
      areaId: mapAreaTable.int(row, "AreaID"),
      name: mapAreaTable.string(row, "AreaName"),
      left: mapAreaTable.float(row, "LocLeft"),
      right: mapAreaTable.float(row, "LocRight"),
      top: mapAreaTable.float(row, "LocTop"),
      bottom: mapAreaTable.float(row, "LocBottom"),
      displayMapId: mapAreaTable.int(row, "DisplayMapID"),
      defaultDungeonFloor: mapAreaTable.int(row, "DefaultDungeonFloor"),
      parentWorldMapId: mapAreaTable.int(row, "ParentWorldMapID"),
    });
  }

  const overlays: MapOverlayInfo[] = [];
  for (const row of overlayTable.rows()) {
    const textureName = overlayTable.string(row, "TextureName");
    // A row with no picture cannot be drawn and cannot be explored into view; 102 of 988 are like
    // this, and carrying them would be a tenth of the payload for nothing.
    if (!textureName) continue;
    const areaIds: number[] = [];
    for (let element = 0; element < OVERLAY_AREAS; element++) {
      const areaId = overlayTable.int(row, "AreaID", element);
      if (areaId > 0) areaIds.push(areaId);
    }
    overlays.push({
      id: overlayTable.id(row),
      mapAreaId: overlayTable.int(row, "MapAreaID"),
      areaIds,
      textureName,
      width: overlayTable.int(row, "TextureWidth"),
      height: overlayTable.int(row, "TextureHeight"),
      offsetX: overlayTable.int(row, "OffsetX"),
      offsetY: overlayTable.int(row, "OffsetY"),
    });
  }

  const continents: ContinentInfo[] = [];
  for (const row of continentTable.rows()) {
    continents.push({
      id: continentTable.id(row),
      mapId: continentTable.int(row, "MapID"),
      left: continentTable.int(row, "LeftBoundary"),
      right: continentTable.int(row, "RightBoundary"),
      top: continentTable.int(row, "TopBoundary"),
      bottom: continentTable.int(row, "BottomBoundary"),
      offsetX: continentTable.float(row, "ContinentOffset", 0),
      offsetY: continentTable.float(row, "ContinentOffset", 1),
      scale: continentTable.float(row, "Scale"),
    });
  }

  const maps: MapInfo[] = [];
  for (const row of mapTable.rows()) {
    maps.push({
      id: mapTable.id(row),
      directory: mapTable.string(row, "Directory"),
      name: mapTable.locstring(row, "MapName_lang"),
      instanceType: mapTable.int(row, "InstanceType"),
    });
  }

  return { areas, mapAreas, overlays, continents, maps };
}
