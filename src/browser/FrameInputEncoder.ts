/**
 * 22.10 ARC-2 S5: the main thread's half of the frame codec (FrameInput.ts) — diffs the live world against what it
 * sent last frame and writes only the difference.
 *
 * Per object and frame it compares the values the renderer reads with the copies it keeps of what it sent: about
 * thirty property reads, no allocation for an object that did not move. Fields are re-read only when their Map's
 * write counter moved (world/FieldsVersion.ts), and then diffed against a shadow copy, so a values block that wrote
 * one word sends one word. The rates likewise (`speeds`, same counter). Splines, seats, rotations go whole, when
 * their objects or values change.
 */

import { fieldsVersion } from "../world/FieldsVersion.js";
import type { WorldObjectState, WorldPosition } from "../world/WorldState.js";
import type { EnvironmentObject } from "./Terrain.js";
import {
  FIELDS_REPLACED, MOTION_STRIDE, sameNumber,
  type AddedObject, type FrameArgs, type FrameInput, type ObjectChange, type ObjectScalars, type RenderWorld,
} from "./FrameInput.js";

/** The equality the encoder diffs with: identity, except that NaN is NaN and 0 is not -0. */
function same(a: unknown, b: unknown): boolean {
  return typeof a === "number" && typeof b === "number" ? sameNumber(a, b) : a === b;
}

/** What was sent for one object incarnation. */
class SentObject {
  /** The frame this record was last met in the live map; `retiredAt` when another object took its guid. */
  seen = 0;
  retiredAt = 0;
  /** The record this one replaced under the same guid, for the order check; cleared after the frame. */
  replaces: SentObject | undefined = undefined;
  born: number;
  fresh = true;
  // Position and flags (the `motion` rows).
  position: WorldPosition | undefined = undefined;
  generation = 0;
  x = 0;
  y = 0;
  z = 0;
  orientation = 0;
  flags = 0;
  // Fields.
  fieldsMap: ReadonlyMap<number, number> | undefined = undefined;
  fieldsVersion = -1;
  readonly shadow = new Map<number, number>();
  // Scalars.
  typeId: number | undefined = undefined;
  runSpeed: number | undefined = undefined;
  turnRate: number | undefined = undefined;
  updateFlags = 0;
  targetGuid: bigint | undefined = undefined;
  pitch: number | undefined = undefined;
  fallJumped: boolean | undefined = undefined;
  vehicleId: number | undefined = undefined;
  vehicleOrientation: number | undefined = undefined;
  transportTime: number | undefined = undefined;
  transportTimeAt: number | undefined = undefined;
  // The seat.
  seat: WorldObjectState["transport"] = undefined;
  seatGuid = 0n;
  seatX = 0;
  seatY = 0;
  seatZ = 0;
  seatOrientation = 0;
  seatIndex = 0;
  // The spline and its latch.
  motion: WorldObjectState["motion"] = undefined;
  track: unknown = undefined;
  latch: WorldObjectState["splineTier"] = undefined;
  latchTier: number | undefined = undefined;
  latchFieldTier: number | undefined = undefined;
  // Rates, rotation, the create block's transport position.
  speeds: WorldObjectState["speeds"] = undefined;
  speedsVersion = -1;
  rotation: WorldObjectState["rotation"] = undefined;
  rotationX = 0;
  rotationY = 0;
  rotationZ = 0;
  rotationW = 0;
  positionTransport: WorldObjectState["positionTransport"] = undefined;

  constructor(readonly slot: number, readonly guid: bigint, readonly object: WorldObjectState, frame: number) {
    this.born = frame;
  }
}

/** A Float64Array that grows; `take` copies what was written into a fresh, transferable array. */
class Float64Writer {
  #buffer = new Float64Array(1024);
  length = 0;

