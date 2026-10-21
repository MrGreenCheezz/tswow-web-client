/**
 * 22.10 ARC-2 S3a-review: the renderer's side of RenderResults.ts rows, filled incrementally. A row is recomputed
 * only when something it derives from changed; an unchanged world recomputes nothing (bench city: the full
 * per-frame fill cost +0.11 ms). The answers are the ones a full fill gives, because each key holds every input
 * its row's math reads:
 *
 * * a unit row (`unit.height`, and `#bodyHeight` for the shoulder and the helm): the height, the model (whose
 *   attachment table is immutable), the scale, whether the stand-in pill is still on, the saddle, the seat lift;
 * * a game object's box (`#gameObjectPickCorners`): the node's position and scale, the spawn orientation, the
 *   model box, and what `gameObjectWorldRotation` reads of the object — its rotation, its type, its carrier's
 *   facing. Whether it is drawn, clickable and in the overlay's range is still tested every frame by the caller.
 *
 * Keys live on the renderer's own records (`resultKey`, `pickKey`), so a held unit costs a few comparisons and
 * no map lookup.
 */

import type { Quat } from "../world/GameObjectRotation.js";
import type { ModelBox } from "../world/GameObjectModelFrame.js";
import type { WorldObjectState } from "../world/WorldState.js";
import { gameObjectType } from "./GameObjectClickable.js";
import {
  PICK_CORNER_VALUES, PICK_RESULT_SIZE, PICK_RESULT_STAMP, UNIT_RESULT_HEIGHT, UNIT_RESULT_SIZE, UNIT_RESULT_STAMP,
} from "./RenderResults.js";
import type { WvmModel } from "./Wvm.js";

/** What a unit row derives from; the renderer's `RenderedUnit` is one. */
export interface UnitRowSource {
  readonly height: number;
  readonly wvm: WvmModel | undefined;
  readonly scale: number;
  readonly body: object | undefined;
  readonly mount: { readonly seat: number } | undefined;
  readonly node: object;
  resultKey: UnitRowKey | undefined;
}

/** The vehicle poser's seat lifts (VehiclePassengerPose.ts): `liftEpoch` moves whenever any lift does. */
export interface SeatLiftSource {
  readonly liftEpoch: number;
  seatLift(node: object): number;
}

export class UnitRowKey {
  height = Number.NaN;
  wvm: WvmModel | undefined = undefined;
  scale = Number.NaN;
  capsule = false;
  seat = Number.NaN;
  lift = Number.NaN;
  liftEpoch = -1;

  constructor(readonly rows: Map<bigint, Float64Array>, readonly row: Float64Array) {}
}

/** Writes a unit's pivot and eye into `row` for the given seat lift (the renderer's `#bodyHeight`). */
export type UnitRowCompute = (unit: UnitRowSource, lift: number, row: Float64Array) => void;

export class UnitResultRows {
  /** Rows recomputed so far (tests and diagnostics). */
  computed = 0;

  /**
   * One row per unit in `units`, recomputed only where its inputs moved; rows of units no longer held are
   * dropped. `stamp` is written into a row when it is recomputed (the fill that last derived it).
   */
  fill(rows: Map<bigint, Float64Array>, units: ReadonlyMap<bigint, UnitRowSource>, lifts: SeatLiftSource,
    stamp: number, compute: UnitRowCompute): void {
    const epoch = lifts.liftEpoch;
    for (const [guid, unit] of units) {
      let key = unit.resultKey;
      if (key === undefined || key.rows !== rows) {
        const row = new Float64Array(UNIT_RESULT_SIZE);
        rows.set(guid, row);
        key = unit.resultKey = new UnitRowKey(rows, row);
      }
      const capsule = !unit.body;
      const seat = unit.mount?.seat ?? 0;
      let lift = key.lift;
      if (key.liftEpoch !== epoch) {
        lift = lifts.seatLift(unit.node);
        key.liftEpoch = epoch;
      }
      if (key.height === unit.height && key.wvm === unit.wvm && key.scale === unit.scale && key.capsule === capsule
        && key.seat === seat && key.lift === lift) continue;
      key.height = unit.height;
      key.wvm = unit.wvm;
      key.scale = unit.scale;
      key.capsule = capsule;
      key.seat = seat;
      key.lift = lift;
      const row = key.row;
      row[UNIT_RESULT_HEIGHT] = unit.height;
      compute(unit, lift, row);
      row[UNIT_RESULT_STAMP] = stamp;
      this.computed++;
    }
    if (rows.size !== units.size) for (const guid of rows.keys()) if (!units.has(guid)) rows.delete(guid);
  }
}

