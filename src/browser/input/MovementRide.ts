import type { MovementInfo } from "../../world/MovementProtocol.js";
import type { KnockbackImpulse } from "../../world/KnockbackImpulse.js";
import { normalizeOrientation, type TransportSeat } from "../../world/TransportMath.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import type { CollisionWorld } from "../game/Collision.js";
import { GameObjectCollisionModels, type CollisionModelSource } from "../game/GameObjectCollisionModels.js";
import { LOAD_WAIT_MAX, STEP_DOWN, STEP_HEIGHT, type CharacterInput, type CharacterMotion, type PhysicsEvent, type TerrainProbe } from "../game/Physics.js";
import { TransportCollision, toCarrierLocal, type CarrierPose } from "../game/TransportCollision.js";
import {
  CarrierProbe, SHIP_SEAT, boardingDecision, deckFloorUnder, isRideCarrier, newRideState, noteCarrierPose,
  rideVerdict, stepRide, withinRideBounds, worldFloorUnder, type RideFloor, type RideState,
} from "../game/TransportRide.js";
import { forgetRideObjects, noteRideObjects, resumableSeat } from "./RideResume.js";

/**
 * 11.01 slice A3, the page's half: which ship the character stands on, kept between frames for
 * `Movement.advancePhysics`.
 *
 * The offset is the character's own `WorldObjectState.transport` — what the server sent in a
 * create block or what our last packet said — so a ride survives anything that rebuilds the
 * movement layer, and `WorldClient`'s acknowledgements see the same seat. This file keeps it
 * current every substep, decides boarding and leaving, and loads the decks near the character
 * (`TransportCollision`, released when the ship sails out of range).
 *
 * `WorldState.#carryPassenger` composes the character on this frame's deck before the physics runs
 * (`updateMotions`), and the step here composes it again after; both read the same offset and the
 * same pose, so they agree. A world-facing change made between frames (a mouse turn) is carried
 * into the offset by {@link rideTurned}, or the carry would undo it.
 */

/** What the page gives the ride: a carrier's collision in its own frame (`TransportCollision`). */
export interface RideCarriers {
  forObject(object: WorldObjectState): CollisionWorld | null | undefined;
  retain(guids: ReadonlySet<bigint>): void;
  clear(): void;
}

/**
 * How near (2D, yards) a ship's deck is fetched and kept: past {@link RIDE_MAX_OFFSET}'s box with
 * room to load before it arrives at a dock. Further away its meshes are released.
 */
export const RIDE_WARM_RANGE = 150;
/** How often the list of ships in view is rebuilt when the object count has not changed. */
const SHIP_RESCAN_MS = 1000;

let models: GameObjectCollisionModels | undefined;
let carriers: RideCarriers | undefined;
let ride: RideState | undefined;
/** The ride flipped on or off this frame; `Movement` sends the packet that says so. */
let flipped = false;

/** The ships in view: rebuilt when objects come or go, not every frame. */
const ships = new Set<bigint>();
let shipsScannedAt = Number.NEGATIVE_INFINITY;
let shipsScannedSize = -1;
let shipsScannedObjects: ReadonlyMap<bigint, WorldObjectState> | undefined;
/** Carriers whose decks are kept, swapped each frame so membership changes only reach `retain` when real. */
let near = new Set<bigint>();
let nearNext = new Set<bigint>();

const PROBE = new CarrierProbe();
/** The offset being stepped this frame; `self.transport` is written from it every substep. */
const LOCAL: WorldPosition = { x: 0, y: 0, z: 0, orientation: 0 };
const FEET = { x: 0, y: 0, z: 0 };
const FLOORS: RideFloor[] = [];
const FLOOR_POOL: RideFloor[] = [];

