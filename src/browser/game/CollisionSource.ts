import { CollisionClient, canonicalCollisionModelName, type CollisionModel } from "../CollisionClient.js";
import type { BenchmarkAsyncReadinessStats } from "../RenderBenchmarkReadiness.js";
import { terrainGrid, type EnvironmentObject } from "../Terrain.js";
import {
  CollisionMesh, CollisionWorld, transformCollisionBounds, transformCollisionMesh,
  type CollisionFloorHit, type CollisionPlacement,
} from "./Collision.js";
import { withGeneration } from "../GatewayGeneration.js";

export { canonicalCollisionModelName };

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
 * The unit of work is one *placed group*: one group of one spawn's model, transformed into world
 * space and gridded on its own, once, the first time it comes into range. It used to be the whole
 * placement, merged, and that was the freeze in every city. Stormwind is one spawn with 284
 * groups; whenever the handful in range changed — every eight yards of walking along a street —
 * all 34 to 46 of them were transformed again and one grid the size of a district was rebuilt
 * over them: 183,000 to 206,000 triangles, 36-58 ms, twenty megabytes of garbage, twice a second
 * on a mount. Now a group that was built is kept, in the world while it is wanted and in a cache
 * bounded by memory after, and walking only moves meshes in and out of the world. Building a group
 * nobody has built yet is the one expensive thing left, and it is spread over frames by a budget,
 * never for what the player can already touch.
 */

/** How far out collision is built. Beyond this the character cannot reach anything this frame. */
const COLLISION_RANGE = 90;
/**
 * How much further out than that a group already standing in the world is kept.
 *
 * Adding a group at ninety yards and dropping it again at ninety is a group that goes in and out
 * with every rebuild along a street that runs beside it. Kept to 120, it leaves only once it is
 * clearly behind the player; the ceilings below still decide whether there is room for it.
 */
const RETAIN_MARGIN = 30;
/** How far the player walks before the set of nearby placements is worked out again. */
const REBUILD_DISTANCE = 8;
/**
 * Ceilings, and they are logged rather than silent.
 *
 * Elwynn's Goldshire tile holds 4,870 placements and most of them are cutlery; a city's WMO is
 * three quarters of a million triangles. Both need a limit, and a limit nobody is told about reads
 * as "collision works here" right up until it does not.
 *
 * They are spent nearest placement first on the groups within `COLLISION_RANGE`, exactly as when
 * every placement was one mesh; groups kept by `RETAIN_MARGIN` only use what is left over.
 */
const MAX_INSTANCES = 400;
const MAX_TRIANGLES = 300_000;
/** How far either side of the player vmap tiles are held. One tile is 533 yards across. */
const TILE_SPREAD = 140;
/** A failed tile transport/decode is unresolved, with the same bounded retry cadence as its models. */
const TILE_RETRY_BASE_MS = 100;
const TILE_RETRY_MAX_MS = 5_000;
/**
 * Bytes of built group meshes kept, triangles and grids together. What is standing in the world
 * is never evicted; above this, the groups least recently wanted go first.
 *
 * The Trade District's in-range set is about ten megabytes, so this keeps the last few districts
 * walked through for the walk back.
 */
const GROUP_CACHE_BYTES = 64 * 1024 * 1024;
/**
 * How long one frame may spend building groups further out than `IMMEDIATE_BUILD_RANGE`.
 *
 * Measured on the Trade District's 44 groups in range: a median group is 810 triangles and builds
 * in 0.24 ms, the largest is 29,258 and takes 4.9 ms, and all of them together 29 ms — which is
 * what arriving in the city asks for at once. Four milliseconds a frame finishes that in a handful
 * of frames without any of them being the one the player sees stall.
 */
const BUILD_BUDGET_MS = 4;
/**
 * Groups whose box is this close to the player are built on the frame they are wanted, whatever
 * the budget says. The budget is only allowed to delay what is still walking distance away: a
 * floor put off to the next frame is a floor the player falls through on this one. Twelve yards is
 * over half a second at the fastest flight speed there is (310%, 21.7 yards a second) — far more
 * than a character moves between two refreshes, each of which measures the queue again from where
 * the player is. A blink or a charge that lands further than that moves the player more than
 * `REBUILD_DISTANCE`, and the evaluation that causes builds what is underfoot on that same frame,
 * before physics runs.
 */
const IMMEDIATE_BUILD_RANGE = 12;

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
  /** The winning triangle's index within its own group. */
  triangle: number;
  groupIndex: number;
  groupId: number;
  groupFlags: number;
}

/**
 * A column a caller has already walked: `CollisionWorld.floorHitUnder(x, y, fromZ, minZ)` with no
 * filter, at the same point and on the same collision revision. See `staticWmoFloorState`.
 */
