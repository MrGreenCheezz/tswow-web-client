import assert from "node:assert/strict";
import test from "node:test";

// 11.01 (15.11): a lift car its TransportRotation.dbc keys turn beyond a heading (194301 and 194303 in the dataset turn
// about their y axis on the way up). Wow.exe draws the car with that rotation (0x0070dc10 → 0x0070c700), its entity collides
// in it, and a passenger's matrix is its offset times the car's (0x00704cc0) — so the floor, the riders and the click box
// tilt with the car. Before, the model turned whole while collision and riders followed the heading alone.
import { PacketWriter } from "../dist/code/protocol/index.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { composePassengerPosition, passengerOffset } from "../dist/code/world/TransportMath.js";
import { decodeCollisionModel, encodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { TransportCollision } from "../dist/code/browser/game/TransportCollision.js";
import { GO_STATE_READY, GO_TYPE_TRANSPORT, GameObjectColliders } from "../dist/code/browser/game/GameObjectColliders.js";
import { TILT_REBUILD_RADIANS, TiltedCarrierWorlds, tiltBeyondHeading } from "../dist/code/browser/game/TransportTiltCollision.js";
import { liftCarrierPose } from "../dist/code/browser/LiftClock.js";
import { keepPathRotation } from "../dist/code/browser/TransportPickRotation.js";

const LIFT = 0xf110_0000_0000_00bbn;
const SELF = 0x1234n;
const RIDER = 0x0777n;
const ENTRY = 9998;
const DISPLAY = 7776;
const BASE = { x: 500, y: 500, z: 10, orientation: 0 };
const GROUND = 5;
const TILT = 0.3;
/** A car leaning by TILT about its x axis, held for the whole path (two equal keys, the last held to the end). */
const leaning = { x: Math.sin(TILT / 2), y: 0, z: 0, w: Math.cos(TILT / 2) };
const PATH = {
  entry: ENTRY, period: 10_000,
  frames: [{ time: 0, x: 0, y: 0, z: 0 }, { time: 10_000, x: 0, y: 0, z: 0 }],
  rotations: [{ time: 0, ...leaning }, { time: 5000, ...leaning }],
};
const LEVEL = { ...PATH, rotations: undefined };
const near = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;

function platform() {
  const vertices = Float32Array.from([-3, -3, 0, 3, -3, 0, 3, 3, 0, -3, 3, 0]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const group = { bounds: { minX: -3, minY: -3, minZ: 0, maxX: 3, maxY: 3, maxZ: 0 }, flags: 0x8, groupId: 1, vertices, indices };
  const model = decodeCollisionModel(encodeCollisionModel([group]).slice().buffer);
  return new TransportCollision({ revision: 0, model: (id) => (id === DISPLAY ? model : null), requestGroups() {} });
}

/** The core's create block for a lift (GameObject.cpp:320-321), PARENTROTATION the identity (no gameobject_addon row). */
function liftCreate() {
  const values = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, ENTRY],
    [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, DISPLAY],
    [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, (GO_TYPE_TRANSPORT << 8) | GO_STATE_READY],
    [UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset, 0x28],
    // The identity's w = 1.0f (the core's default rotation; x, y, z are 0 and left out of the block).
    [UPDATE_FIELDS.GAMEOBJECT_PARENTROTATION.offset + 3, 0x3f80_0000],
  ]);
  const blocks = Math.ceil((Math.max(...values.keys()) + 1) / 32);
  const masks = new Array(blocks).fill(0);
  for (const index of values.keys()) masks[index >> 5] |= 1 << (index & 31);
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(LIFT).u8(5).u16(0x42)
    .f32(BASE.x).f32(BASE.y).f32(BASE.z).f32(BASE.orientation).u32(0);
  writer.u8(blocks);
  for (const mask of masks) writer.u32(mask >>> 0);
  for (const index of [...values.keys()].sort((a, b) => a - b)) writer.u32(values.get(index));
  return writer.toUint8Array();
}

function world(path = PATH) {
  const state = new WorldState();
  state.carrierPoseProvider = liftCarrierPose({ path: (entry) => (entry === ENTRY ? path : undefined) });
  state.applyUpdate(liftCreate(), 0);
  return state;
}

test("an offset on a turned carrier is turned by its whole rotation, and back (TransportMath)", () => {
  const car = { x: 1, y: 2, z: 3, orientation: 0, rotated: true, rotation: leaning };
  const at = composePassengerPosition(car, { guid: LIFT, x: 0, y: 2, z: 0, orientation: 0, seat: 0xff });
  assert.ok(near(at.x, 1) && near(at.y, 2 + 2 * Math.cos(TILT)) && near(at.z, 3 + 2 * Math.sin(TILT)), JSON.stringify(at));
  const back = passengerOffset(car, at);
  assert.ok(near(back.x, 0) && near(back.y, 2) && near(back.z, 0) && near(back.orientation, 0));
  // A heading alone (every other key set of the dataset) composes as the yaw always did.
  const half = 0.4;
  const turned = { x: 0, y: 0, z: 0, orientation: 0.8, rotated: true, rotation: { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) } };
  const plain = { x: 0, y: 0, z: 0, orientation: 0.8 };
  const seat = { guid: LIFT, x: 1.5, y: -0.5, z: 0.25, orientation: 0.3, seat: 0xff };
  const a = composePassengerPosition(turned, seat);
  const b = composePassengerPosition(plain, seat);
  assert.ok(near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z) && near(a.orientation, b.orientation));
});

