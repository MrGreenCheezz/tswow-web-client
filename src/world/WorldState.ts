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
import {
  buildTrack, describeMonsterMove, isRunnableSpline, readCreateSpline, resyncTrack, sampleSpline, trackAnimationTier,
  type SplineDescription, type SplineFacing, type SplineSample, type SplineTrack,
} from "./SplineModel.js";
import {
  CORRECTION_SNAP_DISTANCE, EXTRAPOLATION_HORIZON_MS, advanceDrift, anchorDrift, emptyDrift, kinematicsFor,
  type Drift, type DriftSample, type GroundProbe,
} from "./MovementExtrapolation.js";
import { realignDrift } from "./MovementExtrapolation.js"; // L8 5.04
import { driftPitch } from "./MovementExtrapolation.js"; // L8-review 5.04
import { unpackRotation, type Quat } from "./GameObjectRotation.js";
import { isShipCarrier, positionPassengerSeat, sampleCarrierGlide, startCarrierGlide, type CarrierGlide } from "./TransportPassengers.js";

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
const TYPEID_PLAYER = 4;
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

const MAX_UPDATE_PAYLOAD = 16 * 1024 * 1024;
/** One sample buffer for every unit's frame, so evaluating a spline allocates nothing. */
const SPLINE_SAMPLE: SplineSample = { x: 0, y: 0, z: 0, orientation: 0 };
/** The same for a remote player's extrapolation (5.04). */
const DRIFT_SAMPLE: DriftSample = { x: 0, y: 0, z: 0, orientation: 0 };

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
   * The tier a spline's Animation effect gave the unit. Wow.exe sets its own tier once the effect
   * starts (0x0098CA00 → 0x0073AF00) and leaves it there after arrival, until a BYTES_1 update with
   * a different tier byte overwrites it (0x007167C0). Absent on most objects; see `splineAnimationTier`.
   */
  splineTier?: SplineTierLatch | undefined;
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
  /**
   * When `transportTime` was read (`applyUpdate`'s clock). 11.01-A1: a ship's clock counts from
   * here, not from the first frame after the packet, which a hidden page may not draw for minutes.
   */
  transportTimeAt?: number | undefined;
  fields: Map<number, number>;
  /**
   * A remote player's last movement packet and the motion it declared, while that motion is being
   * extrapolated (5.04, `MovementExtrapolation.ts`). Never set for the controlled character, a
   * passenger, or a unit on a server spline.
   */
  drift?: Drift | undefined;
  /** The pitch of the last movement packet: swimming, flying, or explicitly allowed to pitch. */
  pitch?: number | undefined;
  /**
   * A game object's local rotation from the create block's `UPDATEFLAG_ROTATION` (5.27), unpacked
   * from `GameObject::UpdatePackedRotation`'s 64 bits. Its yaw normally agrees with
   * `position.orientation`; anything beyond that is what `GameObjectRotation.gameObjectTilt` returns.
   */
  rotation?: Quat | undefined;
  /**
   * `UPDATEFLAG_POSITION`'s transport: the guid and the offset on it, for a non-living object
   * spawned aboard. Data only until the transport line consumes it.
   */
  positionTransport?: { guid: bigint; x: number; y: number; z: number } | undefined;
  /** `UPDATEFLAG_VEHICLE`: the `Vehicle.dbc` id of a unit that is a vehicle. */
  vehicleId?: number | undefined;
  /**
   * 11.02-F1: the float `UPDATEFLAG_VEHICLE` writes after the id — the transport offset's orientation
   * when the vehicle rides a transport, its own otherwise (Object.cpp:463-466). Data only.
   */
  vehicleOrientation?: number | undefined;
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

interface SplineTierLatch {
  /** The effect's tier, or undefined once a later BYTES_1 change has overruled it. */
  tier: number | undefined;
  /** The BYTES_1 tier byte when the effect took over: a change from it overrules the effect. */
  fieldTier: number | undefined;
  /** The path whose effect this is, so the same effect is never applied twice. */
  track: SplineTrack;
}

interface SplineMotion {
  splineId: number;
  /** The first lap's path in world coordinates, closed for a cycle. */
  points: SplinePoint[];
  /** Distance from `points[0]` to `points[i + 1]`. */
  lengths: number[];
  totalLength: number;
  startedAt: number;
  duration: number;
  cyclic: boolean;
  /** `MonsterMove` carries this in spline flags, not in the unit movement word. */
  flying: boolean;
  finalOrientation: number | undefined;
  /**
   * The full description the frame is evaluated from (`SplineModel.ts`): parabola, fall, facing,
   * tier. Absent only on a copy made by something that knows the fields above and nothing more;
   * `updateMotions` then rebuilds an equivalent polyline from them.
   */
  track?: SplineTrack;
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
  /** The create block's spline (`WriteCreate`), present exactly when SPLINE_ENABLED was set. */
  spline: SplineDescription | undefined;
  /** A living object's whole MovementInfo (pitch, fall clock, jump), for extrapolation. */
  info: MovementInfo | undefined;
  /** The nine speeds a living object's block carries, in `CREATE_SPEED_ORDER`. */
  speeds: readonly number[] | undefined;
  rotation: Quat | undefined;
  positionTransport: { guid: bigint; x: number; y: number; z: number } | undefined;
  vehicleId: number | undefined;
  vehicleOrientation: number | undefined; // 11.02-F1
}