export interface KnownCollisionFloor {
  readonly fromZ: number;
  readonly minZ: number;
  readonly hit: CollisionFloorHit | undefined;
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

/** Tuning a test turns down to reach the edges; the game uses the defaults. */
export interface CollisionSourceOptions {
  /** Bytes of built group meshes kept, standing or not. See `GROUP_CACHE_BYTES`. */
  cacheBytes?: number;
  /** Milliseconds a frame may spend building groups the player cannot touch yet. */
  buildBudgetMs?: number;
}

/** What the cache of built groups is doing, for the diagnostics line and for tests. */
export interface CollisionGroupCacheStats {
  /** Built group meshes held, standing in the world or waiting to be wanted again. */
  groups: number;
  /** Of those, the ones standing in the world. */
  standing: number;
  /** Their triangles and grids, in bytes. */
  bytes: number;
  /** Groups transformed and gridded since this source was made. Rises only for something new. */
  built: number;
  /** Groups dropped to stay under the cap. */
  evicted: number;
  /** Wanted groups still waiting for a frame with budget left to build them. */
  deferred: number;
  /** How many times the wanted set has been worked out. */
  evaluations: number;
}

/** One vmap spawn whose collision model has answered, and every group built from it. */
interface PlacedModel extends CollisionPlacement {
  /** The tile object last matched; the same object again skips comparing the transform. */
  object: EnvironmentObject;
  readonly id: number;
  readonly kind: EnvironmentObject["kind"];
  readonly name: string;
  /** What the static WMO locator hands out; absent for an M2. */
  readonly identity: Readonly<StaticWmoPlacementIdentity> | undefined;
  /** The model the boxes were placed from. */
  model: CollisionModel;
  /**
   * Every group's box in world space, four numbers each — minX, minY, maxX, maxY — placed once.
   * Choosing a city's groups by range used to place all 284 boxes again on every rebuild.
   */
  boxes: Float64Array;
  /** Built groups by group index, standing or cached. */
  readonly groups: Map<number, PlacedGroup>;
  /** How many of those are standing in the world. */
  standing: number;
  /** The evaluation that last found this spawn in range with its model answered. */
  seen: number;
  /** The evaluation whose ceilings last counted it as an instance. */
  counted: number;
}

/** One group of one spawn, in world space with its own grid. */
interface PlacedGroup {
  readonly owner: PlacedModel;
  readonly index: number;
  /** Its key in the world, unique to this build. Hits on it report `owner.id`. */
  readonly key: number;
  readonly mesh: CollisionMesh;
  /** The geometry it was built from: different arrays are a different group. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly bytes: number;
  standing: boolean;
  /** The evaluation that last wanted it. The least recent is evicted first. */
  wanted: number;
}

/** A wanted group not built yet. */
interface PendingBuild {
  readonly record: PlacedModel;
  readonly index: number;
  /** From the player, measured again on every frame it is still waiting. */
  distance: number;
}

interface NearPlacement {
  readonly object: EnvironmentObject;
  readonly distance: number;
}

/** What should be standing around one point, worked out without building anything. */
interface CollisionPlan {
  /** Placements within `COLLISION_RANGE + RETAIN_MARGIN`, nearest first. */
  readonly near: readonly NearPlacement[];
  /** The in-range groups the ceilings admitted, by placement, nearest placement first. */
  readonly chosen: ReadonlyArray<{ readonly record: PlacedModel; readonly groups: readonly number[] }>;
  readonly instances: number;
  readonly triangles: number;
  readonly dropped: number;
  /** Models asked for and not answered yet. */
  readonly pendingModels: Set<string>;
  /** Groups asked for and not here yet, by model name. */
  readonly pendingGroups: Map<string, Set<number>>;
}

export class CollisionSource {
  readonly world = new CollisionWorld();
  readonly models: CollisionClient;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  readonly #baseUrl: string;
  readonly #cacheLimit: number;
  readonly #buildBudgetMs: number;
  /** Spawns whose model has answered, by spawn id: the placement half of every group built. */
  readonly #placements = new Map<number, PlacedModel>();
  /** Groups standing in the world. */
  readonly #standing = new Set<PlacedGroup>();
  #pending: PendingBuild[] = [];
  /** What the last evaluation asked for and did not get, so a landing can be told apart. */
  #awaitedModels = new Set<string>();
  #awaitedGroups = new Map<string, Set<number>>();
  readonly #tiles = new Map<string, readonly EnvironmentObject[] | null>();
  readonly #loading = new Set<string>();
  readonly #tileErrors = new Set<string>();
  readonly #tileRetryAttempts = new Map<string, number>();
  readonly #tileRetryAfter = new Map<string, number>();
  readonly #tileRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped whenever `#tiles` changes at all; the placement list below is only valid for one. */
  #tilesVersion = 0;
  /** The tiles around the player, one representative per spawn, and which tiles they came from. */
  #unique: readonly EnvironmentObject[] = [];
  #uniqueKey = "";
  #uniqueVersion = -1;
  #tileRevision = 0;
  #map: number | undefined;
  #atX = Number.NaN;
  #atY = Number.NaN;
  #modelRevision = -1;
  #knownTiles = -1;
  /** Set when the barrier finds a group it wants that no evaluation has queued. */
  #dirty = false;
  #reportDue = false;
  #cacheBytes = 0;
  #nextKey = 1;
  /** Evaluations so far; what `seen`, `counted` and `wanted` are stamped with. */
  #serial = 0;
  #groupsBuilt = 0;
  #evicted = 0;
  #instances = 0;
  #triangles = 0;
  #dropped = 0;
  #revision = 0;
  #tileSuccess = 0;
  #tileError = 0;

