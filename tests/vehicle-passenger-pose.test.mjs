import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

// 11.02-H: where a vehicle passenger is drawn and which pose it holds (browser/VehiclePassengerPose.ts),
// by Wow.exe 3.3.5a's rules (Ghidra, read-only, .runtime/re-2026-10-03/l1102h): the seat attachment
// table 0x00a2d3f0, the seat matrix 0x007490f0 (Rz(f − yaw) · Rx(roll) · Ry(pitch), AttachmentOffset,
// PassengerAttachmentID 0x00748400), the ride animations 0x00747b20/0x007485b0, HIDE_PASSENGER
// 0x007489c0/0x00730f30. Synthetic rows and rigs for the rules, then the real dataset when present.
const {
  VEHICLE_SEAT_ATTACHMENT_POINTS, VehiclePassengerPoser, findAttachment, passengerSeatRotation, placeOnSeatAttachment,
  seatRotationWithoutAttachment, vehicleSeatAttachmentPoint,
} = await import("../dist/code/browser/VehiclePassengerPose.js");
const {
  SEAT_FLAG_HAS_UPPER_ANIM_FOR_RIDE, passengerSeatAnimations, seatPoseFamily, seatPoseWanted, vehiclePassengerSeatPose,
  vehicleSeatTransition,
} = await import("../dist/code/browser/VehicleSeatPose.js");
const {
  M2_TO_SCENE, chooseAnimation, needsSidecarAnimations, poseAnimation, poseAnimationFamily, poseTransition,
} = await import("../dist/code/browser/AnimatedModel.js");
const { ANIMATION_IDS } = await import("../dist/code/generated/animations.js");
const { MOVEMENT_FLAGS } = await import("../dist/code/world/MovementProtocol.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_SEAT_FLAGS } = await import("../dist/code/world/VehicleSeatModel.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const F = VEHICLE_SEAT_FLAGS;
const EPS = 1e-6;

function near(actual, expected, message, eps = EPS) {
  assert.ok(Math.abs(actual - expected) <= eps, `${message}: ${actual} vs ${expected}`);
}
function nearVector(actual, expected, message, eps = EPS) {
  near(actual.x, expected.x, `${message} x`, eps);
  near(actual.y, expected.y, `${message} y`, eps);
  near(actual.z, expected.z, `${message} z`, eps);
}
/** Same rotation (q and −q are one). */
function sameRotation(actual, expected, message, eps = 1e-6) {
  const dot = Math.abs(actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w);
  assert.ok(dot >= 1 - eps, `${message}: ${actual.toArray()} vs ${expected.toArray()}`);
}
const yawScene = (angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);

/** A Vehicle.dbc row of 40 columns. */
function vehicleRow({ id, seats = [] }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}

/** A VehicleSeat.dbc row of 58 columns; the animation columns −1 unless given. */
function seatRow({
  id, flags = 0, attachmentId = -1, offset = [0, 0, 0], ride = [-1, -1], upper = [-1, -1],
  yaw = 0, pitch = 0, roll = 0, passengerAttachmentId = -1,
}) {
  const C = VEHICLE_SEAT_COLUMN;
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  for (const column of [C.EnterAnimStart, C.EnterAnimLoop, C.ExitAnimStart, C.ExitAnimLoop, C.ExitAnimEnd,
    C.VehicleEnterAnim, C.VehicleExitAnim, C.VehicleRideAnimLoop]) row[column] = -1;
  row[C.ID] = id;
  row[C.Flags] = flags;
  row[C.AttachmentID] = attachmentId;
  [row[C.AttachmentOffsetX], row[C.AttachmentOffsetY], row[C.AttachmentOffsetZ]] = offset;
  [row[C.RideAnimStart], row[C.RideAnimLoop]] = ride;
  [row[C.RideUpperAnimStart], row[C.RideUpperAnimLoop]] = upper;
  [row[C.PassengerYaw], row[C.PassengerPitch], row[C.PassengerRoll]] = [yaw, pitch, roll];
  row[C.PassengerAttachmentID] = passengerAttachmentId;
  return row;
}

// The dataset's shapes: the Siege Engine (117) and its turret (116) in slot 7, a mammoth (312).
const ENGINE_VEHICLE = 117;
const TURRET_VEHICLE = 116;
const MAMMOTH_VEHICLE = 312;
const DRIVER_SEAT = 1648;
const HIDDEN_SEAT = 1649;
const TILTED_SEAT = 1650;
const NO_POINT_SEAT = 1651;
const TURRET_SLOT_SEAT = 1652;
const GUNNER_SEAT = 1643;
const MAMMOTH_SEAT = 2764;
// Review 11.02-H: a seat on MountMain (AttachmentID 21 → point 0), the id a character model also
// carries (its shield point) — so a seat put on the rider instead of the mount would show.
const MOUNT_MAIN_VEHICLE = 9900;
const MOUNT_MAIN_SEAT = 99001;
const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [
    vehicleRow({ id: ENGINE_VEHICLE, seats: [DRIVER_SEAT, HIDDEN_SEAT, TILTED_SEAT, NO_POINT_SEAT, 0, 0, 0, TURRET_SLOT_SEAT] }),
    vehicleRow({ id: TURRET_VEHICLE, seats: [GUNNER_SEAT] }),
    vehicleRow({ id: MAMMOTH_VEHICLE, seats: [0, MAMMOTH_SEAT] }),
    vehicleRow({ id: MOUNT_MAIN_VEHICLE, seats: [0, MOUNT_MAIN_SEAT] }),
  ],
  seats: [
    // 1648 as in the dataset: VehicleSeat1 (13 → 39), offset 0.2 forward, legs Mount, hands UseStanding.
    seatRow({ id: DRIVER_SEAT, flags: 0x67108a0b, attachmentId: 13, offset: [0.2, 0, 0], ride: [-1, 91], upper: [128, 123] }),
    seatRow({ id: HIDDEN_SEAT, flags: F.HAS_LOWER_ANIM_FOR_RIDE | F.HIDE_PASSENGER, attachmentId: 14, ride: [-1, 102] }),
    seatRow({ id: TILTED_SEAT, flags: F.HAS_LOWER_ANIM_FOR_RIDE, attachmentId: 15, ride: [96, 97], pitch: -0.349, roll: 0.2, yaw: 0.5 }),
    seatRow({ id: NO_POINT_SEAT, flags: F.HAS_LOWER_ANIM_FOR_RIDE, attachmentId: -1, offset: [0, 1.5, 1.5], ride: [-1, 102], yaw: -1.5708 }),
    seatRow({ id: TURRET_SLOT_SEAT, flags: 0x3006408, attachmentId: 20 }),
    seatRow({ id: GUNNER_SEAT, flags: 0x67100a0f, attachmentId: 13, ride: [-1, 102], upper: [128, 123] }),
    seatRow({ id: MAMMOTH_SEAT, flags: 0xde00800b, attachmentId: 14, ride: [-1, 91], upper: [128, 123] }),
    seatRow({ id: MOUNT_MAIN_SEAT, flags: F.HAS_LOWER_ANIM_FOR_RIDE, attachmentId: 21, ride: [-1, 91] }),
  ],
  indicators: [],
  indicatorSeats: [],
};
const catalog = vehicleCatalogFrom(ANSWER);