  reserve(count: number): Float64Array {
    if (this.length + count > this.#buffer.length) {
      const grown = new Float64Array(Math.max(this.#buffer.length * 2, this.length + count));
      grown.set(this.#buffer.subarray(0, this.length));
      this.#buffer = grown;
    }
    return this.#buffer;
  }

  take(): Float64Array {
    const out = this.#buffer.slice(0, this.length);
    this.length = 0;
    return out;
  }
}

const NO_ADDED: readonly AddedObject[] = Object.freeze([]);
const NO_CHANGES: readonly ObjectChange[] = Object.freeze([]);

/** `draw`'s value arguments, as the loop or the bench hands them over (FrameArgs without the environment's number). */
export type FrameArgValues = Omit<FrameArgs, "environment">;

export class FrameInputEncoder {
  #frame = 0;
  #nextSlot = 1;
  #world: RenderWorld | undefined;
  readonly #byGuid = new Map<bigint, SentObject>();
  #order: SentObject[] = [];
  #nextOrder: SentObject[] = [];
  readonly #motion = new Float64Writer();
  readonly #fields = new Float64Writer();
  #environment: readonly EnvironmentObject[] | undefined;
  #environmentId = 0;
  #environmentSerial = 0;

  /** The environment list sent last, by the number `FrameArgs.environment` names it with. */
  get environmentList(): readonly EnvironmentObject[] {
    return this.#environment ?? [];
  }

  encode(world: RenderWorld, args: FrameArgValues, environment: readonly EnvironmentObject[]): FrameInput {
    const frame = ++this.#frame;
    const reset = world !== this.#world;
    if (reset) {
      this.#world = world;
      this.#byGuid.clear();
      this.#order.length = 0;
    }
    let added: AddedObject[] | undefined;
    let removed: number[] | undefined;
    let changes: ObjectChange[] | undefined;
    const next = this.#nextOrder;
    next.length = 0;
    for (const [guid, object] of world.objects) {
      let sent = this.#byGuid.get(guid);
      if (sent === undefined || sent.object !== object) {
        const replaced = sent;
        sent = new SentObject(this.#nextSlot++, guid, object, frame);
        if (replaced !== undefined) {
          replaced.retiredAt = frame;
          sent.replaces = replaced;
          (removed ??= []).push(replaced.slot);
        }
        this.#byGuid.set(guid, sent);
        (added ??= []).push({ slot: sent.slot, guid, replaces: replaced?.slot ?? -1 });
      }
      sent.seen = frame;
      next.push(sent);
      const change = this.#diff(sent, object);
      if (change !== undefined) (changes ??= []).push(change);
    }
    // Gone without a successor: dropped from the guid table too.
    const previous = this.#order;
    let pureRemovals = false;
    for (const sent of previous) {
      if (sent.seen === frame || sent.retiredAt === frame) continue;
      (removed ??= []).push(sent.slot);
      pureRemovals = true;
      if (this.#byGuid.get(sent.guid) === sent) this.#byGuid.delete(sent.guid);
    }
    const order = !reset && (added !== undefined || pureRemovals || previous.length !== next.length)
      ? this.#orderIfChanged(previous, next, frame) : !reset ? this.#orderIfMoved(previous, next) : undefined;
    for (const sent of next) sent.replaces = undefined;
    this.#nextOrder = previous;
    this.#order = next;
    if (environment !== this.#environment) {
      this.#environment = environment;
      this.#environmentSerial++;
      this.#environmentId = environment.length === 0 ? 0 : this.#environmentSerial;
    }
    return {
      frame,
      reset,
      selfGuid: world.selfGuid,
      predictedGuid: world.predictedGuid,
      added: added ?? NO_ADDED,
      removed: Int32Array.from(removed ?? []),
      order,
      motion: this.#motion.take(),
      fields: this.#fields.take(),
      changes: changes ?? NO_CHANGES,
      args: { ...args, environment: this.#environmentId },
    };
  }

  /**
   * The whole slot order, unless it is the previous one without the pure removals (a replacement keeps its guid's
   * place, as `Map.set` over a live key does) followed by the new guids in their order.
   */
  #orderIfChanged(previous: readonly SentObject[], next: readonly SentObject[], frame: number): Int32Array | undefined {
    let at = 0;
    let appended = false;
    for (const sent of next) {
      const anchor = sent.replaces ?? (sent.born === frame ? undefined : sent);
      if (anchor === undefined) {
        appended = true;
        continue;
      }
      if (appended) return slotsOf(next);
      while (at < previous.length && previous[at] !== anchor
        && previous[at]!.seen !== frame && previous[at]!.retiredAt !== frame) at++;
      if (previous[at] !== anchor) return slotsOf(next);
      at++;
    }
    return undefined;
  }

  /** Same members as last frame: the order is resent only if somebody re-inserted a key (delete, then set). */
  #orderIfMoved(previous: readonly SentObject[], next: readonly SentObject[]): Int32Array | undefined {
    for (let index = 0; index < next.length; index++) if (previous[index] !== next[index]) return slotsOf(next);
    return undefined;
  }

  /** Writes this object's moved numbers and fields, and returns its change record if a rare part moved. */
  #diff(sent: SentObject, object: WorldObjectState): ObjectChange | undefined {
    const fresh = sent.fresh;
    sent.fresh = false;
    // Position and movement flags.
    const position = object.position;
    if (position !== sent.position) {
      sent.position = position;
      sent.generation = position === undefined ? 0 : sent.generation + 1;
      this.#writeMotion(sent, position, object.movementFlags);
    } else if (fresh || object.movementFlags !== sent.flags || (position !== undefined
      && (!sameNumber(position.x, sent.x) || !sameNumber(position.y, sent.y) || !sameNumber(position.z, sent.z)
        || !sameNumber(position.orientation, sent.orientation)))) {
      this.#writeMotion(sent, position, object.movementFlags);
    }
    // Fields: re-read only when their counter moved.
    const fields = object.fields;
    if (fields !== sent.fieldsMap || fieldsVersion(fields) !== sent.fieldsVersion) this.#writeFields(sent, fields);
    let change: ObjectChange | undefined;
    if (fresh || !same(object.typeId, sent.typeId) || !same(object.runSpeed, sent.runSpeed)
      || !same(object.turnRate, sent.turnRate) || object.updateFlags !== sent.updateFlags
      || object.targetGuid !== sent.targetGuid || !same(object.pitch, sent.pitch) || object.fallJumped !== sent.fallJumped
      || !same(object.vehicleId, sent.vehicleId) || !same(object.vehicleOrientation, sent.vehicleOrientation)
      || !same(object.transportTime, sent.transportTime) || !same(object.transportTimeAt, sent.transportTimeAt)) {
      (change ??= { slot: sent.slot }).scalars = this.#scalars(sent, object);
    }
    const seat = object.transport;
    if (seat !== sent.seat || (seat !== undefined && (seat.guid !== sent.seatGuid || !sameNumber(seat.x, sent.seatX)
      || !sameNumber(seat.y, sent.seatY) || !sameNumber(seat.z, sent.seatZ)
      || !sameNumber(seat.orientation, sent.seatOrientation) || !sameNumber(seat.seat, sent.seatIndex)))) {
      const freshSeat = seat !== sent.seat;
      sent.seat = seat;
      if (seat !== undefined) {
        sent.seatGuid = seat.guid;
        sent.seatX = seat.x;
        sent.seatY = seat.y;
        sent.seatZ = seat.z;
        sent.seatOrientation = seat.orientation;
        sent.seatIndex = seat.seat;
      }
      (change ??= { slot: sent.slot }).transport = seat === undefined ? undefined : {
        fresh: freshSeat, guid: seat.guid, x: seat.x, y: seat.y, z: seat.z, orientation: seat.orientation, seat: seat.seat,
      };
    }
    const motion = object.motion;
    const latch = object.splineTier;
    if (motion !== sent.motion || motion?.track !== sent.track || latch !== sent.latch
      || (latch !== undefined && (!same(latch.tier, sent.latchTier) || !same(latch.fieldTier, sent.latchFieldTier)))) {
      const latchOnly = motion === sent.motion && motion?.track === sent.track;
      sent.motion = motion;
      sent.track = motion?.track;
      sent.latch = latch;
      sent.latchTier = latch?.tier;
      sent.latchFieldTier = latch?.fieldTier;
      const latchChange = latch === undefined ? undefined
        : { tier: latch.tier, fieldTier: latch.fieldTier, linked: motion !== undefined && latch.track === motion.track };
      (change ??= { slot: sent.slot }).spline = latchOnly ? { latch: latchChange } : { motion, latch: latchChange };
    }
    const speeds = object.speeds;
    if (speeds !== sent.speeds || (speeds !== undefined && fieldsVersion(speeds) !== sent.speedsVersion)) {
      const freshRates = speeds !== sent.speeds;
      sent.speeds = speeds;
      sent.speedsVersion = speeds === undefined ? -1 : fieldsVersion(speeds);
      (change ??= { slot: sent.slot }).speeds = speeds === undefined ? undefined
        : { fresh: freshRates, entries: [...speeds] };
    }
    const rotation = object.rotation;
    if (rotation !== sent.rotation || (rotation !== undefined && (!sameNumber(rotation.x, sent.rotationX)
      || !sameNumber(rotation.y, sent.rotationY) || !sameNumber(rotation.z, sent.rotationZ)
      || !sameNumber(rotation.w, sent.rotationW)))) {
      const freshRotation = rotation !== sent.rotation;
      sent.rotation = rotation;
      if (rotation !== undefined) {
        sent.rotationX = rotation.x;
        sent.rotationY = rotation.y;
        sent.rotationZ = rotation.z;
        sent.rotationW = rotation.w;
      }
      (change ??= { slot: sent.slot }).rotation = rotation === undefined ? undefined
        : { fresh: freshRotation, x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w };
    }
    const positionTransport = object.positionTransport;
    if (positionTransport !== sent.positionTransport) {
      sent.positionTransport = positionTransport;
      (change ??= { slot: sent.slot }).positionTransport = positionTransport;
    }
    return change;
  }

  #writeMotion(sent: SentObject, position: WorldPosition | undefined, flags: number): void {
    const writer = this.#motion;
    const out = writer.reserve(MOTION_STRIDE);
    const at = writer.length;
    out[at] = sent.slot;
    out[at + 1] = sent.generation;
    if (position !== undefined) {
      out[at + 2] = sent.x = position.x;
      out[at + 3] = sent.y = position.y;
      out[at + 4] = sent.z = position.z;
      out[at + 5] = sent.orientation = position.orientation;
    } else {
      out[at + 2] = out[at + 3] = out[at + 4] = out[at + 5] = 0;
    }
    out[at + 6] = sent.flags = flags;
    writer.length = at + MOTION_STRIDE;
  }

  #writeFields(sent: SentObject, fields: ReadonlyMap<number, number>): void {
    const writer = this.#fields;
    const shadow = sent.shadow;
    const replaced = fields !== sent.fieldsMap;
    sent.fieldsMap = fields;
    sent.fieldsVersion = fieldsVersion(fields);
    if (replaced) shadow.clear();
    // Header now, counts once known; at most every key set plus every shadow key deleted.
    let out = writer.reserve(3 + fields.size * 2 + shadow.size);
    const head = writer.length;
    let at = head + 3;
    let sets = 0;
    for (const [key, value] of fields) {
      const old = shadow.get(key);
      if (old !== undefined && sameNumber(old, value)) continue;
      shadow.set(key, value);
      out[at++] = key;
      out[at++] = value;
      sets++;
    }
    let deletes = 0;
    if (shadow.size !== fields.size) {
      for (const key of shadow.keys()) {
        if (fields.has(key)) continue;
        shadow.delete(key);
        out[at++] = key;
        deletes++;
      }
    }
    if (sets === 0 && deletes === 0 && !replaced) return;
    out = writer.reserve(0);
    out[head] = sent.slot;
    out[head + 1] = sets;
    out[head + 2] = replaced ? FIELDS_REPLACED : deletes;
    writer.length = at;
  }

  #scalars(sent: SentObject, object: WorldObjectState): ObjectScalars {
    sent.typeId = object.typeId;
    sent.runSpeed = object.runSpeed;
    sent.turnRate = object.turnRate;
    sent.updateFlags = object.updateFlags;
    sent.targetGuid = object.targetGuid;
    sent.pitch = object.pitch;
    sent.fallJumped = object.fallJumped;
    sent.vehicleId = object.vehicleId;
    sent.vehicleOrientation = object.vehicleOrientation;
    sent.transportTime = object.transportTime;
    sent.transportTimeAt = object.transportTimeAt;
    return {
      typeId: object.typeId, runSpeed: object.runSpeed, turnRate: object.turnRate, updateFlags: object.updateFlags,
      targetGuid: object.targetGuid, pitch: object.pitch, fallJumped: object.fallJumped, vehicleId: object.vehicleId,
      vehicleOrientation: object.vehicleOrientation, transportTime: object.transportTime,
      transportTimeAt: object.transportTimeAt,
    };
  }
}

function slotsOf(order: readonly SentObject[]): Int32Array {
  const slots = new Int32Array(order.length);
  for (let index = 0; index < order.length; index++) slots[index] = order[index]!.slot;
  return slots;
}
