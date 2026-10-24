/**
 * Plan item 3.58 tail (25.10): the Azeroth world map's projection, as Wow.exe 3.3.5a 12340 computes it
 * (descriptions only; addresses from the wowdecomp reconstruction).
 *
 * The world map (`SetMapZoom(0)`, CGWorldMap::m_currentContinent −1) has no WorldMapArea rectangle: a world
 * position is placed by its continent's WorldMapContinent row. CGWorldMap::GetWorldPosition (0x00544140):
 *
 * 1. TransformPosition (0x00543920): the first WorldMapTransforms row of the position's map whose region holds
 *    it moves it onto its new map by the row's offset (an instance drawn on its continent); otherwise it stays.
 * 2. GetContinentRec (0x00544090): the last WorldMapContinent row of that map. None: no position (0, 0).
 * 3. u = ContinentOffset[0] / 62.625 + 0.5 − y · Scale / 33,400 and v = ContinentOffset[1] / 41.75 + 0.5 −
 *    x · Scale / 22,266.7 — the constants 0.015968064, 0.00002994012, 0.023952097, 0.000044910183: the world
 *    art is 1002 × 668 at 16 pixels per ADT tile of 533⅓ yards. Not clamped to the map.
 * 4. A position on map 530 (Outland) is flagged: the player arrow (GetPlayerPosition 0x005444F0) and the
 *    landmarks (GetPOIPosition 0x005445F0, the gossip POI in SetMap 0x00546310) are then (0, 0); the corpse and
 *    the release point (0x00545950, 0x005459C0) are not.
 *
 * The continent highlight rectangles of the same map (CGWorldMap::InitializeGame 0x00547EB0, read by
 * GetMapHighlight 0x00544420 and ProcessClick 0x005468F0) use the same placement over the ADT boundaries:
 * left = (LeftBoundary · Scale + 31.3125 − 32 · Scale + ContinentOffset[0]) / 62.625, right with RightBoundary + 1,
 * top and bottom likewise over 41.75 with 20.875.
 */
import type { ContinentInfo, MapTransformInfo } from "../../gateway/AreaMetadata.js";

/** Map.dbc 530: a position there is off the Azeroth world map (0x00544140's `outland`). */
export const WORLD_MAP_OUTLAND_MAP = 530;

/** 1 / 62.625 and 1 / 41.75: one ADT tile on the 1002 × 668 world art (0x00547EB0, 0x00544140). */
const TILE_U = 0.015968064;
const TILE_V = 0.023952097;
/** 1 / (62.625 · 533⅓) and 1 / (41.75 · 533⅓): one yard. */
const YARD_U = 0.00002994012;
const YARD_V = 0.000044910183;

export interface WorldMapProjectionData {
  readonly continents: readonly ContinentInfo[];
  readonly transforms: readonly MapTransformInfo[];
}

/** TransformPosition (0x00543920): the first row of `mapId` whose region holds (x, y), or none. */
export function worldMapTransform(transforms: readonly MapTransformInfo[], mapId: number, x: number, y: number):
  MapTransformInfo | undefined {
  for (const row of transforms) {
    if (row.mapId !== mapId) continue;
    // RegionMin/RegionMax as the DBC holds them; the gateway names them bottom/top (x) and right/left (y).
    if (x < Math.min(row.regionBottom, row.regionTop) || x > Math.max(row.regionBottom, row.regionTop)
      || y < Math.min(row.regionRight, row.regionLeft) || y > Math.max(row.regionRight, row.regionLeft)) continue;
    return row;
  }
  return undefined;
}

/** GetContinentRec (0x00544090): the last WorldMapContinent row of a map. */
export function worldMapContinent(continents: readonly ContinentInfo[], mapId: number): ContinentInfo | undefined {
  for (let index = continents.length - 1; index >= 0; index--) {
    if (continents[index]!.mapId === mapId) return continents[index];
  }
  return undefined;
}

/**
 * GetWorldPosition's world-map branch (0x00544140): where world (x, y) on `mapId` falls on the Azeroth world
 * map, unclamped, and whether it is in Outland; undefined when no continent row places it (Wow.exe: 0, 0).
 */
export function worldMapPoint(data: WorldMapProjectionData, mapId: number, x: number, y: number):
  { u: number; v: number; outland: boolean } | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const transform = worldMapTransform(data.transforms, mapId, x, y);
  const newMapId = transform ? transform.newMapId : mapId;
  const tx = transform ? x + transform.offsetX : x;
  const ty = transform ? y + transform.offsetY : y;
  const continent = worldMapContinent(data.continents, newMapId);
  if (!continent) return undefined;
  return {
    u: continent.offsetX * TILE_U + 0.5 - ty * YARD_U * continent.scale,
    v: continent.offsetY * TILE_V + 0.5 - tx * YARD_V * continent.scale,
    outland: newMapId === WORLD_MAP_OUTLAND_MAP,
  };
}

/** A continent's highlight rectangle on the world art (0x00547EB0), normalized: [left, top, right, bottom]. */
export function worldMapContinentRect(continent: ContinentInfo): readonly [number, number, number, number] {
  const offset = continent.scale * 32;
  const x = 31.3125 - offset + continent.offsetX;
  const y = 20.875 - offset + continent.offsetY;
  return [
    continent.left * continent.scale * TILE_U + x * TILE_U,
    continent.top * continent.scale * TILE_V + y * TILE_V,
    x * TILE_U + TILE_U * ((continent.right + 1) * continent.scale),
    y * TILE_V + TILE_V * ((continent.bottom + 1) * continent.scale),
  ];
}