// ---- the rules -----------------------------------------------------------------------------------

test("11.02-H: a seat's AttachmentID goes through Wow.exe's table (0x00a2d3f0) to the vehicle model's point", () => {
  assert.equal(VEHICLE_SEAT_ATTACHMENT_POINTS.length, 22);
  assert.deepEqual([13, 14, 15, 16, 17, 18, 19, 20].map(vehicleSeatAttachmentPoint), [39, 40, 41, 42, 43, 44, 45, 46],
    "VehicleSeat1…8");
  assert.equal(vehicleSeatAttachmentPoint(21), 0, "MountMain");
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(vehicleSeatAttachmentPoint), [20, 34, 19, 21, 22, 17], "Head, Chest, Base, spell hands, Breath");
  assert.deepEqual([6, 7, 8, 9, 10, 11, 12].map(vehicleSeatAttachmentPoint), [23, 24, 25, 15, 16, 37, 38]);
  assert.equal(vehicleSeatAttachmentPoint(-1), -1, "−1 is no point (an unsigned compare)");
  assert.equal(vehicleSeatAttachmentPoint(22), -1);
  assert.equal(vehicleSeatAttachmentPoint(1.5), -1);
  assert.ok(Object.isFrozen(VEHICLE_SEAT_ATTACHMENT_POINTS));
});

test("11.02-H: the ride animations by layer — legs on HAS_LOWER_ANIM_FOR_RIDE 0x2, the unit's own pose on 0x4", () => {
  const seat = (flags, ride = [-1, 102], upper = [128, 123]) => ({
    flags, rideAnimStart: ride[0], rideAnimLoop: ride[1], rideUpperAnimStart: upper[0], rideUpperAnimLoop: upper[1],
  });
  assert.equal(SEAT_FLAG_HAS_UPPER_ANIM_FOR_RIDE, 0x4);
  assert.deepEqual(passengerSeatAnimations(seat(0)), { lower: undefined, upper: undefined }, "neither flag: the ordinary pose");
  assert.deepEqual(passengerSeatAnimations(seat(0x2)), { lower: { start: undefined, loop: 102 }, upper: undefined });
  assert.deepEqual(passengerSeatAnimations(seat(0x4)), { lower: undefined, upper: { start: 128, loop: 123 } });
  assert.deepEqual(passengerSeatAnimations(seat(0x6, [96, 97])).lower, { start: 96, loop: 97 });
  assert.equal(passengerSeatAnimations(seat(0x6, [-1, -1], [-1, -1])).lower, undefined, "−1/−1 is no pair");
  assert.deepEqual(passengerSeatAnimations(seat(0x2, [0x1fa, 91])).lower, { start: undefined, loop: 91 }, "0x1fa is Wow.exe's none");
  assert.deepEqual(passengerSeatAnimations(seat(0x2 | 0x200 | 0x800, [-1, 91])).lower, { start: undefined, loop: 91 }, "other bits do not matter");
});

test("11.02-H: the whole-body seat pose — the legs' loop first, then RideUpper, a start only when it differs; HIDE_PASSENGER", () => {
  const driver = vehiclePassengerSeatPose(catalog.seat(DRIVER_SEAT));
  assert.deepEqual([...driver.wanted], [ANIMATION_IDS.Mount], "−1/91 under 128/123: sitting is what shows");
  assert.equal(driver.start, undefined);
  assert.equal(driver.hidden, true, "0x67108a0b has 0x200: the Siege Engine hides its crew");
  assert.equal(driver.id, DRIVER_SEAT);
  assert.equal(vehiclePassengerSeatPose(catalog.seat(DRIVER_SEAT)), driver, "one object per seat row");
  assert.ok(Object.isFrozen(driver) && Object.isFrozen(driver.wanted));

  const tilted = vehiclePassengerSeatPose(catalog.seat(TILTED_SEAT));
  assert.deepEqual([...tilted.wanted], [ANIMATION_IDS.SitGround]);
  assert.equal(tilted.start, ANIMATION_IDS.SitGroundDown, "96 then 97");
  assert.equal(vehiclePassengerSeatPose(catalog.seat(HIDDEN_SEAT)).hidden, true);

  const rows = vehicleCatalogFrom({
    ...ANSWER,
    seats: [
      seatRow({ id: 1, flags: 0x4, ride: [-1, 102], upper: [216, 216] }),
      seatRow({ id: 2, flags: 0 }),
      seatRow({ id: 3, flags: 0x6, ride: [-1, -1], upper: [-1, 52] }),
      seatRow({ id: 4, flags: 0x2, ride: [91, 91] }),
      seatRow({ id: 5, flags: 0x2, ride: [100, -1], upper: [6, 6] }),
    ],
  });
  const upperOnly = vehiclePassengerSeatPose(rows.seat(1));
  assert.deepEqual([...upperOnly.wanted], [216], "without 0x2 the whole body plays RideUpper");
  assert.equal(upperOnly.start, undefined, "216/216: the start is the loop");
  assert.deepEqual([...vehiclePassengerSeatPose(rows.seat(2)).wanted], [], "neither flag: no seat pose");
  assert.deepEqual([...vehiclePassengerSeatPose(rows.seat(3)).wanted], [52], "legs without a loop: RideUpper");
  assert.equal(vehiclePassengerSeatPose(rows.seat(4)).start, undefined, "91/91 plays once as the loop");
  assert.deepEqual([...vehiclePassengerSeatPose(rows.seat(5)).wanted], [], "a start without a loop, 0x4 unset: nothing held");
});

