/**
 * 05.10-A7b-4 (7.13, 7.14): the area locator wired to the running game — one per realm session, made on
 * first use from `game.areas` and `game.gatewayOrigin`, so neither the context nor the world entry carry
 * a field for it. The game loop feeds it the character's position once a frame (`updateLiveAreaLocator`);
 * the minimap, the stock UI's zone texts and the rain read what it found.
 *
 * Against a gateway older than `/dbc/wmo-areas` (R1) and `/minimap/wmo` (R2) everything degrades to the
 * client before this slice: the terrain grid's area, the map's name for a dungeon, the MOGP flag for
 * indoors, the ADT minimap.
 */

import { AreaLocator, indoorZoneTexts, type AreaLocatorSources, type LocatorFloor } from "./AreaLocator.js";
import type { AreaClient } from "./AreaClient.js";
import { game } from "./game/Context.js";
import type { EnvironmentObject } from "./Terrain.js";
import { WmoAreaClient } from "./WmoAreaClient.js";
import { drawWmoMinimap, type WmoMinimapDrawSource } from "./WmoMinimapDraw.js";
import { WmoMinimapTileClient } from "./WmoMinimapTiles.js";

interface LiveSession {
  readonly areas: AreaClient;
  readonly origin: string;
  readonly table: WmoAreaClient;
  readonly tiles: WmoMinimapTileClient;
  readonly locator: AreaLocator<EnvironmentObject>;
  readonly sources: AreaLocatorSources<EnvironmentObject> & { objects: readonly EnvironmentObject[] };
}

let session: LiveSession | undefined;

function sessionNow(): LiveSession | undefined {
  const areas = game.areas;
  const origin = game.gatewayOrigin;
  if (!areas || !origin) {
    if (session) {
      session.table.stop();
      session.tiles.clear();
      session = undefined;
    }
    return undefined;
  }
  if (session && session.areas === areas && session.origin === origin) return session;
  session?.table.stop();
  session?.tiles.clear();
  const table = new WmoAreaClient(origin);
  const sources: LiveSession["sources"] = {
    objects: [],
    floor: (map, x, y, fromZ, minZ) => {
      const collision = game.collision;
      // No collision source at all is a current «no WMO floor», not a wait.
      if (!collision) return null;
      return collision.staticWmoFloorState(map, x, y, fromZ, minZ) as LocatorFloor | null | undefined;
    },
    gridAreaId: (map, x, y) => game.terrain?.areaAt(map, x, y),
    gridHeight: (map, x, y) => game.terrain?.heightAt(map, x, y),
    mapAreaTableId: (map) => areas.map(map)?.areaTableId,
    areaFlags: (areaId) => areas.area(areaId)?.flags,
    table: () => table.table(),
  };
  session = { areas, origin, table, tiles: new WmoMinimapTileClient(origin), locator: new AreaLocator(), sources };
  return session;
}

/** Once a frame from the game loop, with the placements the renderer gets; the locator throttles itself. */
export function updateLiveAreaLocator(
  now: number,
  mapId: number | undefined,
  position: { readonly x: number; readonly y: number; readonly z: number },
  objects: readonly EnvironmentObject[],
): AreaLocator<EnvironmentObject> | undefined {
  const live = sessionNow();
  if (!live || mapId === undefined) return undefined;
  live.sources.objects = objects;
  live.locator.update(now, mapId, position.x, position.y, position.z, live.sources);
  return live.locator;
}

/** The locator of this session, for a reader; undefined before the first world frame. */
export function liveAreaLocator(): AreaLocator<EnvironmentObject> | undefined {
  return sessionNow()?.locator;
}

/**
 * The located area at the character, the server's rule (WMO room → grid → map); the terrain grid alone
 * while the locator has not answered for this map.
 */
export function liveAreaIdAt(mapId: number | undefined, x: number, y: number): number {
  const locator = sessionNow()?.locator;
  // 05.10 review A7b-4: only for the point the locator follows (the loop feeds it the camera's subject,
  // a far-sight eye included); anywhere else the terrain grid, as before.
  if (locator && locator.answersAt(mapId, x, y)) return locator.location.areaId;
  return game.terrain?.areaAt(mapId, x, y) ?? 0;
}

/**
 * 05.10 review A7b-4: the client's ZONE_CHANGED_INDOORS test (the floor's group without MOGP 0x8,
 * Wow.exe 0x007A1480) — undefined while the locator has no current answer, the caller then keeps its own.
 */
export function liveWmoInterior(): boolean | undefined {
  return session?.locator.wmoInterior;
}

/** The room's names over the outdoor texts (`indoorZoneTexts`); the texts unchanged outside a room. */
export function liveIndoorZoneTexts(zoneText: string, subZoneText: string, leafName: string): { zoneText: string; subZoneText: string } {
  const live = sessionNow();
  const keys = live?.locator.interiorKeys;
  if (!live || !keys) return { zoneText, subZoneText };
  return indoorZoneTexts(live.table.table(), keys, zoneText, subZoneText, leafName, (id) => live.areas.area(id)?.name);
}

/** Moves whenever the WMO minimap may draw something else (the floor, a building's answer). */
export function liveWmoMinimapRevision(): number {
  const live = session;
  return live ? live.locator.revision * 4096 + live.tiles.revision : -1;
}

const DRAW_SOURCE: {
  placement: WmoMinimapDrawSource["placement"]; groups: WmoMinimapDrawSource["groups"]; floorGroup: number;
  path: string; tiles: WmoMinimapTileClient | undefined;
} & WmoMinimapDrawSource = {
  placement: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 },
  groups: [],
  floorGroup: -1,
  path: "",
  tiles: undefined,
  cells(groupIndex) {
    return this.tiles?.groupTiles(this.path, groupIndex);
  },
  picture(hash) {
    return game.minimapTiles?.picture(hash);
  },
};

/**
 * The building's bakes in the minimap circle, when the character stands on an interior group of a WMO
 * that has them; 0 when nothing was drawn (the caller then draws the ADT tiles, as before).
 */
export function drawLiveWmoMinimap(
  context: CanvasRenderingContext2D,
  mapId: number,
  position: { readonly x: number; readonly y: number; readonly z?: number },
  scale: number,
): number {
  const live = session;
  const locator = live?.locator;
  const floor = locator?.floor;
  const visual = locator?.visual;
  if (!live || !locator || locator.map !== mapId || !floor || !visual || position.z === undefined) return 0;
  if (!locator.answersAt(mapId, position.x, position.y)) return 0; // 05.10 review A7b-4: a far-sight eye's building
  if ((floor.groupFlags & 0x8) !== 0) return 0;
  // The building's answer first: most WMOs have no bakes, and that is known after one request.
  if (!live.tiles.hasTiles(visual.name)) return 0;
  const groups = game.collision?.models.model(floor.placement.modelName ?? visual.name)?.groups;
  if (!groups) return 0;
  DRAW_SOURCE.placement = floor.placement;
  DRAW_SOURCE.groups = groups;
  DRAW_SOURCE.floorGroup = floor.groupIndex;
  DRAW_SOURCE.path = visual.name;
  DRAW_SOURCE.tiles = live.tiles;
  DRAW_AT.x = position.x;
  DRAW_AT.y = position.y;
  DRAW_AT.z = position.z;
  return drawWmoMinimap(context, DRAW_SOURCE, DRAW_AT, scale);
}

const DRAW_AT = { x: 0, y: 0, z: 0 };