  constructor(gatewayWebSocketUrl: string, options: CollisionSourceOptions = {}) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.models = new CollisionClient(gatewayWebSocketUrl);
    this.#cacheLimit = Math.max(0, options.cacheBytes ?? GROUP_CACHE_BYTES);
    this.#buildBudgetMs = Math.max(0, options.buildBudgetMs ?? BUILD_BUDGET_MS);
  }

  /** Triangles standing and placements holding them, for the diagnostics line. */
  get counts(): { instances: number; triangles: number; dropped: number } {
    return { instances: this.#instances, triangles: this.#triangles, dropped: this.#dropped };
  }

  /** Bumped after every rebuild/reset so a retained locator cannot silently become stale. */
  get revision(): number {
    return this.#revision;
  }

  /** The built-group cache, for diagnostics. */
  get groupCache(): Readonly<CollisionGroupCacheStats> {
    let groups = 0;
    for (const record of this.#placements.values()) groups += record.groups.size;
    return Object.freeze({
      groups,
      standing: this.#standing.size,
      bytes: this.#cacheBytes,
      built: this.#groupsBuilt,
      evicted: this.#evicted,
      deferred: this.#pending.length,
      evaluations: this.#serial,
    });
  }

  /** Immutable aggregate counters for VMAP tile work and the nested collision model client. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    const models = this.models.stats;
    return Object.freeze({
      // A group waiting for a frame to build it is work still to do, like a request on the wire.
      pending: this.#loading.size + models.pending + this.#pending.length,
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
    return this.staticWmoFloorState(map, x, y, fromZ, minZ) ?? undefined;
  }

  /**
   * `staticWmoFloorUnder` with its two silences told apart: `null` when the collision around the
   * point is current and no static WMO floor is under it, `undefined` while it is not current yet.
   *
   * The physics needs the difference. A room's water is only known once the room's floor is, and
   * "not loaded" read as "no room" drops a swimmer to the bottom of the pool for the frames a tile
   * takes to arrive.
   *
   * `known` is a column the caller has already walked here with `world.floorHitUnder`, unfiltered,
   * on this revision — the physics' own floor query at the same feet. Its top floor answers this
   * query too whenever it is inside this query's range and is a static WMO's, so the character's
   * floor and its water cost one walk between them.
   */
  staticWmoFloorState(
    map: number | undefined,
    x: number,
    y: number,
    fromZ: number,
    minZ: number,
    known?: KnownCollisionFloor,
  ): StaticWmoFloor | null | undefined {
    if (map === undefined || map !== this.#map) return undefined;
    // An async tile/model may have landed since the last frame-driven rebuild. Returning the old
    // winner in that gap would reintroduce stale/last-arrival behaviour, so wait for `refresh`.
    if (this.#knownTiles !== this.#tileRevision || this.#modelRevision !== this.models.revision) return undefined;
    if (this.#tileKeys(map, x, y).some((key) => !this.#tiles.has(key))) return undefined;
    // The same gap, from the other side: a building's group that is wanted here but still waiting
    // for its build could hold a higher floor than anything standing.
    if (this.#pendingCovers(x, y)) return undefined;
    let hit: CollisionFloorHit | undefined;
    let walk = true;
    // The known column covers this one from above. Nothing in it means nothing in this one, as
    // long as it also reaches as deep; its top floor below this range means the same; and its top
    // floor inside this range is this range's top floor, which answers if it is a building's.
    if (known !== undefined && known.fromZ >= fromZ) {
      const top = known.hit;
      if (top === undefined) {
        if (known.minZ <= minZ) walk = false;
      } else if (top.z < minZ) {
        walk = false;
      } else if (top.z <= fromZ && this.#isStaticWmoHit(top)) {
        hit = top;
        walk = false;
      }
    }
    if (walk) hit = this.world.floorHitUnder(x, y, fromZ, minZ, this.#acceptStaticWmo);
    if (!hit || hit.groupIndex === undefined || hit.groupId === undefined || hit.flags === undefined) return null;
    const placement = this.#placements.get(hit.instanceId)?.identity;
    if (!placement) return null;
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

  /** A floor of a static WMO placement that still carries its group's provenance: no M2, no stale mesh. */
  #isStaticWmoHit(candidate: CollisionFloorHit): boolean {
    const record = this.#placements.get(candidate.instanceId);
    return record?.identity !== undefined
      && candidate.groupIndex !== undefined
      && candidate.groupId !== undefined
      && candidate.flags !== undefined;
  }

  /** The same predicate as a function made once, for the walk's `accept`. */
  readonly #acceptStaticWmo = (candidate: CollisionFloorHit): boolean => this.#isStaticWmoHit(candidate);

  /**
   * Everything is somewhere else now: a teleport, or leaving the world.
   *
   * The built groups go with it. A same-map teleport could have reused some, but they are the
   * expensive thing to keep, and what the player left behind is not where they are going.
   */
  reset(): void {
    this.#forgetBuilt();
    this.#map = undefined;
    this.#atX = Number.NaN;
    this.#atY = Number.NaN;
    this.#modelRevision = -1;
    this.#knownTiles = -1;
    this.#dropped = 0;
    this.#revision++;
  }

  /**
   * Leaving the world: `reset` plus everything `reset` deliberately keeps for a same-map
   * teleport — cached tiles of other maps, retry state and pending retry timers. Without this
   * a re-entry inherits foreign tiles that can never match again (keys carry the old map) and
   * timers that wake a detached source; the tiles also have no eviction, so repeated realm
   * changes would accumulate them without bound.
   */
  dispose(): void {
    for (const timer of this.#tileRetryTimers.values()) clearTimeout(timer);
    this.#tileRetryTimers.clear();
    this.#tileRetryAttempts.clear();
    this.#tileRetryAfter.clear();
    this.#tileErrors.clear();
    this.#loading.clear();
    this.#tiles.clear();
    this.#tilesVersion++;
    this.#unique = [];
    this.#uniqueKey = "";
    this.#tileSuccess = 0;
    this.#tileError = 0;
    this.reset();
  }

  /**
   * Called once a frame; does nothing on nearly all of them.
   *
   * Three things can make the answer different: the player moved, a tile of placements arrived, or
   * a collision mesh this world asked for arrived. Anything else and the world already holds the
   * right triangles — apart from groups still waiting for a frame to be built in, which are built
   * here, nearest first, until this frame's budget is spent.
   */
  refresh(map: number | undefined, x: number, y: number): void {
    if (map === undefined) return;
    const started = performance.now();
    const moved = !(Math.abs(x - this.#atX) < REBUILD_DISTANCE && Math.abs(y - this.#atY) < REBUILD_DISTANCE);
    let evaluate = map !== this.#map || moved || this.#tileRevision !== this.#knownTiles || this.#dirty;
    if (this.models.revision !== this.#modelRevision) {
      this.#modelRevision = this.models.revision;
      // Most landings are nothing this world asked for: the renderer asks for the water of every
      // building in view through the same client, and each of those answers moves the revision
      // too. Only one this world is waiting for — or a retry it was woken up to make — changes
      // what it should hold, and every landing between two frames is one evaluation, not several.
      if (!evaluate) evaluate = this.#awaitedLanded();
    }
    if (evaluate) {
      // A different map shares nothing with the last one, not even its ids. Tiles of the old
      // map can never match the new keys, have no eviction of their own, and would otherwise
      // accumulate across teleports — drop them with their retry state here.
      if (map !== this.#map) {
        this.#forgetBuilt();
        for (const key of this.#tiles.keys()) {
          if (!key.startsWith(`${map}/`)) {
            this.#tiles.delete(key);
            this.#tilesVersion++;
            this.#clearTileRetry(key);
          }
        }
      }
      this.#map = map;
      this.#atX = x;
      this.#atY = y;
      this.#modelRevision = this.models.revision;
      this.#knownTiles = this.#tileRevision;
      this.#dirty = false;
      this.#evaluate(map, x, y);
    }
    if (this.#pending.length > 0) this.#buildPending(x, y, started);
    if (this.#reportDue && this.#pending.length === 0) this.#report();
  }

  /**
   * Whether the collision inputs around a destination have answered.
   *
   * `refresh` is intentionally separate from this query: it is the frame-driven builder, while
   * this method is the transfer barrier's question.  A tile with no VMAP objects and a model that
   * answered 404 are both valid, empty answers.  An absent tile/model is not considered ready until
   * its request has completed, otherwise the first physics frame after a teleport can fall through
   * a building whose collision is still on the wire.
   *
   * Answered is also not the same as standing: a group waiting for a frame's build budget is air
   * until it is built, so the barrier stays closed until every group `refresh` would put in the
   * world is in it.
   */
  isReady(map: number | undefined, x: number, y: number): boolean {
    if (map === undefined) return false;
    if (map !== this.#map || Math.abs(x - this.#atX) >= REBUILD_DISTANCE || Math.abs(y - this.#atY) >= REBUILD_DISTANCE) {
      this.refresh(map, x, y);
    }

    const keys = this.#tileKeys(map, x, y);
    if (keys.some((key) => !this.#tiles.has(key))) return false;

    // Keep this pass in lockstep with the evaluation: objects beyond either builder ceiling cannot
    // affect the character this frame and must not hold the transfer curtain hostage. It is the
    // same plan, so every unresolved model/group is collected — and asked for — in one pass rather
    // than returning at the first miss and serialising a city into one request per RAF.
    const plan = this.#plan(map, x, y);
    if (plan.pendingModels.size > 0 || plan.pendingGroups.size > 0) return false;
    for (const { record, groups } of plan.chosen) {
      for (const index of groups) {
        const group = record.groups.get(index);
        if (group?.standing && this.#current(group)) continue;
        // Neither standing nor queued: this point was never evaluated with it — it landed since,
        // or the barrier is asking a few yards from where the last evaluation stood. The next
        // refresh evaluates here and builds it.
        if (!this.#pending.some((item) => item.record === record && item.index === index)) this.#dirty = true;
        return false;
      }
    }
    return true;
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

  /**
   * The placements the server itself uses, from the tiles around this point, one per spawn.
   *
   * A spawn is repeated in every tile its model overlaps — Stormwind's 3,830 doodads are in each of
   * the city's tiles — so four tiles gather up to 15,500 objects to keep 4,000. The survivors are
   * kept until the set of tiles changes, which is every few hundred yards rather than every eight.
   */
  #placementsAround(map: number, x: number, y: number): readonly EnvironmentObject[] {
    const tiles: (readonly EnvironmentObject[])[] = [];
    const seen = new Set<string>();
    let key = "";
    for (const offsetX of [-TILE_SPREAD, 0, TILE_SPREAD]) {
      for (const offsetY of [-TILE_SPREAD, 0, TILE_SPREAD]) {
        const grid = terrainGrid(x + offsetX, y + offsetY);
        if (!grid) continue;
        const tileKey = `${map}/${grid.x}/${grid.y}`;
        if (seen.has(tileKey)) continue;
        seen.add(tileKey);
        const tile = this.#tiles.get(tileKey);
        if (tile) {
          tiles.push(tile);
          key += `${tileKey};`;
        } else if (tile === undefined && !this.#loading.has(tileKey) && this.#tileRetryDue(tileKey)) {
          this.#loading.add(tileKey);
          void this.#loadTile(map, grid.x, grid.y, tileKey);
        }
      }
    }
    if (key !== this.#uniqueKey || this.#tilesVersion !== this.#uniqueVersion) {
      this.#unique = uniquePlacements(tiles);
      this.#uniqueKey = key;
      this.#uniqueVersion = this.#tilesVersion;
    }
    return this.#unique;
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
    // A response that outlives its world must not resurrect it. Teleports and exits purge
    // foreign tiles, and `#tiles` has no eviction of its own — so a late write for a map that is
    // no longer built would sit there forever. The key carries its map and `#map` is cleared by
    // `reset`/`dispose`, which makes "no longer matches" the exact retirement test: same-map data
    // stays valid however many resets it survives. `#loading` is always released so the current
    // world re-requests through the ordinary path.
    const retired = (): boolean => map !== this.#map;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#loading.delete(key);
      if (retired()) return;
      this.#tileRevision++;
      if (success) this.#tileSuccess++;
      else this.#tileError++;
    };
    try {
      // The raw vmap route, not the visual one the renderer prefers: these are the spawns the
      // server places its own collision with, named the way its `.vmo` files are named.
      const response = await fetch(withGeneration(`${this.#baseUrl}/environment/${map}/${gridX}/${gridY}`));
      if (retired()) return;
      if (response.status === 204 || response.status === 404) {
        // A tile with nothing in it: open ground, and the terrain is the whole of the answer there.
        this.#tiles.set(key, null);
        this.#tilesVersion++;
        this.#tileErrors.delete(key);
        this.#clearTileRetry(key);
        settle(true);
        return;
      }
      if (!response.ok) throw new Error(`VMAP tile gateway returned ${response.status}`);
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new Error("VMAP tile gateway returned invalid objects");
      this.#tiles.set(key, value as EnvironmentObject[]);
      this.#tilesVersion++;
      // The tile's own spelling of every building it places is the spelling the gateway's disk
      // has. Anything else asking the model client for the same file — the renderer's water
      // probe, by an archive path in capitals — is folded onto it and shares the one download.
      for (const object of value as unknown[]) {
        const placed = object as Partial<EnvironmentObject> | null;
        if (placed?.kind === "wmo" && typeof placed.name === "string") this.models.preferSpelling(placed.name);
      }
      this.#tileErrors.delete(key);
      this.#clearTileRetry(key);
      settle(true);
    } catch (error) {
      // A transport or decode failure is not an authored empty tile. Keep readiness closed and let
      // the normal revision-driven rebuild issue one bounded retry after its cooldown. Retired
      // responses schedule nothing: their retry state would belong to a world that is gone.
      if (!retired()) {
        if (this.#tiles.delete(key)) this.#tilesVersion++;
        this.#tileErrors.add(key);
        this.#retryTileLater(key);
        settle(false);
        this.onStatus?.(error instanceof Error ? error.message : String(error), true);
      }
    } finally {
      settle(false);
    }
  }

  /**
   * Everything within reach of a point, nearest first, measured to each placement's box.
   *
   * Distance to the box rather than to the origin: a city's WMO has its origin at one corner and
   * is a mile across, and the player is inside it long before they are near that corner.
   */
  #near(map: number, x: number, y: number): NearPlacement[] {
    const reach = COLLISION_RANGE + RETAIN_MARGIN;
    const near: NearPlacement[] = [];
    for (const object of this.#placementsAround(map, x, y)) {
      const bounds = object.bounds;
      const dx = bounds ? Math.max(bounds.minX - x, 0, x - bounds.maxX) : Math.abs(object.x - x);
      const dy = bounds ? Math.max(bounds.minY - y, 0, y - bounds.maxY) : Math.abs(object.y - y);
      // Either axis alone out of reach settles it without the square root, and in a city tile
      // that is nearly every one of four thousand objects.
      if (dx >= reach || dy >= reach) continue;
      const distance = Math.hypot(dx, dy);
      if (distance < reach) near.push({ object, distance });
    }
    near.sort((left, right) => left.distance - right.distance || left.object.id - right.object.id);
    return near;
  }

  /**
   * Which groups should stand around this point, and what is still missing to stand them.
   *
   * Asks for what is missing on the way — models, and the geometry of in-range groups that are
   * still only a box — but builds nothing. The evaluation and the transfer barrier both work from
   * this, so they can never disagree about what "everything" is.
   */
  #plan(map: number, x: number, y: number): CollisionPlan {
    const serial = this.#serial;
    const near = this.#near(map, x, y);
    const chosen: Array<{ record: PlacedModel; groups: number[] }> = [];
    const pendingModels = new Set<string>();
    const pendingGroups = new Map<string, Set<number>>();
    let instances = 0;
    let triangles = 0;
    let dropped = 0;
    for (const { object, distance } of near) {
      // Nearest first, so everything from here on is only there to be kept, never to be built.
      if (distance >= COLLISION_RANGE) break;
      if (instances >= MAX_INSTANCES || triangles >= MAX_TRIANGLES) {
        dropped++;
        continue;
      }
      const model = this.models.model(object.name);
      // Not here yet: the client bumps its revision when it lands, which brings us back. `null`
      // is a resolved 404 and means this placement has no collision model at all.
      if (!model) {
        if (!this.models.isResolved(object.name)) pendingModels.add(object.name);
        continue;
      }
      const record = this.#record(map, object, model);
      record.seen = serial;
      // Which of the model's groups are near enough to be worth carrying, and which of those are
      // still only a box. A single-group doodad answers this in one comparison.
      let groups: number[] | undefined;
      let missing: number[] | undefined;
      let groupTriangles = 0;
      for (let index = 0; index < model.groups.length; index++) {
        const group = model.groups[index]!;
        if (group.triangleCount === 0) continue;
        if (!(groupDistance(record.boxes, index, x, y) < COLLISION_RANGE)) continue;
        if (group.vertices && group.indices) {
          (groups ??= []).push(index);
          // A loaded group's header reports the same count as its index buffer, so the ceiling is
          // spent on exactly the triangles the built meshes will hold.
          groupTriangles += group.triangleCount;
        } else {
          (missing ??= []).push(index);
        }
      }
      if (missing) {
        this.models.requestGroups(object.name, missing);
        const waiting = pendingGroups.get(object.name) ?? new Set<number>();
        for (const index of missing) waiting.add(index);
        pendingGroups.set(object.name, waiting);
      }
      if (!groups) continue;
      record.counted = serial;
      instances++;
      triangles += groupTriangles;
      chosen.push({ record, groups });
    }
    return { near, chosen, instances, triangles, dropped, pendingModels, pendingGroups };
  }

  /**
   * Works out what should stand around the player and makes the world hold it.
   *
   * Nothing here transforms a triangle. A group already built goes back into the world from the
   * cache, a group standing that is no longer wanted comes out of it, and a group never built is
   * queued for `#buildPending`.
   */
  #evaluate(map: number, x: number, y: number): void {
    const serial = ++this.#serial;
    const plan = this.#plan(map, x, y);
    this.#awaitedModels = plan.pendingModels;
    this.#awaitedGroups = plan.pendingGroups;
    this.#dropped = plan.dropped;

    const builds: PendingBuild[] = [];
    for (const { record, groups } of plan.chosen) {
      for (const index of groups) {
        const group = record.groups.get(index);
        if (group && this.#current(group)) {
          group.wanted = serial;
          continue;
        }
        if (group) this.#evict(group);
        builds.push({ record, index, distance: 0 });
      }
    }

    // Standing and only a little out of range: kept, nearest placement first, while the ceilings
    // have room left after everything in range has had its share.
    let instances = plan.instances;
    let triangles = plan.triangles;
    const reach = COLLISION_RANGE + RETAIN_MARGIN;
    for (const { object } of plan.near) {
      const record = this.#placements.get(object.id);
      if (!record || record.standing === 0 || !samePlacement(record, object)) continue;
      for (const group of record.groups.values()) {
        if (!group.standing || group.wanted === serial || !this.#current(group)) continue;
        if (!(groupDistance(record.boxes, group.index, x, y) < reach)) continue;
        if (triangles >= MAX_TRIANGLES) continue;
        if (record.counted !== serial) {
          if (instances >= MAX_INSTANCES) continue;
          record.counted = serial;
          instances++;
        }
        group.wanted = serial;
        triangles += group.mesh.triangleCount;
      }
    }

    for (const group of this.#standing) {
      if (group.wanted !== serial) this.#take(group);
    }
    // Built before and wanted again: back in from the cache without a triangle transformed.
    for (const { record, groups } of plan.chosen) {
      for (const index of groups) {
        const group = record.groups.get(index);
        if (group && group.wanted === serial) this.#put(group);
      }
    }
    this.#pending = builds;
    // Spawns neither in range nor holding anything built are forgotten; their boxes are cheap to
    // place again and the tiles they came from are what bounds them.
    for (const record of this.#placements.values()) {
      if (record.seen !== serial && record.groups.size === 0) this.#placements.delete(record.id);
    }
    this.#trim();
    this.#revision++;
    this.#reportDue = true;
  }

  /**
   * Builds queued groups, nearest first, until this frame's budget is spent.
   *
   * Nearest to where the player is now, not to where the plan was made: a group they are walking
   * towards moves up the queue, and one they are within `IMMEDIATE_BUILD_RANGE` of is built this
   * frame whatever the clock says. The queue also always moves by at least one group a frame, so
   * a frame whose evaluation alone used up the budget still gets somewhere.
   */
  #buildPending(x: number, y: number, started: number): void {
    const pending = this.#pending;
    for (const item of pending) item.distance = groupDistance(item.record.boxes, item.index, x, y);
    pending.sort((left, right) => left.distance - right.distance
      || left.record.id - right.record.id || left.index - right.index);
    let done = 0;
    let built = false;
    for (; done < pending.length; done++) {
      const item = pending[done]!;
      if (built && item.distance >= IMMEDIATE_BUILD_RANGE
        && performance.now() - started >= this.#buildBudgetMs) break;
      if (this.#build(item)) built = true;
    }
    pending.splice(0, done);
    if (!built) return;
    this.#trim();
    this.#revision++;
    this.#reportDue = true;
  }

  /** Transforms and grids one group and stands it in the world. */
  #build(item: PendingBuild): boolean {
    const { record, index } = item;
    // Superseded while it waited: a newer evaluation replaced the spawn, or it is built already.
    if (this.#placements.get(record.id) !== record || record.groups.has(index)) return false;
    const source = record.model.groups[index];
    if (!source?.vertices || !source.indices) return false;
    // One group, one run: the group's `MOGP` flags are how the character finds out whether the
    // floor it is standing on has a roof, and its index and authored id are how the WMO locator
    // names the room.
    const mesh = new CollisionMesh(transformCollisionMesh(source.vertices, source.indices, record), [
      { first: 0, flags: source.flags, groupIndex: index, groupId: source.groupId },
    ]);
    const group: PlacedGroup = {
      owner: record,
      index,
      key: this.#nextKey++,
      mesh,
      vertices: source.vertices,
      indices: source.indices,
      bytes: mesh.byteLength,
      standing: false,
      wanted: this.#serial,
    };
    record.groups.set(index, group);
    this.#cacheBytes += group.bytes;
    this.#groupsBuilt++;
    this.#put(group);
    return true;
  }

  /** The record for a spawn, made or checked against the tile's object and model. */
  #record(map: number, object: EnvironmentObject, model: CollisionModel): PlacedModel {
    let record = this.#placements.get(object.id);
    if (record && record.object !== object) {
      // A spawn id is only stable within one map, and one spawn repeated in two tiles is the same
      // transform twice. A different transform under the same id is a different placement.
      if (samePlacement(record, object)) record.object = object;
      else {
        this.#forget(record);
        record = undefined;
      }
    }
    if (record && record.model !== model) {
      record.model = model;
      record.boxes = groupBoxes(model, record);
    }
    if (!record) {
      record = {
        object,
        id: object.id,
        kind: object.kind,
        name: object.name,
        x: object.x,
        y: object.y,
        z: object.z,
        rotationX: object.rotationX,
        rotationY: object.rotationY,
        rotationZ: object.rotationZ,
        scale: object.scale,
        identity: object.kind === "wmo" ? staticWmoPlacementIdentity(map, object) : undefined,
        model,
        boxes: new Float64Array(0),
        groups: new Map(),
        standing: 0,
        seen: -1,
        counted: -1,
      };
      record.boxes = groupBoxes(model, record);
      this.#placements.set(object.id, record);
    }
    return record;
  }

  /** Whether a built group was built from the geometry its model holds now. */
  #current(group: PlacedGroup): boolean {
    const source = group.owner.model.groups[group.index];
    return source?.vertices === group.vertices && source.indices === group.indices;
  }

  #put(group: PlacedGroup): void {
    if (group.standing) return;
    group.standing = true;
    this.#standing.add(group);
    // Keyed by the build, answering for the spawn: see `CollisionWorld`.
    this.world.set(group.key, group.mesh, group.owner.id);
    if (group.owner.standing++ === 0) this.#instances++;
    this.#triangles += group.mesh.triangleCount;
  }

  #take(group: PlacedGroup): void {
    if (!group.standing) return;
    group.standing = false;
    this.#standing.delete(group);
    this.world.delete(group.key);
    if (--group.owner.standing === 0) this.#instances--;
    this.#triangles -= group.mesh.triangleCount;
  }

  #evict(group: PlacedGroup): void {
    this.#take(group);
    if (group.owner.groups.get(group.index) === group) group.owner.groups.delete(group.index);
    this.#cacheBytes -= group.bytes;
  }

  #forget(record: PlacedModel): void {
    for (const group of [...record.groups.values()]) this.#evict(group);
    if (this.#placements.get(record.id) === record) this.#placements.delete(record.id);
  }

  /** Evicts idle groups, least recently wanted first, until the cache is under its cap. */
  #trim(): void {
    if (this.#cacheBytes <= this.#cacheLimit) return;
    const idle: PlacedGroup[] = [];
    for (const record of this.#placements.values()) {
      for (const group of record.groups.values()) if (!group.standing) idle.push(group);
    }
    // The key breaks ties, so the same walk evicts the same groups.
    idle.sort((left, right) => left.wanted - right.wanted || left.key - right.key);
    for (const group of idle) {
      if (this.#cacheBytes <= this.#cacheLimit) break;
      this.#evict(group);
      this.#evicted++;
    }
  }

  /** Everything built, standing or cached, and everything waiting to be. Tiles are kept. */
  #forgetBuilt(): void {
    this.world.clear();
    this.#placements.clear();
    this.#standing.clear();
    this.#pending = [];
    this.#awaitedModels = new Set();
    this.#awaitedGroups = new Map();
    this.#cacheBytes = 0;
    this.#instances = 0;
    this.#triangles = 0;
    this.#dirty = false;
  }

  /**
   * Whether anything the last evaluation was waiting for has arrived.
   *
   * Asked of the client again rather than only looked up: a download that failed is requested
   * once more here when its cooldown is over, which is what the client's retry timer moved its
   * revision to wake — the same thing a full rebuild used to do, for the handful of names in
   * question instead of every placement around the player.
   */
  #awaitedLanded(): boolean {
    let landed = false;
    for (const name of this.#awaitedModels) {
      if (this.models.model(name) || this.models.isResolved(name)) landed = true;
    }
    for (const [name, groups] of this.#awaitedGroups) {
      const model = this.models.model(name);
      if (!model) continue;
      let missing: number[] | undefined;
      for (const index of groups) {
        const group = model.groups[index];
        if (group?.vertices && group.indices) landed = true;
        else (missing ??= []).push(index);
      }
      if (missing) this.models.requestGroups(name, missing);
    }
    return landed;
  }

  /** Whether a building's group waiting to be built stands over this point. */
  #pendingCovers(x: number, y: number): boolean {
    for (const { record, index } of this.#pending) {
      if (!record.identity) continue;
      const boxes = record.boxes;
      const base = index * 4;
      if (x >= boxes[base]! && x <= boxes[base + 2]! && y >= boxes[base + 1]! && y <= boxes[base + 3]!) return true;
    }
    return false;
  }

  /**
   * Reported whenever the world changed, and the dropped count is part of it. A ceiling nobody is
   * told about reads as "collision works here" right up until the moment it does not.
   */
  #report(): void {
    this.#reportDue = false;
    const thousands = (this.#triangles / 1000).toFixed(1);
    const dropped = this.#dropped;
    this.onStatus?.(
      `Коллизия: ${this.#instances} объектов, ${thousands}k треугольников${dropped > 0 ? ` · ${dropped} не поместилось` : ""}`,
      false,
    );
  }
}

/**
 * One deterministic representative for a spawn repeated in adjacent `.vmtile` files.
 *
 * On this dataset the repeats are exact copies — 96,583 of them across Eastern Kingdoms and not
 * one differing field — so which one wins only matters for a tile that disagrees with itself, and
 * then it must not depend on which tile arrived first.
 */
function uniquePlacements(tiles: readonly (readonly EnvironmentObject[])[]): EnvironmentObject[] {
  const byId = new Map<number, EnvironmentObject>();
  for (const tile of tiles) {
    for (const object of tile) {
      const current = byId.get(object.id);
      if (!current || comparePlacements(object, current) < 0) byId.set(object.id, object);
    }
  }
  return [...byId.values()];
}

/**
 * Total ordering used for duplicate ids: id, kind, name, then the transform, field by field.
 *
 * It used to compare two `JSON.stringify` signatures, which was 6.5-25 ms of every Stormwind
 * rebuild spent writing strings about objects that were identical anyway.
 */
function comparePlacements(left: EnvironmentObject, right: EnvironmentObject): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return compareNumbers(left.x, right.x)
    || compareNumbers(left.y, right.y)
    || compareNumbers(left.z, right.z)
    || compareNumbers(left.rotationX, right.rotationX)
    || compareNumbers(left.rotationY, right.rotationY)
    || compareNumbers(left.rotationZ, right.rotationZ)
    || compareNumbers(left.scale, right.scale);
}

/** Numeric order in which NaN sorts last and equals itself, so a corrupt tile still has a total order. */
function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
  if (Number.isNaN(right)) return -1;
  return left < right ? -1 : 1;
}

/** Whether a record and a tile object describe the same placement of the same model. */
function samePlacement(record: PlacedModel, object: EnvironmentObject): boolean {
  return record.kind === object.kind
    && record.name === object.name
    && record.x === object.x
    && record.y === object.y
    && record.z === object.z
    && record.rotationX === object.rotationX
    && record.rotationY === object.rotationY
    && record.rotationZ === object.rotationZ
    && record.scale === object.scale;
}

/**
 * Every group's model-space box placed in world space.
 *
 * Needed before any geometry is: a city's groups are chosen by which of their boxes the player is
 * near, and asking for the geometry first would defeat the whole point of choosing.
 */
function groupBoxes(model: CollisionModel, placement: CollisionPlacement): Float64Array {
  const boxes = new Float64Array(model.groups.length * 4);
  for (let index = 0; index < model.groups.length; index++) {
    const group = model.groups[index]!;
    // A group with nothing in it is never carried, and its box is never asked about.
    if (group.triangleCount === 0) continue;
    const box = transformCollisionBounds(group.bounds, placement);
    const base = index * 4;
    boxes[base] = box.minX;
    boxes[base + 1] = box.minY;
    boxes[base + 2] = box.maxX;
    boxes[base + 3] = box.maxY;
  }
  return boxes;
}

/** Horizontal distance from a point to one group's placed box; zero inside it. */
function groupDistance(boxes: Float64Array, index: number, x: number, y: number): number {
  const base = index * 4;
  const dx = Math.max(boxes[base]! - x, 0, x - boxes[base + 2]!);
  const dy = Math.max(boxes[base + 1]! - y, 0, y - boxes[base + 3]!);
  return Math.hypot(dx, dy);
}