test("11.02-H: the seat turn is Rz(f − PassengerYaw) · Rx(roll) · Ry(pitch) in M2 axes (0x007490f0)", () => {
  const q = new THREE.Quaternion();
  const forward = () => new THREE.Vector3(1, 0, 0);
  passengerSeatRotation(0.7, { passengerYaw: 0.2, passengerPitch: 0, passengerRoll: 0 }, q);
  nearVector(forward().applyQuaternion(q), { x: Math.cos(0.5), y: Math.sin(0.5), z: 0 }, "f − yaw, counter-clockwise about Z");
  passengerSeatRotation(0, { passengerYaw: Math.PI / 2, passengerPitch: 0, passengerRoll: 0 }, q);
  nearVector(forward().applyQuaternion(q), { x: 0, y: -1, z: 0 }, "a positive PassengerYaw turns the passenger right");
  // Pitch first, then roll, then yaw: +X under Ry(π/2) is −Z, under Rx(π/2) that is +Y.
  passengerSeatRotation(0, { passengerYaw: 0, passengerPitch: Math.PI / 2, passengerRoll: Math.PI / 2 }, q);
  nearVector(forward().applyQuaternion(q), { x: 0, y: 1, z: 0 }, "Ry then Rx");
  passengerSeatRotation(0, { passengerYaw: 0, passengerPitch: 0.3, passengerRoll: 0 }, q);
  nearVector(forward().applyQuaternion(q), { x: Math.cos(0.3), y: 0, z: -Math.sin(0.3) }, "pitch about Y");
  passengerSeatRotation(0, { passengerYaw: 0, passengerPitch: 0, passengerRoll: 0.3 }, q);
  nearVector(new THREE.Vector3(0, 1, 0).applyQuaternion(q), { x: 0, y: Math.cos(0.3), z: Math.sin(0.3) }, "roll about X");
  passengerSeatRotation(Number.NaN, { passengerYaw: Number.NaN, passengerPitch: Number.NaN, passengerRoll: Number.NaN }, q);
  sameRotation(q, new THREE.Quaternion(), "a column the table did not fill is no turn");
});

test("11.02-H: on the point — offset in the point's frame, the seat turn, the passenger's own point on the seat, its own size", () => {
  const facing = 0.9;
  const vehicleRoot = yawScene(facing).multiply(M2_TO_SCENE);
  const at = new THREE.Vector3(10, 5, -3);
  const frame = new THREE.Matrix4().compose(at, vehicleRoot, new THREE.Vector3(2, 2, 2));
  const seat = { attachmentOffset: { x: 0.5, y: 0, z: 1 }, passengerYaw: 0.1, passengerPitch: 0, passengerRoll: 0 };
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  placeOnSeatAttachment(frame, seat, 0.3, 1, undefined, position, quaternion);
  const expected = new THREE.Vector3(0.5, 0, 1).multiplyScalar(2).applyQuaternion(vehicleRoot).add(at);
  nearVector(position, expected, "AttachmentOffset scales and turns with the vehicle");
  sameRotation(quaternion, yawScene(facing + 0.3 - 0.1), "the vehicle's facing + f − yaw, about scene up");

  // PassengerAttachmentID: the passenger's chest point, not its feet, lands on the seat.
  const chest = [0.1, 0, 1.2];
  const scale = 1.5;
  placeOnSeatAttachment(frame, seat, 0.3, scale, chest, position, quaternion);
  const node = new THREE.Object3D();
  node.position.copy(position);
  node.quaternion.copy(quaternion);
  node.scale.setScalar(scale);
  const root = new THREE.Object3D();
  root.quaternion.copy(M2_TO_SCENE);
  node.add(root);
  node.updateMatrixWorld(true);
  const chestWorld = new THREE.Vector3(...chest).applyMatrix4(root.matrixWorld);
  nearVector(chestWorld, new THREE.Vector3(0.5, 0, 1).applyMatrix4(frame), "the passenger's point on the seat point");
  const feet = new THREE.Vector3(0, 0, 0).applyMatrix4(root.matrixWorld);
  near(chestWorld.distanceTo(feet), scale * Math.hypot(...chest), "at the passenger's own size, not the vehicle's", 1e-5);
});

test("11.02-H: without the point on the model — the server's place, the vehicle's turn and the seat's", () => {
  const q = new THREE.Quaternion();
  seatRotationWithoutAttachment(yawScene(1.1), 0.4, { passengerYaw: -1.5708, passengerPitch: 0, passengerRoll: 0 }, q);
  sameRotation(q, yawScene(1.1 + 0.4 + 1.5708), "vehicle facing + f − yaw");
  seatRotationWithoutAttachment(yawScene(0), 0, { passengerYaw: 0, passengerPitch: 0.3, passengerRoll: 0 }, q);
  const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  near(nose.y, -Math.sin(0.3), "a positive pitch puts the nose down (M2 −Z is scene −Y)");
  assert.equal(findAttachment([{ id: 39, bone: 0, position: [0, 0, 0] }], 40), undefined);
  assert.equal(findAttachment(undefined, 39), undefined);
});

// ---- the renderer's side, on synthetic rigs ------------------------------------------------------

const ENGINE = 0xf150_0074_9800_0101n;
const TURRET = 0xf150_0074_9400_0102n;
const MAMMOTH_OWNER = 0x21n;
const SELF = 0x10n;
const FRIEND = 0x11n;
const GUNNER = 0x12n;
const DECKHAND = 0x13n;
const SHIP = 0x1fc0_0000_0000_0104n;

function object(guid, { typeId = 4, vehicleId, carrier, seat = 0, orientation = 0, position = { x: 0, y: 0, z: 0, orientation: 0 } } = {}) {
  return {
    guid, typeId, vehicleId, fields: new Map(), movementFlags: 0, position,
    transport: carrier === undefined ? undefined : { guid: carrier, x: 0, y: 0, z: 0, orientation, seat },
  };
}

