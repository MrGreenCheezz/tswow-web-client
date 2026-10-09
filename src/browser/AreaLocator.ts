/**
 * 05.10-A7b-4 (7.13, 7.01): which area a point is in and whether it is outdoors — the server's rule,
 * computed in one place for the minimap, the stock UI's zone texts, the zone sound and the rain.
 *
 * The server never says which sub-area or room the character is in (`SMSG_INIT_WORLD_STATES` names a zone
 * on a zone change; there is no packet for a room), so the client counts it, and TrinityCore's own answer
 * is the one to repeat (Map.cpp):
 *
 * - `GetAreaId` (:2694-2728): the vmap floor under the point wins when the point stands on it
 *   (`z >= vmapZ − 0.05`) and it is not under the terrain (`z < gridZ − 0.05 || vmapZ > gridZ`); then
 *   the WMOAreaTable row of (root WMO id, MODF name set, MOGP group id) gives `AreaTableID` when non-zero;
 *   otherwise the terrain grid's area; otherwise `Map.AreaTableID` — the zone of a dungeon that is one WMO
 *   with no terrain at all (Wailing Caverns → 718).
 * - the outdoors half of the full status (:2882-2911): on a WMO floor, MOGP `0x8`, overridden by the row's
 *   `Flags & 4` (outdoors) and then `Flags & 2` (indoors); with no WMO floor, the grid area's
 *   `AreaTable.Flags`: outdoors unless INSIDE (0x02000000) is set without OUTSIDE (0x04000000).
 *
 * The floor is the collision floor the physics stands on (`CollisionSource.staticWmoFloorState`: static
 * WMOs only, as the server's area query skips M2s); its (root id, name set) come from the visual tile's
 * placement of the same building (visual-tile-v5 `wmoId`/`nameSet`, slice A7b-1), matched to the vmap
 * spawn by model name and transform the way the renderer's fog locator does. A v4 tile without the two
 * fields, or a gateway without `/dbc/wmo-areas`, leaves the WMO half out: the grid area and the MOGP flag
 * alone, which is what the client did before this.
 *
 * Room names (`indoorZoneTexts`) are the client's, not the server's: the whole-building row (group −1)
 * replaces the zone text when its name differs from the sub-zone, and the group's own row names the
 * sub-zone — the 1.12.1 reading of the stock client (CPPClientExample/benilla `crates/benilla-app/src/area.rs`,
 * functions 0x67e670/0x69d830/0x69d8f0 of that build). 05.10 review A7b-4: the same rule in Wow.exe 3.3.5a
 * 12340 — 0x0078EC70 (called from the zone update 0x0078F020) takes the whole-building name from 0x007A1500
 * (row −1's name, else its AreaTableID's name, else the area under the player; no row → empty → no change),
 * replaces the zone text and clears the sub-zone when that name is not the sub-zone's, then lets the group's
 * own non-empty name (0x007A15B0) be the sub-zone; the zone setter 0x005204C0 stores both. Live check 14.24.
 *
 * Cost: `update` recomputes at most every `AREA_LOCATOR_INTERVAL_MS` or after a step of
 * `AREA_LOCATOR_STEP` yards, one collision column walk and two `Map.get`; between those it is a few
 * comparisons. The visual placement scan runs only when the building or the placement list changes.
 */

import { canonicalCollisionModelName } from "./CollisionClient.js";
import type { WmoAreaEntry, WmoAreaTable } from "./WmoAreaClient.js";

/** `AREA_FLAG_INSIDE` / `AREA_FLAG_OUTSIDE` (TrinityCore DBCEnums.h:274-275). */
export const AREA_FLAG_INSIDE = 0x0200_0000;
export const AREA_FLAG_OUTSIDE = 0x0400_0000;
/** WMOAreaTable `Flags` the core reads (Map.cpp :2891-2894). */
export const WMO_AREA_FLAG_INDOORS = 0x2;
export const WMO_AREA_FLAG_OUTDOORS = 0x4;
/** MOGP flag of a group open to the sky. */
export const MOGP_FLAG_EXTERIOR = 0x8;
/** `GROUND_HEIGHT_TOLERANCE` (TrinityCore SharedDefines.h:26). */
export const GROUND_HEIGHT_TOLERANCE = 0.05;
/** `INVALID_HEIGHT` (Map.h:293): a grid height that is not there. */
export const INVALID_HEIGHT = -100_000;

