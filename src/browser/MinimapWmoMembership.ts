/**
 * 3.13 (15.11): which building an object on the minimap stands in, and what the minimap does with it — Wow.exe 3.3.5a
 * 12340, Ghidra read-only (`.runtime/re-2026-11-07/313/mm.c`, `mm2.c`, `draw.c`, `gt2.c`; `.runtime/re-2026-11-15/quest5/`).
 *
 * The original:
 * - Every CGObject_C gets a map entity when its model is made (0x00743760 writes object+0xB8 from 0x00781A10, which
 *   wraps the model). The map keeps that entity's parent links (+0x20): the WMO groups it is linked into, the same
 *   links the renderer uses to draw a unit inside a room.
 * - 0x0077F090 → 0x007A1480 ("is the entity indoors") walks those links: the first group whose MOGP flags lack 0x8
 *   (exterior) says yes; an exterior group says no unless its placement carries flag 0x400, which skips to the next
 *   link. 0x0077F160 → 0x007A18D0 then gives the building of that link: MOHD `wmoID` and a second word of the same
 *   model object (CMapObj+4), and the group index — the minimap compares only the first two.
 * - The minimap rebuilds its object lists (0x0057F7F0 over every object, through 0x004D4B30) at most once a second,
 *   or at once on a zoom, a turn of the map or a new map (0x0057DCA0 tail: `999 < now − last`). For the player it
 *   asks the same two functions of its own entity. Then, for each object the earlier tests keep:
 *   - the player in a building (its first word non-zero): only an object of the same building is listed, plain;
 *   - the player outside: every object is listed, and one in a building is marked (`+0x18`).
 *   Party and raid members are listed by their own loop and never marked.
 * - A marked object's icon is drawn after the plain ones, its vertex colour (0xB0, 0xB0, 0xB0, 0xFF) — 0x00580380 with
 *   1 after 0 — and its name in the minimap tooltip is wrapped in `|cffb0b0b0 … |r`, subname lines included (0x0057C720).
 *   The rotated lists (0x00580720) skip a marked entry altogether; this client draws none of those lists.
 *
 * This client: the map entity's links do not exist here. The nearest it has is the collision floor under the object —
 * the same static-WMO column walk the area locator and the indoor minimap read for the player
 * (`CollisionSource.staticWmoFloorState`), kept only when the server would take that floor over the terrain under it
 * (`wmoFloorWins`, Map.cpp `GetAreaId`). "In a building" is that floor's group without MOGP 0x8, the same test
 * 0x007A1480 makes of its first link; the 0x400 skip is not repeated (the placement flag is not known here). The
 * building's identity is the placement's model (`canonicalModelName`): both words Wow.exe compares are read from the
 * model object, not from the placement, so two placements of one WMO count as one building there too.
 *
 * Cost: one column walk per listed object (not per object in view: only those the earlier tests already put on the
 * map), and only when it is due — its first sight or a new map, else once a second has passed (Wow.exe's own rebuild
 * cadence) and since its last walk it moved half a yard, the collision changed, or the collision could not answer. A
 * standing crowd costs nothing; a moving one at most one walk per object per second. The collision exists only around
 * the player (90 yards plus a margin): farther objects answer "not in a building" until their walls are built.
 */

import { wmoFloorWins } from "./AreaLocator.js";

/** MOGP flag of a group open to the sky (0x007A1480 tests `flags & 8`). */
export const MINIMAP_WMO_EXTERIOR = 0x8;
/** Wow.exe rebuilds the minimap's object lists at most once in this many milliseconds (0x0057DCA0, `999 <`). */
export const MINIMAP_WMO_RECHECK_MS = 1000;
/** A move smaller than this (yards, each axis) does not ask the collision again. */
export const MINIMAP_WMO_STEP = 0.5;
/** How far above the feet the floor search starts, and how deep it goes (the area locator's rise and depth). */
const RISE = 0.1;
const DEPTH = 400;

/** The vertex colour of a marked icon, over 255 (0x00580380: 0xB0). */
export const MINIMAP_WMO_GREY = 0xb0 / 0xff;

