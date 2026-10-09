// 11.02-H: where a vehicle passenger is drawn — the seat's own columns of VehicleSeat.dbc that the
// core never reads (AttachmentID, PassengerYaw/Pitch/Roll, PassengerAttachmentID), applied the way
// Wow.exe 3.3.5a 12340 applies them; the core puts the passenger at the vehicle plus AttachmentOffset
// (Vehicle.cpp:936-945, RelocatePassengers :621-644), the client draws it on the vehicle model's
// point. Ghidra, read-only: .runtime/re-2026-10-03/l1102h/r1-r4.c.
//
// Placement (VehiclePassenger_C, per frame 0x0074a7f0 → 0x007490f0, seated state 3):
// - The seat's AttachmentID 0…21 goes through the table at 0x00a2d3f0 to an M2 attachment id of the
//   vehicle's model (`VEHICLE_SEAT_ATTACHMENT_POINTS`: 13…20 are VehicleSeat1…8 = 39…46, 21 is
//   MountMain 0, 2 is Base 19, 1 Chest 34, 0 Head 20…); anything else is −1, no point.
// - When the vehicle's model is loaded and has that point (0x008273d0), the passenger's model is
//   attached to it (0x00831630) with a local matrix built, in M2 axes, as Rz(f − PassengerYaw), then
//   Rx(PassengerRoll) and Ry(PassengerPitch) pre-multiplied (0x004c3380/0x004c3300/0x004c3340 over the
//   row-vector builders 0x004c3290/0x004c31b0/0x004c3220): a vertex is turned by pitch about Y, then
//   roll about X, then yaw about Z. f is the passenger's drawn facing inside its transport (unit+0xaa0,
//   which 0x00717ec0 composes with the transport's matrix) — the transport block's orientation here.
//   The translation is AttachmentOffset in the point's frame (so it scales with the vehicle), and the
//   rotation part is scaled by the passenger's scale over the point frame's (row 0 length), so the
//   passenger keeps its own size on a scaled vehicle.
// - PassengerAttachmentID (raw M2 id on the passenger's model, 0x00748400 → 0x00827460): when the
//   passenger's model has it, its model-space position, turned and scaled like the model, is taken
//   off the translation — that point of the passenger, not its feet, lands on the seat.
// - The vehicle's model is loaded but has no such point (AttachmentID −1 on 27 seats of this dataset):
//   the vehicle's position plus AttachmentOffset turned by its facing (0x0074937d: the facing turns
//   the vehicle's translation matrix, which then post-multiplies the seat's), with the same seat turn.
//   The vehicle's model not loaded at all: the unit's own place and facing (0x0074a7f0).
// - The "vehicle's model" is CGUnit_C vtable +0xd4 on the vehicle (0x006e6f80, the same slot in both
//   unit vtables 0x00a34d90 and 0x00a326c8): the mount model unit+0x98c when there is one, else the
//   unit's own model unit+0xb4. The mount model is made from the mount display id cached at +0x9c0
//   (0x0073d5d0 → setter 0x00717910), so for a player whose mount carries a vehicle kit (Traveler's
//   Tundra Mammoth 312/313, Mekgineer's Chopper 318) the seats are the mount's VehicleSeat points —
//   and a mounted vehicle whose mount is still downloading has no seat model yet, never the rider's.
//
// The pose a seated passenger holds (the ride animations, HIDE_PASSENGER) is VehicleSeatPose.ts;
// here a HIDE_PASSENGER seat hides the passenger's node while it sits there (Wow.exe 0x00730f30).
// 11.02-tails: each `place` also leaves, per seated passenger, its step from its own place to the
// drawn one and whether its seat hides it (VehiclePassengerOverlay.ts): the plate, the bubbles, the
// click box, the sight test and the selection ring hang from the model as drawn, like Wow.exe's.
//
// Not modelled: the entering and exiting arcs (states 1/2 and 4/5: EnterSpeed/Gravity/ArcHeight,
// the eased progress of 0x00747d70, Enter/Exit animations, ExitAnimEnd on landing — this client sees
// a passenger seated or not), the vehicle's own ride animation (VehicleRideAnimLoop on a bone,
// 0x00756d10), FlagsB 0x10000's mirrored vehicle pose (0x00748620), and the smoothing of the drawn
// facing (0x00735f60).
//
// Without vehicle rows, with no seat, on a ship, a lift or a mount: nothing here runs and the unit is
// drawn exactly as before. Once a frame nothing is allocated: seat poses are cached per seat row,
// matrices are module scratch, and the sets of placed nodes are reused. Review 11.02-H: `place` walks
// the frame's admission entries and reads one property of each; the objects and the units are looked
// up only for a unit on a transport (a frame of 300 units with the tables loaded and no vehicle in
// view measured 9.6 µs of BigInt map lookups in node when it walked the drawn guids instead).