export const AREA_LOCATOR_INTERVAL_MS = 250;
export const AREA_LOCATOR_STEP = 0.5;
/** How far above the feet the floor search starts — the physics' WMO probe rise (input/Movement.ts). */
export const AREA_LOCATOR_RISE = 0.1;
/** How deep it looks (game/Physics.ts `FLOOR_SEARCH_DEPTH`). */
export const AREA_LOCATOR_DEPTH = 400;
/**
 * 05.10 review A7b-4: how far (yards, each axis) from the last computed point a not-current collision
 * still holds a building's answer — a step inside a room while a group is on its way. Past it (a same-map
 * teleport resets the collision) the grid answers alone; `answersAt` uses the same reach for readers
 * asking about another point (the character while the camera follows a far-sight eye).
 */
export const AREA_LOCATOR_HOLD = 20;

/** What the WMO floor under the point says, the inputs of `locateArea`. */
export interface AreaLocatorWmo {
  /** The floor's height. */
  readonly floorZ: number;
  /** MOGP flags of the floor's group. */
  readonly groupFlags: number;
  /** MOGP group id (the WMOAreaTable `WMOGroupID`). */
  readonly groupId: number;
  /** `MOHD.wmoID` and MODF `nameSet` of the placement; undefined on a tile without them. */
  readonly wmoId: number | undefined;
  readonly nameSet: number | undefined;
}

export interface AreaLocatorInput {
  readonly z: number;
  /** The WMO floor under the point, or undefined when there is none. */
  readonly wmo: AreaLocatorWmo | undefined;
  /** The terrain grid's area at the point; undefined/0 without one. */
  readonly gridAreaId: number | undefined;
  /** The terrain height at the point; undefined without terrain. */
  readonly gridHeight: number | undefined;
  /** `Map.AreaTableID`; undefined from a gateway older than the field. */
  readonly mapAreaTableId: number | undefined;
  readonly table: WmoAreaTable | undefined;
  /** `AreaTable.Flags` of an area, undefined when unknown. */
  readonly areaFlags: (areaId: number) => number | undefined;
}

export interface AreaLocation {
  /** The area id (0 when nothing names one). */
  areaId: number;
  outdoors: boolean;
  /** Whether the WMO floor took part (the server's `wmoData` branch). */
  onWmo: boolean;
  /** The WMOAreaTable row of the floor's group, when the floor took part and has one. */
  row: WmoAreaEntry | undefined;
}

export function emptyAreaLocation(): AreaLocation {
  return { areaId: 0, outdoors: true, onWmo: false, row: undefined };
}

/** Whether the server would take the WMO floor over the terrain grid at this height. */
export function wmoFloorWins(z: number, floorZ: number, gridHeight: number | undefined): boolean {
  const grid = gridHeight === undefined || !Number.isFinite(gridHeight) ? INVALID_HEIGHT : gridHeight;
  return z >= floorZ - GROUND_HEIGHT_TOLERANCE && (z < grid - GROUND_HEIGHT_TOLERANCE || floorZ > grid);
}

/** The core's area and outdoors answer (see the module comment), written into `out`. */
export function locateArea(input: AreaLocatorInput, out: AreaLocation): AreaLocation {
  const gridAreaId = input.gridAreaId !== undefined && input.gridAreaId > 0 ? input.gridAreaId : 0;
  const wmo = input.wmo;
  out.row = undefined;
  if (wmo && wmoFloorWins(input.z, wmo.floorZ, input.gridHeight)) {
    out.onWmo = true;
    const row = wmo.wmoId !== undefined && wmo.nameSet !== undefined
      ? input.table?.lookup(wmo.wmoId, wmo.nameSet, wmo.groupId) : undefined;
    out.row = row;
    let outdoors = (wmo.groupFlags & MOGP_FLAG_EXTERIOR) !== 0;
    let areaId = 0;
    if (row) {
      areaId = row.areaId;
      if ((row.flags & WMO_AREA_FLAG_OUTDOORS) !== 0) outdoors = true;
      else if ((row.flags & WMO_AREA_FLAG_INDOORS) !== 0) outdoors = false;
    }
    out.outdoors = outdoors;
    out.areaId = areaId || gridAreaId;
  } else {
    out.onWmo = false;
    out.areaId = gridAreaId;
    const flags = gridAreaId > 0 ? input.areaFlags(gridAreaId) : undefined;
    out.outdoors = flags === undefined || (flags & (AREA_FLAG_INSIDE | AREA_FLAG_OUTSIDE)) !== AREA_FLAG_INSIDE;
  }
  if (out.areaId === 0) out.areaId = input.mapAreaTableId !== undefined && input.mapAreaTableId > 0 ? input.mapAreaTableId : 0;
  return out;
}