/** Every world mount: decks of ships in this world, from this gateway's collision models. */
export function startTransportRide(gatewayUrl: string, geometry: CollisionModelSource): void {
  const origin = new URL(gatewayUrl.replace(/^ws/, "http")).origin;
  if (models?.origin !== origin) {
    models?.stop();
    models = new GameObjectCollisionModels(origin, geometry);
  }
  models.retry();
  const source = models;
  carriers = new TransportCollision({
    model: (displayId) => source.model(displayId),
    requestGroups: (displayId, groups) => source.requestGroups(displayId, groups),
    get revision() {
      return source.revision;
    },
  });
  forgetRide();
  forgetRideObjects();
}

/** The world session is retired: no deck requests behind the character screen. */
export function stopTransportRide(): void {
  models?.stop();
  carriers?.clear();
  carriers = undefined;
  forgetRide();
  forgetRideObjects();
}

/** 11.01-B: the game objects' collision models of this gateway, shared with doors and lifts (GameObjectColliders.ts). */
export function rideCollisionModels(): GameObjectCollisionModels | undefined {
  return models;
}

/** Tests: the carriers' collision, without a gateway. */
export function setRideCarriers(source: RideCarriers | undefined): void {
  carriers = source;
  forgetRide();
  forgetRideObjects();
}

/** Drops the ride's own state (counters, scans); the server's seat on the character stays. */
export function forgetRide(): void {
  ride = undefined;
  flipped = false;
  ships.clear();
  shipsScannedAt = Number.NEGATIVE_INFINITY;
  shipsScannedSize = -1;
  shipsScannedObjects = undefined;
  near.clear();
  nearNext.clear();
  PROBE.deck = undefined;
}

/** The ride in progress, for the movement layer and the tests. */
export function currentRide(): Readonly<RideState> | undefined {
  return ride;
}

/** The carrier under the character moved this frame: a heartbeat is due even with no key held. */
export function rideCarrierMoving(): boolean {
  return ride?.carrierMoving === true;
}

/** Whether the ride started or ended this frame (read once: the flag clears). */
export function takeRideFlip(): boolean {
  const value = flipped;
  flipped = false;
  return value;
}

/** The seat a packet carries: the character's own, while it is the ride's. */
function rideSeat(self: WorldObjectState | undefined): TransportSeat | undefined {
  const seat = self?.transport;
  // 11.01-C: between a reset of the ride's state and the frame that rebuilds it (RideResume.ts).
  if (ride === undefined) return resumableSeat(seat);
  return seat !== undefined && seat.guid === ride.guid ? seat : undefined;
}

/** Whether a packet now carries the transport block (and with it `MOVEMENTFLAG_ONTRANSPORT`). */
export function rideActive(self: WorldObjectState | undefined): boolean {
  return rideSeat(self) !== undefined;
}

/**
 * The transport block of a packet: guid, offset, facing relative to the carrier, a ship's seat.
 * `MOVEMENTFLAG_ONTRANSPORT` goes on exactly when this is defined, never one without the other.
 */
export function rideTransportBlock(self: WorldObjectState | undefined, time: number): MovementInfo["transport"] | undefined {
  const seat = rideSeat(self);
  if (!seat) return undefined;
  return { guid: seat.guid, x: seat.x, y: seat.y, z: seat.z, orientation: seat.orientation, time, seat: SHIP_SEAT };
}

/** A turn of the character made outside the frame (the mouse): its offset turns with it. */
export function rideTurned(self: WorldObjectState | undefined, radians: number): void {
  const seat = rideSeat(self);
  if (!seat) return;
  seat.orientation = normalizeOrientation(seat.orientation + radians);
  LOCAL.orientation = seat.orientation;
}

/** A knock back's direction is the world's; on a deck the step runs in the carrier's frame. */
export function rideImpulse(self: WorldObjectState | undefined, impulse: KnockbackImpulse,
  objects: ReadonlyMap<bigint, WorldObjectState>): KnockbackImpulse {
  const seat = rideSeat(self);
  const pose = seat === undefined ? undefined : objects.get(seat.guid)?.position;
  if (!pose) return impulse;
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  return { ...impulse, cos: impulse.cos * cos + impulse.sin * sin, sin: impulse.sin * cos - impulse.cos * sin };
}

