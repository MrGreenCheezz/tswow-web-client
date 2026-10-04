import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import { liftPoseAt } from "../LiftClock.js";
import type { TransportPath } from "../TransportPath.js";
import type { CollisionWorld } from "./Collision.js";
import { DynamicColliderProbe, type DynamicCollider } from "./DynamicColliderProbe.js";
import type { CharacterMotion, TerrainProbe } from "./Physics.js";
import { DEFAULT_COLLISION_HEIGHT } from "./Physics.js";
import { TransportCollision, type CarrierModelSource, type CarrierPose } from "./TransportCollision.js";
import { worldFloorUnder } from "./TransportRide.js";

/**
 * 11.01 slice B: closed doors and lifts — the game objects whose collision the physics now asks
 * besides the static world.
 *
 * What the core keeps. Every game object whose display id has a `.dtree` row gets a model in the
 * map's dynamic tree (`GameObject::CreateModel` → `GameObjectModel::Create`; `AddToWorld` inserts
 * it, GameObject.cpp:236-243), enabled when `toggledState` holds: a chest's loot is ready, else the
 * object is `GO_STATE_READY` or a transport (:236). `SetGoState` re-decides it for every
 * non-transport — READY on, anything else off (GameObject.cpp:2687-2705, `EnableCollision`). The
 * model sits at `pos + scale · Rz(o) · v` (GameObjectModel.cpp:124-137): yaw only, so a tilted
 * object's collision is still level, and that frame is the one used here (`TransportCollision`).
 *
 * What this mirrors, conservatively: doors (`GAMEOBJECT_TYPE_DOOR`, 0) solid exactly while their
 * state byte (`GAMEOBJECT_BYTES_1` byte 0, `SetGoState`) reads READY (1, closed) and open at ACTIVE
 * (0) and DESTROYED (2, the 3.3.5 name of ACTIVE_ALTERNATIVE — `SwitchDoorOrButton(…, alternative)`,
 * GameObject.cpp:1650), and only doors whose template is known and not `startOpen` (`doorSolid`);
 * lifts (`GAMEOBJECT_TYPE_TRANSPORT`, 11) always solid, as the core keeps
 * them, but where the client draws them on their path (LiftClock.ts) rather than at the spawn the
 * core never moves them from. Other types the core also makes solid (chests, buttons, goobers,
 * generic props) are left out on purpose: the owner plays dungeons daily, and a misplaced prop in a
 * corridor costs more than one missing (the renderer may draw game objects half a turn from the core
 * frame — plan item 7.24). A state that never came, a model the gateway has no row for, a gateway
 * without `/vmap/gobject-models` (404): no collider, exactly as before this slice.
 *
 * Lifts are client-only rides (spec 11.01, mechanism 5): the character standing on a lift's floor is
 * moved by the platform's own move each frame, and its packets stay in world coordinates without
 * `MOVEMENTFLAG_ONTRANSPORT` — the core would keep the flag for a type 11 guid but never make the
 * player a passenger (MovementHandler.cpp:340-345), and observers would add the offset to the lift's
 * static spawn.
 */

export const GO_TYPE_DOOR = 0;
export const GO_TYPE_TRANSPORT = 11;
/** `GOState` (SharedDefines.h:1655-1660). */
export const GO_STATE_ACTIVE = 0;
export const GO_STATE_READY = 1;
export const GO_STATE_DESTROYED = 2;

/** 2D yards from the character within which a door or a lift is asked and its model kept. */
export const COLLIDER_RANGE = 60;
/** Feet within this of a lift's floor (at last frame's pose) stand on it. */
export const LIFT_STAND_TOLERANCE = 0.25;
/** A platform that moved further in one frame jumped (a path's cut, a stale frame): no carry. */
export const LIFT_CARRY_MAX_STEP = 20;
/** How often the candidate list is rebuilt when the object count has not changed. */
const RESCAN_MS = 1000;