/** What a game object's box derives from on the renderer's side; `RenderedGameObject` is one. */
export interface PickRowSource {
  readonly node: { readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly scale: { readonly x: number } };
  readonly base: { readonly orientation: number };
  readonly pickBox: ModelBox | null | undefined;
  pickKey: PickRowKey | undefined;
}

export class PickRowKey {
  x = Number.NaN;
  y = Number.NaN;
  z = Number.NaN;
  scale = Number.NaN;
  orientation = Number.NaN;
  box: ModelBox | null | undefined = undefined;
  rotation: Quat | undefined = undefined;
  rx = Number.NaN;
  ry = Number.NaN;
  rz = Number.NaN;
  rw = Number.NaN;
  type = -1;
  carried = false;
  carrierOrientation = Number.NaN;
  /** The fill that last published the row; one fill ago means it is still in the map. */
  published = -1;

  constructor(readonly rows: Map<bigint, Float64Array>, readonly row: Float64Array) {}

  matches(object: WorldObjectState, rendered: PickRowSource): boolean {
    const at = rendered.node.position;
    const rotation = object.rotation;
    const carrier = object.transport;
    return this.x === at.x && this.y === at.y && this.z === at.z && this.scale === rendered.node.scale.x
      && this.orientation === rendered.base.orientation && this.box === rendered.pickBox
      && this.rotation === rotation && (rotation === undefined
        || (this.rx === rotation.x && this.ry === rotation.y && this.rz === rotation.z && this.rw === rotation.w))
      && this.type === gameObjectType(object) && this.carried === (carrier !== undefined)
      && (carrier === undefined || this.carrierOrientation === carrier.orientation);
  }

  note(object: WorldObjectState, rendered: PickRowSource): void {
    const at = rendered.node.position;
    this.x = at.x;
    this.y = at.y;
    this.z = at.z;
    this.scale = rendered.node.scale.x;
    this.orientation = rendered.base.orientation;
    this.box = rendered.pickBox;
    const rotation = object.rotation;
    this.rotation = rotation;
    this.rx = rotation?.x ?? Number.NaN;
    this.ry = rotation?.y ?? Number.NaN;
    this.rz = rotation?.z ?? Number.NaN;
    this.rw = rotation?.w ?? Number.NaN;
    this.type = gameObjectType(object);
    this.carried = object.transport !== undefined;
    this.carrierOrientation = object.transport?.orientation ?? Number.NaN;
  }
}

/** Writes a game object's corners into `out` (the renderer's `#gameObjectPickCorners`); false without a box. */
export type PickRowCompute = (object: WorldObjectState, rendered: PickRowSource, out: Float64Array) => boolean;

export class PickResultRows {
  /** Boxes recomputed so far (tests and diagnostics). */
  computed = 0;
  readonly #corners = new Float64Array(PICK_CORNER_VALUES);

  /**
   * The box of one game object the caller found drawn, clickable and in range, into `rows` at this fill's
   * `stamp`; recomputed only when its inputs moved. False (and no row) without a box. The caller drops rows not
   * stamped by this fill afterwards (`dropStaleRows`).
   */
  publish(rows: Map<bigint, Float64Array>, guid: bigint, object: WorldObjectState, rendered: PickRowSource,
    stamp: number, compute: PickRowCompute): boolean {
    let key = rendered.pickKey;
    if (key === undefined || key.rows !== rows || !key.matches(object, rendered)) {
      this.computed++;
      const corners = this.#corners;
      if (!compute(object, rendered, corners)) return false;
      if (key === undefined || key.rows !== rows) key = rendered.pickKey = new PickRowKey(rows, new Float64Array(PICK_RESULT_SIZE));
      key.row.set(corners);
      key.note(object, rendered);
      // `compute` may have built the box just now; the key holds what the next fill will compare.
      key.published = -1;
    }
    // A row published by the fill before this one is still in the map; anything else is put back.
    if (key.published !== stamp - 1) rows.set(guid, key.row);
    key.published = stamp;
    key.row[PICK_RESULT_STAMP] = stamp;
    return true;
  }
}
