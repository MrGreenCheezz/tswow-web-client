import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { normalizeOrientation } from "../../world/TransportMath.js";
import type { WorldObjectState, WorldPosition } from "../../world/WorldState.js";
import type { CollisionWorld } from "./Collision.js";
import {
  FLOOR_SEARCH_DEPTH, STEP_HEIGHT, stepCharacter,
  type CharacterInput, type CharacterMotion, type MovementMode, type PhysicsEvent, type TerrainProbe,
} from "./Physics.js";
import type { CarrierPose } from "./TransportCollision.js";

/**
 * 11.01 slice A3: standing on a ship's deck and sailing with it. Pure: no DOM, no packets, no page
 * state — `input/MovementRide.ts` keeps the ride between frames and `input/Movement.ts` sends.
 *
 * A rider's truth is its offset in the carrier's frame (the core keeps exactly that, in
 * `m_movementInfo.transport.pos`, and relocates every passenger from it on each transport update,
 * `Transport::UpdatePassengerPositions`, Transport.cpp:693-747). So a frame on a deck is: the step
 * in the carrier's frame against the carrier's own collision (`TransportCollision`, slice A2, whose
 * mesh is `scale · v` — the passenger frame of `TransportMath`), then `world = pose ∘ local`. The
 * terrain and the static world are not asked during the step; they are asked once a frame, to tell
 * whether the deck is still what the feet stand over (`rideVerdict`).
 *
 * Boarding needs no opcode: any movement packet with `MOVEMENTFLAG_ONTRANSPORT` and the guid of a
 * transport on the map makes the core add the passenger, one without the flag removes it
 * (`HandleMovementOpcodes`, MovementHandler.cpp:306-351). `CMSG_MOVE_CHNG_TRANSPORT` goes through
 * the same handler with no special case (Opcodes.cpp:1040), so it is not needed for that.
 */

/** wowee's rule (spec 11.01, mechanism 5): this many frames in a row without the deck under the feet end the ride. */
export const RIDE_LEAVE_FRAMES = 20;
/** And any axis of the offset beyond this ends it at once (wowee's ship box is 65 × 30). */
export const RIDE_MAX_OFFSET = 65;
/**
 * The core's own limit: a packet whose offset exceeds it on any axis is dropped without a word
 * (MovementHandler.cpp:313-315). Stays above {@link RIDE_MAX_OFFSET}, so a ride ends before it.
 */
export const TRANSPORT_OFFSET_LIMIT = 75;
/**
 * A ship has no seats: the core keeps −1 (`TransportInfo::Reset`, MovementInfo.h:40, `int8 seat`)
 * and reads the byte back as `int8` (WorldSession.cpp:976); the wire byte is 0xFF.
 */
export const SHIP_SEAT = 0xff;
/** `GAMEOBJECT_TYPE_MO_TRANSPORT` (SharedDefines.h): ships and zeppelins. Lifts (11) are slice B. */
export const RIDE_CARRIER_GO_TYPE = 15;
const TYPEID_GAMEOBJECT = 5;
const GAMEOBJECT_BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;

/** A game object the character can ride as a passenger: a ship or a zeppelin (byte 1 of `GAMEOBJECT_BYTES_1` is the type). */
export function isRideCarrier(object: WorldObjectState | undefined): boolean {
  return object !== undefined && object.typeId === TYPEID_GAMEOBJECT
    && (((object.fields.get(GAMEOBJECT_BYTES_1) ?? 0) >>> 8) & 0xff) === RIDE_CARRIER_GO_TYPE;
}

/** The ride between frames. The offset itself lives in the character's `WorldObjectState.transport`. */
export interface RideState {
  readonly guid: bigint;
  /** Frames in a row the deck has not been what the feet stand over. */
  offDeckFrames: number;
  /** The carrier's pose last frame, to tell a sailing carrier from a moored one. */
  lastX: number;
  lastY: number;
  lastZ: number;
  lastOrientation: number;
  /** The carrier moved since the frame before: the character is going somewhere without a key. */
  carrierMoving: boolean;
  /**
   * Milliseconds in a row the carrier's collision has been "not yet" (review A3): a gateway without
   * `/vmap/gobject-models` never answers, and a ride over no deck must not outlast the physics' own
   * wait for ground (`LOAD_WAIT_MAX`).
   */
  deckWaitMs: number;
}