const TYPEID_GAMEOBJECT = 5;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;

/** `GAMEOBJECT_BYTES_1` byte 1 (`SetGoType`, GameObject.h:177); undefined when not known. */
export function gameObjectType(object: WorldObjectState): number | undefined {
  if (object.typeId !== TYPEID_GAMEOBJECT) return undefined;
  const bytes = object.fields.get(BYTES_1);
  return bytes === undefined ? undefined : (bytes >>> 8) & 0xff;
}

/** `GAMEOBJECT_BYTES_1` byte 0 (`SetGoState`); undefined when the field never came. */
export function gameObjectState(object: WorldObjectState): number | undefined {
  if (object.typeId !== TYPEID_GAMEOBJECT) return undefined;
  const bytes = object.fields.get(BYTES_1);
  return bytes === undefined ? undefined : bytes & 0xff;
}

/** What a door's collision needs of its template (`CMSG_GAMEOBJECT_QUERY`): the type and `data`. */
export interface DoorTemplate {
  readonly type: number;
  readonly data: readonly number[];
}

/**
 * A door's collision: true closed (READY), false open (ACTIVE, DESTROYED), undefined when unknown
 * or not a door.
 *
 * Only a door whose template says `startOpen` = 0 (`door.startOpen`, data0, GameObjectData.h:59)
 * counts. The core turns the collision on at READY whatever that word says (its own comment at
 * GameObject.cpp:2700 notes the gap), but the client reads the word "to determine GO_ACTIVATED means
 * open/closed" (GameObjectData.h:59): a startOpen door at READY may stand open on Wow.exe's screen
 * while the core blocks it. Where the two disagree there is no collider — and none until the
 * template has come.
 */
export function doorSolid(object: WorldObjectState, template: DoorTemplate | undefined): boolean | undefined {
  if (gameObjectType(object) !== GO_TYPE_DOOR) return undefined;
  if (template === undefined || template.type !== GO_TYPE_DOOR) return undefined;
  const state = gameObjectState(object);
  if (state === GO_STATE_ACTIVE || state === GO_STATE_DESTROYED) return false;
  if (state !== GO_STATE_READY) return undefined;
  return template.data[0] === 0 ? true : undefined;
}

/** The template source: `WorldClient.gameObjectTemplate` in the page (asks once per entry). */
export type DoorTemplates = (entry: number, guid: bigint) => DoorTemplate | undefined;

/** The carriers' collision in their own frames: `TransportCollision` in the page. */
export type ColliderModels = Pick<TransportCollision, "forObject" | "retain" | "clear">;
/** The lifts' paths: `TransportPathClient` in the page (`/dbc/transport-paths`). */
export interface LiftPaths {
  path(entry: number): TransportPath | undefined;
}

interface ColliderRecord extends DynamicCollider {
  readonly lift: boolean;
  pose: CarrierPose;
  /** A lift's pose last frame, for the carry; valid only when it was a collider then. */
  readonly prev: CarrierPose;
  prevValid: boolean;
  /**
   * A door that became solid with the character inside its box: left out until the character is
   * clear of it. Undefined until decided (a new record, or a new mesh for it).
   */
  passable: boolean | undefined;
}

const FEET = { x: 0, y: 0, z: 0 };

export class GameObjectColliders {
  readonly #models: ColliderModels;
  readonly #paths: LiftPaths | undefined;
  readonly #probe = new DynamicColliderProbe({ ground: () => undefined, liquid: () => undefined, hole: () => false });
  readonly #records = new Map<bigint, ColliderRecord>();
  readonly #candidates = new Set<bigint>();
  #scannedAt = Number.NEGATIVE_INFINITY;
  #scannedSize = -1;
  #scannedObjects: ReadonlyMap<bigint, WorldObjectState> | undefined;
  #near = new Set<bigint>();
  #nearNext = new Set<bigint>();
  #carrying = false;
  #settled = false;

  readonly #templates: DoorTemplates | undefined;

