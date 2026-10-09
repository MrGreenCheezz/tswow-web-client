import type { CollisionModel } from "../../world/CollisionFormat.js";
import { gameObject, worldObject } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import {
  CollisionMesh, CollisionWorld, transformCollisionMesh, type CollisionPlacement, type Vector3,
} from "./Collision.js";

/**
 * 11.01 slice A2: a carrier's own collision — a ship's deck, a zeppelin's gondola, a lift's floor —
 * held in the carrier's frame rather than the world's.
 *
 * The core places a game object's model as `world = iPos + iScale · Rz(orientation) · v`
 * (`GameObjectModel::initialize`/`UpdatePosition`, GameObjectModel.cpp:124-137, 266-276; queries go
 * the other way, `iInvRot · (p − iPos) · iInvScale`, :174-175). That is the passenger frame of
 * `TransportMath.composePassengerPosition` exactly (`pos + Rz(o) · offset`), so a mesh of `scale · v`
 * is the deck in passenger offsets: a character's transport offset is asked against it directly and
 * the answer does not depend on where the ship is or which way it faces. One `CollisionWorld` per
 * carrier, built once per model and scale, never moved.
 *
 * The trap: static buildings come through `transformCollisionMesh`, which undoes vmap's internal
 * mirror (`placement − scale · R · v`). A game object has no such mirror. A yaw of 180° turns the
 * mirror's `−x, −y` back into `+x, +y`, so `gameObjectLocalPlacement` hands that function the one
 * placement that yields `scale · v` (pinned by tests/transport-collision.test.mjs against the
 * `.dtree` boxes, which are asymmetric along the keel and would come out reversed if mirrored).
 */

/** The placement under which `transformCollisionMesh` yields `scale · v`: the carrier's local frame. */
export function gameObjectLocalPlacement(scale: number): CollisionPlacement {
  return { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 180, rotationZ: 0, scale: carrierScale(scale) };
}

/** `OBJECT_FIELD_SCALE_X` as a mesh scale: a missing, zero or broken value is the core's default 1. */
export function carrierScale(scale: number): number {
  return scale > 0 && Number.isFinite(scale) ? scale : 1;
}

/** The pose of a carrier in the world: `WorldObjectState.position` + `orientation` of a transport. */
export interface CarrierPose {
  x: number;
  y: number;
  z: number;
  orientation: number;
}

/** World point → the carrier's frame (`TransportMath.passengerOffset` without the orientation). */
export function toCarrierLocal(pose: CarrierPose, x: number, y: number, z: number, out: Vector3): Vector3 {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  const dx = x - pose.x;
  const dy = y - pose.y;
  out.x = dx * cos + dy * sin;
  out.y = dy * cos - dx * sin;
  out.z = z - pose.z;
  return out;
}

/** The carrier's frame → world (`TransportMath.composePassengerPosition` without the orientation). */
export function toCarrierWorld(pose: CarrierPose, x: number, y: number, z: number, out: Vector3): Vector3 {
  const cos = Math.cos(pose.orientation);
  const sin = Math.sin(pose.orientation);
  out.x = pose.x + x * cos - y * sin;
  out.y = pose.y + x * sin + y * cos;
  out.z = pose.z + z;
  return out;
}

/** The model source: `GameObjectCollisionModels` in the page, a fake in tests. */
export interface CarrierModelSource {
  model(displayId: number): CollisionModel | null | undefined;
  requestGroups(displayId: number, groups: readonly number[]): void;
  readonly revision: number;
}

interface CarrierRecord {
  displayId: number;
  scale: number;
  readonly world: CollisionWorld;
  /** The model the built groups came from; a new object (another answer) rebuilds from scratch. */
  model: CollisionModel | undefined;
  /** Source revision this record last looked at; unchanged means nothing new can be built. */
  seen: number;
  complete: boolean;
}

/** The instance every mesh of a carrier reports; one carrier per world, so any constant serves. */
const CARRIER_INSTANCE = 1;