/** A rig of one bone at `pivot` under a root with the M2 quarter turn, in a node at `at` facing `facing`. */
function rig({ at = [0, 0, 0], facing = 0, scale = 1, pivot = [1, 0, 2], attachments = [] } = {}) {
  const node = new THREE.Group();
  node.position.set(...at);
  node.rotation.y = facing;
  node.scale.setScalar(scale);
  const root = new THREE.Object3D();
  root.quaternion.copy(M2_TO_SCENE);
  node.add(root);
  const bone = new THREE.Bone();
  bone.position.set(...pivot);
  root.add(bone);
  return {
    node, scale, root,
    skinned: { skeleton: { bones: [bone] } },
    template: { pivots: new Float32Array(pivot) },
    wvm: { attachments },
  };
}
function passengerRig(at = [0, 0, 0], attachments = []) {
  const node = new THREE.Group();
  node.position.set(...at);
  return { node, scale: 1, wvm: { attachments } };
}
/** Where a point of a rig's model space is in the scene. */
function modelPoint(unit, point) {
  unit.node.updateMatrixWorld(true);
  return new THREE.Vector3(...point).applyMatrix4(unit.root.matrixWorld);
}
/**
 * The renderer's call (review 11.02-H): the frame's admission entries in draw order — the objects
 * `#drawUnit` drew — the set of their guids, and the drawn units.
 */
function placeDrawn(poser, objects, guids, units) {
  const list = [...guids];
  const admitted = list.filter((guid) => objects.has(guid)).map((guid) => ({ value: objects.get(guid) }));
  poser.place(admitted, new Set(list), units);
}