export function newRideState(guid: bigint, pose: CarrierPose): RideState {
  return {
    guid, offDeckFrames: 0,
    lastX: pose.x, lastY: pose.y, lastZ: pose.z, lastOrientation: pose.orientation, carrierMoving: false, deckWaitMs: 0,
  };
}

/** Records this frame's carrier pose; true when it moved since the last one. */
export function noteCarrierPose(ride: RideState, pose: CarrierPose): boolean {
  ride.carrierMoving = pose.x !== ride.lastX || pose.y !== ride.lastY || pose.z !== ride.lastZ
    || pose.orientation !== ride.lastOrientation;
  ride.lastX = pose.x;
  ride.lastY = pose.y;
  ride.lastZ = pose.z;
  ride.lastOrientation = pose.orientation;
  return ride.carrierMoving;
}

/** One candidate floor under the feet: world height, and the carrier it belongs to (undefined: the world's). */
export interface RideFloor {
  z: number | undefined;
  carrier: bigint | undefined;
}

/**
 * Which carrier, if any, the character boards: the one whose deck is the highest floor under the
 * feet within a step over them — the floor the physics would put them on. `reach` is how far
 * below the feet a deck still counts (a step down on the ground; a frame's fall in the air), so a
 * deck far underneath is not boarded until the feet get to it. The world wins a tie: a deck flush
 * with a pier is still the pier.
 */
export function boardingDecision(feetZ: number, floors: readonly RideFloor[], reach: number): bigint | undefined {
  let bestZ = Number.NEGATIVE_INFINITY;
  let best: bigint | undefined;
  let found = false;
  for (let index = 0; index < floors.length; index++) {
    const floor = floors[index]!;
    const z = floor.z;
    if (z === undefined || z > feetZ + STEP_HEIGHT) continue;
    if (!found || z > bestZ || (z === bestZ && floor.carrier === undefined)) {
      bestZ = z;
      best = floor.carrier;
      found = true;
    }
  }
  if (best === undefined || feetZ - bestZ > reach) return undefined;
  return best;
}

/** Every axis of the offset within {@link RIDE_MAX_OFFSET}. */
export function withinRideBounds(local: { x: number; y: number; z: number }): boolean {
  return Math.abs(local.x) <= RIDE_MAX_OFFSET && Math.abs(local.y) <= RIDE_MAX_OFFSET && Math.abs(local.z) <= RIDE_MAX_OFFSET;
}

/** What the end of a frame on a deck knows about the feet. */
export interface RideFooting {
  /** The deck under the feet, in the carrier's frame; undefined when none. */
  deckZ: number | undefined;
  /** False while the carrier's collision is still loading: no deck is not evidence then. */
  deckKnown: boolean;
  /** The world's own floor under the feet (terrain, static collision), world height. */
  worldFloorZ: number | undefined;
  /** The carrier's height this frame. */
  poseZ: number;
  mode: MovementMode;
  /** In the air with flight or levitation: the character steers its own altitude. */
  flying: boolean;
}

/**
 * Whether the ride ends this frame (updates `offDeckFrames`).
 *
 * Ends at once: in water, flying, beyond {@link RIDE_MAX_OFFSET} on any axis, or with the world's
 * own floor the support under the feet (higher than the deck and within a step of them) — a pier.
 * Ends after {@link RIDE_LEAVE_FRAMES} frames in a row in which the deck is not the highest floor
 * under the feet: walked or fallen over the rail. A jump above the deck does not count — the deck
 * is still what is underneath.
 */
export function rideVerdict(ride: RideState, local: { x: number; y: number; z: number }, footing: RideFooting): boolean {
  if (footing.mode === "swim" || (footing.mode === "air" && footing.flying)) return true;
  if (!withinRideBounds(local)) return true;
  const feetZ = local.z + footing.poseZ;
  const deckZ = footing.deckZ === undefined ? undefined : footing.deckZ + footing.poseZ;
  // A world floor over the head is not under the feet (a hull under a pier's planks).
  const worldZ = footing.worldFloorZ !== undefined && footing.worldFloorZ <= feetZ + STEP_HEIGHT ? footing.worldFloorZ : undefined;
  const worldUnder = worldZ !== undefined && (deckZ === undefined || worldZ > deckZ);
  // Stood on, or about to be: the support is the world's (a pier, a dock).
  if (worldUnder && feetZ - worldZ! <= STEP_HEIGHT) return true;
  if (deckZ !== undefined && !worldUnder) ride.offDeckFrames = 0;
  // A deck still loading is no evidence either way.
  else if (footing.deckKnown) ride.offDeckFrames++;
  return ride.offDeckFrames >= RIDE_LEAVE_FRAMES;
}