test("a rider on a leaning car is drawn on its leaning floor", () => {
  const state = world();
  const offset = { x: 0, y: 2, z: 0 };
  state.move(RIDER, { flags: MOVEMENT_FLAGS.onTransport, position: { x: BASE.x, y: BASE.y + 2, z: BASE.z, orientation: 0 },
    transport: { guid: LIFT, ...offset, orientation: 0, seat: 0 } }, 1000);
  state.updateMotions(1000);
  const at = state.objects.get(RIDER).position;
  assert.ok(near(at.y, BASE.y + 2 * Math.cos(TILT)) && near(at.z, BASE.z + 2 * Math.sin(TILT)), `on the lean: ${JSON.stringify(at)}`);
});

function colliders(path = PATH) {
  const set = new GameObjectColliders(platform(), { path: (entry) => (entry === ENTRY ? path : undefined) });
  const state = world(path);
  const self = { guid: SELF, typeId: 4, position: { x: BASE.x, y: BASE.y + 2, z: BASE.z + 2, orientation: 0 }, fields: new Map() };
  const base = { ground: () => GROUND, liquid: () => undefined, hole: () => false, floor: () => GROUND };
  return { set, state, self, base };
}

test("a leaning car's floor leans in the collision too; a level one stays level", () => {
  const leaningCar = colliders();
  const probe = leaningCar.set.frame(leaningCar.state.objects, leaningCar.self, leaningCar.base, { mode: "ground" }, 1000);
  const floor = probe.floor(BASE.x, BASE.y + 2, BASE.z + 5, BASE.z - 5);
  assert.ok(near(floor, BASE.z + 2 * Math.tan(TILT)), `the floor 2 yd along y: ${floor}`);
  const low = probe.floor(BASE.x, BASE.y - 2, BASE.z + 5, BASE.z - 5);
  assert.ok(near(low, BASE.z - 2 * Math.tan(TILT)), `and the other side lower: ${low}`);

  const level = colliders(LEVEL);
  const flat = level.set.frame(level.state.objects, level.self, level.base, { mode: "ground" }, 1000);
  assert.ok(near(flat.floor(BASE.x, BASE.y + 2, BASE.z + 5, BASE.z - 5), BASE.z));
  assert.equal(level.set.tiltRebuilds, 0, "nothing turned for a level car");
});

test("the character's seat on a leaning car is in the car's frame, and the carry puts it back on the lean", () => {
  const { set, state, self, base } = colliders();
  self.position.z = BASE.z + 2 * Math.tan(TILT);
  set.frame(state.objects, self, base, { mode: "ground" }, 1000);
  set.settleSeat(self, { mode: "ground" }, base);
  assert.equal(self.transport?.guid, LIFT);
  assert.ok(near(self.transport.y, 2 / Math.cos(TILT)) && near(self.transport.z, 0), `on the floor: ${self.transport.x}, ${self.transport.y}, ${self.transport.z}`);
  // Moved off by something else (within the colliders' range): the next frame puts it back on its seat.
  self.position.x = BASE.x + 3;
  self.position.y = BASE.y;
  self.position.z = BASE.z;
  set.frame(state.objects, self, base, { mode: "air" }, 1100);
  assert.ok(near(self.position.y, BASE.y + 2) && near(self.position.z, BASE.z + 2 * Math.tan(TILT)), "composed in the whole rotation");
});

test("the turned mesh is rebuilt only when the lean has moved on", () => {
  const tilted = new TiltedCarrierWorlds();
  const base = platform().carrier(LIFT, DISPLAY, 1);
  const a = tilted.world(LIFT, base, leaning);
  assert.equal(tilted.world(LIFT, base, { ...leaning }), a);
  assert.equal(tilted.rebuilds, 1);
  const small = TILT + TILT_REBUILD_RADIANS / 2;
  tilted.world(LIFT, base, { x: Math.sin(small / 2), y: 0, z: 0, w: Math.cos(small / 2) });
  assert.equal(tilted.rebuilds, 1, "within half a degree: kept");
  const more = TILT + 2 * TILT_REBUILD_RADIANS;
  assert.equal(tilted.world(LIFT, base, { x: Math.sin(more / 2), y: 0, z: 0, w: Math.cos(more / 2) }), a, "the same world, turned again");
  assert.equal(tilted.rebuilds, 2);
});

test("the tilt beyond a heading gives the rotation back after that heading", () => {
  const heading = 1.1;
  const yaw = { x: 0, y: 0, z: Math.sin(heading / 2), w: Math.cos(heading / 2) };
  // rotation = yaw ⊗ lean
  const r = {
    x: yaw.w * leaning.x + yaw.x * leaning.w + yaw.y * leaning.z - yaw.z * leaning.y,
    y: yaw.w * leaning.y - yaw.x * leaning.z + yaw.y * leaning.w + yaw.z * leaning.x,
    z: yaw.w * leaning.z + yaw.x * leaning.y - yaw.y * leaning.x + yaw.z * leaning.w,
    w: yaw.w * leaning.w - yaw.x * leaning.x - yaw.y * leaning.y - yaw.z * leaning.z,
  };
  const tilt = tiltBeyondHeading(r, heading, { x: 0, y: 0, z: 0, w: 1 });
  assert.ok(near(tilt.x, leaning.x) && near(tilt.y, leaning.y) && near(tilt.z, leaning.z) && near(tilt.w, leaning.w));
});

test("the click box turns with the car: its rotation is kept and the published box derived again", () => {
  const key = { x: 5 };
  const kept = keepPathRotation(undefined, leaning, key);
  assert.deepEqual(kept, leaning);
  assert.ok(Number.isNaN(key.x), "a new rotation: the row is derived again");
  key.x = 5;
  assert.equal(keepPathRotation(kept, { ...leaning }, key), kept);
  assert.equal(key.x, 5, "the same rotation keeps the row");
  assert.equal(keepPathRotation(kept, undefined, key), undefined);
  assert.ok(Number.isNaN(key.x), "level again: derived again");
});