test("11.02-H: a passenger is drawn on its seat's point of the vehicle's model, turned by the seat", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  const self = object(SELF, { carrier: ENGINE, seat: 0, orientation: 0.25 });
  const friend = object(FRIEND, { carrier: ENGINE, seat: 2 });
  const objects = new Map([[ENGINE, engineObject], [SELF, self], [FRIEND, friend]]);
  const engine = rig({
    at: [100, 3, -50], facing: 0.6,
    attachments: [{ id: 39, bone: 0, position: [1.5, 0.2, 2.5] }, { id: 41, bone: 0, position: [-1, 0, 2] }],
  });
  const units = new Map([[ENGINE, engine], [SELF, passengerRig([100, 3, -50])], [FRIEND, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  assert.equal(poser.seatOf(self)?.id, DRIVER_SEAT);
  assert.equal(poser.seatPose(self), vehiclePassengerSeatPose(catalog.seat(DRIVER_SEAT)));
  placeDrawn(poser, objects, [SELF, ENGINE, FRIEND], units);
  // 0.2 forward of VehicleSeat1, in the vehicle's frame.
  nearVector(units.get(SELF).node.position, modelPoint(engine, [1.7, 0.2, 2.5]), "the driver on VehicleSeat1 + offset");
  sameRotation(units.get(SELF).node.quaternion, yawScene(0.6 + 0.25), "facing: the vehicle's and the seat's own");
  // An observer's view of somebody else in another seat: VehicleSeat3 (15 → 41), tilted.
  nearVector(units.get(FRIEND).node.position, modelPoint(engine, [-1, 0, 2]), "a friend on VehicleSeat3");
  const expected = yawScene(0.6).multiply(M2_TO_SCENE)
    .multiply(passengerSeatRotation(0, { passengerYaw: 0.5, passengerPitch: -0.349, passengerRoll: 0.2 }, new THREE.Quaternion()))
    .multiply(M2_TO_SCENE.clone().invert());
  sameRotation(units.get(FRIEND).node.quaternion, expected, "with its yaw, pitch and roll");
  assert.equal(units.get(FRIEND).node.visible, true);
  assert.equal(units.get(SELF).node.visible, false, "the driver's seat hides its passenger");
  // The camera rises with the seat point: the node's height over the place `#drawUnit` gave it.
  near(poser.seatLift(units.get(SELF).node), modelPoint(engine, [1.7, 0.2, 2.5]).y - 3, "the driver's lift");
  near(poser.seatLift(units.get(FRIEND).node), modelPoint(engine, [-1, 0, 2]).y - 0, "the friend's lift");
  assert.equal(poser.seatLift(engine.node), 0, "not a passenger");
});

test("11.02-H: the bone moves the seat — the point follows the vehicle's posed bone, scale and all", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  const self = object(SELF, { carrier: ENGINE, seat: 0 });
  const objects = new Map([[ENGINE, engineObject], [SELF, self]]);
  const engine = rig({ at: [5, 0, 5], facing: -0.4, scale: 1.6, attachments: [{ id: 39, bone: 0, position: [1, 0, 3] }] });
  const bone = engine.skinned.skeleton.bones[0];
  bone.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.4);
  bone.position.z += 0.3;
  const units = new Map([[ENGINE, engine], [SELF, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [ENGINE, SELF], units);
  engine.node.updateMatrixWorld(true);
  const seatPoint = new THREE.Vector3(1 + 0.2 - 1, 0, 3 - 2).applyMatrix4(bone.matrixWorld);
  nearVector(units.get(SELF).node.position, seatPoint, "the posed bone's frame, offset in it");
});

test("11.02-H: a player vehicle's seats are on its mount (the mammoth), not on the rider", () => {
  const owner = object(MAMMOTH_OWNER, { vehicleId: MAMMOTH_VEHICLE });
  const friend = object(FRIEND, { carrier: MAMMOTH_OWNER, seat: 1 });
  const objects = new Map([[MAMMOTH_OWNER, owner], [FRIEND, friend]]);
  const rider = rig({ at: [0, 0, 0], attachments: [] });
  const mammoth = rig({ attachments: [{ id: 40, bone: 0, position: [-0.5, 0.8, 4.2] }] });
  rider.node.add(mammoth.node);
  const units = new Map([[MAMMOTH_OWNER, { ...rider, mount: { skinned: mammoth.skinned, template: mammoth.template, wvm: mammoth.wvm } }],
    [FRIEND, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  nearVector(units.get(FRIEND).node.position, modelPoint(mammoth, [-0.5, 0.8, 4.2]), "VehicleSeat2 of the mammoth");
  assert.deepEqual([...poser.seatPose(friend).wanted], [ANIMATION_IDS.Mount]);
});

test("11.02-H: a vehicle model without a rig still has its points (the static model's root, M2 inside)", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  const friend = object(FRIEND, { carrier: ENGINE, seat: 2 });
  const objects = new Map([[ENGINE, engineObject], [FRIEND, friend]]);
  const node = new THREE.Group();
  node.position.set(3, 4, 5);
  node.rotation.y = -0.8;
  const visual = new THREE.Object3D();
  visual.quaternion.copy(M2_TO_SCENE);
  node.add(visual);
  const units = new Map([[ENGINE, { node, scale: 1, visual, wvm: { attachments: [{ id: 41, bone: 0, position: [2, -1, 1.5] }] } }],
    [FRIEND, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [ENGINE, FRIEND], units);
  node.updateMatrixWorld(true);
  nearVector(units.get(FRIEND).node.position, new THREE.Vector3(2, -1, 1.5).applyMatrix4(visual.matrixWorld), "VehicleSeat3 of the model");
});

test("11.02-H: a gunner in a turret on a siege engine is placed after the turret, whatever the draw order", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  const turretObject = object(TURRET, { typeId: 3, vehicleId: TURRET_VEHICLE, carrier: ENGINE, seat: 7 });
  const gunner = object(GUNNER, { carrier: TURRET, seat: 0 });
  const objects = new Map([[ENGINE, engineObject], [TURRET, turretObject], [GUNNER, gunner]]);
  const engine = rig({ at: [20, 1, 20], facing: 1.2, attachments: [{ id: 46, bone: 0, position: [-2, 0, 3] }] });
  const turret = rig({ attachments: [{ id: 39, bone: 0, position: [0.4, 0, 1.1] }] });
  const units = new Map([[ENGINE, engine], [TURRET, turret], [GUNNER, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [GUNNER, TURRET, ENGINE], units);
  nearVector(turret.node.position, modelPoint(engine, [-2, 0, 3]), "the turret on VehicleSeat8 (20 → 46)");
  nearVector(units.get(GUNNER).node.position, modelPoint(turret, [0.4, 0, 1.1]), "the gunner on the turret where it now is");
});

test("11.02-H: HIDE_PASSENGER hides the passenger while it sits; a point the model lacks keeps the place and turns", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE, position: { x: 0, y: 0, z: 0, orientation: 0.7 } });
  const hidden = object(SELF, { carrier: ENGINE, seat: 1 });
  const noPoint = object(FRIEND, { carrier: ENGINE, seat: 3, orientation: 0.1 });
  const objects = new Map([[ENGINE, engineObject], [SELF, hidden], [FRIEND, noPoint]]);
  const engine = rig({ facing: 0.7, attachments: [] });
  const units = new Map([[ENGINE, engine], [SELF, passengerRig([1, 2, 3])], [FRIEND, passengerRig([4, 5, 6])]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [ENGINE, SELF, FRIEND], units);
  assert.equal(units.get(SELF).node.visible, false, "0x200: no model while seated");
  nearVector(units.get(SELF).node.position, { x: 1, y: 2, z: 3 }, "and its seat point is not on this model: left in place");
  sameRotation(units.get(SELF).node.quaternion, new THREE.Quaternion(), "a seat with no turn leaves the rotation `#drawUnit` wrote");
  nearVector(units.get(FRIEND).node.position, { x: 4, y: 5, z: 6 }, "AttachmentID −1: the server's place");
  sameRotation(units.get(FRIEND).node.quaternion, yawScene(0.7 + 0.1 + 1.5708), "with the seat's yaw");
});

test("11.02-H: nothing changes without the tables, off a vehicle, on a ship, before the vehicle is drawn or built", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  // Slot 2 (the tilted seat): a seat that is drawn and turns, so any change would show.
  const self = object(SELF, { carrier: ENGINE, seat: 2, orientation: 0.25 });
  // Seat byte 0 on purpose (a ship's is 0xFF): only the carrier's guid may say "not a vehicle".
  const deckhand = object(DECKHAND, { carrier: SHIP, seat: 0 });
  const walker = object(FRIEND);
  const shipObject = { ...object(SHIP, { typeId: 5 }), vehicleId: ENGINE_VEHICLE };
  const objects = new Map([[ENGINE, engineObject], [SELF, self], [DECKHAND, deckhand], [FRIEND, walker], [SHIP, shipObject]]);
  const engine = rig({ at: [100, 3, -50], attachments: [{ id: 41, bone: 0, position: [1.5, 0.2, 2.5] }] });
  const fresh = () => new Map([[ENGINE, engine], [SELF, passengerRig([7, 8, 9])], [DECKHAND, passengerRig([1, 1, 1])],
    [FRIEND, passengerRig([2, 2, 2])], [SHIP, rig({ attachments: [{ id: 39, bone: 0, position: [0, 0, 0] }] })]]);
  const unchanged = (units, guid, at, message) => {
    nearVector(units.get(guid).node.position, { x: at[0], y: at[1], z: at[2] }, message);
    sameRotation(units.get(guid).node.quaternion, new THREE.Quaternion(), `${message} (turn)`);
    assert.equal(units.get(guid).node.visible, true, `${message} (visible)`);
  };
  const poser = new VehiclePassengerPoser();

  let units = fresh();
  poser.begin(objects, undefined);
  assert.equal(poser.seatPose(self), undefined, "no tables: no seat");
  placeDrawn(poser, objects, objects.keys(), units);
  unchanged(units, SELF, [7, 8, 9], "no tables");

  units = fresh();
  poser.begin(objects, catalog);
  assert.equal(poser.seatPose(deckhand), undefined, "a ship is not a vehicle (0x0074b8b0)");
  assert.equal(poser.seatPose(walker), undefined);
  placeDrawn(poser, objects, [ENGINE, SELF, DECKHAND, FRIEND, SHIP], units);
  unchanged(units, DECKHAND, [1, 1, 1], "on a ship");
  unchanged(units, FRIEND, [2, 2, 2], "on foot");

  units = fresh();
  placeDrawn(poser, objects, [SELF], units);
  unchanged(units, SELF, [7, 8, 9], "the vehicle not drawn this frame");

  units = fresh();
  units.set(ENGINE, { ...engine, wvm: undefined, skinned: undefined, template: undefined });
  placeDrawn(poser, objects, [SELF, ENGINE], units);
  unchanged(units, SELF, [7, 8, 9], "the vehicle's model not loaded");

  units = fresh();
  const alone = new Map([[SELF, self]]);
  poser.begin(alone, catalog);
  placeDrawn(poser, alone, [SELF], units);
  unchanged(units, SELF, [7, 8, 9], "the vehicle out of view");
});

test("11.02-H: leaving the seat gives the node back the facing-only rotation", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  const friend = object(FRIEND, { carrier: ENGINE, seat: 2 });
  const objects = new Map([[ENGINE, engineObject], [FRIEND, friend]]);
  const engine = rig({ attachments: [{ id: 41, bone: 0, position: [-1, 0, 2] }] });
  const units = new Map([[ENGINE, engine], [FRIEND, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [ENGINE, FRIEND], units);
  const node = units.get(FRIEND).node;
  assert.ok(Math.abs(node.rotation.x) > 1e-3 || Math.abs(node.rotation.z) > 1e-3, "the tilted seat tilts the node");
  assert.ok(poser.seatLift(node) > 0);
  friend.transport = undefined;
  node.rotation.y = 1.25; // what `#drawUnit` writes the next frame
  placeDrawn(poser, objects, [ENGINE, FRIEND], units);
  assert.equal(node.rotation.x, 0);
  assert.equal(node.rotation.z, 0);
  near(node.rotation.y, 1.25, "the facing it was given");
  sameRotation(node.quaternion, yawScene(1.25), "and the quaternion with it");
  assert.equal(poser.seatLift(node), 0, "and the camera comes down with it");
});

// ---- review 11.02-H ------------------------------------------------------------------------------

/** A Map that counts its lookups. */
class CountingMap extends Map {
  gets = 0;
  get(key) {
    this.gets++;
    return super.get(key);
  }
}

test("11.02-H review: with the tables and nobody on a vehicle, `place` looks nothing up — one read per admitted unit", () => {
  const objects = new CountingMap();
  const units = new CountingMap();
  for (let index = 0; index < 300; index++) {
    const guid = BigInt(0x100 + index);
    objects.set(guid, object(guid));
    units.set(guid, passengerRig());
  }
  // Ship passengers have a transport too: turned away by the carrier's guid, still without a lookup.
  for (const guid of [DECKHAND, 0x14n]) {
    objects.set(guid, object(guid, { carrier: SHIP, seat: 0 }));
    units.set(guid, passengerRig([1, 1, 1]));
  }
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  const admitted = [...objects.keys()].map((guid) => ({ value: objects.get(guid) }));
  objects.gets = 0;
  units.gets = 0;
  poser.place(admitted, new Set(objects.keys()), units);
  assert.equal(objects.gets, 0, "no object looked up");
  assert.equal(units.gets, 0, "no unit looked up");
  nearVector(units.get(DECKHAND).node.position, { x: 1, y: 1, z: 1 }, "the deckhand where `#drawUnit` put it");
  // Carriers that are not vehicles (0x0074b8b0): a creature of HighGuid::Unit and an elevator.
  const creatureCarrier = 0xf130_0074_9800_0105n;
  const elevator = 0xf120_0000_0000_0106n;
  const riders = [object(0x15n, { carrier: creatureCarrier, seat: 0 }), object(0x16n, { carrier: elevator, seat: 0 })];
  const carriers = new Map([[creatureCarrier, object(creatureCarrier, { typeId: 3, vehicleId: ENGINE_VEHICLE })],
    [elevator, { ...object(elevator, { typeId: 5 }), vehicleId: ENGINE_VEHICLE }], ...riders.map((rider) => [rider.guid, rider])]);
  poser.begin(carriers, catalog);
  assert.deepEqual(riders.map((rider) => poser.seatPose(rider)), [undefined, undefined]);
});

test("11.02-H review: a passenger the frame did not draw is not placed, and gets its facing-only rotation back", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  const friend = object(FRIEND, { carrier: ENGINE, seat: 2 });
  const objects = new Map([[ENGINE, engineObject], [FRIEND, friend]]);
  const engine = rig({ attachments: [{ id: 41, bone: 0, position: [-1, 0, 2] }] });
  const units = new Map([[ENGINE, engine], [FRIEND, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [ENGINE, FRIEND], units);
  const node = units.get(FRIEND).node;
  assert.ok(Math.abs(node.rotation.x) > 1e-3 || Math.abs(node.rotation.z) > 1e-3, "seated and tilted");
  // Over the budget next frame: still in range, still seated, not drawn.
  placeDrawn(poser, objects, [ENGINE], units);
  assert.equal(node.rotation.x, 0, "not placed again");
  assert.equal(node.rotation.z, 0);
  assert.equal(poser.seatLift(node), 0);
});

test("11.02-H review: a HIDE_PASSENGER node is reported hidden, so the warm-hold release cannot show it again", () => {
  const engineObject = object(ENGINE, { typeId: 3, vehicleId: ENGINE_VEHICLE });
  const hidden = object(SELF, { carrier: ENGINE, seat: 1 });
  const friend = object(FRIEND, { carrier: ENGINE, seat: 2 });
  const objects = new Map([[ENGINE, engineObject], [SELF, hidden], [FRIEND, friend]]);
  const engine = rig({ attachments: [{ id: 40, bone: 0, position: [0, 0, 2] }, { id: 41, bone: 0, position: [-1, 0, 2] }] });
  const units = new Map([[ENGINE, engine], [SELF, passengerRig()], [FRIEND, passengerRig()]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [ENGINE, SELF, FRIEND], units);
  assert.equal(poser.hides(units.get(SELF).node), true, "the seat hides it this frame");
  assert.equal(poser.hides(units.get(FRIEND).node), false);
  assert.equal(poser.hides(engine.node), false);
  hidden.transport = undefined;
  placeDrawn(poser, objects, [ENGINE, SELF, FRIEND], units);
  assert.equal(poser.hides(units.get(SELF).node), false, "out of the seat: nothing hidden");
  // The release writes `hold.visible` after `place`; the renderer keeps the seat's word there.
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const release = renderer.indexOf("#releaseWarmUnits(): void {");
  const write = renderer.indexOf("unit.node.visible = hold.visible && !this.#vehiclePassengers.hides(unit.node); // 11.02-H-review", release);
  assert.ok(release > 0 && write > release && write - release < 1500, "the release asks the poser");
});

test("11.02-H review: a mounted vehicle's seats are on its mount only (Wow.exe vtable +0xd4 = 0x006e6f80)", () => {
  const MOUNT_DISPLAY = UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset;
  const owner = object(MAMMOTH_OWNER, { vehicleId: MOUNT_MAIN_VEHICLE });
  owner.fields.set(MOUNT_DISPLAY, 25871);
  const friend = object(FRIEND, { carrier: MAMMOTH_OWNER, seat: 1 });
  const objects = new Map([[MAMMOTH_OWNER, owner], [FRIEND, friend]]);
  // The rider's own model has a point 0 (a character's shield point).
  const rider = rig({ at: [0, 0, 0], attachments: [{ id: 0, bone: 0, position: [0.3, 0.5, 1.2] }] });
  let units = new Map([[MAMMOTH_OWNER, rider], [FRIEND, passengerRig([4, 5, 6])]]);
  const poser = new VehiclePassengerPoser();
  poser.begin(objects, catalog);
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  nearVector(units.get(FRIEND).node.position, { x: 4, y: 5, z: 6 }, "the mount not built yet: the passenger's own place");
  sameRotation(units.get(FRIEND).node.quaternion, new THREE.Quaternion(), "and its own turn");
  assert.equal(poser.seatLift(units.get(FRIEND).node), 0);

  // Built: MountMain of the mount model.
  const mount = rig({ attachments: [{ id: 0, bone: 0, position: [0, 0.2, 3.1] }] });
  rider.node.add(mount.node);
  units = new Map([[MAMMOTH_OWNER, { ...rider, mount: { skinned: mount.skinned, template: mount.template, wvm: mount.wvm } }],
    [FRIEND, passengerRig([4, 5, 6])]]);
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  nearVector(units.get(FRIEND).node.position, modelPoint(mount, [0, 0.2, 3.1]), "MountMain of the mount");

  // Not mounted: the vehicle's own model, as before.
  owner.fields.delete(MOUNT_DISPLAY);
  units = new Map([[MAMMOTH_OWNER, rider], [FRIEND, passengerRig([4, 5, 6])]]);
  rider.node.remove(mount.node);
  placeDrawn(poser, objects, [MAMMOTH_OWNER, FRIEND], units);
  nearVector(units.get(FRIEND).node.position, modelPoint(rider, [0.3, 0.5, 1.2]), "point 0 of the unmounted vehicle's model");
});

// ---- the pose ------------------------------------------------------------------------------------

function basePose(overrides = {}) {
  return { dead: false, movementFlags: 0, spline: false, standState: 0, ...overrides };
}

test("11.02-H: the unit's pose takes the seat's loop in the seat family; without a seat nothing changes", () => {
  const driver = vehiclePassengerSeatPose(catalog.seat(DRIVER_SEAT));
  const seated = basePose({ movementFlags: MOVEMENT_FLAGS.onTransport | MOVEMENT_FLAGS.root, vehicleSeat: driver });
  assert.deepEqual(poseAnimation(seated), { wanted: [ANIMATION_IDS.Mount], loop: true });
  assert.equal(poseAnimationFamily(seated), "mount");
  assert.equal(seatPoseWanted(driver), driver.wanted, "the cached list, not a copy");
  assert.equal(seatPoseWanted(undefined), undefined);
  assert.equal(seatPoseFamily(driver, true), false);
  assert.equal(seatPoseFamily(undefined, false), false);
  assert.equal(vehicleSeatTransition(undefined, undefined), false, "not seated: the ordinary one-shots");
  assert.deepEqual(poseAnimation({ ...seated, dead: true }).wanted, [ANIMATION_IDS.Dead, ANIMATION_IDS.Death], "dead stays dead");
  assert.equal(poseAnimationFamily({ ...seated, dead: true }), "any");
  const none = vehiclePassengerSeatPose(vehicleCatalogFrom({ ...ANSWER, seats: [seatRow({ id: 9 })] }).seat(9));
  assert.deepEqual(poseAnimation(basePose({ vehicleSeat: none })), poseAnimation(basePose()), "a seat with no loop: the ordinary pose");
  assert.equal(poseAnimationFamily(basePose({ vehicleSeat: none })), "any");
  // Without a seat, the ordinary answers (and the seat changes nothing in them).
  assert.deepEqual(poseAnimation(basePose()).wanted, poseAnimation(basePose({ vehicleSeat: undefined })).wanted);
  assert.equal(poseAnimationFamily(basePose()), "any");

  // Drawn and fetched inside the seat family: a rig without the loop stands, it never falls back
  // through AnimationData into another family (132 Drowned → 131 → 1 Death in the "any" chain).
  const drowned = { ...driver, id: 77, wanted: Object.freeze([132]) };
  const clips = new Map([[ANIMATION_IDS.Stand, {}], [ANIMATION_IDS.Death, {}]]);
  assert.deepEqual(chooseAnimation(clips, basePose({ vehicleSeat: drowned })), { animation: ANIMATION_IDS.Stand, loop: true });
  assert.deepEqual(chooseAnimation(new Map([...clips, [ANIMATION_IDS.Mount, {}]]), seated), { animation: ANIMATION_IDS.Mount, loop: true });
  assert.equal(needsSidecarAnimations({ clips, animations: new Set([0, 1, 132]), merged: false }, [132], poseAnimationFamily(basePose({ vehicleSeat: drowned }))),
    true, "the loop is asked of the sidecar");
});

test("11.02-H: the only one-shot in or out of a seat is the seat's start, on taking it", () => {
  const tilted = vehiclePassengerSeatPose(catalog.seat(TILTED_SEAT));
  const driver = vehiclePassengerSeatPose(catalog.seat(DRIVER_SEAT));
  const standing = basePose();
  const falling = basePose({ movementFlags: MOVEMENT_FLAGS.falling });
  assert.equal(poseTransition(standing, basePose({ vehicleSeat: tilted })), ANIMATION_IDS.SitGroundDown, "RideAnimStart 96");
  assert.equal(poseTransition(basePose({ vehicleSeat: tilted }), basePose({ vehicleSeat: tilted })), undefined, "still seated");
  assert.equal(poseTransition(basePose({ vehicleSeat: driver }), basePose({ vehicleSeat: tilted })), ANIMATION_IDS.SitGroundDown,
    "a seat switch is a new seat");
  assert.equal(poseTransition(standing, basePose({ vehicleSeat: driver })), undefined, "no start on 1648");
  assert.equal(poseTransition(basePose({ vehicleSeat: driver }), falling), undefined, "out of the seat: no JumpStart");
  assert.equal(poseTransition(falling, basePose({ vehicleSeat: driver, movementFlags: MOVEMENT_FLAGS.falling })), undefined);
  // Unchanged without seats.
  assert.equal(poseTransition(standing, falling), ANIMATION_IDS.JumpStart);
  assert.equal(poseTransition(falling, standing), ANIMATION_IDS.JumpEnd);
});

test("11.02-H: the renderer's hooks are in place and marked", () => {
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const begin = renderer.indexOf("this.#vehiclePassengers.begin(state.objects, vehicleCatalog()); // 11.02-H");
  const draw = renderer.indexOf("this.#drawUnit(object, state.selfGuid === object.guid");
  // Review 11.02-H: the admitted entries go in, so a frame with nobody on a transport looks nothing up.
  const place = renderer.indexOf("this.#vehiclePassengers.place(admission.admitted, drawn, this.#units); // 11.02-H-review");
  assert.ok(begin > 0 && draw > begin && place > draw, "begin before the draws, place after every unit is drawn");
  assert.ok(renderer.lastIndexOf("11.02-H", place) > place - 200, "marked");
  const pose = renderer.indexOf("const vehicleSeat = unit.mount === undefined ? this.#vehiclePassengers.seatPose(object) : undefined;");
  assert.ok(pose > 0 && renderer.indexOf("if (vehicleSeat !== undefined) pose.vehicleSeat = vehicleSeat;", pose) > pose);
  const body = renderer.indexOf("#bodyHeight(guid: bigint, point: number, share: number, fallback: number): number {");
  assert.ok(renderer.indexOf("body, share, fallback) + seat + vehicleSeatLift; // 11.02-H", body) > body, "the camera's pivot and eye");
  const animated = readFileSync(new URL("../src/browser/AnimatedModel.ts", import.meta.url), "utf8");
  assert.equal(animated.match(/11\.02-H/g)?.length, 6, "the AnimatedModel hooks");
});

// ---- the real dataset ----------------------------------------------------------------------------

const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const haveDataset = existsSync(`${DATASET_DBC}/Vehicle.dbc`) && existsSync(`${DATASET_DBC}/VehicleSeat.dbc`);

test("11.02-H: the dataset — siege engine, mammoth, chopper and mechano-hog seats", { skip: !haveDataset && "no dataset DBCs on this machine" }, async () => {
  const { loadVehicles } = await import("../dist/code/gateway/VehicleMetadata.js");
  const answer = await loadVehicles(DATASET_DBC);
  const real = vehicleCatalogFrom(JSON.parse(JSON.stringify(answer)));
  const seatOf = (vehicle, slot) => real.seatInSlot(vehicle, slot);
  // The Siege Engine: the driver on VehicleSeat1 sitting on Mount; the passengers on VehicleSeat2/3;
  // the whole crew hidden inside (HIDE_PASSENGER on 1648-1650).
  const driver = seatOf(117, 0);
  assert.equal(driver.id, 1648);
  assert.equal(vehicleSeatAttachmentPoint(driver.attachmentId), 39);
  assert.deepEqual([...vehiclePassengerSeatPose(driver).wanted], [ANIMATION_IDS.Mount]);
  assert.deepEqual([0, 1, 2].map((slot) => vehiclePassengerSeatPose(seatOf(117, slot)).hidden), [true, true, true]);
  assert.deepEqual([vehicleSeatAttachmentPoint(seatOf(117, 1).attachmentId), vehicleSeatAttachmentPoint(seatOf(117, 2).attachmentId)], [40, 41]);
  assert.equal(vehicleSeatAttachmentPoint(seatOf(117, 7).attachmentId), 46, "the turret rides VehicleSeat8");
  // Traveler's Tundra Mammoth (312 Alliance, 313 Horde): two passengers, legs on Mount, nothing hidden.
  for (const mammoth of [312, 313]) {
    assert.deepEqual([1, 2].map((slot) => vehicleSeatAttachmentPoint(seatOf(mammoth, slot).attachmentId)), [40, 39]);
    assert.deepEqual([1, 2].map((slot) => [...vehiclePassengerSeatPose(seatOf(mammoth, slot)).wanted]), [[91], [91]]);
    assert.equal(vehiclePassengerSeatPose(seatOf(mammoth, 1)).hidden, false);
  }
  assert.deepEqual([...vehiclePassengerSeatPose(seatOf(318, 1)).wanted], [ANIMATION_IDS.ReclinedMountPassenger], "the chopper's sidecar");
  const hog = seatOf(342, 1);
  assert.equal(vehicleSeatAttachmentPoint(hog.attachmentId), 40);
  assert.equal(hog.passengerAttachmentId, 34, "the mechano-hog passenger's chest on the seat");
  near(hog.passengerPitch, -0.349, "pitched back", 1e-3);
  // The whole table.
  let hidden = 0;
  let unmapped = 0;
  let seated = 0;
  let started = 0;
  for (const row of answer.seats) {
    const seat = real.seat(row[VEHICLE_SEAT_COLUMN.ID]);
    const pose = vehiclePassengerSeatPose(seat);
    if (pose.hidden) hidden++;
    if (vehicleSeatAttachmentPoint(seat.attachmentId) < 0) unmapped++;
    if (pose.wanted.length > 0) seated++;
    if (pose.start !== undefined) started++;
  }
  assert.equal(answer.seats.length, 720);
  assert.equal(hidden, 81, "HIDE_PASSENGER seats");
  assert.equal(unmapped, 27, "AttachmentID −1");
  assert.equal(seated, 588, "seats with a ride loop (115 have neither flag, 17 a flag and no loop)");
  assert.equal(started, 34, "seats with a start one-shot (96→97, 131→132, 0→17…)");
});