/**
 * L16: the character's own airborne motion turned by `radians`, when it changes frames in the air —
 * boarding (minus the carrier's heading) or leaving (plus it). Wow.exe's frame change
 * (CMovementData_C::ForceSetTransportInt 0x006ec400 → 0x0098c730 / 0x0098ba20 → 0x0098b850) turns the
 * movement direction, the jump block's cos/sin among it, by the transport's rotation and keeps the
 * speeds: the transport's own velocity is not handed to the character. Here that is the jump block
 * the packets carry and a knock back's drift; the keys' way is the facing, which `compose` already
 * turns. Allocates nothing.
 */
export function turnAirMotion(motion: CharacterMotion, radians: number): void {
  const jump = motion.jump;
  const drift = motion.drift;
  if ((jump === undefined && drift === undefined) || radians === 0) return;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  if (jump !== undefined) {
    const c = jump.cosAngle;
    const s = jump.sinAngle;
    jump.cosAngle = c * cos - s * sin;
    jump.sinAngle = c * sin + s * cos;
  }
  if (drift !== undefined) {
    const vx = drift.vx;
    drift.vx = vx * cos - drift.vy * sin;
    drift.vy = vx * sin + drift.vy * cos;
  }
}

/** What `beginRideFrame` reads of the frame. */
export interface RideFrameInput {
  objects: ReadonlyMap<bigint, WorldObjectState>;
  self: WorldObjectState;
  /** The world's probe: terrain and static collision. */
  world: TerrainProbe;
  /** L16: written only to turn the airborne motion between frames (`turnAirMotion`); was Readonly. */
  motion: CharacterMotion;
  flying: boolean;
  /** Seconds this frame's physics advances: how far a fall may carry the feet past a deck. */
  elapsed: number;
  now: number;
}

/**
 * Frame start, after the turn and before the step. Returns the probe to step against while the
 * character rides (the step then goes through {@link stepRideSubstep}); undefined to step in the
 * world as before. Boards when a ship's deck is the floor under the feet.
 */
