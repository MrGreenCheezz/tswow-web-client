import { unzlibSync } from "three/examples/jsm/libs/fflate.module.js";
import { PacketReader } from "../protocol/PacketReader.js";
import { MOVEMENT_FLAGS, MOVEMENT_MASK_MOVING, readMovementInfo, type MovementInfo } from "./MovementProtocol.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
// Constants only, and `Fields.ts` takes nothing back from here but a type, so this is one edge and
// not a cycle: the compiled `Fields.js` imports `updateFields.js` and nothing else.
import { UNIT_DYNFLAG_DEAD, UNIT_DYNFLAG_LOOTABLE } from "./Fields.js";
import type { MonsterMove, SplinePoint } from "./MonsterMoveProtocol.js";
import { composePassengerPosition, type TransportSeat } from "./TransportMath.js";
import type { SplineSpeedName } from "./SplineStateProtocol.js";

const UPDATE_VALUES = 0;
const UPDATE_MOVEMENT = 1;
const UPDATE_CREATE = 2;
const UPDATE_CREATE2 = 3;
const UPDATE_OUT_OF_RANGE = 4;
const UPDATE_NEAR = 5;

const FLAG_SELF = 0x0001;
const FLAG_TRANSPORT = 0x0002;
const FLAG_HAS_TARGET = 0x0004;
const FLAG_UNKNOWN = 0x0008;
const FLAG_LOW_GUID = 0x0010;
const FLAG_LIVING = 0x0020;
const FLAG_STATIONARY = 0x0040;
const FLAG_VEHICLE = 0x0080;
const FLAG_POSITION = 0x0100;
const FLAG_ROTATION = 0x0200;

const MOVE_SPLINE_ENABLED = 0x08000000;

const TYPEID_UNIT = 3;
const NO_RETIRED_OBJECTS: readonly bigint[] = [];
/** `UNIT_FLAG_ON_TAXI`, set by FlightPathMovementGenerator while the server owns the rider. */
const UNIT_FLAG_ON_TAXI = 0x00100000;

/**
 * What the server takes off a creature when its spline ends, and never says that it has.
 *
 * `MoveSplineInit::Launch` raises `SPLINE_ENABLED|FORWARD` before every spline
 * (`MoveSplineInit.cpp:95-101`) and `Unit::UpdateSplineMovement` drops them again on arrival
 * (`Unit.cpp:564-566` calling `Unit::DisableSpline`, `:609-613`) without writing a packet.
 * `UPDATETYPE_MOVEMENT` is never sent by this core either, so the word a creature's create block
 * carries is the only one it will ever be given: measured on `dist/code`, a creature created with
 * `0x08000001` still reads `0x08000001` after its spline has finished, after `SMSG_MONSTER_MOVE`
 * stop, and after all sixteen `SMSG_SPLINE_MOVE_*` — the flags of those sixteen come to
 * `0x71200d00` between them, which meets `0xf` in nothing. Scrubbing here is that missing removal.
 *
 * The whole of `MOVEMENTFLAG_MASK_MOVING` rather than the four translation bits, because that is
 * what the core clears itself (`UnitDefines.h:303-306`): a creature whose create block caught it
 * in the air keeps `FALLING` by the same silence and plays the jump loop for ever.
 */
const SPLINE_SCRUB_MASK = MOVEMENT_MASK_MOVING | MOVE_SPLINE_ENABLED;

const SPLINE_FINAL_POINT = 0x00008000;
const SPLINE_FINAL_TARGET = 0x00010000;
const SPLINE_FINAL_ANGLE = 0x00020000;
const MAX_UPDATE_PAYLOAD = 16 * 1024 * 1024;
const MAX_SPLINE_NODES = 4096;

/**
 * Movement packets for other units arrive a few times a second. Assigning the new position
 * outright makes them jump; each update is instead played out over this long. Anything further
 * than the snap distance is a teleport or a correction and is applied at once.
 */
const GLIDE_DURATION = 180;
const GLIDE_SNAP_DISTANCE = 25;

export interface WorldPosition {
  x: number;
  y: number;
  z: number;
  orientation: number;
}

