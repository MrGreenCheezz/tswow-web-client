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
import type { CollisionModelGroup } from "../world/CollisionFormat.js";
import { wmoMinimapAlignment } from "./WmoMinimapAlign.js";
import { drawWmoMinimap, wmoWorldToModel, type WmoMinimapPicture } from "./WmoMinimapDraw.js";
import { wmoMinimapMode, type WmoMinimapMode } from "./WmoMinimapGate.js";
import {
  WmoMinimapTileList, orderWmoMinimapTiles, selectWmoMinimapTiles, wmoMinimapPictureCorners, wmoMinimapQueryBox,
  type WmoMinimapModel,
} from "./WmoMinimapSelect.js";
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

/** 12.10 (7.27): the tiles of the last query and what it was asked for (0x007F5BA0 queries again only on a change). */
const TILES = new WmoMinimapTileList();
const QUERY = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const MODEL_AT = { x: 0, y: 0, z: 0 };
const LAST: {
  visual: EnvironmentObject | undefined; wmo: WmoMinimapModel | undefined;
  placement: LocatorFloor["placement"] | undefined; collision: readonly CollisionModelGroup[] | undefined;
  group: number; mode: WmoMinimapMode | undefined; cellX: number; cellY: number; radius: number;
  tiles: WmoMinimapTileClient | undefined; tilesRevision: number;
  queried: WmoMinimapModel | undefined; queriedAt: LocatorFloor["placement"] | undefined;
  /** How many of the query's tiles have a bake. */
  baked: number;
} = {
  visual: undefined, wmo: undefined, placement: undefined, collision: undefined,
  group: -1, mode: undefined, cellX: Number.NaN, cellY: Number.NaN, radius: Number.NaN, tiles: undefined, tilesRevision: -1,
  queried: undefined, queriedAt: undefined, baked: 0,
};

function picture(hash: string): WmoMinimapPicture | undefined {
  return game.minimapTiles?.picture(hash);
}

/**
 * 12.10 (7.27): the building minimap — Wow.exe's choice (`WmoMinimapGate.ts`) between it and the terrain
 * minimap, its tiles (`WmoMinimapSelect.ts`) and their lay (`WmoMinimapDraw.ts`). True when the building
 * minimap owns the circle (drawn on the caller's dark background, pictures still on their way included);
 * false leaves the ADT tiles to the caller.
 *
 * `radius` is the circle's radius in yards — where the original uses its indoor zoom table (25…150 yards,
 * `minimapInsideZoom`), this client keeps its one zoom for both minimaps.
 *
 * Kept from before, and not the original's: a building whose bakes are not known (none — most WMOs — or a
 * gateway without `/minimap/wmo`) keeps the terrain minimap, where the original draws its empty render
 * target (a black circle); so does a building whose visual artifact or collision model is not here yet.
 * Until the WMOAreaTable answers (or on a tile older than visual-tile-v5, which has no root id) the choice
 * is made without the rows, and then an empty query keeps the terrain too: Stormwind's streets lit as
 * exterior are interiors to the MOGP flag alone, and without the root row they would go dark.
 */
export function drawLiveWmoMinimap(
  context: CanvasRenderingContext2D,
  mapId: number,
  position: { readonly x: number; readonly y: number; readonly z?: number },
  scale: number,
  radius: number,
): boolean {
  const live = session;
  const locator = live?.locator;
  const floor = locator?.floor;
  const visual = locator?.visual;
  if (!live || !locator || locator.map !== mapId || !floor || !visual || position.z === undefined) return false;
  if (!locator.answersAt(mapId, position.x, position.y)) return false; // 05.10 review A7b-4: a far-sight eye's building
  // 0x007F5BA0 (via 0x007A1640): the group's row and the whole building's row.
  const table = live.table.table();
  const wmoId = visual.wmoId, nameSet = visual.nameSet;
  const groupRow = wmoId !== undefined && nameSet !== undefined ? table?.lookup(wmoId, nameSet, floor.groupId) : undefined;
  const rootRow = wmoId !== undefined && nameSet !== undefined ? table?.whole(wmoId, nameSet) : undefined;
  const mode = wmoMinimapMode(floor.groupFlags, groupRow?.flags, rootRow?.flags);
  if (mode === "terrain") return false;
  const rowsKnown = table !== undefined && wmoId !== undefined && nameSet !== undefined;
  // The building's answer first: most WMOs have no bakes, and that is known after one request.
  if (!live.tiles.hasTiles(visual.name)) return false;
  // The file's groups and portals (the visual artifact) and the collision's, lined up once per building.
  if (visual !== LAST.visual || !LAST.wmo) {
    LAST.visual = visual;
    LAST.wmo = game.environment?.model(visual.name)?.wmo;
  }
  if (floor.placement !== LAST.placement || !LAST.collision) {
    LAST.placement = floor.placement;
    LAST.collision = game.collision?.models.model(floor.placement.modelName ?? visual.name)?.groups;
  }
  const wmo = LAST.wmo, collision = LAST.collision;
  if (!wmo || !collision) return false;
  const alignment = wmoMinimapAlignment(wmo.groups, collision);
  const current = alignment?.visualOfCollision[floor.groupIndex] ?? -1;
  const group = wmo.groups[current];
  if (!alignment || !group) return false;
  const cellX = Math.floor(position.x / radius);
  const cellY = Math.floor(position.y / radius);
  if (current !== LAST.group || mode !== LAST.mode || cellX !== LAST.cellX || cellY !== LAST.cellY || radius !== LAST.radius
    || live.tiles !== LAST.tiles || live.tiles.revision !== LAST.tilesRevision || wmo !== LAST.queried
    || floor.placement !== LAST.queriedAt) {
    LAST.group = current;
    LAST.mode = mode;
    LAST.cellX = cellX;
    LAST.cellY = cellY;
    LAST.radius = radius;
    LAST.tiles = live.tiles;
    LAST.tilesRevision = live.tiles.revision;
    LAST.queried = wmo;
    LAST.queriedAt = floor.placement;
    wmoMinimapQueryBox(floor.placement, position.x, position.y, position.z, radius, group.bounds.maxZ, QUERY);
    selectWmoMinimapTiles(TILES, wmo, mode, current, QUERY, alignment.stops);
    wmoWorldToModel(floor.placement, position.x, position.y, position.z, MODEL_AT);
    LAST.baked = 0;
    for (let at = 0; at < TILES.count; at++) {
      TILES.hashes[at] = live.tiles.groupTiles(visual.name, TILES.group[at]!)?.get(`${TILES.x[at]}-${TILES.y[at]}`);
      if (TILES.hashes[at] !== undefined) LAST.baked++;
      wmoMinimapPictureCorners(TILES, at, floor.placement, MODEL_AT.z);
    }
    orderWmoMinimapTiles(TILES, current, MODEL_AT.z);
  }
  if (!rowsKnown && LAST.baked === 0) return false;
  drawWmoMinimap(context, TILES, picture, position, scale, radius);
  return true;
}