import * as THREE from "three";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { VehicleCatalog, VehicleSeatEntry } from "../world/VehicleDbc.js";
import { isVehicleCarrierGuid } from "../world/VehicleSeatModel.js";
import type { WorldObjectState } from "../world/WorldState.js";
import { M2_TO_SCENE } from "./AnimatedModel.js";
import { vehiclePassengerSeatPose, type VehiclePassengerSeatPose } from "./VehicleSeatPose.js";
import type { WvmAttachment } from "./Wvm.js";
// 11.02-tails: what each frame did with a passenger, for the overlays (plate, bubbles, click box, ring).
import { beginSeatDrawnFrame, seatDrawnRecord } from "./VehiclePassengerOverlay.js";

/** Wow.exe 0x00a2d3f0: VehicleSeat.AttachmentID 0…21 → the M2 attachment id on the vehicle's model. */
export const VEHICLE_SEAT_ATTACHMENT_POINTS: readonly number[] = Object.freeze([
  20, 34, 19, 21, 22, 17, 23, 24, 25, 15, 16, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 0,
]);

/** The M2 attachment id a seat's AttachmentID names, or −1 (0x007490f0/0x007493b0: unsigned `< 0x16`). */
export function vehicleSeatAttachmentPoint(attachmentId: number): number {
  return Number.isInteger(attachmentId) && attachmentId >= 0 && attachmentId < VEHICLE_SEAT_ATTACHMENT_POINTS.length
    ? VEHICLE_SEAT_ATTACHMENT_POINTS[attachmentId]! : -1;
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const M2_FROM_SCENE = M2_TO_SCENE.clone().invert();
const _turn = new THREE.Quaternion();

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * The passenger's turn inside the seat frame, in M2 axes (Z up, +X forward): Rz(f − PassengerYaw)
 * · Rx(PassengerRoll) · Ry(PassengerPitch) — pitch applied first, yaw last (Wow.exe 0x007490f0).
 */
export function passengerSeatRotation(localFacing: number,
  seat: Pick<VehicleSeatEntry, "passengerYaw" | "passengerPitch" | "passengerRoll">,
  out: THREE.Quaternion): THREE.Quaternion {
  out.setFromAxisAngle(AXIS_Z, finite(localFacing) - finite(seat.passengerYaw));
  const roll = finite(seat.passengerRoll);
  if (roll !== 0) out.multiply(_turn.setFromAxisAngle(AXIS_X, roll));
  const pitch = finite(seat.passengerPitch);
  if (pitch !== 0) out.multiply(_turn.setFromAxisAngle(AXIS_Y, pitch));
  return out;
}

const _framePosition = new THREE.Vector3();
const _frameQuaternion = new THREE.Quaternion();
const _frameScale = new THREE.Vector3();
const _seatRotation = new THREE.Quaternion();
const _local = new THREE.Vector3();
const _point = new THREE.Vector3();

/**
 * Where a passenger's node goes when its seat's point is on the vehicle's model.
 *
 * `attachmentWorld` is the point's frame in the scene: the bone's world matrix translated to the
 * point, M2 axes inside (the vehicle root's quarter turn is in it). The node's model carries the
 * same quarter turn under it, so the node's own rotation is the frame's, the seat's turn, and that
 * turn taken back out. The node's scale is left alone: it is the passenger's.
 */
export function placeOnSeatAttachment(
  attachmentWorld: THREE.Matrix4,
  seat: Pick<VehicleSeatEntry, "attachmentOffset" | "passengerYaw" | "passengerPitch" | "passengerRoll">,
  localFacing: number,
  passengerScale: number,
  passengerPoint: readonly number[] | undefined,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): void {
  attachmentWorld.decompose(_framePosition, _frameQuaternion, _frameScale);
  passengerSeatRotation(localFacing, seat, _seatRotation);
  const offset = seat.attachmentOffset;
  _local.set(finite(offset.x), finite(offset.y), finite(offset.z));
  if (passengerPoint !== undefined) {
    // In the frame's units: the passenger's own size over the frame's (0x007490f0's scale).
    const scale = passengerScale / (_frameScale.x > 0 ? _frameScale.x : 1);
    _point.set(-finite(passengerPoint[0] ?? 0), -finite(passengerPoint[1] ?? 0), -finite(passengerPoint[2] ?? 0))
      .multiplyScalar(scale).applyQuaternion(_seatRotation);
    _local.add(_point);
  }
  position.copy(_local).applyMatrix4(attachmentWorld);
  quaternion.copy(_frameQuaternion).multiply(_seatRotation).multiply(M2_FROM_SCENE);
}

/**
 * The node's rotation when the vehicle's model has no such point: the vehicle node's own rotation
 * and the seat's turn (0x007490f0's other branch). The position stays the server's composition.
 */
export function seatRotationWithoutAttachment(vehicleRotation: THREE.Quaternion, localFacing: number,
  seat: Pick<VehicleSeatEntry, "passengerYaw" | "passengerPitch" | "passengerRoll">,
  out: THREE.Quaternion): THREE.Quaternion {
  passengerSeatRotation(localFacing, seat, _seatRotation);
  return out.copy(vehicleRotation).multiply(M2_TO_SCENE).multiply(_seatRotation).multiply(M2_FROM_SCENE);
}

/** The attachment with that id on a model, or undefined; no allocation. */
export function findAttachment(attachments: readonly WvmAttachment[] | undefined, id: number): WvmAttachment | undefined {
  if (attachments === undefined) return undefined;
  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index]!;
    if (attachment.id === id) return attachment;
  }
  return undefined;
}