export interface WorldObjectState {
  guid: bigint;
  typeId: number | undefined;
  position: WorldPosition | undefined;
  movementFlags: number;
  updateFlags: number;
  targetGuid: bigint | undefined;
  runSpeed: number | undefined;
  turnRate: number | undefined;
  motion: SplineMotion | undefined;
  glide: Glide | undefined;
  /**
   * The transport this object is riding, and where on it.
   *
   * Kept because nothing else will say: a boat carries its passengers with no network output at
   * all, so an object placed only where its last packet put it is left standing over the water.
   */
  transport: TransportSeat | undefined;
  /**
   * Rates the server has set on this unit, from the `SMSG_SPLINE_SET_*` family, in yards or
   * radians a second. Absent until one arrives, which is the common case.
   */
  speeds: Map<SplineSpeedName, number> | undefined;
  /**
   * The transport clock out of the create block's `UPDATEFLAG_TRANSPORT`, in milliseconds.
   *
   * For a ship this is how far along its path the server has taken it. For a lift — which the
   * server never moves at all — it is `GameTime::GetGameTimeMS()`, the worldserver's own uptime,
   * because `ToTransport()` returns null for that type and the core writes the clock instead. Both
   * readings are the same thing to a renderer: a moment to start counting from, shared by every
   * client in range, which is what makes two players see the same lift in the same place.
   */
  transportTime: number | undefined;
  fields: Map<number, number>;
}

/** Local input must not replace a server spline or move the rider before taxi control returns. */
export function serverControlsMovement(object: WorldObjectState | undefined): boolean {
  return object !== undefined && (object.motion !== undefined
    || ((object.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset) ?? 0) & UNIT_FLAG_ON_TAXI) !== 0);
}

interface Glide {
  fromX: number;
  fromY: number;
  fromZ: number;
  fromOrientation: number;
  toX: number;
  toY: number;
  toZ: number;
  toOrientation: number;
  startedAt: number;
  duration: number;
}

interface SplineMotion {
  splineId: number;
  points: SplinePoint[];
  lengths: number[];
  totalLength: number;
  startedAt: number;
  duration: number;
  cyclic: boolean;
  /** `MonsterMove` carries this in spline flags, not in the unit movement word. */
  flying: boolean;
  finalOrientation: number | undefined;
}

interface MovementUpdate {
  position: WorldPosition | undefined;
  transport: TransportSeat | undefined;
  movementFlags: number;
  updateFlags: number;
  targetGuid: bigint | undefined;
  runSpeed: number | undefined;
  turnRate: number | undefined;
  transportTime: number | undefined;
}

/**
 * How the store hears about a change without the state having to know what a store is. Everything
 * here reports what changed rather than what it became: the object is already in `objects`, and
 * handing out a snapshot would let a listener read a value the next block has since moved on from.
 */
export interface StateObserver {
  fieldsChanged(guid: bigint, indices: readonly number[]): void;
  objectCreated(guid: bigint, typeId: number | undefined): void;
  objectDestroyed(guid: bigint): void;
  /** A movement packet or a spline, not the per-frame interpolation between them. */
  objectMoved(guid: bigint): void;
  selfChanged(guid: bigint | undefined): void;
}

export class WorldState {
  readonly objects = new Map<bigint, WorldObjectState>();
  revision = 0;

  /** Fires only for natural completion of a noncyclic spline, not for a stop or teleport. */
  onSplineFinished: ((guid: bigint, splineId: number) => void) | undefined;

  /** Set by `WorldStore`. Unset by default, so nothing is recorded for a state nobody watches. */
  observer: StateObserver | undefined;

  #selfGuid: bigint | undefined;

  /** The controlled character. It arrives with the first update that carries the self flag. */
  get selfGuid(): bigint | undefined {
    return this.#selfGuid;
  }