  constructor(models: ColliderModels, paths: LiftPaths | undefined, templates?: DoorTemplates) {
    this.#models = models;
    this.#paths = paths;
    this.#templates = templates;
  }

  /** The lift under the feet moved the character this frame: a heartbeat is due without a key. */
  get carrying(): boolean {
    return this.#carrying;
  }

  /** A carry ended (the lift stopped, the character stepped off): read once, the flag clears. */
  takeSettled(): boolean {
    const value = this.#settled;
    this.#settled = false;
    return value;
  }

  /** How many colliders the last frame asked (diagnostics, tests). */
  get active(): number {
    return this.#probe.count;
  }

  /**
   * Frame start, before the step: picks the doors and lifts near the character, carries a character
   * standing on a lift by the lift's move, and returns the probe to step against — `base` itself
   * when nothing is near, so a frame without doors or lifts asks the world exactly as before.
   */
  frame(objects: ReadonlyMap<bigint, WorldObjectState>, self: WorldObjectState, base: TerrainProbe,
    motion: Readonly<CharacterMotion>, now: number): TerrainProbe {
    const probe = this.#probe;
    probe.base = base;
    probe.count = 0;
    const position = self.position;
    if (!position) {
      this.#endCarry(false);
      return base;
    }
    this.#rescan(objects, now);
    const near = this.#nearNext;
    near.clear();
    for (const guid of this.#candidates) {
      const object = objects.get(guid);
      if (!object?.position) continue;
      const type = gameObjectType(object);
      if (type === GO_TYPE_DOOR) this.#door(object, position, near);
      else if (type === GO_TYPE_TRANSPORT) this.#lift(object, position, near, now);
    }
    for (const guid of this.#records.keys()) if (!near.has(guid)) this.#records.delete(guid);
    let changed = near.size !== this.#near.size;
    if (!changed) for (const guid of near) if (!this.#near.has(guid)) {
      changed = true;
      break;
    }
    this.#nearNext = this.#near;
    this.#near = near;
    if (changed) this.#models.retain(near);

    this.#endCarry(this.#carry(position, motion, base));
    for (let index = 0; index < probe.count; index++) {
      const record = probe.colliders[index] as ColliderRecord;
      if (!record.lift) continue;
      record.prev.x = record.pose.x;
      record.prev.y = record.pose.y;
      record.prev.z = record.pose.z;
      record.prev.orientation = record.pose.orientation;
      record.prevValid = true;
    }
    return probe.count > 0 ? probe : base;
  }

  clear(): void {
    this.#records.clear();
    this.#candidates.clear();
    this.#near.clear();
    this.#nearNext.clear();
    this.#scannedObjects = undefined;
    this.#scannedSize = -1;
    this.#scannedAt = Number.NEGATIVE_INFINITY;
    this.#probe.count = 0;
    this.#carrying = false;
    this.#settled = false;
    this.#models.clear();
  }

  #door(object: WorldObjectState, position: WorldPosition, near: Set<bigint>): void {
    const pose = object.position!;
    if (!within(pose, position)) return;
    near.add(object.guid);
    // Asked while open too, so the model is there by the time the door closes.
    const world = this.#models.forObject(object);
    const template = this.#templates?.(object.fields.get(ENTRY) ?? 0, object.guid);
    if (doorSolid(object, template) !== true || !world) {
      this.#records.delete(object.guid);
      return;
    }
    const record = this.#record(object.guid, world, false);
    record.pose.x = pose.x;
    record.pose.y = pose.y;
    record.pose.z = pose.z;
    record.pose.orientation = pose.orientation;
    // Review 11.01-B: a door closing on the character (a boss door shutting on someone in the
    // doorway) must not hold it. The wall push is two-sided, so a body inside a slab thicker than
    // itself is only ever pushed back inwards — trapped until the door opens again. Such a door
    // stays passable to the character until its body is clear of the box, then is solid as usual.
    if (record.passable === undefined) record.passable = insideBox(record, position);
    else if (record.passable && !insideBox(record, position)) record.passable = false;
    if (record.passable) return;
    this.#push(record);
  }

