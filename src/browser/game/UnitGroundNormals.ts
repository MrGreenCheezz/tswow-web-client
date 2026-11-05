/**
 * 05.11 (6.44): the ground under each unit, for the lean its model may ask for (world/UnitTilt.ts).
 *
 * The answer is the page's because the collision world is: terrain and floors both, the highest surface at the unit's
 * feet or below. Wow.exe reads the same column at any height: on the stand a horse jumped 1, 3, 15 and 40 yards over a
 * slope took the slope's lean, with a flying flag too, and one 2 yards under the ground took none. A unit is read again
 * only when it has moved, so a crowd standing costs nothing.
 */

import type { GroundNormal } from "../../world/UnitTilt.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { Vector3 } from "./Collision.js";

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
/** Nothing leans on level ground, and most ground a unit stands on is level: one record for all of them. */
const STRAIGHT_UP: GroundNormal = Object.freeze([0, 0, 1] as const);
/** A triangle of terrain is two yards across at its smallest: half a yard finds the next one in time. */
const RESAMPLE_YARDS = 0.5;
/** How far over its own place a surface still counts as under a unit's feet: a server's height is not exact. */
const FEET_REACH = 1;
/** How far down the column is read. Measured to 40 yards with no change; this is every floor there is. */
const LOOK_DOWN = 2000;
/** The step of the terrain's slope: inside one triangle unless the unit stands on an edge, where it averages both. */
const TERRAIN_STEP = 0.1;
/** A frame's worth of readings. A city's crowd is spread over a few frames and nothing is lost by it. */
const READINGS_PER_FRAME = 32;
const SAME_NORMAL = 1e-4;

export interface UnitGroundSources {
  readonly map: number | undefined;
  readonly terrain: {
    residentHeightAt(map: number, x: number, y: number): number | undefined;
    isHole(map: number | undefined, x: number, y: number): boolean;
  } | undefined;
  readonly collision: {
    floorNormalUnder(x: number, y: number, fromZ: number, minZ: number, out: Vector3): number | undefined;
  } | undefined;
}

interface ReadPlace {
  x: number;
  y: number;
  z: number;
  /** The last frame the unit was there to be read, which is how a unit gone is told. */
  stamp: number;
}

export class UnitGroundNormals {
  readonly normals = new Map<bigint, GroundNormal>();
  readonly #read = new Map<bigint, ReadPlace>();
  readonly #floor: Vector3 = { x: 0, y: 0, z: 1 };
  #map: number | undefined;
  #stamp = 0;

  /** This frame's map: the entries of units that have moved are read again, those of units gone dropped. */
  collect(objects: ReadonlyMap<bigint, WorldObjectState> | undefined, sources: UnitGroundSources | undefined): ReadonlyMap<bigint, GroundNormal> {
    const normals = this.normals;
    const read = this.#read;
    if (objects === undefined || sources === undefined || sources.map === undefined) {
      normals.clear();
      read.clear();
      return normals;
    }
    if (sources.map !== this.#map) {
      this.#map = sources.map;
      normals.clear();
      read.clear();
    }
    const stamp = ++this.#stamp;
    let budget = READINGS_PER_FRAME;
    for (const object of objects.values()) {
      if (object.typeId !== TYPEID_UNIT && object.typeId !== TYPEID_PLAYER) continue;
      const position = object.position;
      // On a transport the ground is the deck's, whose normal the renderer does not lean by.
      if (position === undefined || object.transport !== undefined) continue;
      const place = read.get(object.guid);
      if (place !== undefined) {
        place.stamp = stamp;
        if (Math.abs(place.x - position.x) < RESAMPLE_YARDS && Math.abs(place.y - position.y) < RESAMPLE_YARDS
          && Math.abs(place.z - position.z) < RESAMPLE_YARDS) continue;
      }
      if (budget === 0) continue;
      budget--;
      const normal = this.#groundUnder(position.x, position.y, position.z, sources);
      // Nothing resident there yet: asked again next frame, and whatever was known stands until then.
      if (normal === undefined) continue;
      if (place === undefined) read.set(object.guid, { x: position.x, y: position.y, z: position.z, stamp });
      else {
        place.x = position.x;
        place.y = position.y;
        place.z = position.z;
      }
      const old = normals.get(object.guid);
      if (old === undefined || !sameNormal(old, normal)) normals.set(object.guid, normal);
    }
    for (const [guid, place] of read) {
      if (place.stamp === stamp) continue;
      read.delete(guid);
      normals.delete(guid);
    }
    return normals;
  }

  #groundUnder(x: number, y: number, z: number, sources: UnitGroundSources): GroundNormal | undefined {
    const map = sources.map!;
    const fromZ = z + FEET_REACH;
    const terrain = sources.terrain;
    let terrainZ = terrain === undefined || terrain.isHole(map, x, y) ? undefined : terrain.residentHeightAt(map, x, y);
    if (terrainZ !== undefined && terrainZ > fromZ) terrainZ = undefined; // A hill over a cave.
    const floor = this.#floor;
    const floorZ = sources.collision?.floorNormalUnder(x, y, fromZ, terrainZ ?? z - LOOK_DOWN, floor);
    if (floorZ !== undefined && (terrainZ === undefined || floorZ >= terrainZ)) return normalOf(floor.x, floor.y, floor.z);
    if (terrainZ === undefined) return undefined;
    const east = terrain!.residentHeightAt(map, x + TERRAIN_STEP, y);
    const west = terrain!.residentHeightAt(map, x - TERRAIN_STEP, y);
    const north = terrain!.residentHeightAt(map, x, y + TERRAIN_STEP);
    const south = terrain!.residentHeightAt(map, x, y - TERRAIN_STEP);
    if (east === undefined || west === undefined || north === undefined || south === undefined) return undefined;
    const slopeX = (east - west) / (2 * TERRAIN_STEP);
    const slopeY = (north - south) / (2 * TERRAIN_STEP);
    const length = Math.hypot(slopeX, slopeY, 1);
    return normalOf(-slopeX / length, -slopeY / length, 1 / length);
  }
}

function normalOf(x: number, y: number, z: number): GroundNormal {
  return 1 - z < SAME_NORMAL ? STRAIGHT_UP : [x, y, z];
}

function sameNormal(a: GroundNormal, b: GroundNormal): boolean {
  return Math.abs(a[0] - b[0]) < SAME_NORMAL && Math.abs(a[1] - b[1]) < SAME_NORMAL && Math.abs(a[2] - b[2]) < SAME_NORMAL;
}