  set selfGuid(guid: bigint | undefined) {
    if (this.#selfGuid === guid) return;
    this.#selfGuid = guid;
    this.observer?.selfChanged(guid);
  }

  /**
   * Applies an update packet and returns GUIDs whose previous incarnation was retired.
   *
   * `UPDATE_OUT_OF_RANGE` is the core's ordinary visibility-destruction path.  The
   * state observer reports actual object changes to field consumers, while the packet owner
   * needs this list to retire packet-owned data such as auras and casts. A later create block
   * preserves the new object, but initial auras arrive in a separate packet after object updates
   * (TrinityCore VisibleNotifier::SendToSelf), so the previous aura/cast state still expires.
   */
  applyUpdate(payload: Uint8Array): readonly bigint[] {
    const reader = new PacketReader(payload);
    const blockCount = reader.u32();
    if (blockCount > payload.byteLength) throw new RangeError(`Invalid object update block count ${blockCount}`);
    let retired: bigint[] | undefined;

    for (let block = 0; block < blockCount; block++) {
      const updateType = reader.u8();
      if (updateType === UPDATE_VALUES) {
        const guid = reader.packedGuid();
        const changed = readValues(reader, this.#get(guid).fields);
        this.observer?.fieldsChanged(guid, changed);
      } else if (updateType === UPDATE_MOVEMENT) {
        const guid = reader.packedGuid();
        this.#applyMovement(this.#get(guid), readMovement(reader));
        this.observer?.objectMoved(guid);
      } else if (updateType === UPDATE_CREATE || updateType === UPDATE_CREATE2) {
        const guid = reader.packedGuid();
        const object: WorldObjectState = {
          guid,
          typeId: reader.u8(),
          position: undefined,
          movementFlags: 0,
          updateFlags: 0,
          targetGuid: undefined,
          runSpeed: undefined,
          turnRate: undefined,
          transport: undefined,
          speeds: undefined,
          motion: undefined,
          glide: undefined,
          transportTime: undefined,
          fields: new Map(),
        };
        this.objects.set(guid, object);
        // Announced before its fields, so a listener that asks for the object finds it there.
        this.observer?.objectCreated(guid, object.typeId);
        this.#applyMovement(object, readMovement(reader));
        this.observer?.objectMoved(guid);
        // Read first, tell second: `observer?.fieldsChanged(guid, readValues(…))` would skip the
        // read itself whenever nothing is watching, because an optional call evaluates no
        // arguments. That leaves the packet half-consumed and every field unset.
        const created = readValues(reader, object.fields);
        this.observer?.fieldsChanged(guid, created);
      } else if (updateType === UPDATE_OUT_OF_RANGE) {
        const count = reader.u32();
        if (count > reader.remaining) throw new RangeError(`Invalid out-of-range object count ${count}`);
        for (let index = 0; index < count; index++) {
          const guid = reader.packedGuid();
          this.#remove(guid);
          (retired ??= []).push(guid);
        }
      } else if (updateType === UPDATE_NEAR) {
        const count = reader.u32();
        if (count > reader.remaining) throw new RangeError(`Invalid near-object count ${count}`);
        for (let index = 0; index < count; index++) reader.packedGuid();
      } else {
        throw new RangeError(`Unknown object update type ${updateType}`);
      }
    }

    reader.assertFinished();
    this.revision++;
    return retired ?? NO_RETIRED_OBJECTS;
  }

  destroy(guid: bigint): void {
    this.#remove(guid);
    this.revision++;
  }

  /**
   * Retires map-scoped objects while retaining the controlled player through a far transfer.
   * TrinityCore recreates the player, transport and visible neighbours after WORLDPORT_ACK, but
   * retaining the player here keeps the mover identity and its live aura snapshot valid until
   * those packets arrive.
   */
  clearExcept(guid: bigint | undefined): readonly bigint[] {
    let retired: bigint[] | undefined;
    for (const objectGuid of this.objects.keys()) {
      if (objectGuid !== guid && this.#remove(objectGuid)) (retired ??= []).push(objectGuid);
    }
    if (!retired) return NO_RETIRED_OBJECTS;
    this.revision++;
    return retired;
  }

  /** A transport worldport has no absolute position until the destination self CREATE arrives. */
  invalidatePosition(guid: bigint): void {
    const object = this.objects.get(guid);
    if (!object) return;
    object.position = undefined;
    object.motion = undefined;
    object.glide = undefined;
    object.transport = undefined;
    object.movementFlags = 0;
    this.revision++;
    this.observer?.objectMoved(guid);
  }

  move(guid: bigint, movement: Pick<MovementInfo, "flags" | "position" | "transport">, now = performance.now()): void {
    const object = this.#get(guid);
    const previous = object.position;
    object.movementFlags = movement.flags;
    object.motion = undefined;
    // Where it is riding, if it is. The position in the same packet is already composed, so this
    // is only for the frames afterwards, when the transport has moved and nothing was sent.
    object.transport = movement.transport && movement.transport.guid !== 0n
      ? {
        guid: movement.transport.guid,
        x: movement.transport.x,
        y: movement.transport.y,
        z: movement.transport.z,
        orientation: movement.transport.orientation,
        seat: movement.transport.seat,
      }
      : undefined;
    const target = movement.position;
    // The controlled character is predicted locally and must not lag behind its own input.
    const jump = previous === undefined || guid === this.selfGuid
      ? Number.POSITIVE_INFINITY
      : Math.hypot(target.x - previous.x, target.y - previous.y, target.z - previous.z);
    if (jump > GLIDE_SNAP_DISTANCE) {
      object.glide = undefined;
      object.position = { ...target };
    } else {
      object.glide = {
        fromX: previous!.x, fromY: previous!.y, fromZ: previous!.z, fromOrientation: previous!.orientation,
        toX: target.x, toY: target.y, toZ: target.z, toOrientation: target.orientation,
        startedAt: now, duration: GLIDE_DURATION,
      };
    }
    this.revision++;
    this.observer?.objectMoved(guid);
  }

  /**
   * The same as `move`, but never smoothed.
   *
   * `move` glides a unit to its new position whenever the step is under `GLIDE_SNAP_DISTANCE`, so
   * that a neighbour's travel looks continuous between packets. A teleport is exactly the case
   * where that is wrong: a blink is about twenty yards, comfortably under the threshold, and
   * gliding it would slide the mage across the ground instead of moving them in one frame.
   * `MSG_MOVE_TELEPORT` is the only packet that means "this was not travel".
   */
  teleport(guid: bigint, movement: Pick<MovementInfo, "flags" | "position" | "transport">): void {
    const object = this.#get(guid);
    object.movementFlags = movement.flags;
    object.motion = undefined;
    object.glide = undefined;
    // The core recomputes the transport offset for a teleport that lands on one, so the offset in
    // this packet is the new one and not the one the unit had before it moved.
    object.transport = movement.transport && movement.transport.guid !== 0n
      ? {
        guid: movement.transport.guid,
        x: movement.transport.x,
        y: movement.transport.y,
        z: movement.transport.z,
        orientation: movement.transport.orientation,
        seat: movement.transport.seat,
      }
      : undefined;
    object.position = { ...movement.position };
    this.revision++;
    this.observer?.objectMoved(guid);
  }

  setField(guid: bigint, index: number, value: number): void {
    this.#get(guid).fields.set(index, value);
    this.revision++;
    this.observer?.fieldsChanged(guid, [index]);
  }

  startSpline(move: MonsterMove, now: number): void {
    const object = this.#get(move.guid);
    const finalPoint = move.points.at(-1);
    if (!finalPoint) return;
    // VehicleJoinEvent does not send a fresh create block for a passenger already in view. Its
    // MONSTER_MOVE_TRANSPORT packet is the update that gives bystanders the new transport and seat.
    // Conversely Vehicle::_ExitVehicle launches a plain MONSTER_MOVE after clearing ONTRANSPORT.
    const previousSeat = object.transport;
    object.transport = move.transportGuid === undefined ? undefined : {
      guid: move.transportGuid,
      x: finalPoint.x, y: finalPoint.y, z: finalPoint.z,
      orientation: move.finalOrientation ?? (previousSeat?.guid === move.transportGuid ? previousSeat.orientation : 0),
      seat: move.transportSeat ?? 0,
    };
    const transport = move.transportGuid === undefined ? undefined : this.objects.get(move.transportGuid)?.position;
    if (move.transportGuid !== undefined && !transport) {
      // It has boarded something not in view, so whatever path it was on is over whether or not
      // this one can be plotted. Dropping it matters most for a cyclic spline, which nothing else
      // ever ends: the unit would otherwise pace its old route until it left sight.
      if (object.motion) {
        object.motion = undefined;
        this.#scrubSplineFlags(object);
      }
      this.revision++;
      this.observer?.objectMoved(move.guid);
      return;
    }
    // A spline launched on a transport is in the transport's own frame, and the packet says so
    // only by its opcode. Adding the transport's position without turning it is right exactly
    // while the ship faces zero: the error grows with every degree it turns, which is why it
    // reads as a pathfinding problem rather than a coordinate one.
    const points: SplinePoint[] = transport
      ? move.points.map((point) => {
        const world = composePassengerPosition(transport, { guid: 0n, ...point, orientation: 0, seat: 0 });
        return { x: world.x, y: world.y, z: world.z };
      })
      : move.points.map((point) => ({ ...point }));
    if (points.length === 0) return;
    object.glide = undefined;
    object.position = { ...points[0]!, orientation: object.position?.orientation ?? 0 };
    if (move.duration === 0 || points.length === 1) {
      if (move.finalOrientation !== undefined) object.position.orientation = move.finalOrientation;
      object.motion = undefined;
      // This is `MoveSplineInit::Stop`, and there the removal and the packet are one act:
      // `MoveSplineInit.cpp:178` takes `FORWARD|SPLINE_ENABLED` off and `:192` broadcasts the
      // stop the line after. Everything that halts a creature mid-path — combat, a root, a
      // charm — comes through `Unit::StopMoving` and arrives here.
      this.#scrubSplineFlags(object);
      this.revision++;
      this.observer?.objectMoved(move.guid);
      return;
    }
    if (move.cyclic) points.push({ ...points[0]! });
    const lengths: number[] = [];
    let totalLength = 0;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]!;
      const next = points[index]!;
      totalLength += Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z);
      lengths.push(totalLength);
    }
    object.motion = {
      splineId: move.splineId, points, lengths, totalLength, startedAt: now, duration: move.duration, cyclic: move.cyclic,
      flying: move.flying === true, finalOrientation: move.finalOrientation,
    };
    this.revision++;
    this.observer?.objectMoved(move.guid);
  }