/** What the collision says under a point (the part of `StaticWmoFloor` read here). */
export interface MinimapWmoFloor {
  readonly floorZ: number;
  readonly groupFlags: number;
  readonly placement: { readonly canonicalModelName: string };
}

export interface MinimapWmoSources {
  /** `CollisionSource.staticWmoFloorState`: undefined while not current, null for no WMO floor. */
  floor(map: number, x: number, y: number, fromZ: number, minZ: number): MinimapWmoFloor | null | undefined;
  /** The terrain height there; undefined without terrain. */
  gridHeight(map: number, x: number, y: number): number | undefined;
  /** Moves whenever the collision changed (`CollisionSource.revision`). */
  readonly revision: number;
}

/**
 * The building an object at (x, y, z) stands inside, as this client can tell it: undefined outside one; `null` while
 * the collision there is not current.
 */
export function minimapWmoBuildingAt(
  sources: MinimapWmoSources, map: number, x: number, y: number, z: number,
): string | undefined | null {
  const floor = sources.floor(map, x, y, z + RISE, z - DEPTH);
  if (floor === undefined) return null;
  if (floor === null || (floor.groupFlags & MINIMAP_WMO_EXTERIOR) !== 0) return undefined;
  if (!wmoFloorWins(z, floor.floorZ, sources.gridHeight(map, x, y))) return undefined;
  return floor.placement.canonicalModelName;
}

/** What 0x0057F7F0 does with an object once the player's building and the object's are known. */
export type MinimapWmoVerdict = "plain" | "grey" | "hidden";

export function minimapWmoVerdict(player: string | undefined, object: string | undefined): MinimapWmoVerdict {
  if (player !== undefined) return object === player ? "plain" : "hidden";
  return object === undefined ? "plain" : "grey";
}

interface Entry {
  building: string | undefined;
  known: boolean;
  x: number;
  y: number;
  z: number;
  at: number;
  revision: number;
  map: number;
  seen: number;
}

/** The buildings of the objects the minimap lists, asked of the collision only when due (see the module comment). */
export class MinimapWmoMembership {
  readonly #entries = new Map<bigint, Entry>();
  #pass = 0;
  /** Column walks made so far, for tests and the diagnostics. */
  walks = 0;

  /** Starts a listing pass; entries not asked for during the pass are dropped by `end`. */
  begin(): void {
    this.#pass++;
  }

  /** Forgets the objects not asked for since `begin`. */
  end(): void {
    for (const [guid, entry] of this.#entries) if (entry.seen !== this.#pass) this.#entries.delete(guid);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** The building `guid` stands in (undefined: none, or not known yet). */
  buildingOf(
    guid: bigint, map: number, position: { readonly x: number; readonly y: number; readonly z: number },
    now: number, sources: MinimapWmoSources,
  ): string | undefined {
    let entry = this.#entries.get(guid);
    // Wow.exe's lists are a second old at most, so nothing here is asked again sooner; within that, only what may
    // have changed — a move, other walls, another map, or an answer the collision could not give yet.
    const due = entry === undefined || entry.map !== map
      || (now - entry.at >= MINIMAP_WMO_RECHECK_MS && (!entry.known || entry.revision !== sources.revision
        || Math.abs(position.x - entry.x) >= MINIMAP_WMO_STEP || Math.abs(position.y - entry.y) >= MINIMAP_WMO_STEP
        || Math.abs(position.z - entry.z) >= MINIMAP_WMO_STEP));
    if (entry === undefined) {
      entry = { building: undefined, known: false, x: 0, y: 0, z: 0, at: 0, revision: -1, map, seen: 0 };
      this.#entries.set(guid, entry);
    }
    entry.seen = this.#pass;
    if (!due) return entry.building;
    this.walks++;
    const building = minimapWmoBuildingAt(sources, map, position.x, position.y, position.z);
    // Not current: the last answer stands, and the walk is asked again next time.
    entry.at = now;
    entry.map = map;
    if (building === null) {
      entry.known = false;
      return entry.building;
    }
    entry.building = building;
    entry.known = true;
    entry.x = position.x;
    entry.y = position.y;
    entry.z = position.z;
    entry.revision = sources.revision;
    return building;
  }
}