export function beginRideFrame(frame: RideFrameInput): TerrainProbe | undefined {
  const { objects, self } = frame;
  noteRideObjects(objects);
  const position = self.position;
  if (!position) return undefined;
  rescanShips(objects, frame.now);
  const seat = self.transport;
  // The server's word on the seat comes first: a seat on something else (a vehicle) is not a ride,
  // and no seat at all ends one.
  if (ride !== undefined && seat?.guid !== ride.guid) {
    // L16: the arc goes back to the world's frame with the old seat (in practice the server moves a
    // seat only with a teleport, which has already reset the arc).
    turnAirMotion(frame.motion, ride.lastOrientation);
    ride = undefined;
  }
  if (seat !== undefined) {
    const carrier = objects.get(seat.guid);
    if (!isRideCarrier(carrier)) {
      // Review A3: the ship we rode left view (destroyed): the ride ends where the character is,
      // or every packet would go on carrying an offset frozen on a ship that is gone.
      if (ride !== undefined) leave(self, frame.motion);
      keepNear(objects, position, undefined);
      return undefined;
    }
    const pose = carrier!.position;
    if (!pose) {
      // The ship we stood on left view: the ride ends where the character is.
      if (ride !== undefined) leave(self, frame.motion);
      keepNear(objects, position, undefined);
      return undefined;
    }
    if (ride === undefined) {
      ride = newRideState(seat.guid, pose);
      // L16: a seat from the server (a create block, a teleport onto a deck) starts the deck's frame
      // as boarding does — Wow.exe turns the arc for any transport set (0x006ec400); it has normally
      // just been reset by the teleport, and then there is nothing to turn.
      turnAirMotion(frame.motion, -pose.orientation);
    }
    noteCarrierPose(ride, pose);
    keepNear(objects, position, seat.guid);
    const deck = carriers?.forObject(carrier!);
    if (deck === null) {
      // The core gives this model no collision: there is no deck to stand on.
      leave(self, frame.motion);
      return undefined;
    }
    // Review A3: a deck still on its way is waited for as the physics waits for ground, and no
    // longer. A gateway without `/vmap/gobject-models` never sends it; the seat the server gave
    // (logging in aboard, a teleport onto a deck) then goes as it did before this slice — the world
    // takes over — instead of a ride over nothing that sends a frozen offset for good.
    if (deck === undefined) {
      ride.deckWaitMs += frame.elapsed * 1000;
      if (ride.deckWaitMs >= LOAD_WAIT_MAX) {
        leave(self, frame.motion);
        return undefined;
      }
    } else ride.deckWaitMs = 0;
    PROBE.deck = deck;
    LOCAL.x = seat.x;
    LOCAL.y = seat.y;
    LOCAL.z = seat.z;
    // The world facing is the newer word: the turn keys and following turned it this frame.
    LOCAL.orientation = normalizeOrientation(position.orientation - pose.orientation);
    seat.orientation = LOCAL.orientation;
    return PROBE;
  }

  keepNear(objects, position, undefined);
  if (near.size === 0 || frame.motion.mode === "swim" || (frame.motion.mode === "air" && frame.flying)) return undefined;
  // Boarding: a deck within reach below the feet that is the highest floor there.
  releaseFloors();
  for (const guid of near) {
    const carrier = objects.get(guid);
    const pose = carrier?.position;
    if (!carrier || !pose) continue;
    toCarrierLocal(pose, position.x, position.y, position.z, FEET);
    if (!withinRideBounds(FEET)) continue;
    const deck = carriers?.forObject(carrier);
    if (!deck) continue;
    const z = deckFloorUnder(deck, FEET.x, FEET.y, FEET.z);
    if (z === undefined) continue;
    pushFloor(z + pose.z, guid);
  }
  if (FLOORS.length === 0) return undefined;
  pushFloor(worldFloorUnder(frame.world, position.x, position.y, position.z), undefined);
  const reach = frame.motion.mode === "air"
    ? Math.max(STEP_DOWN, -frame.motion.velocityZ * frame.elapsed + STEP_HEIGHT) : STEP_DOWN;
  const boarded = boardingDecision(position.z, FLOORS, reach);
  if (boarded === undefined) return undefined;
  const carrier = objects.get(boarded)!;
  const pose = carrier.position!;
  const deck = carriers?.forObject(carrier);
  if (!deck) return undefined;
  ride = newRideState(boarded, pose);
  // L16: an arc in the air goes on in the ship's frame (Wow.exe 0x0098ba20 → 0x0098b850).
  turnAirMotion(frame.motion, -pose.orientation);
  toCarrierLocal(pose, position.x, position.y, position.z, LOCAL);
  LOCAL.orientation = normalizeOrientation(position.orientation - pose.orientation);
  self.transport = { guid: boarded, x: LOCAL.x, y: LOCAL.y, z: LOCAL.z, orientation: LOCAL.orientation, seat: SHIP_SEAT };
  PROBE.deck = deck;
  flipped = true;
  return PROBE;
}

/**
 * One substep on the deck: the step in the carrier's frame, then the world position and the seat
 * written from it, so a packet an event sends mid-frame says where the character is now.
 */
export function stepRideSubstep(frame: RideFrameInput, motion: CharacterMotion, input: CharacterInput, elapsed: number,
  events: PhysicsEvent[]): PhysicsEvent[] {
  const pose = ride === undefined ? undefined : frame.objects.get(ride.guid)?.position;
  const position = frame.self.position;
  if (events.length !== 0) events.length = 0;
  if (!pose || !position) return events;
  stepRide(pose, LOCAL, motion, input, PROBE, elapsed, position, events);
  writeSeat(frame.self);
  return events;
}

