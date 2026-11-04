import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { MovementInfo } from "../../world/MovementProtocol.js";
import { normalizeOrientation } from "../../world/TransportMath.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import { liftPhaseMs, liftPoseAt } from "../LiftClock.js";
import type { TransportPath } from "../TransportPath.js";
import type { CollisionWorld } from "./Collision.js";
import { DynamicColliderProbe, type DynamicCollider } from "./DynamicColliderProbe.js";
import type { CharacterMotion, TerrainProbe } from "./Physics.js";
import { DEFAULT_COLLISION_HEIGHT } from "./Physics.js";
import { TransportCollision, type CarrierModelSource, type CarrierPose } from "./TransportCollision.js";
import { SHIP_SEAT, worldFloorUnder } from "./TransportRide.js";

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
 * What Wow.exe makes solid (11.01, owner's decision of 12.10; Ghidra notes
 * .runtime/re-2026-10-11/glue-1110/t1101-*.txt). Every game object's model becomes a world entity
 * when the object is set up (0x00711a10 → 0x007110b0 → 0x00783500): a WMO a map object definition, an
 * M2 a doodad definition, each carrying the object's guid as the owner of its triangles (+0x148 /
 * +0xb8). The movement collision query (0x0075f0a0 → 0x00783910 → 0x007a5f20, flags 0x0075e3d0)
 * gathers both — the dynamic WMOs from their list (0x007a55e0), a game object's doodad from the
 * chunks and groups it stands in (0x007a50c0, under query flag 0x100000, which every movement query
 * has) — unless the entity's +0xc bit 0x100 is set. That bit is set only by a destructible building
 * for the models of its other states and while it is hidden (0x00710be0, 0x0070dfa0, 0x0070e750,
 * 0x0070b6a0/0x0070b6e0), and by 0x00710460 (GO vt+0x140, which also drops a transport's passengers).
 * No game object's state or type turns it off otherwise — the door's state handler 0x0070d690 only
 * picks the animation.
 *
 * So here: every game object near the character whose display id has a collision model is solid at
 * `pos + scale · Rz(o) · v` (`gameObjectSolid`), whatever its type and state, with three exceptions:
 * - doors (`GAMEOBJECT_TYPE_DOOR`, 0) by their state byte (`GAMEOBJECT_BYTES_1` byte 0, `SetGoState`): solid
 *   at READY (1), open at ACTIVE (0) and DESTROYED (2, the 3.3.5 name of ACTIVE_ALTERNATIVE —
 *   `SwitchDoorOrButton(…, alternative)`, GameObject.cpp:1650), whatever the template's `startOpen` says.
 *   Measured on Wow.exe's stand 04.11 (display 443, walking into it, runs/lift-door.txt): stopped at the door
 *   in state 1 and through it in 0 and 2, the same with data0 = 1. Its state handler 0x0070d690 only picks the
 *   animation and 0x0082ec30 reads the M2's static collision arrays, so what lets the body through is
 *   somewhere else in the client; the rule is measured, the mechanism is not;
 * - lifts (`GAMEOBJECT_TYPE_TRANSPORT`, 11) solid where the client draws them on their path
 *   (LiftClock.ts) rather than at the spawn the core never moves them from, and carrying;
 * - ships and zeppelins (`GAMEOBJECT_TYPE_MO_TRANSPORT`, 15): the ridden one's deck is the ride's, in its
 *   own frame (input/MovementRide.ts); any other is solid at its pose this frame like the rest (04.11).
 *   Boarding and the end of a ride read the world's floor as the pier, and a deck in it would always tie
 *   with itself, so they ask `withoutHulls`.
 * A destructible building (33) is solid by its current display id, which the core switches with the
 * state (`SetDestructibleState` → `SetDisplayId`), as Wow.exe swaps the active model. A game object
 * aboard the ship the character rides is solid in that ship's frame, at its seat (`rideColliderProbe`),
 * so a crate on the deck stands on the deck the step runs on. A model the gateway has no row for, a
 * gateway without `/vmap/gobject-models` (404): no collider, exactly as before slice B.
 *
 * Riding a lift, as measured on Wow.exe's stand 04.11 (F:\\WowOracle\\tools\\lift-ride.mjs, lift-walkon.mjs): a step that
 * ends on the floor of a lift with `GO_FLAG_TRANSPORT` (0x8 in GAMEOBJECT_FLAGS; without it nothing happens and the car
 * leaves the character behind) makes the character its passenger, landing or walking on alike. Every packet then has
 * MOVEMENTFLAG_ONTRANSPORT, the world position, the car's guid, the offset on it, the path time and seat −1. Standing still
 * sends nothing at all while the car moves. A jump keeps the seat, its offset rising. Stepping off ends it where the floor
 * under the feet stops being the car's, and falling ends it outside the model's box (0x0077ffb0). The core keeps the flag for
 * a type 11 guid without making the player a passenger (MovementHandler.cpp:340-345); observers place the rider on the car
 * (`WorldState.carrierPoseProvider`). Wow.exe says a change of seat with CMSG_MOVE_CHNG_TRANSPORT; here a heartbeat, as for
 * ships, until observers read that opcode (Movement.ts).
 */

export const GO_TYPE_DOOR = 0;
export const GO_TYPE_TRANSPORT = 11;
/** 11.01: ships and zeppelins — the ridden one is the ride's, any other a wall. */
export const GO_TYPE_MO_TRANSPORT = 15;
/** `GOState` (SharedDefines.h:1655-1660). */
export const GO_STATE_ACTIVE = 0;
export const GO_STATE_READY = 1;
export const GO_STATE_DESTROYED = 2;

/** 2D yards from the character within which a game object is asked and its model kept. */
export const COLLIDER_RANGE = 60;
/**
 * 11.01: a collider joins a frame's probe only while the character is within this many yards of its
 * model's footprint (in the model's frame) and not further below its bottom — the step of a frame
 * is a fraction of it, and a city's worth of benches is not asked on every query.
 */
export const COLLIDER_REACH = 8;
/** Feet within this of a lift's floor (at last frame's pose) stand on it. */
export const LIFT_STAND_TOLERANCE = 0.25;
/** `GO_FLAG_TRANSPORT` in GAMEOBJECT_FLAGS: what makes a lift's floor a transport to Wow.exe (measured 04.11). */
export const GO_FLAG_TRANSPORT = 0x8;
/** 0x0077ffb0 lifts the top of the model's box by this: [0xa3e6f0] + [0xa3e6ec]. */
const LIFT_BOX_TOP_MARGIN = 1.6404123 + 1 / 72;
/** How often the candidate list is rebuilt when the object count has not changed. */
const RESCAN_MS = 1000;

const TYPEID_GAMEOBJECT = 5;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const FLAGS = UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset;

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

/**
 * A door's collision: true closed (READY), false open (ACTIVE, DESTROYED), undefined when not a door or its state has
 * not come. 04.11: the template does not enter it, `startOpen` included (measured, see the head of this file).
 */
export function doorSolid(object: WorldObjectState): boolean | undefined {
  if (gameObjectType(object) !== GO_TYPE_DOOR) return undefined;
  const state = gameObjectState(object);
  if (state === GO_STATE_ACTIVE || state === GO_STATE_DESTROYED) return false;
  return state === GO_STATE_READY ? true : undefined;
}

/**
 * 11.01: whether a game object's model is solid here — true for every type Wow.exe leaves its entity
 * collidable for (all but a destructible building's other states, which the display id already
 * leaves out), a door by `doorSolid`, false for a ship (the ride's). Undefined when the type is not
 * known yet. A lift is solid too; `GameObjectColliders` places it on its path.
 */
export function gameObjectSolid(object: WorldObjectState): boolean | undefined {
  const type = gameObjectType(object);
  if (type === undefined) return undefined;
  if (type === GO_TYPE_DOOR) return doorSolid(object);
  return type !== GO_TYPE_MO_TRANSPORT;
}

/** The carriers' collision in their own frames: `TransportCollision` in the page. */
export type ColliderModels = Pick<TransportCollision, "forObject" | "retain" | "clear">;
/** The lifts' paths: `TransportPathClient` in the page (`/dbc/transport-paths`). */
export interface LiftPaths {
  path(entry: number): TransportPath | undefined;
}

interface ColliderRecord extends DynamicCollider {
  readonly lift: boolean;
  /** 04.11: a lift with `GO_FLAG_TRANSPORT`, whose floor takes passengers. */
  carrier: boolean;
  /** 04.11: a lift's path period, for the path time its passengers send. */
  period: number;
  /** 04.11: a ship not ridden, left out of `withoutHulls`. */
  hull: boolean;
  pose: CarrierPose;
  /**
   * A door that became solid with the character inside its box: left out until the character is
   * clear of it. Undefined until decided (a new record, or a new mesh for it).
   */
  passable: boolean | undefined;
  /** 11.01: the model's box in its own frame (all meshes so far), for `COLLIDER_REACH`; rebuilt as groups arrive. */
  readonly box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /** 11.01: `world.size` when `box` was built. */
  boxSize: number;
}

const FEET = { x: 0, y: 0, z: 0 };

export class GameObjectColliders {
  readonly #models: ColliderModels;
  readonly #paths: LiftPaths | undefined;
  readonly #probe = new DynamicColliderProbe({ ground: () => undefined, liquid: () => undefined, hole: () => false });
  /** 11.01: the game objects aboard the ship the character rides, in that ship's frame (`rideProbe`). */
  readonly #aboardProbe = new DynamicColliderProbe({ ground: () => undefined, liquid: () => undefined, hole: () => false });
  /** 04.11: this frame's colliders but the hulls, for what reads the world's floor as the pier (`withoutHulls`). */
  readonly #noHulls = new DynamicColliderProbe({ ground: () => undefined, liquid: () => undefined, hole: () => false });
  /** 11.01: the ship those are aboard; undefined when the character rides none. */
  #aboardCarrier: bigint | undefined;
  readonly #records = new Map<bigint, ColliderRecord>();
  readonly #candidates = new Set<bigint>();
  #scannedAt = Number.NEGATIVE_INFINITY;
  #scannedSize = -1;
  #scannedObjects: ReadonlyMap<bigint, WorldObjectState> | undefined;
  #near = new Set<bigint>();
  #nearNext = new Set<bigint>();
  #seatChanged = false;

  constructor(models: ColliderModels, paths: LiftPaths | undefined) {
    this.#models = models;
    this.#paths = paths;
  }

  /** The character got on or off a lift: read once, the flag clears. */
  takeSeatChanged(): boolean {
    const value = this.#seatChanged;
    this.#seatChanged = false;
    return value;
  }

  /** Whether `self`'s seat is on a lift near it. */
  seatedOnLift(self: WorldObjectState | undefined): boolean {
    const seat = self?.transport;
    return seat !== undefined && this.#records.get(seat.guid)?.lift === true;
  }

  /**
   * The block a passenger's packet carries: the offset on the car, the path time (measured: 673 ms into the path on
   * the landing, running with the clock) and seat −1. Undefined when `self` is not on a lift.
   */
  liftTransportBlock(self: WorldObjectState | undefined, object: WorldObjectState | undefined, now: number): MovementInfo["transport"] | undefined {
    const seat = self?.transport;
    const record = seat === undefined ? undefined : this.#records.get(seat.guid);
    if (!seat || !record?.lift || !object) return undefined;
    return { guid: seat.guid, x: seat.x, y: seat.y, z: seat.z, orientation: seat.orientation,
      time: Math.trunc(liftPhaseMs(object, record.period, now)) >>> 0, seat: SHIP_SEAT };
  }

  /**
   * 04.11: a turn of the character made outside the frame (the mouse): its facing on the car turns with it, or the next frame's
   * carry, which composes the world's facing from the seat (WorldState), undoes it.
   */
  turnedOnLift(self: WorldObjectState | undefined, radians: number): void {
    const seat = self?.transport;
    if (seat !== undefined && this.#records.get(seat.guid)?.lift) seat.orientation = normalizeOrientation(seat.orientation + radians);
  }

  /** How many colliders the last frame asked (diagnostics, tests). */
  get active(): number {
    return this.#probe.count;
  }

  /** 11.01: how many game objects aboard the ridden ship the last frame put in its frame (diagnostics, tests). */
  get aboard(): number {
    return this.#aboardProbe.count;
  }

  /**
   * 04.11: the world as this frame's `frame` returned it, without the ships. Boarding asks it: a deck that is
   * also the world's floor would tie with itself, and the world wins a tie.
   */
  withoutHulls(base: TerrainProbe): TerrainProbe {
    const probe = this.#noHulls;
    if (probe.count === this.#probe.count && probe.count > 0) return this.#probe;
    if (probe.count === 0) return base;
    probe.base = base;
    return probe;
  }

  /**
   * 11.01: the probe for a step on `carrier`'s deck — `deck` itself (the ride's `CarrierProbe`), with
   * the game objects aboard that ship at their seats when the last frame found any.
   */
  rideProbe(carrier: bigint, deck: TerrainProbe): TerrainProbe {
    const probe = this.#aboardProbe;
    if (this.#aboardCarrier !== carrier || probe.count === 0) return deck;
    probe.base = deck;
    return probe;
  }

  /**
   * Frame start, before the step: picks the game objects near the character, carries a character
   * standing on a lift by the lift's move, and returns the probe to step against — `base` itself
   * when nothing is near, so a frame without them asks the world exactly as before. 11.01: the game
   * objects aboard the ship the character rides go to that ship's frame instead (`rideProbe`).
   */
  frame(objects: ReadonlyMap<bigint, WorldObjectState>, self: WorldObjectState, base: TerrainProbe,
    motion: Readonly<CharacterMotion>, now: number): TerrainProbe {
    const probe = this.#probe;
    probe.base = base;
    probe.count = 0;
    this.#noHulls.count = 0;
    this.#aboardProbe.count = 0;
    const position = self.position;
    if (!position) return base;
    this.#rescan(objects, now);
    // 11.01: the ship the character stands on, if any (its seat is the ride's offset).
    const seat = self.transport;
    const carrier = seat === undefined ? undefined : objects.get(seat.guid);
    this.#aboardCarrier = carrier !== undefined && gameObjectType(carrier) === GO_TYPE_MO_TRANSPORT ? seat!.guid : undefined;
    const near = this.#nearNext;
    near.clear();
    for (const guid of this.#candidates) {
      const object = objects.get(guid);
      if (!object?.position) continue;
      const type = gameObjectType(object);
      if (type === GO_TYPE_TRANSPORT) this.#lift(object, position, near, now);
      else if (type === GO_TYPE_MO_TRANSPORT) {
        if (guid !== this.#aboardCarrier) this.#hull(object, position, near); // 04.11
      } else if (type === undefined) continue;
      else if (this.#aboardCarrier !== undefined && object.transport?.guid === this.#aboardCarrier) {
        this.#aboard(object, seat!, position, near);
      } else this.#solid(object, position, near);
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

    this.#composeSeat(self, position);
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
    this.#noHulls.count = 0;
    this.#aboardProbe.count = 0;
    this.#aboardCarrier = undefined;
    this.#seatChanged = false;
    this.#models.clear();
  }

  /** 11.01: any game object but a lift and a ship, at its world pose (a door by its state). */
  #solid(object: WorldObjectState, position: WorldPosition, near: Set<bigint>): void {
    const pose = object.position!;
    if (!within(pose, position)) return;
    near.add(object.guid);
    // Asked while open too, so the model is there by the time a door closes.
    const world = this.#models.forObject(object);
    const door = gameObjectType(object) === GO_TYPE_DOOR;
    if (gameObjectSolid(object) !== true || !world) {
      this.#records.delete(object.guid);
      return;
    }
    const record = this.#record(object.guid, world, false);
    record.pose.x = pose.x;
    record.pose.y = pose.y;
    record.pose.z = pose.z;
    record.pose.orientation = pose.orientation;
    if (door) {
      // Review 11.01-B: a door closing on the character (a boss door shutting on someone in the
      // doorway) must not hold it. The wall push is two-sided, so a body inside a slab thicker than
      // itself is only ever pushed back inwards — trapped until the door opens again. Such a door
      // stays passable to the character until its body is clear of the box, then is solid as usual.
      // 11.01: doors only — the box of a bridge or a building holds the character standing on it.
      if (record.passable === undefined) record.passable = insideBox(record, position);
      else if (record.passable && !insideBox(record, position)) record.passable = false;
      if (record.passable) return;
    }
    if (!withinReach(record, position.x, position.y, position.z)) return;
    this.#push(record);
  }

  /**
   * 04.11: a ship the character does not ride, at its pose this frame: Wow.exe gathers it like any game object's
   * model (0x007a55e0, the list of dynamic WMOs), and the core has it in the same dynamic tree.
   */
  #hull(object: WorldObjectState, position: WorldPosition, near: Set<bigint>): void {
    const pose = object.position!;
    if (!within(pose, position)) return;
    near.add(object.guid);
    const world = this.#models.forObject(object);
    if (!world) {
      this.#records.delete(object.guid);
      return;
    }
    const record = this.#record(object.guid, world, false);
    record.hull = true;
    record.pose.x = pose.x;
    record.pose.y = pose.y;
    record.pose.z = pose.z;
    record.pose.orientation = pose.orientation;
    if (withinReach(record, position.x, position.y, position.z)) this.#push(record);
  }

  /**
   * 11.01: a game object aboard the ship the character rides: its model at its seat in the ship's
   * frame (`positionPassengerSeat`: offset, facing relative to the ship), where the ride's step runs.
   */
  #aboard(object: WorldObjectState, seat: { x: number; y: number; z: number }, position: WorldPosition,
    near: Set<bigint>): void {
    const local = object.transport!;
    if (!within(object.position!, position)) return;
    near.add(object.guid);
    const world = this.#models.forObject(object);
    const door = gameObjectType(object) === GO_TYPE_DOOR;
    if (gameObjectSolid(object) !== true || !world) {
      this.#records.delete(object.guid);
      return;
    }
    const record = this.#record(object.guid, world, false);
    record.pose.x = local.x;
    record.pose.y = local.y;
    record.pose.z = local.z;
    record.pose.orientation = local.orientation;
    if (!withinReach(record, seat.x, seat.y, seat.z)) return;
    const probe = this.#aboardProbe;
    probe.colliders[probe.count++] = record;
  }

  #lift(object: WorldObjectState, position: WorldPosition, near: Set<bigint>, now: number): void {
    // Until the path is known the lift is nowhere in particular: no collider rather than one at the spawn.
    const path = this.#paths?.path(object.fields.get(ENTRY) ?? 0);
    if (!path) return;
    const pose = liftPoseAt(object, path, now, LIFT_POSE);
    if (!pose || !within(pose, position)) return;
    near.add(object.guid);
    const world = this.#models.forObject(object);
    if (!world) {
      this.#records.delete(object.guid);
      return;
    }
    const record = this.#record(object.guid, world, true);
    record.carrier = ((object.fields.get(FLAGS) ?? 0) & GO_FLAG_TRANSPORT) !== 0;
    record.period = path.period;
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
        guid, world, lift, carrier: false, period: 0, hull: false, pose: { x: 0, y: 0, z: 0, orientation: 0 },
        passable: undefined,
        box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }, boxSize: -1, // 11.01
      };
      this.#records.set(guid, record);
    }
    // Another world for the same guid (a new display id or scale): the old pose relation is moot.
    if (record.world !== world) {
      record.world = world;
      record.passable = undefined;
      record.boxSize = -1; // 11.01
    }
    return record;
  }

  #push(record: ColliderRecord): void {
    const probe = this.#probe;
    probe.colliders[probe.count++] = record;
    if (!record.hull) this.#noHulls.colliders[this.#noHulls.count++] = record; // 04.11
  }

  /** A passenger of a lift is where its offset on the car says, at this frame's pose, in the air too. */
  #composeSeat(self: WorldObjectState, position: WorldPosition): void {
    const seat = self.transport;
    const record = seat === undefined ? undefined : this.#records.get(seat.guid);
    if (!seat || !record?.lift) return;
    const pose = record.pose;
    const cos = Math.cos(pose.orientation);
    const sin = Math.sin(pose.orientation);
    position.x = pose.x + seat.x * cos - seat.y * sin;
    position.y = pose.y + seat.x * sin + seat.y * cos;
    position.z = pose.z + seat.z;
  }

  /**
   * Frame end, after the step: whether the character is a lift's passenger now, and its offset on the car.
   * On the ground: the floor under the feet decides, the lift's unless the world has something as high. In the air: the
   * seat stays until the character is outside the model's box (0x0077ffb0). In water: no seat.
   */
  settleSeat(self: WorldObjectState, motion: Readonly<CharacterMotion>, base: TerrainProbe): void {
    const position = self.position;
    if (!position) return;
    const seat = self.transport;
    const seated = seat === undefined ? undefined : this.#records.get(seat.guid);
    // A seat on anything else (a ship's, a vehicle's) is not this one's to touch.
    if (seat !== undefined && seated?.lift !== true) return;
    let record: ColliderRecord | undefined;
    if (motion.mode === "ground") record = this.#liftUnderFeet(position, base);
    else if (motion.mode === "air" && seated !== undefined && insideLiftBox(seated, position)) record = seated;
    if (record === undefined) {
      if (seat !== undefined) {
        self.transport = undefined;
        this.#seatChanged = true;
      }
      return;
    }
    const pose = record.pose;
    const cos = Math.cos(pose.orientation);
    const sin = Math.sin(pose.orientation);
    const dx = position.x - pose.x;
    const dy = position.y - pose.y;
    const x = dx * cos + dy * sin;
    const y = dy * cos - dx * sin;
    const z = position.z - pose.z;
    const orientation = normalizeOrientation(position.orientation - pose.orientation);
    if (seat !== undefined && seat.guid === record.guid) {
      seat.x = x;
      seat.y = y;
      seat.z = z;
      seat.orientation = orientation;
      return;
    }
    self.transport = { guid: record.guid, x, y, z, orientation, seat: SHIP_SEAT };
    this.#seatChanged = true;
  }

  /** The lift with a transport flag whose floor is under the feet now. */
  #liftUnderFeet(position: WorldPosition, base: TerrainProbe): ColliderRecord | undefined {
    const probe = this.#probe;
    let best: ColliderRecord | undefined;
    let bestZ = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < probe.count; index++) {
      const record = probe.colliders[index] as ColliderRecord;
      if (!record.carrier) continue;
      const pose = record.pose;
      const cos = Math.cos(pose.orientation);
      const sin = Math.sin(pose.orientation);
      const dx = position.x - pose.x;
      const dy = position.y - pose.y;
      FEET.x = dx * cos + dy * sin;
      FEET.y = dy * cos - dx * sin;
      FEET.z = position.z - pose.z;
      const hit = record.world.floorUnder(FEET.x, FEET.y, FEET.z + LIFT_STAND_TOLERANCE, FEET.z - LIFT_STAND_TOLERANCE);
      if (hit === undefined || hit + pose.z <= bestZ) continue;
      best = record;
      bestZ = hit + pose.z;
    }
    if (!best) return undefined;
    const worldZ = worldFloorUnder(base, position.x, position.y, position.z);
    return worldZ !== undefined && worldZ >= bestZ ? undefined : best;
  }

  #rescan(objects: ReadonlyMap<bigint, WorldObjectState>, now: number): void {
    if (objects === this.#scannedObjects && objects.size === this.#scannedSize && now - this.#scannedAt < RESCAN_MS) return;
    this.#scannedObjects = objects;
    this.#scannedSize = objects.size;
    this.#scannedAt = now;
    this.#candidates.clear();
    for (const object of objects.values()) {
      // 11.01: every game object; a type still unknown is looked at again. 04.11: ships too.
      if (gameObjectType(object) !== undefined) this.#candidates.add(object.guid);
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
 * 11.01: whether a point (the character, in the frame `record.pose` stands in) is within
 * `COLLIDER_REACH` of the model's footprint and not further than that below it — anywhere above it
 * counts, a fall can land on it. The box is the union of the meshes built so far, kept per record.
 */
function withinReach(record: ColliderRecord, x: number, y: number, z: number): boolean {
  const world = record.world;
  const box = record.box;
  if (record.boxSize !== world.size) {
    record.boxSize = world.size;
    box.minX = box.minY = box.minZ = Number.POSITIVE_INFINITY;
    box.maxX = box.maxY = box.maxZ = Number.NEGATIVE_INFINITY;
    for (const id of world.ids()) {
      const bounds = world.get(id)?.bounds;
      if (!bounds) continue;
      if (bounds.minX < box.minX) box.minX = bounds.minX;
      if (bounds.minY < box.minY) box.minY = bounds.minY;
      if (bounds.minZ < box.minZ) box.minZ = bounds.minZ;
      if (bounds.maxX > box.maxX) box.maxX = bounds.maxX;
      if (bounds.maxY > box.maxY) box.maxY = bounds.maxY;
      if (bounds.maxZ > box.maxZ) box.maxZ = bounds.maxZ;
    }
  }
  const pose = record.pose;
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const dx = x - pose.x;
  const dy = y - pose.y;
  const localX = dx * cos + dy * sin;
  const localY = dy * cos - dx * sin;
  return localX >= box.minX - COLLIDER_REACH && localX <= box.maxX + COLLIDER_REACH
    && localY >= box.minY - COLLIDER_REACH && localY <= box.maxY + COLLIDER_REACH
    && z - pose.z >= box.minZ - COLLIDER_REACH;
}

/** 0x0077ffb0's test: the feet inside the model's box, its top lifted by the character's height. */
function insideLiftBox(record: ColliderRecord, position: WorldPosition): boolean {
  withinReach(record, position.x, position.y, position.z); // Brings `box` up to date.
  const box = record.box;
  const pose = record.pose;
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const dx = position.x - pose.x;
  const dy = position.y - pose.y;
  const x = dx * cos + dy * sin;
  const y = dy * cos - dx * sin;
  const z = position.z - pose.z;
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ + LIFT_BOX_TOP_MARGIN;
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
export function startGameObjectColliders(models: CarrierModelSource | undefined, paths: LiftPaths | undefined): void {
  colliders?.clear();
  colliders = models ? new GameObjectColliders(new TransportCollision(models), paths) : undefined;
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

/** 04.11: `GameObjectColliders.withoutHulls` for the live world. */
export function gameObjectWorldWithoutHulls(base: TerrainProbe): TerrainProbe {
  return colliders ? colliders.withoutHulls(base) : base;
}

/** 04.11: `GameObjectColliders.settleSeat` for the live world; frame end, after the step. */
export function settleLiftSeat(self: WorldObjectState, motion: Readonly<CharacterMotion>, base: TerrainProbe): void {
  colliders?.settleSeat(self, motion, base);
}

/** 04.11: the character got on or off a lift this frame: one packet says so. */
export function takeLiftSeatChanged(): boolean {
  return colliders?.takeSeatChanged() === true;
}

/** 04.11: whether a packet now carries a lift's transport block. */
export function seatedOnLift(self: WorldObjectState | undefined): boolean {
  return colliders?.seatedOnLift(self) === true;
}

/** 04.11: a mouse turn on a lift (`GameObjectColliders.turnedOnLift`). */
export function liftTurned(self: WorldObjectState | undefined, radians: number): void {
  colliders?.turnedOnLift(self, radians);
}

/** 04.11: that block; `object` is the car. */
export function liftTransportBlock(self: WorldObjectState | undefined, object: WorldObjectState | undefined, now: number): MovementInfo["transport"] | undefined {
  return colliders?.liftTransportBlock(self, object, now);
}

/**
 * 11.01: the probe a step on `carrier`'s deck runs against (MovementRide): the deck with the game
 * objects aboard at their seats, or the deck alone.
 */
export function rideColliderProbe(carrier: bigint, deck: TerrainProbe): TerrainProbe {
  return colliders ? colliders.rideProbe(carrier, deck) : deck;
}