  updateMotions(now: number): void {
    for (const object of this.objects.values()) {
      // A passenger first: whatever its own motion does next is relative to a deck that may have
      // moved since the last packet, and no packet will ever say so.
      this.#carryPassenger(object);
      this.#advanceGlide(object, now);
      const motion = object.motion;
      if (!motion || !object.position) continue;
      const rawProgress = (now - motion.startedAt) / motion.duration;
      const progress = motion.cyclic ? ((rawProgress % 1) + 1) % 1 : Math.min(Math.max(rawProgress, 0), 1);
      const distance = progress * motion.totalLength;
      let segment = motion.lengths.findIndex((length) => distance <= length);
      if (segment < 0) segment = motion.lengths.length - 1;
      const startDistance = segment === 0 ? 0 : motion.lengths[segment - 1]!;
      const segmentLength = (motion.lengths[segment] ?? startDistance) - startDistance;
      const ratio = segmentLength === 0 ? 0 : (distance - startDistance) / segmentLength;
      const start = motion.points[segment]!;
      const end = motion.points[segment + 1]!;
      object.position.x = start.x + (end.x - start.x) * ratio;
      object.position.y = start.y + (end.y - start.y) * ratio;
      object.position.z = start.z + (end.z - start.z) * ratio;
      object.position.orientation = Math.atan2(end.y - start.y, end.x - start.x);
      if (!motion.cyclic && rawProgress >= 1) {
        if (motion.finalOrientation !== undefined) object.position.orientation = motion.finalOrientation;
        object.motion = undefined;
        // Arrival is the one the server keeps to itself: `Unit::UpdateSplineMovement` calls
        // `DisableSpline` and writes nothing. Without this the creature stops in place and its
        // flags go on saying FORWARD, so the pose jumps from Walk to Run at the moment it halts.
        this.#scrubSplineFlags(object);
        this.onSplineFinished?.(object.guid, motion.splineId);
      }
    }
  }