  #lift(object: WorldObjectState, position: WorldPosition, near: Set<bigint>, now: number): void {
    // Until the path is known the lift is nowhere in particular: no collider rather than one at the spawn.
    const path = this.#paths?.path(object.fields.get(ENTRY) ?? 0);
    if (!path) return;
    let record = this.#records.get(object.guid);
    const pose = liftPoseAt(object, path, now, LIFT_POSE);
    if (!pose || !within(pose, position)) {
      if (record) record.prevValid = false;
      return;
    }
    near.add(object.guid);
    const world = this.#models.forObject(object);
    if (!world) {
      this.#records.delete(object.guid);
      return;
    }
    record = this.#record(object.guid, world, true);
    record.pose.x = pose.x;
    record.pose.y = pose.y;
    record.pose.z = pose.z;
    record.pose.orientation = pose.orientation;
    this.#push(record);
  }

  #record(guid: bigint, world: CollisionWorld, lift: boolean): ColliderRecord {
    let record = this.#records.get(guid);
    if (!record || record.lift !== lift) {
      record = {
        guid, world, lift, pose: { x: 0, y: 0, z: 0, orientation: 0 }, prev: { x: 0, y: 0, z: 0, orientation: 0 },
        prevValid: false, passable: undefined,
      };
      this.#records.set(guid, record);
    }
    // Another world for the same guid (a new display id or scale): the old pose relation is moot.
    if (record.world !== world) {
      record.world = world;
      record.prevValid = false;
      record.passable = undefined;
    }
    return record;
  }

  #push(record: ColliderRecord): void {
    const probe = this.#probe;
    probe.colliders[probe.count++] = record;
  }

  /**
   * The character on a lift goes where the lift went: the feet in the lift's frame at last frame's
   * pose, put back at this frame's. Only on the ground, only when that floor is the lift's and the
   * world has nothing as high under the feet (a landing flush with the platform is the landing).
   * True when the character moved.
   */
  #carry(position: WorldPosition, motion: Readonly<CharacterMotion>, base: TerrainProbe): boolean {
    if (motion.mode !== "ground") return false;
    const probe = this.#probe;
    let best: ColliderRecord | undefined;
    let bestZ = Number.NEGATIVE_INFINITY;
    let bestX = 0;
    let bestY = 0;
    let bestLocalZ = 0;
    for (let index = 0; index < probe.count; index++) {
      const record = probe.colliders[index] as ColliderRecord;
      if (!record.lift || !record.prevValid) continue;
      const prev = record.prev;
      const cos = Math.cos(prev.orientation);
      const sin = Math.sin(prev.orientation);
      const dx = position.x - prev.x;
      const dy = position.y - prev.y;
      FEET.x = dx * cos + dy * sin;
      FEET.y = dy * cos - dx * sin;
      FEET.z = position.z - prev.z;
      const hit = record.world.floorUnder(FEET.x, FEET.y, FEET.z + LIFT_STAND_TOLERANCE, FEET.z - LIFT_STAND_TOLERANCE);
      if (hit === undefined || hit + prev.z <= bestZ) continue;
      best = record;
      bestZ = hit + prev.z;
      bestX = FEET.x;
      bestY = FEET.y;
      bestLocalZ = FEET.z;
    }
    if (!best) return false;
    const worldZ = worldFloorUnder(base, position.x, position.y, position.z);
    if (worldZ !== undefined && worldZ >= bestZ) return false;
    const pose = best.pose;
    const cos = Math.cos(pose.orientation);
    const sin = Math.sin(pose.orientation);
    const x = pose.x + bestX * cos - bestY * sin;
    const y = pose.y + bestX * sin + bestY * cos;
    const z = pose.z + bestLocalZ;
    const dx = x - position.x;
    const dy = y - position.y;
    const dz = z - position.z;
    if (dx === 0 && dy === 0 && dz === 0) return false;
    if (Math.abs(dx) > LIFT_CARRY_MAX_STEP || Math.abs(dy) > LIFT_CARRY_MAX_STEP || Math.abs(dz) > LIFT_CARRY_MAX_STEP) return false;
    position.x = x;
    position.y = y;
    position.z = z;
    return true;
  }

  #endCarry(moved: boolean): void {
    if (this.#carrying && !moved) this.#settled = true;
    this.#carrying = moved;
  }

  #rescan(objects: ReadonlyMap<bigint, WorldObjectState>, now: number): void {
    if (objects === this.#scannedObjects && objects.size === this.#scannedSize && now - this.#scannedAt < RESCAN_MS) return;
    this.#scannedObjects = objects;
    this.#scannedSize = objects.size;
    this.#scannedAt = now;
    this.#candidates.clear();
    for (const object of objects.values()) {
      const type = gameObjectType(object);
      if (type === GO_TYPE_DOOR || type === GO_TYPE_TRANSPORT) this.#candidates.add(object.guid);
    }
  }
}

