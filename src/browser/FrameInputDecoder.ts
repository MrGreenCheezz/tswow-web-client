/**
 * 22.10 ARC-2 S5: the renderer's half of the frame codec (FrameInput.ts) — applies each frame's difference to a mirror
 * world the renderer draws from exactly as from the main thread's `WorldState`.
 *
 * Mirror objects are stable: one per object incarnation, kept across frames and replaced only when the main thread
 * replaced its object (a CREATE over a live guid), because the renderer's caches key on object identity — the corpse
 * views (CorpseModel.ts), the armed models (NpcWeapons.ts), the lift clocks (LiftClock.ts), the seat records
 * (VehiclePassengerOverlay.ts). Inner objects follow the main thread's identities the same way: a position, a seat, a
 * rate Map or a rotation that was mutated there is mutated here, one that was replaced is replaced here. The objects
 * Map keeps the main thread's iteration order, which the admission passes depend on.
 */

import { bumpFieldsVersion } from "../world/FieldsVersion.js";
import { toRenderTime } from "./RenderClock.js";
import type { SplineTrack } from "../world/SplineModel.js";
import type { SplineSpeedName } from "../world/SplineStateProtocol.js";
import type { WorldObjectState } from "../world/WorldState.js";
import {
  FIELDS_REPLACED, MOTION_FLAGS, MOTION_GENERATION, MOTION_ORIENTATION, MOTION_SLOT, MOTION_STRIDE, MOTION_X, MOTION_Y,
  MOTION_Z,
  type FrameArgs, type FrameInput, type ObjectChange, type RenderWorld,
} from "./FrameInput.js";

/**
 * The track a latch holds when it is not the current spline's: `splineAnimationTier` only compares it with
 * `motion.track` by identity, and a mirror track is never this object.
 */
const UNLINKED_TRACK = Object.freeze({}) as unknown as SplineTrack;

interface MirrorRecord {
  readonly object: WorldObjectState;
  generation: number;
}

/** A world-state-shaped mirror (`RenderWorld`): what `WorldRenderer3D.draw` reads, and nothing else. */
export class MirrorWorld implements RenderWorld {
  readonly objects = new Map<bigint, WorldObjectState>();
  selfGuid: bigint | undefined = undefined;
  predictedGuid: bigint | undefined = undefined;
}

export class FrameInputDecoder {
  readonly world = new MirrorWorld();
  readonly #slots = new Map<number, MirrorRecord>();
  #args: FrameArgs | undefined;

  /** The last frame's value arguments. */
  get args(): FrameArgs | undefined {
    return this.#args;
  }

  apply(input: FrameInput): MirrorWorld {
    const world = this.world;
    const objects = world.objects;
    const slots = this.#slots;
    if (input.reset) {
      objects.clear();
      slots.clear();
    }
    world.selfGuid = input.selfGuid;
    world.predictedGuid = input.predictedGuid;
    // Membership. A replacement keeps its guid's place in the Map (`set` over a live key), as on the main thread.
    const added = input.added;
    let replaced: Set<number> | undefined;
    for (const entry of added) if (entry.replaces >= 0) (replaced ??= new Set()).add(entry.replaces);
    for (const slot of input.removed) {
      const record = slots.get(slot);
      if (record === undefined) continue;
      slots.delete(slot);
      const guid = record.object.guid;
      if (replaced?.has(slot) !== true && objects.get(guid) === record.object) objects.delete(guid);
    }
    for (const entry of added) {
      const object = mirrorObject(entry.guid);
      slots.set(entry.slot, { object, generation: 0 });
      if (input.order === undefined) objects.set(entry.guid, object);
    }
    if (input.order !== undefined) {
      objects.clear();
      for (const slot of input.order) {
        const object = slots.get(slot)?.object;
        if (object !== undefined) objects.set(object.guid, object);
      }
    }
    this.#applyMotion(input.motion);
    this.#applyFields(input.fields);
    for (const change of input.changes) this.#applyChange(change);
    this.#args = input.args;
    return world;
  }