export class TransportCollision {
  readonly #models: CarrierModelSource;
  readonly #carriers = new Map<bigint, CarrierRecord>();

  constructor(models: CarrierModelSource) {
    this.#models = models;
  }

  get size(): number {
    return this.#carriers.size;
  }

  /**
   * The carrier's collision in its own frame. `null`: the core gives this display id none (and the
   * deck is not solid there either); undefined: still loading; otherwise a world that may still be
   * missing groups (`isComplete`). Cheap to call every frame: nothing is rebuilt unless the source
   * moved on, the display id changed or `OBJECT_FIELD_SCALE_X` did.
   */
  carrier(guid: bigint, displayId: number, scale: number): CollisionWorld | null | undefined {
    // Per frame for the carrier under the feet: nothing below allocates unless something changed.
    const wantedScale = carrierScale(scale);
    let record = this.#carriers.get(guid);
    if (record && (record.displayId !== displayId || record.scale !== wantedScale)) {
      this.#carriers.delete(guid);
      record = undefined;
    }
    const revision = this.#models.revision;
    if (record && record.seen === revision) return record.complete || record.world.size > 0 ? record.world : undefined;
    const model = this.#models.model(displayId);
    if (model === null) {
      this.#carriers.delete(guid);
      return null;
    }
    if (!record) {
      record = { displayId, scale: wantedScale, world: new CollisionWorld(), model: undefined, seen: -1, complete: false };
      this.#carriers.set(guid, record);
    }
    record.seen = revision;
    if (!model) return undefined;
    this.#build(record, model);
    return record.complete || record.world.size > 0 ? record.world : undefined;
  }

  /**
   * `carrier` for a game object in view: `GAMEOBJECT_DISPLAYID` and `OBJECT_FIELD_SCALE_X` (the
   * core's `GetScale()`, 1 when the field never came) straight from its fields.
   */
  forObject(object: WorldObjectState): CollisionWorld | null | undefined {
    const displayId = gameObject.displayId(object);
    if (!displayId) return null;
    return this.carrier(object.guid, displayId, worldObject.scale(object) ?? 1);
  }

  /** Whether every group with triangles is standing in the carrier's world. */
  isComplete(guid: bigint): boolean {
    return this.#carriers.get(guid)?.complete ?? false;
  }

  /** The carrier left view or the ride ended: its meshes go (no meshes are kept for far carriers). */
  release(guid: bigint): void {
    this.#carriers.delete(guid);
  }

  /** Keeps only these carriers. */
  retain(guids: ReadonlySet<bigint>): void {
    for (const guid of this.#carriers.keys()) if (!guids.has(guid)) this.#carriers.delete(guid);
  }

  clear(): void {
    this.#carriers.clear();
  }

  #build(record: CarrierRecord, model: CollisionModel): void {
    if (record.model !== model) {
      record.world.clear();
      record.model = model;
      record.complete = false;
    }
    if (record.complete) return;
    const placement = gameObjectLocalPlacement(record.scale);
    let missing: number[] | undefined;
    for (let index = 0; index < model.groups.length; index++) {
      const group = model.groups[index]!;
      if (group.triangleCount === 0 || record.world.has(index)) continue;
      if (!group.vertices || !group.indices) {
        (missing ??= []).push(index);
        continue;
      }
      // One group, one run, as CollisionSource builds them: the flags and authored id travel with it.
      record.world.set(index, new CollisionMesh(transformCollisionMesh(group.vertices, group.indices, placement), [
        { first: 0, flags: group.flags, groupIndex: index, groupId: group.groupId },
      ]), CARRIER_INSTANCE);
    }
    // A model over the gateway's triangle budget arrives as boxes; a carrier is small enough to want
    // all of it. The collision client asks once per group and backs off on failure by itself.
    if (missing) this.#models.requestGroups(record.displayId, missing);
    record.complete = missing === undefined;
  }
}