/** `world = pose ∘ local`, orientation included (`TransportMath.composePassengerPosition`, in place). */
export function composeRide(pose: CarrierPose, local: WorldPosition, out: WorldPosition): WorldPosition {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const x = pose.x + local.x * cos - local.y * sin;
  const y = pose.y + local.x * sin + local.y * cos;
  out.x = x;
  out.y = y;
  out.z = pose.z + local.z;
  out.orientation = normalizeOrientation(pose.orientation + local.orientation);
  return out;
}

/** `local = pose⁻¹ ∘ world` (`TransportMath.passengerOffset`, in place). */
export function rideLocalFrom(pose: CarrierPose, world: WorldPosition, out: WorldPosition): WorldPosition {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const dx = world.x - pose.x;
  const dy = world.y - pose.y;
  out.x = dx * cos + dy * sin;
  out.y = dy * cos - dx * sin;
  out.z = world.z - pose.z;
  out.orientation = normalizeOrientation(world.orientation - pose.orientation);
  return out;
}

/**
 * The floor of the world itself under a point — terrain unless the chunk is a hole, and the static
 * collision — as `Physics.solidFloor` reads it, searched down from a step over the feet.
 */
export function worldFloorUnder(probe: TerrainProbe, x: number, y: number, z: number): number | undefined {
  let floor = probe.hole(x, y) ? undefined : probe.ground(x, y);
  const solid = probe.floor?.(x, y, z + STEP_HEIGHT, z - FLOOR_SEARCH_DEPTH);
  if (solid !== undefined && (floor === undefined || solid > floor)) floor = solid;
  return floor;
}

/** The deck under a point of the carrier's frame, searched down from a step over the feet. */
export function deckFloorUnder(deck: CollisionWorld, x: number, y: number, z: number): number | undefined {
  return deck.floorUnder(x, y, z + STEP_HEIGHT, z - FLOOR_SEARCH_DEPTH);
}

/**
 * The world as the step sees it on a deck: the carrier's collision in its own frame and nothing
 * else. No terrain, no water: over the rail there is nothing, and the frames that follow end the
 * ride before the world is needed. While the carrier's mesh is loading (`deck` undefined) the
 * physics waits rather than falls, as it waits for a tile (`loaded`). One instance, re-pointed
 * each frame, so a frame allocates nothing.
 */
export class CarrierProbe implements TerrainProbe {
  deck: CollisionWorld | undefined = undefined;

  ground(): number | undefined {
    return undefined;
  }

  liquid(): undefined {
    return undefined;
  }

  /** A loaded carrier has nothing under the feet but its own mesh: off it is a fall, not a wait. */
  hole(): boolean {
    return this.deck !== undefined;
  }

  loaded(): boolean {
    return this.deck !== undefined;
  }

  floor(x: number, y: number, fromZ: number, minZ: number): number | undefined {
    return this.deck?.floorUnder(x, y, fromZ, minZ);
  }

  pushOut(x: number, y: number, z: number, radius: number, bodyHeight: number): { x: number; y: number } {
    const deck = this.deck;
    if (deck === undefined) {
      PUSH.x = x;
      PUSH.y = y;
      return PUSH;
    }
    return deck.pushOut(x, y, z, radius, bodyHeight, STEP_HEIGHT);
  }

  ceiling(x: number, y: number, fromZ: number, toZ: number): number | undefined {
    return this.deck?.ceilingAbove(x, y, fromZ, toZ);
  }
}

const PUSH = { x: 0, y: 0 };

/**
 * One physics substep on a deck: `stepCharacter` over the carrier's frame, then the world position
 * composed from this frame's pose. `local.orientation` is the facing relative to the carrier, so
 * walking forward goes where the character faces on the deck.
 */
export function stepRide(
  pose: CarrierPose, local: WorldPosition, motion: CharacterMotion, input: CharacterInput,
  probe: TerrainProbe, elapsed: number, world: WorldPosition, events: PhysicsEvent[],
): PhysicsEvent[] {
  stepCharacter(local, motion, input, probe, elapsed, events);
  composeRide(pose, local, world);
  return events;
}
