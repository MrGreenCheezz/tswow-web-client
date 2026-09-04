import { CollisionClient } from "../CollisionClient.js";
import type { BenchmarkAsyncReadinessStats } from "../RenderBenchmarkReadiness.js";
import { terrainGrid, type EnvironmentObject } from "../Terrain.js";
import {
  CollisionMesh, CollisionWorld, transformCollisionBounds, transformCollisionMesh,
  type CollisionPlacement, type CollisionRun,
} from "./Collision.js";

/**
 * Keeping the collision world stocked with whatever the player is standing near.
 *
 * Both halves come from the server and neither from the client's own art. The meshes are the `.vmo`
 * files the vmap extractor wrote; the placements are the `.vmtile` files beside them, read directly
 * rather than through the tile the renderer uses. That distinction is the slice. The renderer's
 * placements are the ADT's — named by their full archive path, turned by a quaternion — and they
 * are not what `ModelInstance` places anything with. Mixing the two would put a building's
 * collision somewhere near its picture, which is worse than having none: it is a wall the server
 * does not believe in.
 *
 * Rebuilding is deliberately rare. Transforming a building's twenty-six thousand triangles into
 * world space is not something to do per frame, and it does not have to be: what is solid only
 * changes when the player walks somewhere else or a download lands.
 */

/** How far out collision is built. Beyond this the character cannot reach anything this frame. */
const COLLISION_RANGE = 90;
/** How far the player walks before the set of nearby placements is worked out again. */
const REBUILD_DISTANCE = 8;
/**
 * Ceilings, and they are logged rather than silent.
 *
 * Elwynn's Goldshire tile holds 4,870 placements and most of them are cutlery; a city's WMO is
 * three quarters of a million triangles. Both need a limit, and a limit nobody is told about reads
 * as "collision works here" right up until it does not.
 */
const MAX_INSTANCES = 400;
const MAX_TRIANGLES = 300_000;
/** How far either side of the player vmap tiles are held. One tile is 533 yards across. */
const TILE_SPREAD = 140;
/** A failed tile transport/decode is unresolved, with the same bounded retry cadence as its models. */
const TILE_RETRY_BASE_MS = 100;
const TILE_RETRY_MAX_MS = 5_000;

/** The raw vmap spawn identity and transform needed to match its visual WMO placement. */
export interface StaticWmoPlacementIdentity extends CollisionPlacement {
  /** Stable within one map; visual ADT ids are a different id space and must not be compared. */
  spawnId: number;
  map: number;
  /** Stable cache/debug identity. */
  key: string;
  /** The exact model name used by the collision route. */
  modelName: string;
  /** Lower-case basename for matching a visual placement whose name includes an archive path. */
  canonicalModelName: string;
}

/** The collision floor that authoritatively selected a static WMO and one of its groups. */
export interface StaticWmoFloor {
  /** Lets a caller invalidate a cached answer whenever the collision set is rebuilt. */
  revision: number;
  placement: Readonly<StaticWmoPlacementIdentity>;
  floorZ: number;
  triangle: number;
  groupIndex: number;
  groupId: number;
  groupFlags: number;
}

/** A visual archive path and a vmap basename reduce to the same deterministic model name. */
export function canonicalCollisionModelName(name: string): string {
  const clean = name.replace(/\0+$/, "");
  const cut = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  return (cut >= 0 ? clean.slice(cut + 1) : clean).toLowerCase();
}

/** Copy a raw spawn into an immutable-by-convention identity; never retain a tile JSON object. */
export function staticWmoPlacementIdentity(map: number, object: EnvironmentObject): StaticWmoPlacementIdentity {
  return Object.freeze({
    map,
    spawnId: object.id,
    key: `${map}:${object.id}`,
    modelName: object.name,
    canonicalModelName: canonicalCollisionModelName(object.name),
    x: object.x,
    y: object.y,
    z: object.z,
    rotationX: object.rotationX,
    rotationY: object.rotationY,
    rotationZ: object.rotationZ,
    scale: object.scale,
  });
}

interface BuiltInstance {
  name: string;
  /** Which groups went into the mesh, so a group arriving later rebuilds it and nothing else does. */
  groups: string;
  /** A spawn id can be reused after a map change; its transform is part of the cache key. */
  placementSignature: string;
  placement: Readonly<StaticWmoPlacementIdentity> | undefined;
}