/** What the placement reads of a drawn model: its rig, or its static visual, and its attachments. */
export interface SeatRigModel {
  readonly skinned?: { readonly skeleton: { readonly bones: readonly THREE.Bone[] } } | undefined;
  readonly template?: { readonly pivots: Float32Array } | undefined;
  readonly wvm?: { readonly attachments: readonly WvmAttachment[] } | undefined;
}

/** What the placement reads of a drawn unit (the renderer's `RenderedUnit` is one). */
export interface SeatRigUnit extends SeatRigModel {
  readonly node: THREE.Object3D;
  readonly scale: number;
  /** A model with no rig, carrying the M2 quarter turn like a rig's root. */
  readonly visual?: THREE.Object3D | undefined;
  /** The mount under it: for a player vehicle (a mammoth) the model the seats are on. */
  readonly mount?: SeatRigModel | undefined;
}

/**
 * The point's frame in the scene into `out`: a rig's bone world matrix (refreshed the way spell
 * anchors refresh it) translated from the bone's pivot to the point, or a static model's root
 * translated to it. False when the model cannot answer.
 */
export function seatAttachmentFrame(model: SeatRigModel & { readonly visual?: THREE.Object3D | undefined },
  attachment: WvmAttachment, out: THREE.Matrix4): boolean {
  const [x, y, z] = attachment.position;
  if (model.skinned !== undefined && model.template !== undefined) {
    const bone = model.skinned.skeleton.bones[attachment.bone];
    if (bone === undefined) return false;
    bone.updateWorldMatrix(true, false);
    const pivots = model.template.pivots;
    const at = attachment.bone * 3;
    out.makeTranslation(x - (pivots[at] ?? 0), y - (pivots[at + 1] ?? 0), z - (pivots[at + 2] ?? 0)).premultiply(bone.matrixWorld);
    return true;
  }
  if (model.visual !== undefined) {
    model.visual.updateWorldMatrix(true, false);
    out.makeTranslation(x, y, z).premultiply(model.visual.matrixWorld);
    return true;
  }
  return false;
}

/** A chain of carriers longer than this is a stale loop in the objects, not a vehicle. */
const MAX_SEAT_DEPTH = 4;
const _attachmentWorld = new THREE.Matrix4();
const MOUNT_DISPLAY_ID = UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset;

type Objects = ReadonlyMap<bigint, WorldObjectState>;

/** One unit the renderer drew this frame — its admission entry (`UnitAdmissionCandidate`). */
export interface SeatPlacementEntry {
  readonly value: WorldObjectState;
}

/**
 * The renderer's side: the seat a unit holds this frame (`seatPose`, read when its pose is chosen)
 * and its node put on the vehicle once every unit is posed (`place`). `begin` hands it the frame's
 * objects and the vehicle tables; without tables every answer is "no seat".
 */