  #applyMotion(rows: Float64Array): void {
    const slots = this.#slots;
    for (let at = 0; at < rows.length; at += MOTION_STRIDE) {
      const record = slots.get(rows[at + MOTION_SLOT]!);
      if (record === undefined) continue;
      const object = record.object;
      const generation = rows[at + MOTION_GENERATION]!;
      object.movementFlags = rows[at + MOTION_FLAGS]!;
      if (generation === 0) {
        object.position = undefined;
        record.generation = 0;
        continue;
      }
      const x = rows[at + MOTION_X]!;
      const y = rows[at + MOTION_Y]!;
      const z = rows[at + MOTION_Z]!;
      const orientation = rows[at + MOTION_ORIENTATION]!;
      const position = object.position;
      if (generation !== record.generation || position === undefined) {
        record.generation = generation;
        object.position = { x, y, z, orientation };
      } else {
        position.x = x;
        position.y = y;
        position.z = z;
        position.orientation = orientation;
      }
    }
  }

  #applyFields(packed: Float64Array): void {
    const slots = this.#slots;
    let at = 0;
    while (at < packed.length) {
      const record = slots.get(packed[at]!);
      const sets = packed[at + 1]!;
      const deletes = packed[at + 2]!;
      at += 3;
      const fields = record?.object.fields;
      if (fields !== undefined && deletes === FIELDS_REPLACED) fields.clear();
      for (let index = 0; index < sets; index++, at += 2) fields?.set(packed[at]!, packed[at + 1]!);
      if (deletes > 0) for (let index = 0; index < deletes; index++, at++) fields?.delete(packed[at]!);
      if (fields !== undefined) bumpFieldsVersion(fields);
    }
  }

  #applyChange(change: ObjectChange): void {
    const record = this.#slots.get(change.slot);
    if (record === undefined) return;
    const object = record.object;
    const scalars = change.scalars;
    if (scalars !== undefined) {
      object.typeId = scalars.typeId;
      object.runSpeed = scalars.runSpeed;
      object.turnRate = scalars.turnRate;
      object.updateFlags = scalars.updateFlags;
      object.targetGuid = scalars.targetGuid;
      object.pitch = scalars.pitch;
      object.fallJumped = scalars.fallJumped;
      object.vehicleId = scalars.vehicleId;
      object.vehicleOrientation = scalars.vehicleOrientation;
      object.transportTime = scalars.transportTime;
      // Main-clock moments onto the renderer's (RenderClock.ts; the identity in the page).
      object.transportTimeAt = scalars.transportTimeAt === undefined ? undefined : toRenderTime(scalars.transportTimeAt);
    }
    if ("transport" in change) {
      const seat = change.transport;
      if (seat === undefined) object.transport = undefined;
      else if (seat.fresh || object.transport === undefined) {
        object.transport = { guid: seat.guid, x: seat.x, y: seat.y, z: seat.z, orientation: seat.orientation, seat: seat.seat };
      } else {
        const own = object.transport;
        own.guid = seat.guid;
        own.x = seat.x;
        own.y = seat.y;
        own.z = seat.z;
        own.orientation = seat.orientation;
        own.seat = seat.seat;
      }
    }
    const spline = change.spline;
    if (spline !== undefined) {
      if ("motion" in spline) {
        const motion = spline.motion;
        // The renderer's own copy (the post made it): its start onto the renderer's clock, as above.
        if (motion !== undefined) motion.startedAt = toRenderTime(motion.startedAt);
        object.motion = motion;
      }
      const latch = spline.latch;
      const track = object.motion?.track;
      object.splineTier = latch === undefined ? undefined : {
        tier: latch.tier,
        fieldTier: latch.fieldTier,
        track: latch.linked && track !== undefined ? track : UNLINKED_TRACK,
      };
    }
    if ("speeds" in change) {
      const rates = change.speeds;
      if (rates === undefined) object.speeds = undefined;
      else {
        const own = rates.fresh || object.speeds === undefined ? (object.speeds = new Map()) : object.speeds;
        own.clear();
        for (const [name, value] of rates.entries) own.set(name as SplineSpeedName, value);
        bumpFieldsVersion(own);
      }
    }
    if ("rotation" in change) {
      const rotation = change.rotation;
      if (rotation === undefined) object.rotation = undefined;
      else if (rotation.fresh || object.rotation === undefined) {
        object.rotation = { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
      } else {
        object.rotation.x = rotation.x;
        object.rotation.y = rotation.y;
        object.rotation.z = rotation.z;
        object.rotation.w = rotation.w;
      }
    }
    if ("positionTransport" in change) object.positionTransport = change.positionTransport;
  }
}

/** A new mirror object, with every property a `WorldState` object starts with, so the renderer's loops stay monomorphic. */
function mirrorObject(guid: bigint): WorldObjectState {
  return {
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
    vehicleOrientation: undefined,
  };
}