/** Frame end: the seat written, and the ride ended if the deck is no longer what the feet stand on. */
export function endRideFrame(frame: RideFrameInput): void {
  if (ride === undefined) return;
  const pose = frame.objects.get(ride.guid)?.position;
  const position = frame.self.position;
  if (!pose || !position) return;
  writeSeat(frame.self);
  const deck = PROBE.deck;
  const leaving = rideVerdict(ride, LOCAL, {
    deckZ: deck === undefined ? undefined : deckFloorUnder(deck, LOCAL.x, LOCAL.y, LOCAL.z),
    deckKnown: deck !== undefined,
    worldFloorZ: worldFloorUnder(frame.world, position.x, position.y, position.z),
    poseZ: pose.z,
    mode: frame.motion.mode,
    flying: frame.flying,
  });
  if (leaving) leave(frame.self, frame.motion);
}

function writeSeat(self: WorldObjectState): void {
  let seat = self.transport;
  if (seat === undefined || seat.guid !== ride!.guid) {
    seat = { guid: ride!.guid, x: 0, y: 0, z: 0, orientation: 0, seat: SHIP_SEAT };
    self.transport = seat;
  }
  seat.x = LOCAL.x;
  seat.y = LOCAL.y;
  seat.z = LOCAL.z;
  seat.orientation = LOCAL.orientation;
}

/**
 * Off the deck without a seam: the world position stays, the next packet goes without the flag.
 * L16: an arc in the air goes on in the world's frame — turned by the carrier's heading of this frame
 * (the last one seen, for a carrier gone from view), its speeds kept (`turnAirMotion`).
 */
function leave(self: WorldObjectState, motion: CharacterMotion): void {
  if (ride !== undefined) turnAirMotion(motion, ride.lastOrientation);
  ride = undefined;
  self.transport = undefined;
  PROBE.deck = undefined;
  flipped = true;
}

function rescanShips(objects: ReadonlyMap<bigint, WorldObjectState>, now: number): void {
  if (objects === shipsScannedObjects && objects.size === shipsScannedSize && now - shipsScannedAt < SHIP_RESCAN_MS) return;
  shipsScannedObjects = objects;
  shipsScannedSize = objects.size;
  shipsScannedAt = now;
  ships.clear();
  for (const object of objects.values()) if (isRideCarrier(object)) ships.add(object.guid);
}

/** The ships within {@link RIDE_WARM_RANGE} keep their decks (and the ridden one always). */
function keepNear(objects: ReadonlyMap<bigint, WorldObjectState>, position: CarrierPose, riding: bigint | undefined): void {
  nearNext.clear();
  if (riding !== undefined) nearNext.add(riding);
  for (const guid of ships) {
    const pose = objects.get(guid)?.position;
    if (!pose) continue;
    const dx = pose.x - position.x;
    const dy = pose.y - position.y;
    if (dx * dx + dy * dy <= RIDE_WARM_RANGE * RIDE_WARM_RANGE) nearNext.add(guid);
  }
  let changed = nearNext.size !== near.size;
  if (!changed) for (const guid of nearNext) if (!near.has(guid)) {
    changed = true;
    break;
  }
  const previous = near;
  near = nearNext;
  nearNext = previous;
  if (changed) carriers?.retain(near);
}

function releaseFloors(): void {
  for (let index = 0; index < FLOORS.length; index++) FLOOR_POOL.push(FLOORS[index]!);
  FLOORS.length = 0;
}

function pushFloor(z: number | undefined, carrier: bigint | undefined): void {
  const floor = FLOOR_POOL.pop() ?? { z: undefined, carrier: undefined };
  floor.z = z;
  floor.carrier = carrier;
  FLOORS.push(floor);
}