export class VehiclePassengerPoser {
  #objects: Objects | undefined;
  #catalog: VehicleCatalog | undefined;
  #units: ReadonlyMap<bigint, SeatRigUnit> | undefined;
  #drawn: ReadonlySet<bigint> | undefined;
  #depth = 0;
  #deeper = false;
  /** Whether a transport guid names a vehicle (0x0074b8b0); BigInt arithmetic is not repeated per frame. */
  readonly #carriers = new Map<bigint, boolean>();
  #placed = new Set<THREE.Object3D>();
  #placedBefore = new Set<THREE.Object3D>();
  /** How far up each node on a seat point was drawn above its unit's own place, for the camera. */
  readonly #lifts = new WeakMap<THREE.Object3D, number>();
  /** The drawn units on a transport this frame (ships too — `seatOf` turns those away); reused. */
  readonly #riders: WorldObjectState[] = [];
  /** Nodes a HIDE_PASSENGER seat hid this frame (`hides`). */
  readonly #hidden = new Set<THREE.Object3D>();

  begin(objects: Objects, catalog: VehicleCatalog | undefined): void {
    this.#objects = objects;
    this.#catalog = catalog;
  }

  /**
   * How far above its unit's own place this node was last put on a seat point (0 when it was not):
   * the camera's pivot and eye rise with it, as they rise with a mount's saddle — Wow.exe's
   * passenger camera follows the seat point (VehicleCamera_C 0x00759200, review notes 11.02-G).
   */
  seatLift(node: THREE.Object3D): number {
    return this.#lifts.get(node) ?? 0;
  }

  /**
   * Whether a HIDE_PASSENGER seat hid this node in the last `place`: a later visibility write of the
   * frame (the warm-hold release) must not show it again — the unit has no model while it sits there.
   */
  hides(node: THREE.Object3D): boolean {
    return this.#hidden.size > 0 && this.#hidden.has(node);
  }