/** The (root, name set, group) a room's names are looked up by. */
export interface IndoorKeys {
  readonly wmoId: number;
  readonly nameSet: number;
  readonly groupId: number;
}

/**
 * The client's zone and sub-zone texts inside a WMO room (benilla 1.12.1 reading, see the module
 * comment): `zoneText`/`subZoneText` are the outdoor texts, `leafName` the located area's own name.
 *
 * - The whole-building row: its name, else its `AreaTableID`'s name, else the leaf's. When that is not
 *   empty and differs from the sub-zone, it becomes the zone text and the sub-zone is cleared.
 * - The group's own row: a non-empty name becomes the sub-zone.
 * - No row at all changes nothing.
 */
export function indoorZoneTexts(
  table: WmoAreaTable | undefined,
  keys: IndoorKeys | undefined,
  zoneText: string,
  subZoneText: string,
  leafName: string,
  areaName: (areaId: number) => string | undefined,
): { zoneText: string; subZoneText: string } {
  if (!table || !keys) return { zoneText, subZoneText };
  const whole = table.whole(keys.wmoId, keys.nameSet);
  if (whole) {
    const name = whole.name !== "" ? whole.name : whole.areaId !== 0 ? areaName(whole.areaId) ?? "" : leafName;
    if (name !== "" && name !== subZoneText) {
      zoneText = name;
      subZoneText = "";
    }
  }
  const group = table.lookup(keys.wmoId, keys.nameSet, keys.groupId);
  if (group && group.name !== "") subZoneText = group.name;
  return { zoneText, subZoneText };
}

/** A vmap placement the locator can match to a visual one (`StaticWmoPlacementIdentity`). */
export interface LocatorPlacement {
  readonly map: number;
  readonly key: string;
  /** The vmap spawn's own spelling, the collision model's name. */
  readonly modelName?: string;
  readonly canonicalModelName: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationX: number;
  readonly rotationY: number;
  readonly rotationZ: number;
  readonly scale: number;
}

/** A visual placement as the environment tile carries it (`EnvironmentObject`). */
export interface LocatorVisual {
  readonly kind: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationX: number;
  readonly rotationY: number;
  readonly rotationZ: number;
  readonly scale: number;
  readonly wmoId?: number;
  readonly nameSet?: number;
}

/** The floor answer the locator reads (`CollisionSource.staticWmoFloorState`). */
export interface LocatorFloor {
  readonly placement: LocatorPlacement;
  readonly floorZ: number;
  readonly groupIndex: number;
  readonly groupId: number;
  readonly groupFlags: number;
}

const POSITION_EPSILON = 1e-4;
const ANGLE_EPSILON = 1e-4;
const SCALE_EPSILON = 1e-6;

function angleDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return Math.min(delta, 360 - delta);
}

/**
 * The same test as `staticWmoPlacementMatches` in WorldRenderer3D.ts (kept here so the locator does not
 * pull the renderer and three.js in): a WMO of the same file, at the same place, turned the same way.
 */
export function locatorPlacementMatches(raw: LocatorPlacement, visual: LocatorVisual): boolean {
  return visual.kind === "wmo"
    && Math.abs(visual.x - raw.x) <= POSITION_EPSILON
    && Math.abs(visual.y - raw.y) <= POSITION_EPSILON
    && Math.abs(visual.z - raw.z) <= POSITION_EPSILON
    && angleDistance(visual.rotationX, raw.rotationX) <= ANGLE_EPSILON
    && angleDistance(visual.rotationY, raw.rotationY) <= ANGLE_EPSILON
    && angleDistance(visual.rotationZ, raw.rotationZ) <= ANGLE_EPSILON
    && Math.abs(visual.scale - raw.scale) <= SCALE_EPSILON
    && canonicalCollisionModelName(visual.name) === raw.canonicalModelName;
}

/** The one visual placement of a vmap spawn; zero or several is no answer. */
export function uniqueLocatorVisual<T extends LocatorVisual>(raw: LocatorPlacement, objects: readonly T[]): T | undefined {
  let match: T | undefined;
  for (const object of objects) {
    if (!locatorPlacementMatches(raw, object)) continue;
    if (match) return undefined;
    match = object;
  }
  return match;
}