  /**
   * The removal `Unit::DisableSpline` performs and never announces.
   *
   * Creatures only, and that limit is the point. A player's own word is authoritative — the client
   * writes it as it sends it, and `WorldClient.#currentMovement()` and `faceTarget()` send it
   * straight back to the server — so scrubbing it would lie to the core about what the character
   * is doing. And a player is not exempt from splines: a taxi flight builds a `MoveSplineInit` on
   * the player themselves (`FlightPathMovementGenerator.cpp:86-97`) and `Launch` broadcasts
   * `SMSG_MONSTER_MOVE` with `SendMessageToSet(&data, true)`, which includes them.
   */
  #scrubSplineFlags(object: WorldObjectState): void {
    if (object.typeId !== TYPEID_UNIT) return;
    object.movementFlags &= ~SPLINE_SCRUB_MASK;
  }

  /**
   * Puts a passenger back where its transport has carried it.
   *
   * The offset is the only durable fact: the world position in the packet was composed when the
   * packet was written and is stale the moment the ship moves on. Nothing is done for an object
   * whose transport is not in view — its own last position is the best answer there is — and
   * nothing is done for an elevator, because the server keeps no offset for one: it says so twice
   * in `MoveSplineInit.cpp:63` and `:198`, and a rider on a lift reports plain world positions.
   */
  #carryPassenger(object: WorldObjectState): void {
    const seat = object.transport;
    if (!seat || !object.position) return;
    const transport = this.objects.get(seat.guid)?.position;
    if (!transport) return;
    const world = composePassengerPosition(transport, seat);
    object.position.x = world.x;
    object.position.y = world.y;
    object.position.z = world.z;
    object.position.orientation = world.orientation;
  }

  /**
   * One of the sixteen `SMSG_SPLINE_MOVE_*` state changes, which are about somebody else.
   *
   * The packet carries no flags word — the opcode is the change — so this is where the bit is
   * raised. It matters more than it sounds: the renderer picks a unit's pose from these flags, so
   * a murloc told to swim swims rather than running along the lake bed.
   */
  applyMovementFlag(guid: bigint, flag: number, set: boolean): void {
    const object = this.objects.get(guid);
    if (!object) return;
    const before = object.movementFlags;
    object.movementFlags = set ? before | flag : before & ~flag;
    // Root is three changes in the core and one bit on the wire. `Unit::SetRooted(true)` clears
    // `MOVEMENTFLAG_MASK_MOVING`, raises ROOT and calls `StopMoving()` in that order and only then
    // writes this packet (`Unit.cpp:12294-12318`); the comment at `:12299` says the two must never
    // be set together, because a 3.3.5a client freezes on it. Or-ing the one bit and keeping the
    // rest asserts exactly the state the core refuses to hold: alone among the sixteen state
    // opcodes, this one carries a removal as well as an addition.
    if (set && flag === MOVEMENT_FLAGS.root) object.movementFlags &= ~MOVEMENT_MASK_MOVING;
    if (object.movementFlags === before) return;
    this.revision++;
    this.observer?.objectMoved(guid);
  }

  /**
   * `SMSG_FLIGHT_SPLINE_SYNC`: how far through its looping path a unit really is.
   *
   * Sent at most once every five seconds and only for a cyclic spline, so it is a correction for
   * drift on a long flight rather than a position. Re-anchoring the clock is the whole of it: the
   * path is unchanged, only the client's idea of where along it the unit has got to.
   */
  resyncSpline(guid: bigint, progress: number, now: number): void {
    const motion = this.objects.get(guid)?.motion;
    if (!motion || motion.duration <= 0) return;
    motion.startedAt = now - progress * motion.duration;
    this.revision++;
  }

  /** One of the nine `SMSG_SPLINE_SET_*` rates, in yards or radians a second. */
  setSpeed(guid: bigint, name: SplineSpeedName, value: number): void {
    const object = this.objects.get(guid);
    if (!object || !Number.isFinite(value) || value < 0) return;
    object.speeds ??= new Map();
    object.speeds.set(name, value);
    // The two the rest of the client already reads by name keep their own fields in step.
    if (name === "run") object.runSpeed = value;
    else if (name === "turnRate") object.turnRate = value;
    this.revision++;
  }

  #advanceGlide(object: WorldObjectState, now: number): void {
    const glide = object.glide;
    if (!glide) return;
    const position = object.position;
    if (!position) {
      object.glide = undefined;
      return;
    }
    const progress = Math.min(1, Math.max(0, (now - glide.startedAt) / glide.duration));
    position.x = glide.fromX + (glide.toX - glide.fromX) * progress;
    position.y = glide.fromY + (glide.toY - glide.fromY) * progress;
    position.z = glide.fromZ + (glide.toZ - glide.fromZ) * progress;
    position.orientation = glide.fromOrientation + shortestTurn(glide.fromOrientation, glide.toOrientation) * progress;
    if (progress >= 1) object.glide = undefined;
  }

  #get(guid: bigint): WorldObjectState {
    let object = this.objects.get(guid);
    if (!object) {
      object = {
        guid,
        typeId: undefined,
        position: undefined,
        movementFlags: 0,
        updateFlags: 0,
        targetGuid: undefined,
        runSpeed: undefined,
        turnRate: undefined,
        transport: undefined,
        speeds: undefined,
        motion: undefined,
        glide: undefined,
        transportTime: undefined,
        fields: new Map(),
      };
      this.objects.set(guid, object);
      // Values or movement can arrive for a guid no create block introduced; that is still the
      // moment the object starts existing as far as anything watching is concerned.
      this.observer?.objectCreated(guid, undefined);
    }
    return object;
  }

  #applyMovement(object: WorldObjectState, movement: MovementUpdate): void {
    if (movement.position) object.glide = undefined;
    object.position = movement.position ?? object.position;
    object.transport = movement.transport;
    object.movementFlags = movement.movementFlags;
    // The spline a create block carries is read past unused (`skipSpline`), so a creature caught
    // walking is drawn standing where the block put it — and its flags have to agree, or it runs
    // on the spot from the first frame it is ever seen. A path it is really on arrives as
    // `SMSG_MONSTER_MOVE` and moves it through `motion`, which the pose reads on its own.
    if (object.motion === undefined) this.#scrubSplineFlags(object);
    object.updateFlags = movement.updateFlags;
    object.targetGuid = movement.targetGuid;
    object.runSpeed = movement.runSpeed ?? object.runSpeed;
    object.turnRate = movement.turnRate ?? object.turnRate;
    object.transportTime = movement.transportTime ?? object.transportTime;
    if (movement.updateFlags & FLAG_SELF) this.selfGuid = object.guid;
  }

  #remove(guid: bigint): boolean {
    if (!this.objects.delete(guid)) return false;
    if (this.selfGuid === guid) this.selfGuid = undefined;
    this.observer?.objectDestroyed(guid);
    return true;
  }
}