  /** The seat row a unit in view occupies (VehicleSeatModel.ts `unitVehicleSeat`, without allocating). */
  seatOf(object: WorldObjectState): VehicleSeatEntry | undefined {
    const transport = object.transport;
    const catalog = this.#catalog;
    const objects = this.#objects;
    if (transport === undefined || catalog === undefined || objects === undefined) return undefined;
    if (!this.#isCarrier(transport.guid)) return undefined;
    return catalog.seatInSlot(objects.get(transport.guid)?.vehicleId, transport.seat);
  }

  /** `UnitPose.vehicleSeat` for this unit, or undefined (no tables, no seat, a ship, a lift). */
  seatPose(object: WorldObjectState): VehiclePassengerSeatPose | undefined {
    if (object.transport === undefined) return undefined;
    const seat = this.seatOf(object);
    return seat === undefined ? undefined : vehiclePassengerSeatPose(seat);
  }

  /**
   * Every drawn passenger onto its seat, carriers before what rides on them (a turret's gunner after
   * the turret is on the siege engine). Nodes placed last frame and not now get back the facing-only
   * rotation `#drawUnit` writes. `admitted` is the frame's admission entries (the objects drawn),
   * `drawn` their guids: a unit off every transport costs one property read and no lookup.
   */
  place(admitted: readonly SeatPlacementEntry[], drawn: ReadonlySet<bigint>,
    units: ReadonlyMap<bigint, SeatRigUnit>): void {
    const placedBefore = this.#placedBefore;
    this.#placedBefore = this.#placed;
    this.#placed = placedBefore;
    this.#placed.clear();
    if (this.#hidden.size > 0) this.#hidden.clear();
    // 11.02-tails: last frame's overlay records go stale, tables or not.
    beginSeatDrawnFrame();
    if (this.#catalog !== undefined && this.#objects !== undefined) {
      const riders = this.#riders;
      for (let index = 0; index < admitted.length; index++) {
        const object = admitted[index]!.value;
        if (object.transport !== undefined) riders.push(object);
      }
      if (riders.length > 0) {
        this.#units = units;
        this.#drawn = drawn;
        for (let depth = 1; depth <= MAX_SEAT_DEPTH; depth++) {
          this.#depth = depth;
          this.#deeper = false;
          for (let index = 0; index < riders.length; index++) this.#placeAtDepth(riders[index]!);
          if (!this.#deeper) break;
        }
        this.#units = undefined;
        this.#drawn = undefined;
        riders.length = 0;
      }
    }
    if (this.#placedBefore.size > 0) this.#placedBefore.forEach(this.#release);
  }

  #isCarrier(guid: bigint): boolean {
    let carrier = this.#carriers.get(guid);
    if (carrier === undefined) {
      if (this.#carriers.size >= 256) this.#carriers.clear();
      carrier = isVehicleCarrierGuid(guid);
      this.#carriers.set(guid, carrier);
    }
    return carrier;
  }

  /** How many seats up the chain this unit sits; 0 when it holds none. */
  #seatDepth(object: WorldObjectState): number {
    const objects = this.#objects!;
    let depth = 0;
    let current: WorldObjectState | undefined = object;
    while (current !== undefined && depth < MAX_SEAT_DEPTH && this.seatOf(current) !== undefined) {
      depth++;
      current = objects.get(current.transport!.guid);
    }
    return depth;
  }

  #placeAtDepth(object: WorldObjectState): void {
    const depth = this.#seatDepth(object);
    if (depth === 0) return;
    if (depth > this.#depth) {
      this.#deeper = true;
      return;
    }
    if (depth === this.#depth) this.#placeOne(object);
  }

  #placeOne(object: WorldObjectState): void {
    const seat = this.seatOf(object)!;
    const hidden = vehiclePassengerSeatPose(seat).hidden;
    // 11.02-tails: seated this frame, at its own place until the model goes on a point; a HIDE seat
    // hides it whether or not its model is built yet (0x00730f30 asks the seat, not the model).
    const record = seatDrawnRecord(object, hidden);
    const units = this.#units!;
    const unit = units.get(object.guid);
    if (unit === undefined) return;
    if (hidden) {
      unit.node.visible = false;
      this.#hidden.add(unit.node);
    }
    const transport = object.transport!;
    // A vehicle not drawn this frame stands where it stood when it last was.
    if (!this.#drawn!.has(transport.guid)) return;
    const vehicle = units.get(transport.guid);
    if (vehicle === undefined) return;
    // Wow.exe's seat model (vtable +0xd4, 0x006e6f80): the mount's whenever the vehicle is mounted.
    // A mount not built yet is a model not loaded yet — never the rider's model in its place.
    const mounted = vehicle.mount !== undefined
      || (this.#objects!.get(transport.guid)?.fields.get(MOUNT_DISPLAY_ID) ?? 0) !== 0;
    const model: SeatRigModel & { readonly visual?: THREE.Object3D | undefined } | undefined =
      mounted ? vehicle.mount : vehicle;
    // The vehicle's model not loaded yet: the unit's own place and facing, as before.
    if (model?.wvm === undefined) return;
    const point = vehicleSeatAttachmentPoint(seat.attachmentId);
    const attachment = point < 0 ? undefined : findAttachment(model.wvm.attachments, point);
    if (attachment !== undefined && seatAttachmentFrame(model, attachment, _attachmentWorld)) {
      const own = seat.passengerAttachmentId >= 0 ? findAttachment(unit.wvm?.attachments, seat.passengerAttachmentId) : undefined;
      // The unit's own place first: `#drawUnit` put the node there this frame.
      const drawn = unit.node.position;
      const ownX = drawn.x;
      const ownHeight = drawn.y;
      const ownZ = drawn.z;
      placeOnSeatAttachment(_attachmentWorld, seat, transport.orientation, unit.scale, own?.position,
        unit.node.position, unit.node.quaternion);
      this.#lifts.set(unit.node, unit.node.position.y - ownHeight);
      // 11.02-tails: the step in world axes (scene x, y, z = world x, z, −y) for the overlays.
      record.x = drawn.x - ownX;
      record.y = ownZ - drawn.z;
      record.z = drawn.y - ownHeight;
      this.#placed.add(unit.node);
      return;
    }
    this.#lifts.delete(unit.node);
    // No such point on the model: the server's place, the seat's turn — nothing to change without one.
    if (finite(seat.passengerYaw) === 0 && finite(seat.passengerPitch) === 0 && finite(seat.passengerRoll) === 0) return;
    seatRotationWithoutAttachment(vehicle.node.quaternion, transport.orientation, seat, unit.node.quaternion);
    this.#placed.add(unit.node);
  }

  readonly #release = (node: THREE.Object3D): void => {
    if (this.#placed.has(node)) return;
    this.#lifts.delete(node);
    // `#drawUnit` wrote only the facing this frame; a tilt left in the Euler would stay on it.
    node.rotation.x = 0;
    node.rotation.z = 0;
  };
}