const LIFT_POSE: CarrierPose = { x: 0, y: 0, z: 0, orientation: 0 };

function within(pose: CarrierPose, position: WorldPosition): boolean {
  const dx = pose.x - position.x;
  const dy = pose.y - position.y;
  return dx * dx + dy * dy <= COLLIDER_RANGE * COLLIDER_RANGE;
}

/**
 * Whether the character's centre stands in the footprint of one of the collider's meshes (their
 * boxes, in the collider's own frame) with its body overlapping the box's height. A centre outside
 * the footprint is pushed out on its own side; only one inside it can be held.
 */
function insideBox(record: ColliderRecord, position: WorldPosition): boolean {
  const pose = record.pose;
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const dx = position.x - pose.x;
  const dy = position.y - pose.y;
  const x = dx * cos + dy * sin;
  const y = dy * cos - dx * sin;
  const z = position.z - pose.z;
  for (const id of record.world.ids()) {
    const bounds = record.world.get(id)?.bounds;
    if (!bounds) continue;
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
    if (z > bounds.maxZ || z + DEFAULT_COLLISION_HEIGHT < bounds.minZ) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The page's wiring: one set per world session, read by `Movement.advancePhysics`.

let colliders: GameObjectColliders | undefined;

/**
 * Every world mount (EnterWorld.ts), after the ride: the collision models are the ride's own
 * (`rideCollisionModels`, one `/vmap/gobject-models` loader per gateway), the paths the renderer's.
 */
export function startGameObjectColliders(models: CarrierModelSource | undefined, paths: LiftPaths | undefined,
  templates: DoorTemplates | undefined): void {
  colliders?.clear();
  colliders = models ? new GameObjectColliders(new TransportCollision(models), paths, templates) : undefined;
}

/** The world session is retired. */
export function stopGameObjectColliders(): void {
  colliders?.clear();
  colliders = undefined;
}

/** Tests: a collider set without a gateway (undefined: none, the world alone). */
export function setGameObjectColliders(value: GameObjectColliders | undefined): void {
  colliders = value;
}

/** `GameObjectColliders.frame` for the live world; the world probe itself when there is none. */
export function gameObjectColliderFrame(objects: ReadonlyMap<bigint, WorldObjectState>, self: WorldObjectState,
  base: TerrainProbe, motion: Readonly<CharacterMotion>, now: number): TerrainProbe {
  return colliders ? colliders.frame(objects, self, base, motion, now) : base;
}

/** The character is being carried by a moving lift this frame. */
export function liftCarrying(): boolean {
  return colliders?.carrying === true;
}

/** A carry just ended: one heartbeat says where the character came to rest. */
export function takeLiftSettled(): boolean {
  return colliders?.takeSettled() === true;
}