export interface AreaLocatorSources<V extends LocatorVisual> {
  /** `CollisionSource.staticWmoFloorState`: undefined while not current, null for no WMO floor. */
  floor(map: number, x: number, y: number, fromZ: number, minZ: number): LocatorFloor | null | undefined;
  /** The visual placements around the point (the array the renderer gets this frame). */
  readonly objects: readonly V[];
  gridAreaId(map: number, x: number, y: number): number | undefined;
  gridHeight(map: number, x: number, y: number): number | undefined;
  mapAreaTableId(map: number): number | undefined;
  areaFlags(areaId: number): number | undefined;
  table(): WmoAreaTable | undefined;
}

/**
 * The located area of one moving point, recomputed as it moves (see the module comment for the cost).
 *
 * Read the fields after `update`: `areaId`, `indoors` (undefined until the collision around the point is
 * current), `floor`/`visual` (the WMO floor that took part and its visual placement), `interiorKeys`
 * (the room's WMOAreaTable key while standing on an interior group), and `revision`, which moves whenever
 * any of them changes.
 */
export class AreaLocator<V extends LocatorVisual = LocatorVisual> {
  readonly location: AreaLocation = emptyAreaLocation();
  map: number | undefined;
  /** Outdoors negated; undefined until a current collision answer was had for this map. */
  indoors: boolean | undefined;
  /** The WMO floor that took part, and its visual placement when matched. */
  floor: LocatorFloor | undefined;
  visual: V | undefined;
  interiorKeys: IndoorKeys | undefined;
  revision = 0;
  #at = Number.NEGATIVE_INFINITY;
  #x = Number.NaN;
  #y = Number.NaN;
  #z = Number.NaN;
  /** 05.10 review A7b-4: where the last current collision answer was had. */
  #heldX = Number.NaN;
  #heldY = Number.NaN;
  #table: WmoAreaTable | undefined;
  #matchObjects: readonly V[] | undefined;
  #matchKey: string | undefined;
  #matchMap: number | undefined;
  #match: V | undefined;
  readonly #wmo = { floorZ: 0, groupFlags: 0, groupId: 0, wmoId: undefined as number | undefined, nameSet: undefined as number | undefined };
  readonly #input: {
    z: number; wmo: AreaLocatorWmo | undefined; gridAreaId: number | undefined; gridHeight: number | undefined;
    mapAreaTableId: number | undefined; table: WmoAreaTable | undefined; areaFlags: (areaId: number) => number | undefined;
  } = { z: 0, wmo: undefined, gridAreaId: undefined, gridHeight: undefined, mapAreaTableId: undefined, table: undefined, areaFlags: () => undefined };

  /** Recomputes when due; returns whether anything was recomputed. */
  update(now: number, map: number, x: number, y: number, z: number, sources: AreaLocatorSources<V>): boolean {
    const table = sources.table();
    const due = map !== this.map
      || table !== this.#table
      || now - this.#at >= AREA_LOCATOR_INTERVAL_MS
      || Math.abs(x - this.#x) >= AREA_LOCATOR_STEP
      || Math.abs(y - this.#y) >= AREA_LOCATOR_STEP
      || Math.abs(z - this.#z) >= AREA_LOCATOR_STEP;
    if (!due) return false;
    if (map !== this.map) {
      this.map = map;
      this.indoors = undefined;
      this.floor = undefined;
      this.visual = undefined;
      this.interiorKeys = undefined;
    }
    this.#table = table;
    this.#at = now;
    this.#x = x;
    this.#y = y;
    this.#z = z;
    const floor = sources.floor(map, x, y, z + AREA_LOCATOR_RISE, z - AREA_LOCATOR_DEPTH);
    // Not current (a tile or a group still on its way): the last current answer stands until the next
    // recompute. Before the first one there is none, and the grid half is answered alone — the zone label
    // of the client before this slice.
    // 05.10 review A7b-4: only a building's answer is held, and only near where it was had; off a
    // building, or after a far jump, the grid half answers now (the room left behind named the place).
    const wasOnWmo = this.location.onWmo;
    const notCurrent = floor === undefined && this.indoors !== undefined;
    if (notCurrent && wasOnWmo && Math.abs(x - this.#heldX) <= AREA_LOCATOR_HOLD
      && Math.abs(y - this.#heldY) <= AREA_LOCATOR_HOLD) return false;
    if (floor !== undefined) {
      this.#heldX = x;
      this.#heldY = y;
    }
    const visual = floor ? this.#visualOf(floor.placement, sources.objects) : undefined;
    let wmo: AreaLocatorWmo | undefined;
    if (floor) {
      const keys = this.#wmo;
      keys.floorZ = floor.floorZ;
      keys.groupFlags = floor.groupFlags;
      keys.groupId = floor.groupId;
      keys.wmoId = visual?.wmoId;
      keys.nameSet = visual?.nameSet;
      wmo = keys;
    }
    const input = this.#input;
    input.z = z;
    input.wmo = wmo;
    input.gridAreaId = sources.gridAreaId(map, x, y);
    input.gridHeight = wmo ? sources.gridHeight(map, x, y) : undefined;
    input.mapAreaTableId = sources.mapAreaTableId(map);
    input.table = table;
    input.areaFlags = sources.areaFlags;
    const before = this.location.areaId;
    const outdoorsBefore = this.location.outdoors;
    locateArea(input, this.location);
    const nextFloor = floor && this.location.onWmo ? floor : undefined;
    const nextVisual = nextFloor ? visual : undefined;
    const interior = nextFloor !== undefined && nextVisual?.wmoId !== undefined && nextVisual.nameSet !== undefined
      && (nextFloor.groupFlags & MOGP_FLAG_EXTERIOR) === 0;
    const keysChanged = interior
      ? this.interiorKeys === undefined || this.interiorKeys.wmoId !== nextVisual!.wmoId
        || this.interiorKeys.nameSet !== nextVisual!.nameSet || this.interiorKeys.groupId !== nextFloor!.groupId
      : this.interiorKeys !== undefined;
    if (keysChanged) {
      this.interiorKeys = interior
        ? Object.freeze({ wmoId: nextVisual!.wmoId!, nameSet: nextVisual!.nameSet!, groupId: nextFloor!.groupId })
        : undefined;
    }
    // 05.10 review A7b-4: off a building the grid's own answer stands while the collision catches up.
    const indoors = floor !== undefined || (notCurrent && !wasOnWmo) ? !this.location.outdoors : undefined;
    if (before !== this.location.areaId || outdoorsBefore !== this.location.outdoors || keysChanged
      || indoors !== this.indoors || nextFloor?.groupIndex !== this.floor?.groupIndex
      || nextFloor?.placement !== this.floor?.placement || nextVisual !== this.visual) this.revision++;
    this.indoors = indoors;
    this.floor = nextFloor;
    this.visual = nextVisual;
    return true;
  }

  /**
   * 05.10 review A7b-4: the client's own «inside a WMO group» — the floor's group without MOGP 0x8, as
   * Wow.exe 3.3.5a 0x007A1480 tests it for ZONE_CHANGED_INDOORS (the zone setter 0x005204C0 raises
   * 0xA6 + that answer). Not `indoors`: the server's outdoors reads WMOAreaTable Flags 4/2 and
   * AreaTable INSIDE, the client's event does not. Undefined until a current answer.
   */
  get wmoInterior(): boolean | undefined {
    if (this.indoors === undefined) return undefined;
    return this.floor !== undefined && (this.floor.groupFlags & MOGP_FLAG_EXTERIOR) === 0;
  }

  /** 05.10 review A7b-4: whether the answer belongs to this point (same map, within `AREA_LOCATOR_HOLD`). */
  answersAt(map: number | undefined, x: number, y: number): boolean {
    return map !== undefined && map === this.map
      && Math.abs(x - this.#x) <= AREA_LOCATOR_HOLD && Math.abs(y - this.#y) <= AREA_LOCATOR_HOLD;
  }

  /** Forgets everything (a realm left, a far teleport). */
  reset(): void {
    this.map = undefined;
    this.indoors = undefined;
    this.floor = undefined;
    this.visual = undefined;
    this.interiorKeys = undefined;
    this.#at = Number.NEGATIVE_INFINITY;
    this.#x = this.#y = this.#z = Number.NaN;
    this.#heldX = this.#heldY = Number.NaN;
    this.#table = undefined;
    this.#matchObjects = undefined;
    this.#matchKey = undefined;
    this.#matchMap = undefined;
    this.#match = undefined;
    const empty = emptyAreaLocation();
    Object.assign(this.location, empty);
    this.revision++;
  }

  #visualOf(placement: LocatorPlacement, objects: readonly V[]): V | undefined {
    if (objects === this.#matchObjects && placement.key === this.#matchKey && placement.map === this.#matchMap) return this.#match;
    this.#match = uniqueLocatorVisual(placement, objects);
    this.#matchObjects = objects;
    this.#matchKey = placement.key;
    this.#matchMap = placement.map;
    return this.#match;
  }
}