/** Signed angle from one facing to another, always through the shorter side of the circle. */
export function shortestTurn(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

const FLOAT_FIELD_SCRATCH = new DataView(new ArrayBuffer(4));

/** Update fields arrive as raw uint32 words; the unit sizes among them are really floats. */
export function fieldFloat(object: WorldObjectState, offset: number): number | undefined {
  const raw = object.fields.get(offset);
  if (raw === undefined) return undefined;
  FLOAT_FIELD_SCRATCH.setUint32(0, raw >>> 0, true);
  const value = FLOAT_FIELD_SCRATCH.getFloat32(0, true);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Whether this unit is a body.
 *
 * Health when there is health, and the dynamic flags when there is not — and the second half is
 * not a nicety. `Object::BuildValuesUpdate` sets a mask bit in a CREATE block only where
 * `m_uint32Values[index]` is non-zero (`Object.cpp:490`; a VALUES block goes by the change mask
 * instead), so a creature that comes into view already dead arrives with **no**
 * `UNIT_FIELD_HEALTH` slot at all — and `readValues` writes only the slots the mask named, so the
 * map has no entry to compare against zero. Everything downstream then read that body as alive:
 * no bag on the cursor, no dot on the minimap, no «Обыскать» on the target frame, a full-height
 * plate, and Tab offering it ahead of the real corpses. It is the state after login, after a
 * teleport, and on walking up to somebody else's camp.
 *
 * The reference client keeps the same pair for the same reason and wrote the symptom down beside
 * it — «leaves pre-existing corpses standing after login», `wowee/include/game/entity.hpp:52-53`,
 * `isUnitCorpseState` at `:59-64`. The fallback is narrower here than there: the flags answer only
 * when the health slot is missing, so a live unit can never be talked into being a corpse by a bit.
 */
export function isWorldObjectDead(object: WorldObjectState): boolean {
  if (object.typeId !== 3 && object.typeId !== 4) return false;
  const health = object.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset);
  if (health !== undefined) return health === 0;
  const dynamicFlags = object.fields.get(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset) ?? 0;
  return (dynamicFlags & (UNIT_DYNFLAG_DEAD | UNIT_DYNFLAG_LOOTABLE)) !== 0;
}

/**
 * Whether a unit should be drawn lying dead — for poses only.
 *
 * A feigned death is alive: TrinityCore's `HandleFeignDeath` keeps the health and raises
 * `UNIT_DYNFLAG_DEAD` (with `UNIT_FLAG2_FEIGN_DEATH`), so {@link isWorldObjectDead}, which trusts a
 * present health slot over the flags, rightly keeps targeting, loot and the frames treating it as
 * alive — and the body stood upright: a hunter's Feign Death, and every quest corpse wearing a
 * Permanent Feign Death aura (29266/31261/58806 on 141 creature templates and 267 spawns here).
 */
export function appearsDead(object: WorldObjectState): boolean {
  if (isWorldObjectDead(object)) return true;
  if (object.typeId !== 3 && object.typeId !== 4) return false;
  return ((object.fields.get(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset) ?? 0) & UNIT_DYNFLAG_DEAD) !== 0;
}

/**
 * The zlib body of `SMSG_COMPRESSED_UPDATE_OBJECT`, inflated in place.
 *
 * Synchronous on purpose. `DecompressionStream` settles only after several task turns, and the
 * world read loop takes packets strictly in order: behind 30–40 ms crowd frames one compressed
 * update held every later packet (movement, spawns, auras) for 100–560 ms. The live recording of
 * 27.09 had 69 of them waiting 5.3 s in one minute for 99 ms of actual main-thread work. Inflating
 * a few kilobytes here takes microseconds. The compressed bytes are read through a view, not copied.
 */
export function decompressObjectUpdate(payload: Uint8Array): Uint8Array {
  if (payload.byteLength < 4) throw new RangeError("Compressed object update has no size");
  const expectedSize = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
  if (expectedSize > MAX_UPDATE_PAYLOAD) throw new RangeError(`Compressed object update is too large: ${expectedSize}`);
  let result: Uint8Array;
  try {
    result = unzlibSync(payload.subarray(4));
  } catch (error) {
    throw new RangeError(`Compressed object update does not inflate: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.byteLength !== expectedSize) {
    throw new RangeError(`Object update expanded to ${result.byteLength} bytes, expected ${expectedSize}`);
  }
  return result;
}

/** Returns the slots the block wrote, which is what a subscriber needs in order to care. */
function readValues(reader: PacketReader, fields: Map<number, number>): number[] {
  const blockCount = reader.u8();
  const masks = Array.from({ length: blockCount }, () => reader.u32());
  const changed: number[] = [];
  for (let block = 0; block < masks.length; block++) {
    const mask = masks[block] ?? 0;
    for (let bit = 0; bit < 32; bit++) {
      if ((mask & (1 << bit)) === 0) continue;
      const index = block * 32 + bit;
      fields.set(index, reader.u32());
      changed.push(index);
    }
  }
  return changed;
}

function readMovement(reader: PacketReader): MovementUpdate {
  const updateFlags = reader.u16();
  let movementFlags = 0;
  let position: WorldPosition | undefined;
  let transport: TransportSeat | undefined;
  let runSpeed: number | undefined;
  let turnRate: number | undefined;

  if (updateFlags & FLAG_LIVING) {
    const movement = readMovementInfo(reader);
    movementFlags = movement.flags;
    position = movement.position;
    if (movement.transport && movement.transport.guid !== 0n) {
      transport = {
        guid: movement.transport.guid,
        x: movement.transport.x, y: movement.transport.y, z: movement.transport.z,
        orientation: movement.transport.orientation, seat: movement.transport.seat,
      };
    }
    reader.f32();
    runSpeed = reader.f32();
    skipFloats(reader, 5);
    turnRate = reader.f32();
    reader.f32();
    if (movementFlags & MOVE_SPLINE_ENABLED) skipSpline(reader);
  } else if (updateFlags & FLAG_POSITION) {
    reader.packedGuid();
    position = { x: reader.f32(), y: reader.f32(), z: reader.f32(), orientation: 0 };
    skipFloats(reader, 3);
    position.orientation = reader.f32();
    reader.f32();
  } else if (updateFlags & FLAG_STATIONARY) {
    position = readPosition(reader);
  }

  if (updateFlags & FLAG_UNKNOWN) reader.u32();
  if (updateFlags & FLAG_LOW_GUID) reader.u32();
  const targetGuid = updateFlags & FLAG_HAS_TARGET ? reader.packedGuid() : undefined;
  // Read past until now. It is the only clock a lift ever gets: the server sends this once, in
  // the create block, and never mentions the object again.
  const transportTime = updateFlags & FLAG_TRANSPORT ? reader.u32() : undefined;
  if (updateFlags & FLAG_VEHICLE) {
    reader.u32();
    reader.f32();
  }
  if (updateFlags & FLAG_ROTATION) reader.u64();

  return { position, transport, movementFlags, updateFlags, targetGuid, runSpeed, turnRate, transportTime };
}

function readPosition(reader: PacketReader): WorldPosition {
  return { x: reader.f32(), y: reader.f32(), z: reader.f32(), orientation: reader.f32() };
}

function skipFloats(reader: PacketReader, count: number): void {
  for (let index = 0; index < count; index++) reader.f32();
}

function skipSpline(reader: PacketReader): void {
  const flags = reader.u32();
  if (flags & SPLINE_FINAL_ANGLE) reader.f32();
  else if (flags & SPLINE_FINAL_TARGET) reader.u64();
  else if (flags & SPLINE_FINAL_POINT) skipFloats(reader, 3);

  reader.u32();
  reader.u32();
  reader.u32();
  reader.f32();
  reader.f32();
  reader.f32();
  reader.u32();
  const nodes = reader.u32();
  if (nodes > MAX_SPLINE_NODES) throw new RangeError(`Invalid spline node count ${nodes}`);
  reader.bytes(nodes * 12);
  reader.u8();
  skipFloats(reader, 3);
}