export class CollisionSource {
  readonly world = new CollisionWorld();
  readonly models: CollisionClient;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #built = new Map<number, BuiltInstance>();
  readonly #tiles = new Map<string, readonly EnvironmentObject[] | null>();
  readonly #loading = new Set<string>();
  readonly #tileErrors = new Set<string>();
  readonly #tileRetryAttempts = new Map<string, number>();
  readonly #tileRetryAfter = new Map<string, number>();
  readonly #tileRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #tileRevision = 0;
  #map: number | undefined;
  #atX = Number.NaN;
  #atY = Number.NaN;
  #modelRevision = -1;
  #knownTiles = -1;
  #triangles = 0;
  #dropped = 0;
  #revision = 0;
  #tileSuccess = 0;
  #tileError = 0;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.models = new CollisionClient(gatewayWebSocketUrl);
  }

  /** Triangles standing and placements holding them, for the diagnostics line. */
  get counts(): { instances: number; triangles: number; dropped: number } {
    return { instances: this.#built.size, triangles: this.#triangles, dropped: this.#dropped };
  }

  /** Bumped after every rebuild/reset so a retained locator cannot silently become stale. */
  get revision(): number {
    return this.#revision;
  }

  /** Immutable aggregate counters for VMAP tile work and the nested collision model client. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    const models = this.models.stats;
    return Object.freeze({
      pending: this.#loading.size + models.pending,
      success: this.#tileSuccess + models.success,
      error: this.#tileErrors.size + models.error,
      generation: this.#revision + this.#tileRevision + models.generation,
    });
  }

  /**
   * The static WMO group whose walkable collision floor wins under the camera/player point.
   *
   * The requested map must be the map currently built. M2 floors and meshes without current group
   * provenance are rejected before the remaining floors compete, and equal-height overlaps use
   * `CollisionWorld`'s stable instance/group ordering rather than load order.
   */
  staticWmoFloorUnder(
    map: number | undefined,
    x: number,
    y: number,
    fromZ: number,
    minZ: number,
  ): StaticWmoFloor | undefined {
    if (map === undefined || map !== this.#map) return undefined;
    // An async tile/model may have landed since the last frame-driven rebuild. Returning the old
    // winner in that gap would reintroduce stale/last-arrival behaviour, so wait for `refresh`.
    if (this.#knownTiles !== this.#tileRevision || this.#modelRevision !== this.models.revision) return undefined;
    if (this.#tileKeys(map, x, y).some((key) => !this.#tiles.has(key))) return undefined;
    const hit = this.world.floorHitUnder(x, y, fromZ, minZ, (candidate) => {
      const built = this.#built.get(candidate.instanceId);
      return built?.placement !== undefined
        && candidate.groupIndex !== undefined
        && candidate.groupId !== undefined
        && candidate.flags !== undefined;
    });
    if (!hit || hit.groupIndex === undefined || hit.groupId === undefined || hit.flags === undefined) return undefined;
    const placement = this.#built.get(hit.instanceId)?.placement;
    if (!placement) return undefined;
    return {
      revision: this.#revision,
      placement,
      floorZ: hit.z,
      triangle: hit.triangle,
      groupIndex: hit.groupIndex,
      groupId: hit.groupId,
      groupFlags: hit.flags,
    };
  }

  /** Everything is somewhere else now: a teleport, or leaving the world. */
  reset(): void {
    this.world.clear();
    this.#built.clear();
    this.#map = undefined;
    this.#atX = Number.NaN;
    this.#atY = Number.NaN;
    this.#modelRevision = -1;
    this.#knownTiles = -1;
    this.#triangles = 0;
    this.#dropped = 0;
    this.#revision++;
  }

  /**
   * Called once a frame; does nothing on nearly all of them.
   *
   * Three things can make the answer different: the player moved, a tile of placements arrived, or
   * a collision mesh arrived. Anything else and the world already holds the right triangles.
   */
  refresh(map: number | undefined, x: number, y: number): void {
    if (map === undefined) return;
    const moved = !(Math.abs(x - this.#atX) < REBUILD_DISTANCE && Math.abs(y - this.#atY) < REBUILD_DISTANCE);
    if (map === this.#map && !moved
      && this.models.revision === this.#modelRevision
      && this.#tileRevision === this.#knownTiles) return;

    // A different map shares nothing with the last one, not even its ids.
    if (map !== this.#map) {
      this.world.clear();
      this.#built.clear();
    }
    this.#map = map;
    this.#atX = x;
    this.#atY = y;
    this.#modelRevision = this.models.revision;
    this.#knownTiles = this.#tileRevision;
    this.#rebuild(map, x, y);
  }

  /**
   * Whether the collision inputs around a destination have answered.
   *
   * `refresh` is intentionally separate from this query: it is the frame-driven builder, while
   * this method is the transfer barrier's question.  A tile with no VMAP objects and a model that
   * answered 404 are both valid, empty answers.  An absent tile/model is not considered ready until
   * its request has completed, otherwise the first physics frame after a teleport can fall through
   * a building whose collision is still on the wire.
   */
  isReady(map: number | undefined, x: number, y: number): boolean {
    if (map === undefined) return false;
    if (map !== this.#map || Math.abs(x - this.#atX) >= REBUILD_DISTANCE || Math.abs(y - this.#atY) >= REBUILD_DISTANCE) {
      this.refresh(map, x, y);
    }

    const keys = this.#tileKeys(map, x, y);
    if (keys.some((key) => !this.#tiles.has(key))) return false;

    // Keep this pass in lockstep with #rebuild: objects beyond either builder ceiling cannot affect
    // the character this frame and must not hold the transfer curtain hostage. Collect every
    // unresolved model/group first, rather than returning at the first miss and serialising a city
    // into one request per RAF.
    const near = uniquePlacements(this.#placementsAround(map, x, y))
      .map((object) => ({ object, distance: distanceTo(object, x, y) }))
      .filter((entry) => entry.distance < COLLISION_RANGE)
      .sort((left, right) => left.distance - right.distance || comparePlacements(left.object, right.object));
    const pendingModels = new Set<string>();
    const pendingGroups = new Map<string, Set<number>>();
    const wanted = new Set<number>();
    let triangles = 0;
    for (const { object } of near) {
      if (wanted.size >= MAX_INSTANCES || triangles >= MAX_TRIANGLES) continue;
      const model = this.models.model(object.name);
      // `null` is a resolved 404 and means this placement has no collision model.
      if (!this.models.isResolved(object.name)) {
        pendingModels.add(object.name);
        continue;
      }
      if (!model) continue;
      const chosen: number[] = [];
      const missing: number[] = [];
      for (const [index, group] of model.groups.entries()) {
        if (group.triangleCount === 0) continue;
        if (!withinRange(transformCollisionBounds(group.bounds, object), x, y, COLLISION_RANGE)) continue;
        if (group.vertices && group.indices) chosen.push(index);
        else missing.push(index);
      }
      if (missing.length > 0) {
        const groups = pendingGroups.get(object.name) ?? new Set<number>();
        for (const index of missing) groups.add(index);
        pendingGroups.set(object.name, groups);
      }
      if (chosen.length === 0) continue;
      wanted.add(object.id);
      // #rebuild's budget is based on the chosen mesh's triangle count. A loaded group reports the
      // same count as its index buffer, so this avoids transforming every mesh just to ask whether
      // a later placement is still within the budget.
      triangles += chosen.reduce((count, index) => count + model.groups[index]!.triangleCount, 0);
    }
    for (const [name, groups] of pendingGroups) this.models.requestGroups(name, [...groups]);
    return pendingModels.size === 0 && pendingGroups.size === 0;
  }

  #tileKeys(map: number, x: number, y: number): string[] {
    const keys: string[] = [];
    for (const offsetX of [-TILE_SPREAD, 0, TILE_SPREAD]) {
      for (const offsetY of [-TILE_SPREAD, 0, TILE_SPREAD]) {
        const grid = terrainGrid(x + offsetX, y + offsetY);
        if (grid) keys.push(`${map}/${grid.x}/${grid.y}`);
      }
    }
    return keys;
  }

  /** The placements the server itself uses, from the tiles around this point. */
  #placementsAround(map: number, x: number, y: number): EnvironmentObject[] {
    const found: EnvironmentObject[] = [];
    const seen = new Set<string>();
    for (const offsetX of [-TILE_SPREAD, 0, TILE_SPREAD]) {
      for (const offsetY of [-TILE_SPREAD, 0, TILE_SPREAD]) {
        const grid = terrainGrid(x + offsetX, y + offsetY);
        if (!grid) continue;
        const key = `${map}/${grid.x}/${grid.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const tile = this.#tiles.get(key);
        if (tile) found.push(...tile);
        else if (tile === undefined && !this.#loading.has(key) && this.#tileRetryDue(key)) {
          this.#loading.add(key);
          void this.#loadTile(map, grid.x, grid.y, key);
        }
      }
    }
    return found;
  }

  #tileRetryDue(key: string): boolean {
    return Date.now() >= (this.#tileRetryAfter.get(key) ?? 0);
  }

  #retryTileLater(key: string): void {
    const attempt = (this.#tileRetryAttempts.get(key) ?? 0) + 1;
    this.#tileRetryAttempts.set(key, attempt);
    const delay = Math.min(TILE_RETRY_MAX_MS, TILE_RETRY_BASE_MS * 2 ** Math.min(6, attempt - 1));
    this.#tileRetryAfter.set(key, Date.now() + delay);
    const previous = this.#tileRetryTimers.get(key);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.#tileRetryTimers.delete(key);
      // `refresh` is revision-driven. Wake one ordinary rebuild after the cooldown instead of
      // downloading from the timer or polling the failed route every animation frame.
      this.#tileRevision++;
    }, delay);
    this.#tileRetryTimers.set(key, timer);
  }

  #clearTileRetry(key: string): void {
    this.#tileRetryAttempts.delete(key);
    this.#tileRetryAfter.delete(key);
    const timer = this.#tileRetryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#tileRetryTimers.delete(key);
  }

  async #loadTile(map: number, gridX: number, gridY: number, key: string): Promise<void> {
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#loading.delete(key);
      this.#tileRevision++;
      if (success) this.#tileSuccess++;
      else this.#tileError++;
    };
    try {
      // The raw vmap route, not the visual one the renderer prefers: these are the spawns the
      // server places its own collision with, named the way its `.vmo` files are named.
      const response = await fetch(`${this.#baseUrl}/environment/${map}/${gridX}/${gridY}`);
      if (response.status === 204 || response.status === 404) {
        // A tile with nothing in it: open ground, and the terrain is the whole of the answer there.
        this.#tiles.set(key, null);
        this.#tileErrors.delete(key);
        this.#clearTileRetry(key);
        settle(true);
        return;
      }
      if (!response.ok) throw new Error(`VMAP tile gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new Error("VMAP tile gateway returned invalid objects");
      this.#tiles.set(key, value as EnvironmentObject[]);
      this.#tileErrors.delete(key);
      this.#clearTileRetry(key);
      settle(true);
    } catch (error) {
      // A transport or decode failure is not an authored empty tile. Keep readiness closed and let
      // the normal revision-driven rebuild issue one bounded retry after its cooldown.
      this.#tiles.delete(key);
      this.#tileErrors.add(key);
      this.#retryTileLater(key);
      settle(false);
      this.onStatus?.(error instanceof Error ? error.message : String(error), true);
    } finally {
      settle(false);
    }
  }

  #rebuild(map: number, x: number, y: number): void {
    const near = uniquePlacements(this.#placementsAround(map, x, y))
      .map((object) => ({ object, distance: distanceTo(object, x, y) }))
      .filter((entry) => entry.distance < COLLISION_RANGE)
      .sort((left, right) => left.distance - right.distance || comparePlacements(left.object, right.object));

    const wanted = new Set<number>();
    let triangles = 0;
    let dropped = 0;
    for (const { object } of near) {
      if (wanted.size >= MAX_INSTANCES || triangles >= MAX_TRIANGLES) {
        dropped++;
        continue;
      }
      const model = this.models.model(object.name);
      // Not here yet. The client bumps its revision when it lands, which brings us back.
      if (!model) continue;

      // Which of the model's groups are near enough to be worth carrying, and which of those are
      // still only a box. A single-group doodad answers this in one comparison.
      const chosen: number[] = [];
      const missing: number[] = [];
      for (const [index, group] of model.groups.entries()) {
        if (group.triangleCount === 0) continue;
        const box = transformCollisionBounds(group.bounds, object);
        if (!withinRange(box, x, y, COLLISION_RANGE)) continue;
        if (group.vertices && group.indices) chosen.push(index);
        else missing.push(index);
      }
      if (missing.length > 0) this.models.requestGroups(object.name, missing);
      if (chosen.length === 0) continue;

      wanted.add(object.id);
      const key = chosen.join(",");
      const placementSignature = signatureOf(object);
      const built = this.#built.get(object.id);
      const standing = this.world.get(object.id);
      // Already built out of exactly these groups: nothing has changed about it, and transforming
      // it again would be the expensive half of the frame for no difference at all.
      if (standing && built?.name === object.name && built.groups === key
        && built.placementSignature === placementSignature) {
        triangles += standing.triangleCount;
        continue;
      }

      const mesh = buildInstance(model, chosen, object);
      if (!mesh) continue;
      this.world.set(object.id, mesh);
      this.#built.set(object.id, {
        name: object.name,
        groups: key,
        placementSignature,
        placement: object.kind === "wmo" ? staticWmoPlacementIdentity(map, object) : undefined,
      });
      triangles += mesh.triangleCount;
    }

    for (const id of [...this.#built.keys()]) {
      if (wanted.has(id)) continue;
      this.world.delete(id);
      this.#built.delete(id);
    }

    this.#triangles = triangles;
    this.#dropped = dropped;
    this.#revision++;
    // Reported every rebuild, and the dropped count is part of it. A ceiling nobody is told about
    // reads as "collision works here" right up until the moment it does not.
    const thousands = (triangles / 1000).toFixed(1);
    this.onStatus?.(
      `Коллизия: ${this.#built.size} объектов, ${thousands}k треугольников${dropped > 0 ? ` · ${dropped} не поместилось` : ""}`,
      false,
    );
  }
}

/** One deterministic representative for a spawn repeated in adjacent `.vmtile` files. */
function uniquePlacements(objects: readonly EnvironmentObject[]): EnvironmentObject[] {
  const byId = new Map<number, EnvironmentObject>();
  for (const object of objects) {
    const current = byId.get(object.id);
    if (!current || comparePlacements(object, current) < 0) byId.set(object.id, object);
  }
  return [...byId.values()];
}

/** Total ordering used both for duplicate ids and equal-distance build candidates. */
function comparePlacements(left: EnvironmentObject, right: EnvironmentObject): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  const leftSignature = signatureOf(left);
  const rightSignature = signatureOf(right);
  return leftSignature < rightSignature ? -1 : leftSignature > rightSignature ? 1 : 0;
}

function signatureOf(object: EnvironmentObject): string {
  return JSON.stringify([
    object.kind, object.name, object.x, object.y, object.z,
    object.rotationX, object.rotationY, object.rotationZ, object.scale,
  ]);
}

function distanceTo(object: EnvironmentObject, x: number, y: number): number {
  const bounds = object.bounds;
  // Distance to the box rather than to the origin: a city's WMO has its origin at one corner and
  // is a mile across, and the player is inside it long before they are near that corner.
  return bounds ? boxDistance(bounds, x, y) : Math.hypot(object.x - x, object.y - y);
}

function boxDistance(box: { minX: number; minY: number; maxX: number; maxY: number }, x: number, y: number): number {
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dy = Math.max(box.minY - y, 0, y - box.maxY);
  return Math.hypot(dx, dy);
}

function withinRange(box: { minX: number; minY: number; maxX: number; maxY: number }, x: number, y: number, range: number): boolean {
  return boxDistance(box, x, y) < range;
}

/**
 * One placement's chosen groups, transformed into world space and gridded.
 *
 * The groups are merged into one triangle array because that is what the grid and every query
 * want, and a run table records where each one started: the group's `MOGP` flags are how the
 * character finds out whether the floor it is standing on has a roof, and merging would otherwise
 * throw that away.
 */
function buildInstance(
  model: { groups: Array<{ vertices?: Float32Array; indices?: Uint32Array; flags: number; groupId: number }> },
  chosen: readonly number[],
  placement: EnvironmentObject,
): CollisionMesh | undefined {
  const parts: Float32Array[] = [];
  const runs: CollisionRun[] = [];
  let length = 0;
  for (const index of chosen) {
    const group = model.groups[index];
    if (!group?.vertices || !group.indices) continue;
    const part = transformCollisionMesh(group.vertices, group.indices, placement);
    runs.push({ first: length / 9, flags: group.flags, groupIndex: index, groupId: group.groupId });
    parts.push(part);
    length += part.length;
  }
  if (length === 0) return undefined;
  if (parts.length === 1) return new CollisionMesh(parts[0]!, runs);
  const triangles = new Float32Array(length);
  let cursor = 0;
  for (const part of parts) {
    triangles.set(part, cursor);
    cursor += part.length;
  }
  return new CollisionMesh(triangles, runs);
}