/** `Object::BuildMovementUpdate` (Object.cpp:331-339) writes the nine speeds in this order. */
const CREATE_SPEED_ORDER = [
  "walk", "run", "runBack", "swim", "swimBack", "flight", "flightBack", "turnRate", "pitchRate",
] as const satisfies readonly SplineSpeedName[];

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

  /**
   * GUIDs whose CREATE block failed to parse. Update blocks for them are read past and dropped, so
   * a later VALUES block cannot make a typeless, positionless stub of them; a new CREATE, an
   * OUT_OF_RANGE entry or a destroy lifts the quarantine.
   */
  readonly failedCreates = new Set<bigint>();
  /** Update packets that failed part-way, and the blocks after the failure that were never read. */
  updateBlockFailures = 0;
  updateBlocksLost = 0;
  /** `SMSG_FLIGHT_SPLINE_SYNC` for a unit with no path to correct (5.02 diagnostics). */
  splineSyncDropped = 0;

  /**
   * Height of the terrain at a point, set by the browser. Lets an extrapolated walker follow a
   * slope and keeps a falling one from being drawn under the ground before its landing packet.
   */
  groundProbe: GroundProbe | undefined;

  /**
   * M7-3 (11.01-A1): moves the ships and zeppelins to where they are this frame, set by the browser
   * (`browser/TransportMotion.ts`). The server never sends a transport's position after its create
   * block, so without it every passenger rides a ship frozen where it was first seen.
   */
  poseProvider: ((state: WorldState, now: number) => void) | undefined;

  /**
   * 11.02-A: a unit other than the character that this client moves (a vehicle it drives, a creature
   * it possesses), set by `WorldClient` from `SMSG_CLIENT_CONTROL_UPDATE`. Its own packets put it
   * where they say, as the character's do — gliding or extrapolating it would fight the physics.
   */
  predictedGuid: bigint | undefined;

  /** Fires only for natural completion of a noncyclic spline, not for a stop or teleport. */
  onSplineFinished: ((guid: bigint, splineId: number) => void) | undefined;

  /** Set by `WorldStore`. Unset by default, so nothing is recorded for a state nobody watches. */
  observer: StateObserver | undefined;

  #selfGuid: bigint | undefined;
  /** A drift record no unit holds yet, so a packet that turns out to be a stop allocates nothing. */
  #spareDrift: Drift | undefined;
  /** 11.01-E: passengers gliding to their packet in the carrier's frame (TransportPassengers.ts). */
  readonly #carrierGlides = new Map<bigint, CarrierGlide>();

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
  applyUpdate(payload: Uint8Array, now = performance.now()): readonly bigint[] {
    const reader = new PacketReader(payload);
    const blockCount = reader.u32();
    if (blockCount > payload.byteLength) throw new RangeError(`Invalid object update block count ${blockCount}`);
    let retired: bigint[] | undefined;
    let block = 0;
    let updateType: number | undefined;
    let guid: bigint | undefined;

    // Each block is read whole into locals and the scratch before anything is changed, and only
    // then committed. A block that throws half-way therefore leaves no trace — not an object
    // without a position, not half of its fields — while the blocks before it stand (5.26).
    try {
      for (; block < blockCount; block++) {
        updateType = undefined;
        guid = undefined;
        updateType = reader.u8();
        if (updateType === UPDATE_VALUES) {
          guid = reader.packedGuid();
          const slots = readValues(reader);
          if (this.failedCreates.has(guid)) continue;
          const changed = commitValues(this.#get(guid).fields, slots);
          this.observer?.fieldsChanged(guid, changed);
        } else if (updateType === UPDATE_MOVEMENT) {
          guid = reader.packedGuid();
          const movement = readMovement(reader);
          if (this.failedCreates.has(guid)) continue;
          this.#applyMovement(this.#get(guid), movement, now);
          this.observer?.objectMoved(guid);
        } else if (updateType === UPDATE_CREATE || updateType === UPDATE_CREATE2) {
          guid = reader.packedGuid();
          const typeId = reader.u8();
          const movement = readMovement(reader);
          const slots = readValues(reader);
          this.failedCreates.delete(guid);
          const object: WorldObjectState = {
            guid,
            typeId,
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
            splineTier: undefined,
            transportTime: undefined,
            transportTimeAt: undefined,
            fields: new Map(),
            // Every object starts with the same shape, so the per-frame loop over them stays monomorphic.
            drift: undefined,
            pitch: undefined,
            rotation: undefined,
            positionTransport: undefined,
            vehicleId: undefined,
            vehicleOrientation: undefined, // 11.02-F1
          };
          this.objects.set(guid, object);
          // Announced before its fields, so a listener that asks for the object finds it there.
          this.observer?.objectCreated(guid, object.typeId);
          this.#applyMovement(object, movement, now);
          this.observer?.objectMoved(guid);
          const created = commitValues(object.fields, slots);
          this.observer?.fieldsChanged(guid, created);
        } else if (updateType === UPDATE_OUT_OF_RANGE) {
          const count = reader.u32();
          if (count > reader.remaining) throw new RangeError(`Invalid out-of-range object count ${count}`);
          for (let index = 0; index < count; index++) {
            const gone = reader.packedGuid();
            this.failedCreates.delete(gone);
            this.#remove(gone);
            (retired ??= []).push(gone);
          }
        } else if (updateType === UPDATE_NEAR) {
          const count = reader.u32();
          if (count > reader.remaining) throw new RangeError(`Invalid near-object count ${count}`);
          for (let index = 0; index < count; index++) reader.packedGuid();
        } else {
          throw new RangeError(`Unknown object update type ${updateType}`);
        }
      }
      updateType = undefined;
      guid = undefined;
      reader.assertFinished();
    } catch (cause) {
      // Whatever was committed before the failure is real and has to be announced.
      this.revision++;
      const failedCreate = guid !== undefined && (updateType === UPDATE_CREATE || updateType === UPDATE_CREATE2);
      // Its values cannot be trusted to come later: a VALUES block for this guid would otherwise
      // make a stub with no type and no position. Held until a new CREATE, OUT_OF_RANGE or destroy.
      // Not for a guid still held (the kept player of a far teleport, or a failure after commit):
      // freezing a live object's fields would be worse than the stub this guards against.
      if (failedCreate && !this.objects.has(guid!)) this.failedCreates.add(guid!);
      // Block boundaries are unknowable past a broken block, so the rest of the packet is gone.
      const blocksLost = block < blockCount ? blockCount - block : 0;
      this.updateBlockFailures++;
      this.updateBlocksLost += blocksLost;
      throw new UpdateBlockError({
        cause, retired: retired ?? NO_RETIRED_OBJECTS, blockIndex: block, blockCount, blocksLost, guid, updateType,
      });
    }

    this.revision++;
    return retired ?? NO_RETIRED_OBJECTS;
  }

  destroy(guid: bigint): void {
    this.failedCreates.delete(guid);
    this.#remove(guid);
    this.revision++;
  }

  /**
   * 11.02-F1: SMSG_PLAYER_VEHICLE_DATA — a unit in view gains a vehicle kit (a player's mount or aura,
   * an NPCBot's mount) or, with 0, loses it (Unit.cpp:8684-8705, 8769-8783; SpellAuraEffects.cpp:
   * 5051-5054). Later than the create block's id, so it replaces it. A unit out of view is left alone:
   * its next create block carries UPDATEFLAG_VEHICLE itself (`CreateVehicleKit`, Unit.cpp:12723).
   */
  setVehicleKit(guid: bigint, vehicleId: number): void {
    const object = this.objects.get(guid);
    if (object) object.vehicleId = vehicleId === 0 ? undefined : vehicleId;
  }

  /**
   * Retires map-scoped objects while retaining the controlled player through a far transfer.
   * TrinityCore recreates the player, transport and visible neighbours after WORLDPORT_ACK, but
   * retaining the player here keeps the mover identity and its live aura snapshot valid until
   * those packets arrive.
   */
  clearExcept(guid: bigint | undefined): readonly bigint[] {
    this.failedCreates.clear();
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
    object.drift = undefined;
    object.transport = undefined;
    this.#carrierGlides.delete(guid);
    object.movementFlags = 0;
    this.revision++;
    this.observer?.objectMoved(guid);
  }

  /**
   * 11.02-A review: a unit this client has just been handed (`predictedGuid`) stops being carried
   * on by somebody else's last packet — its drift or glide would overwrite the physics every frame
   * until the first packet of ours, and that packet would then report the extrapolated point. It
   * stands where that packet put it, which is where the core holds it.
   */
  settlePredicted(guid: bigint): void {
    const object = this.objects.get(guid);
    if (!object?.position) return;
    const drift = object.drift;
    const glide = object.glide;
    if (drift === undefined && glide === undefined && !this.#carrierGlides.has(guid)) return;
    if (drift) {
      object.position = { x: drift.x, y: drift.y, z: drift.z, orientation: drift.orientation };
      this.#spareDrift = drift;
      object.drift = undefined;
    } else if (glide) {
      object.position = { x: glide.toX, y: glide.toY, z: glide.toZ, orientation: glide.toOrientation };
    }
    object.glide = undefined;
    this.#carrierGlides.delete(guid);
    this.revision++;
    this.observer?.objectMoved(guid);
  }

  /**
   * A movement packet: where the unit is and what it is doing (5.04).
   *
   * Somebody else's packet is not drawn as a destination but as a starting point: the motion its
   * flags declare is carried on between packets (`MovementExtrapolation.ts`), and the gap between
   * where the unit was drawn and where the packet says it is closes over 180 ms instead of jumping.
   * A packet that says the unit is standing glides it the last stretch exactly as before. The
   * controlled character is put where its own packet says — it is predicted locally.
   */
  move(guid: bigint, movement: Pick<MovementInfo, "flags" | "position" | "transport"> & Partial<MovementInfo>,
    now = performance.now()): void {
    const object = this.#get(guid);
    const previous = object.position;
    object.movementFlags = movement.flags;
    object.pitch = movement.pitch;
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
    const self = guid === this.selfGuid || guid === this.predictedGuid;
    const jump = previous === undefined || self
      ? Number.POSITIVE_INFINITY
      : Math.hypot(target.x - previous.x, target.y - previous.y, target.z - previous.z);
    // What the packet declares, tried on a spare record so that a stop allocates nothing.
    const record = object.drift ?? (this.#spareDrift ??= emptyDrift());
    const moving = !self && object.transport === undefined && kinematicsFor(movement, object.speeds, record);
    if (moving) {
      if (record === this.#spareDrift) this.#spareDrift = undefined;
      object.drift = record;
      object.glide = undefined;
      const snap = jump > CORRECTION_SNAP_DISTANCE;
      record.errorX = snap ? 0 : previous!.x - target.x;
      record.errorY = snap ? 0 : previous!.y - target.y;
      record.errorZ = snap ? 0 : previous!.z - target.z;
      record.errorOrientation = snap ? 0 : shortestTurn(target.orientation, previous!.orientation);
      record.x = target.x;
      record.y = target.y;
      record.z = target.z;
      record.orientation = target.orientation;
      record.at = now;
      anchorDrift(record, movement.flags, this.groundProbe);
      // L8-review 5.04: the unit's own clock (`object`; was `this`), as Wow.exe's 0x006EB730 keeps it per mover.
      realignDrift(object, record, movement.time, now, this.groundProbe); // L8 5.04: at the sender's moment
      // The drawn position stays where it was drawn; `updateMotions` moves it from this frame on.
      if (snap) object.position = { ...target };
      this.revision++;
      this.observer?.objectMoved(guid);
      return;
    }
    if (object.drift) {
      this.#spareDrift = object.drift;
      object.drift = undefined;
    }
    this.#carrierGlides.delete(guid);
    // 11.01-E: somebody aboard glides on the deck, not between two world points the ship has left.
    const carrierObject = self || object.transport === undefined ? undefined : this.objects.get(object.transport.guid);
    // Review C/D/E: a ship only — a lift or a vehicle seat glides between world points as before.
    const carrier = isShipCarrier(carrierObject) ? carrierObject!.position : undefined;
    if (carrier) {
      object.glide = undefined;
      object.position = { ...target };
      const glide = startCarrierGlide(previous, carrier, object.transport!, now, GLIDE_DURATION, GLIDE_SNAP_DISTANCE);
      if (glide) {
        this.#carrierGlides.set(guid, glide);
        sampleCarrierGlide(glide, carrier, now, object.position);
      }
      this.revision++;
      this.observer?.objectMoved(guid);
      return;
    }
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
  teleport(guid: bigint, movement: Pick<MovementInfo, "flags" | "position" | "transport"> & Partial<MovementInfo>,
    now = performance.now()): void {
    const object = this.#get(guid);
    object.movementFlags = movement.flags;
    object.pitch = movement.pitch;
    object.motion = undefined;
    object.glide = undefined;
    this.#carrierGlides.delete(guid);
    if (object.drift) {
      this.#spareDrift = object.drift;
      object.drift = undefined;
    }
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
    // A blink taken at a run goes on running from where it lands (5.04).
    if (guid !== this.selfGuid && object.transport === undefined) this.#startDrift(object, movement, now);
    this.revision++;
    this.observer?.objectMoved(guid);
  }

  /** Starts extrapolating from a position that is drawn as it is (no correction to fade). */
  #startDrift(object: WorldObjectState, movement: Pick<MovementInfo, "flags" | "position"> & Partial<MovementInfo>, now: number): void {
    const record = this.#spareDrift ?? emptyDrift();
    if (!kinematicsFor(movement, object.speeds, record)) {
      this.#spareDrift = record;
      return;
    }
    if (record === this.#spareDrift) this.#spareDrift = undefined;
    record.x = movement.position.x;
    record.y = movement.position.y;
    record.z = movement.position.z;
    record.orientation = movement.position.orientation;
    record.at = now;
    record.errorX = record.errorY = record.errorZ = record.errorOrientation = 0;
    anchorDrift(record, movement.flags, this.groundProbe);
    object.drift = record;
  }

  setField(guid: bigint, index: number, value: number): void {
    this.#get(guid).fields.set(index, value);
    this.revision++;
    this.observer?.fieldsChanged(guid, [index]);
  }

  /**
   * A packet's correction to one field of an object this state already holds — an enchantment's
   * remaining time, a socketed gem. Reported like any field change, so the store hears it; unlike
   * `setField`, never the moment an object starts existing: a correction for a guid no update
   * block introduced is dropped, and false says so.
   */
  patchField(guid: bigint, index: number, value: number): boolean {
    const object = this.objects.get(guid);
    if (!object) return false;
    object.fields.set(index, value);
    this.revision++;
    this.observer?.fieldsChanged(guid, [index]);
    return true;
  }

  startSpline(move: MonsterMove, now: number): void {
    const object = this.#get(move.guid);
    const finalPoint = move.points.at(-1);
    if (!finalPoint) return;
    // The server has taken the unit over: whatever its own last packet declared is over.
    object.drift = undefined;
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
    const desc = inWorldFrame(describeMonsterMove(move), transport);
    const points = desc.points;
    if (points.length === 0) return;
    object.glide = undefined;
    object.position = { ...points[0]!, orientation: object.position?.orientation ?? 0 };
    if (move.duration === 0 || points.length === 1) {
      if (desc.facing) object.position.orientation = this.#facingFrom(object.position, desc.facing);
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
    this.#beginMotion(object, desc, now);
    this.revision++;
    this.observer?.objectMoved(move.guid);
  }

  /**
   * Puts a unit on a path already in world coordinates, `timePassedMs` into it (a create block's
   * spline is caught part-way; a MONSTER_MOVE starts at zero). Shared by 5.02 and 5.03.
   */
  #beginMotion(object: WorldObjectState, desc: SplineDescription, now: number): void {
    const orientation = object.position?.orientation ?? 0;
    const track = buildTrack(desc, orientation);
    const first = track.first;
    object.glide = undefined;
    object.drift = undefined;
    object.motion = {
      splineId: desc.splineId,
      points: first.points,
      lengths: first.lengths.slice(1),
      totalLength: first.total,
      startedAt: now - desc.timePassedMs,
      duration: desc.durationMs,
      cyclic: desc.cyclic,
      flying: desc.flying,
      finalOrientation: desc.facing?.kind === "angle" ? desc.facing.angle : undefined,
      track,
    };
    sampleSpline(track, desc.timePassedMs, orientation, SPLINE_SAMPLE);
    object.position = { x: SPLINE_SAMPLE.x, y: SPLINE_SAMPLE.y, z: SPLINE_SAMPLE.z, orientation: SPLINE_SAMPLE.orientation };
  }

  /** Where an arrival facing points: an angle as is, a spot or a visible target by `atan2`. */
  #facingFrom(position: WorldPosition, facing: SplineFacing): number {
    if (facing.kind === "angle") return facing.angle;
    const spot = facing.kind === "spot" ? facing : this.objects.get(facing.guid)?.position;
    // A target out of view leaves the facing as it was: there is nothing to turn towards.
    if (!spot || (spot.x === position.x && spot.y === position.y)) return position.orientation;
    return Math.atan2(spot.y - position.y, spot.x - position.x);
  }

  updateMotions(now: number): void {
    // Carriers before anyone is carried: every passenger below composes on this frame's deck.
    this.poseProvider?.(this, now);
    for (const object of this.objects.values()) {
      // A passenger first: whatever its own motion does next is relative to a deck that may have
      // moved since the last packet, and no packet will ever say so.
      this.#carryPassenger(object);
      if (this.#carrierGlides.size !== 0) this.#advanceCarrierGlide(object, now);
      this.#advanceGlide(object, now);
      if (object.drift !== undefined) this.#advanceDrift(object, object.drift, now);
      const latch = object.splineTier;
      // A BYTES_1 tier byte that has moved on since the effect took over overrules it for good.
      if (latch !== undefined && latch.tier !== undefined && fieldAnimationTier(object) !== latch.fieldTier) {
        latch.tier = undefined;
      }
      const motion = object.motion;
      if (!motion || !object.position) continue;
      const track = motion.track ??= trackFromMotion(motion);
      const elapsed = now - motion.startedAt;
      const animation = track.desc.animation;
      if (animation !== undefined && elapsed >= animation.startMs && latch?.track !== track) {
        object.splineTier = { tier: animation.tier, fieldTier: fieldAnimationTier(object), track };
      }
      const done = sampleSpline(track, elapsed, object.position.orientation, SPLINE_SAMPLE);
      object.position.x = SPLINE_SAMPLE.x;
      object.position.y = SPLINE_SAMPLE.y;
      object.position.z = SPLINE_SAMPLE.z;
      object.position.orientation = SPLINE_SAMPLE.orientation;
      if (done) {
        // The core does nothing for a target facing (`MoveSpline::ComputePosition`); the client
        // turns to the target itself, which is only possible while the target is in view.
        if (track.desc.facing?.kind === "target") {
          object.position.orientation = this.#facingFrom(object.position, track.desc.facing);
        }
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

  /** 11.01-E: the rest of a passenger's glide, on this frame's deck; over when the seat or the carrier changed. */
  #advanceCarrierGlide(object: WorldObjectState, now: number): void {
    const glide = this.#carrierGlides.get(object.guid);
    if (glide === undefined) return;
    const carrier = object.transport?.guid === glide.carrier ? this.objects.get(glide.carrier)?.position : undefined;
    if (!carrier || !object.position || !sampleCarrierGlide(glide, carrier, now, object.position)) {
      this.#carrierGlides.delete(object.guid);
    }
  }

  /** L16 (11.01-E): a passenger's glide on its carrier's deck while one runs — read by BenchmarkReplay's capture. */
  carrierGlide(guid: bigint): Readonly<CarrierGlide> | undefined {
    return this.#carrierGlides.get(guid);
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
   * drift on a long flight rather than a position. Wow.exe (0x0098B5D0) never moves the unit for it:
   * the error sets the pace of the next lap (`resyncTrack`), so a flyer catches up or falls back
   * over a lap instead of jumping — and never back to the start of an Enter_Cycle path.
   */
  resyncSpline(guid: bigint, progress: number, now: number): void {
    const motion = this.objects.get(guid)?.motion;
    if (!motion || motion.duration <= 0) {
      this.splineSyncDropped++;
      return;
    }
    resyncTrack(motion.track ??= trackFromMotion(motion), now - motion.startedAt, progress);
    this.revision++;
  }

  /** One of the nine `SMSG_SPLINE_SET_*` rates, in yards or radians a second. */
  setSpeed(guid: bigint, name: SplineSpeedName, value: number, now = performance.now()): void {
    const object = this.objects.get(guid);
    if (!object || !Number.isFinite(value) || value < 0) return;
    // A rider who mounts mid-run: the motion being extrapolated speeds up from here, not from the
    // packet before (which would put them retroactively further along).
    const drift = object.drift !== undefined && !object.drift.ballistic
      && now - object.drift.at < EXTRAPOLATION_HORIZON_MS ? object.drift : undefined;
    if (drift !== undefined) this.#rebaseDrift(drift, object.movementFlags, now);
    object.speeds ??= new Map();
    object.speeds.set(name, value);
    if (drift !== undefined) {
      // L8-review 5.04: a pitching drift goes on from the pitch its keys have turned to, not the packet's.
      const pitch = drift.pitchTurn !== 0 ? driftPitch(drift, now) : object.pitch; // L8-review 5.04
      kinematicsFor({ flags: object.movementFlags, pitch }, object.speeds, drift); // L8-review 5.04: was `pitch: object.pitch`
    }
    // The two the rest of the client already reads by name keep their own fields in step.
    if (name === "run") object.runSpeed = value;
    else if (name === "turnRate") object.turnRate = value;
    this.revision++;
  }

  /**
   * One frame of a remote player's extrapolation (5.04). A drift that has run past its horizon and
   * finished its correction is dropped; the unit stays where it was last drawn.
   */
  #advanceDrift(object: WorldObjectState, drift: Drift, now: number): void {
    const position = object.position;
    if (!position || object.motion !== undefined || object.transport !== undefined) {
      object.drift = undefined;
      return;
    }
    const live = advanceDrift(drift, now, DRIFT_SAMPLE, this.groundProbe);
    position.x = DRIFT_SAMPLE.x;
    position.y = DRIFT_SAMPLE.y;
    position.z = DRIFT_SAMPLE.z;
    position.orientation = DRIFT_SAMPLE.orientation;
    if (!live) {
      this.#spareDrift ??= drift;
      object.drift = undefined;
    }
  }

  /** Restarts a drift from where its motion has carried it by `now`, keeping what is left of the correction. */
  #rebaseDrift(drift: Drift, flags: number, now: number): void {
    const errorX = drift.errorX;
    const errorY = drift.errorY;
    const errorZ = drift.errorZ;
    const errorOrientation = drift.errorOrientation;
    drift.errorX = drift.errorY = drift.errorZ = drift.errorOrientation = 0;
    advanceDrift(drift, now, DRIFT_SAMPLE, this.groundProbe);
    // L8-review 5.04: what is left of the correction is counted from where its fade began — the arrival
    // (`fadeAt`) once a late packet moved `at` back to its sender's moment, as `advanceDrift` draws it.
    const fadeFrom = drift.fadeAt > drift.at ? drift.fadeAt : drift.at; // L8-review 5.04
    const fade = Math.max(0, 1 - Math.max(0, now - fadeFrom) / GLIDE_DURATION); // L8-review 5.04: was `now - drift.at`
    drift.x = DRIFT_SAMPLE.x;
    drift.y = DRIFT_SAMPLE.y;
    drift.z = DRIFT_SAMPLE.z;
    drift.orientation = DRIFT_SAMPLE.orientation;
    drift.at = now;
    drift.errorX = errorX * fade;
    drift.errorY = errorY * fade;
    drift.errorZ = errorZ * fade;
    drift.errorOrientation = errorOrientation * fade;
    anchorDrift(drift, flags, this.groundProbe);
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
        splineTier: undefined,
        transportTime: undefined,
        transportTimeAt: undefined,
        fields: new Map(),
        drift: undefined,
        pitch: undefined,
        rotation: undefined,
        positionTransport: undefined,
        vehicleId: undefined,
        vehicleOrientation: undefined, // 11.02-F1
      };
      this.objects.set(guid, object);
      // Values or movement can arrive for a guid no create block introduced; that is still the
      // moment the object starts existing as far as anything watching is concerned.
      this.observer?.objectCreated(guid, undefined);
    }
    return object;
  }

  #applyMovement(object: WorldObjectState, movement: MovementUpdate, now: number): void {
    if (movement.position) {
      object.glide = undefined;
      object.drift = undefined;
      this.#carrierGlides.delete(object.guid);
    }
    object.position = movement.position ?? object.position;
    object.transport = movement.transport;
    object.movementFlags = movement.movementFlags;
    // All nine, not the two the renderer used to need: extrapolating a swimmer or a walker between
    // packets needs the rate it is moving at, and the server sends it here once and then only on change.
    if (movement.speeds) {
      const speeds = object.speeds ??= new Map();
      for (let index = 0; index < CREATE_SPEED_ORDER.length; index++) {
        const value = movement.speeds[index]!;
        if (Number.isFinite(value) && value >= 0) speeds.set(CREATE_SPEED_ORDER[index]!, value);
      }
    }
    if (movement.info) object.pitch = movement.info.pitch;
    if (movement.rotation) object.rotation = movement.rotation;
    if (movement.updateFlags & FLAG_POSITION) object.positionTransport = movement.positionTransport;
    // 11.01-D: a game object created aboard is carried like any passenger (TransportPassengers.ts).
    if (movement.positionTransport !== undefined && movement.transport === undefined) {
      object.transport = positionPassengerSeat(movement.positionTransport, object.position,
        this.objects.get(movement.positionTransport.guid)?.position);
    }
    if (movement.vehicleId !== undefined) {
      object.vehicleId = movement.vehicleId;
      object.vehicleOrientation = movement.vehicleOrientation; // 11.02-F1
    }
    // The create block is the only time the server states a path the unit is already on:
    // `MoveSplineInit::Launch` sends its MONSTER_MOVE once, at launch, and never again (5.02). So a
    // patrol, a taxi rider or a circling flyer caught mid-path goes on from where the block says.
    if (movement.spline && isRunnableSpline(movement.spline)) {
      // Points of a spline launched aboard are in the transport's frame (`TransportPathTransform`);
      // with that transport out of view there is no frame to put them in, and the unit stands.
      const transport = movement.transport ? this.objects.get(movement.transport.guid)?.position : undefined;
      if (!movement.transport || transport) this.#beginMotion(object, inWorldFrame(movement.spline, transport), now);
    }
    // A unit whose spline is finished, stopped or unplaceable is drawn standing where the block put
    // it — and its flags have to agree, or it runs on the spot from the first frame it is seen.
    if (object.motion === undefined) this.#scrubSplineFlags(object);
    // A player who comes into view already running goes on running from the block (5.04): the next
    // word about them may be half a second away.
    if (movement.info && movement.position && object.typeId === TYPEID_PLAYER && object.motion === undefined
      && object.transport === undefined && (movement.updateFlags & FLAG_SELF) === 0 && object.guid !== this.selfGuid) {
      this.#startDrift(object, movement.info, now);
    }
    object.updateFlags = movement.updateFlags;
    object.targetGuid = movement.targetGuid;
    object.runSpeed = movement.runSpeed ?? object.runSpeed;
    object.turnRate = movement.turnRate ?? object.turnRate;
    object.transportTime = movement.transportTime ?? object.transportTime;
    if (movement.transportTime !== undefined) object.transportTimeAt = now;
    if (movement.updateFlags & FLAG_SELF) this.selfGuid = object.guid;
  }

  #remove(guid: bigint): boolean {
    if (!this.objects.delete(guid)) return false;
    this.#carrierGlides.delete(guid);
    if (this.selfGuid === guid) this.selfGuid = undefined;
    this.observer?.objectDestroyed(guid);
    return true;
  }
}

/**
 * The tier a unit's spline animates on once its effect has begun — a landing drake's ground tier,
 * a lifting one's hover — or undefined when the unit's own BYTES_1 byte answers (5.03).
 * `MoveSplineFlag::Animation`, set by `MoveSplineInit::SetAnimation` (MotionMaster: takeoff, land).
 *
 * As in Wow.exe the effect outlives its path: the tier stays through arrival and any plain path
 * after it, until the BYTES_1 tier byte changes (`WorldObjectState.splineTier`).
 */
export function splineAnimationTier(object: WorldObjectState, now: number): number | undefined {
  const motion = object.motion;
  const latch = object.splineTier;
  // Once latched, this path's effect answers through the latch, which a field change can overrule.
  if (latch !== undefined && latch.track === motion?.track) return latch.tier;
  const tier = motion?.track ? trackAnimationTier(motion.track, now - motion.startedAt) : undefined;
  return tier ?? latch?.tier;
}

const BYTES_1_INDEX = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;

/** The anim tier byte of UNIT_FIELD_BYTES_1 (byte 3), as `unitFields.animationTier` reads it. */
function fieldAnimationTier(object: WorldObjectState): number | undefined {
  const raw = object.fields.get(BYTES_1_INDEX);
  return raw === undefined ? undefined : (raw >>> 24) & 0xff;
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

/**
 * Why an update packet stopped part-way, and what that cost.
 *
 * `retired` holds the GUIDs already removed by an OUT_OF_RANGE block before the failure, which
 * the packet owner must still retire (auras, casts); the blocks from `blockIndex` on were not
 * applied — `blocksLost` counts them, the failed one included, because past a broken block the
 * boundaries of the rest cannot be found.
 */
export class UpdateBlockError extends Error {
  readonly retired: readonly bigint[];
  readonly blockIndex: number;
  readonly blocksLost: number;
  readonly guid: bigint | undefined;
  readonly updateType: number | undefined;

  constructor(details: {
    cause: unknown; retired: readonly bigint[]; blockIndex: number; blockCount: number; blocksLost: number;
    guid: bigint | undefined; updateType: number | undefined;
  }) {
    const reason = details.cause instanceof Error ? details.cause.message : String(details.cause);
    // No guid in the text: the packet error log groups by message, and one broken layout would
    // otherwise fill it with an entry per creature.
    super(`update block ${details.blockIndex + 1}/${details.blockCount} (type ${details.updateType ?? "?"}) failed: `
      + `${reason}; ${details.blocksLost} block(s) lost`, { cause: details.cause });
    this.name = "UpdateBlockError";
    this.retired = details.retired;
    this.blockIndex = details.blockIndex;
    this.blocksLost = details.blocksLost;
    this.guid = details.guid;
    this.updateType = details.updateType;
  }
}

/** Mask words and slot values of one values block, read before any of it is applied. */
const MAX_FIELD_SLOTS = 255 * 32;
const FIELD_MASK_SCRATCH = new Uint32Array(255);
const FIELD_INDEX_SCRATCH = new Uint16Array(MAX_FIELD_SLOTS);
const FIELD_VALUE_SCRATCH = new Uint32Array(MAX_FIELD_SLOTS);

/**
 * Reads a values block into the shared scratch and returns how many slots it holds. Writes nothing
 * anywhere else, so a block that runs out of bytes half-way changes no field. The scratch is valid
 * until the next call; `commitValues` must follow before another block is read.
 */
function readValues(reader: PacketReader): number {
  const blockCount = reader.u8();
  for (let block = 0; block < blockCount; block++) FIELD_MASK_SCRATCH[block] = reader.u32();
  let slots = 0;
  for (let block = 0; block < blockCount; block++) {
    const mask = FIELD_MASK_SCRATCH[block]!;
    if (mask === 0) continue;
    for (let bit = 0; bit < 32; bit++) {
      if ((mask & (1 << bit)) === 0) continue;
      FIELD_INDEX_SCRATCH[slots] = block * 32 + bit;
      FIELD_VALUE_SCRATCH[slots] = reader.u32();
      slots++;
    }
  }
  return slots;
}

/** Writes the scratch into `fields`; returns the slots written, which is what a subscriber needs. */
function commitValues(fields: Map<number, number>, slots: number): number[] {
  const changed = new Array<number>(slots);
  for (let slot = 0; slot < slots; slot++) {
    const index = FIELD_INDEX_SCRATCH[slot]!;
    fields.set(index, FIELD_VALUE_SCRATCH[slot]!);
    changed[slot] = index;
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
  let spline: SplineDescription | undefined;
  let info: MovementInfo | undefined;
  let speeds: number[] | undefined;
  let positionTransport: MovementUpdate["positionTransport"];

  if (updateFlags & FLAG_LIVING) {
    const movement = readMovementInfo(reader);
    info = movement;
    movementFlags = movement.flags;
    position = movement.position;
    if (movement.transport && movement.transport.guid !== 0n) {
      transport = {
        guid: movement.transport.guid,
        x: movement.transport.x, y: movement.transport.y, z: movement.transport.z,
        orientation: movement.transport.orientation, seat: movement.transport.seat,
      };
    }
    speeds = new Array<number>(CREATE_SPEED_ORDER.length);
    for (let index = 0; index < CREATE_SPEED_ORDER.length; index++) speeds[index] = reader.f32();
    runSpeed = speeds[1];
    turnRate = speeds[7];
    if (movementFlags & MOVE_SPLINE_ENABLED) spline = readCreateSpline(reader);
  } else if (updateFlags & FLAG_POSITION) {
    // Object.cpp:347-379: the transport guid (or a zero byte), the world position, then the
    // offset on the transport or the world position again, the orientation, and a float that is
    // a corpse's orientation and zero for everything else.
    const transportGuid = reader.packedGuid();
    position = { x: reader.f32(), y: reader.f32(), z: reader.f32(), orientation: 0 };
    const offsetX = reader.f32();
    const offsetY = reader.f32();
    const offsetZ = reader.f32();
    position.orientation = reader.f32();
    reader.f32();
    if (transportGuid !== 0n) positionTransport = { guid: transportGuid, x: offsetX, y: offsetY, z: offsetZ };
  } else if (updateFlags & FLAG_STATIONARY) {
    position = readPosition(reader);
  }

  if (updateFlags & FLAG_UNKNOWN) reader.u32();
  if (updateFlags & FLAG_LOW_GUID) reader.u32();
  const targetGuid = updateFlags & FLAG_HAS_TARGET ? reader.packedGuid() : undefined;
  // Read past until now. It is the only clock a lift ever gets: the server sends this once, in
  // the create block, and never mentions the object again.
  const transportTime = updateFlags & FLAG_TRANSPORT ? reader.u32() : undefined;
  let vehicleId: number | undefined;
  let vehicleOrientation: number | undefined; // 11.02-F1
  if (updateFlags & FLAG_VEHICLE) {
    vehicleId = reader.u32();
    vehicleOrientation = reader.f32(); // 11.02-F1: kept, no longer read past
  }
  // `int64 GetPackedLocalRotation()` (Object.cpp:471-472), the game object's whole local rotation.
  const rotation = updateFlags & FLAG_ROTATION ? unpackRotation(reader.u64()) : undefined;

  return {
    position, transport, movementFlags, updateFlags, targetGuid, runSpeed, turnRate, transportTime, spline,
    info, speeds, rotation, positionTransport, vehicleId, vehicleOrientation, // 11.02-F1
  };
}

function readPosition(reader: PacketReader): WorldPosition {
  return { x: reader.f32(), y: reader.f32(), z: reader.f32(), orientation: reader.f32() };
}

/**
 * A description whose points (and facing spot) are in a transport's frame, put into the world's.
 * Composed once, at the start, as `startSpline` always has: the path is then followed in world
 * space while `#carryPassenger` keeps the seat.
 */
function inWorldFrame(desc: SplineDescription, transport: WorldPosition | undefined): SplineDescription {
  if (!transport) return desc;
  const toWorld = (point: SplinePoint): SplinePoint => {
    const world = composePassengerPosition(transport, { guid: 0n, ...point, orientation: 0, seat: 0 });
    return { x: world.x, y: world.y, z: world.z };
  };
  const facing = desc.facing?.kind === "spot" ? { kind: "spot" as const, ...toWorld(desc.facing) } : desc.facing;
  return { ...desc, points: desc.points.map(toWorld), facing };
}

/**
 * A track equivalent to a motion that carries only the plain fields: its closed polyline, angle
 * facing and cycle, exactly as `updateMotions` evaluated them before the description existed.
 */
function trackFromMotion(motion: SplineMotion): SplineTrack {
  const open = motion.cyclic ? motion.points.slice(0, -1) : motion.points;
  return buildTrack({
    splineId: motion.splineId, flags: 0, points: open, durationMs: motion.duration, timePassedMs: 0,
    cyclic: motion.cyclic, enterCycle: false, catmullRom: false, flying: motion.flying, orientationFixed: false,
    backward: false, falling: false, parabolic: undefined, animation: undefined,
    facing: motion.finalOrientation === undefined ? undefined : { kind: "angle", angle: motion.finalOrientation },
  }, 0);
}
