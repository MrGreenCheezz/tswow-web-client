/**
 * Plan item 3.58 (24.10): which AreaPOI rows the world map lists as landmarks, and the icon each gets, as
 * Wow.exe 3.3.5a 12340 decides it (descriptions only).
 *
 * - The list is built when the map is set (CGWorldMap::SetMap, 0x00546310): every AreaPOI row that
 *   CGWorldMap::GetPOIPosition (0x005445f0) places on the displayed map, whose AreaTable row is explored
 *   (or has an ExplorationLevel below 0), and whose WorldStateID, if any, reads non-zero. The row's
 *   FactionID is not consulted.
 * - GetPOIPosition's flag tests: a zone or an orphan map (dungeon, floor) needs 0x4; the Azeroth world map
 *   needs 0x10; a continent (and the world map) needs 0x8. With 0x400 the displayed WorldMapArea must be the
 *   row's own area on its own map.
 * - `GetMapLandmarkInfo` (0x00545a30): the icon is `Icon[state]` (state = the world state's value − 1, 0 when
 *   that is outside 0..8) only for the gossip POI, a row with flag 0x80, or on a continent or the world map;
 *   everywhere else it is 0, the empty first cell of Interface\Minimap\POIIcons. The town, village and city
 *   rows (flags 0x205/0x204/0x20d without 0x80) are therefore invisible hover spots on a zone map — their
 *   Icon[0] 7 is the red banner cell, which is what we drew in their place. The seventh value is
 *   `Flags & 0x200` (showInBattleMap).
 */

import type { AreaPoiInfo } from "../../gateway/AreaMetadata.js";

/** How Wow.exe's map state reads for the GetPOIPosition tests. */
export type FrameXmlLandmarkView = "zone" | "orphan" | "continent" | "world" | "cosmic";

export const AREA_POI_FLAG_ZONE = 0x4;
export const AREA_POI_FLAG_CONTINENT = 0x8;
export const AREA_POI_FLAG_WORLD = 0x10;
export const AREA_POI_FLAG_ALWAYS_ICON = 0x80;
export const AREA_POI_FLAG_BATTLE_MAP = 0x200;
export const AREA_POI_FLAG_OWN_AREA = 0x400;

/** 0x005445f0's flag tests for one row on one kind of map (position and 0x400 aside). */
export function areaPoiFlagsAllow(view: FrameXmlLandmarkView, flags: number): boolean {
  if ((view === "zone" || view === "orphan" || view === "cosmic") && !(flags & AREA_POI_FLAG_ZONE)) return false;
  if (view === "world" && !(flags & AREA_POI_FLAG_WORLD)) return false;
  // m_currentZone < 0 && m_currentOrphanZone < 0: the continent, the world and the cosmic maps.
  if ((view === "continent" || view === "world" || view === "cosmic") && !(flags & AREA_POI_FLAG_CONTINENT)) return false;
  return true;
}

/** The state index 0x00545a30 reads Icon[] with: the world state's value − 1, 0 outside 0..8. */
export function areaPoiIconState(poi: Pick<AreaPoiInfo, "worldStateId">, worldState: (id: number) => number | undefined): number {
  if (!poi.worldStateId) return 0;
  const state = ((worldState(poi.worldStateId) ?? 0) - 1) >>> 0;
  return state >= 9 ? 0 : state;
}

/** GetMapLandmarkInfo's texture index for an AreaPOI row (0x00545a30). */
export function areaPoiLandmarkIcon(view: FrameXmlLandmarkView, poi: Pick<AreaPoiInfo, "flags" | "icons" | "worldStateId">,
  worldState: (id: number) => number | undefined): number {
  const shown = (poi.flags & AREA_POI_FLAG_ALWAYS_ICON) !== 0 || view === "continent" || view === "world";
  return shown ? poi.icons[areaPoiIconState(poi, worldState)] ?? 0 : 0;
}
