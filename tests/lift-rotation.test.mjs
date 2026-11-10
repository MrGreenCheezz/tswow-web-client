// 11.01 (11.11): a lift's car turned along its path as Wow.exe 3.3.5a 12340 does it. 0x0070dc10: with two or more
// TransportRotation.dbc keys the keys either side of the path time are slerped (0x00982460) and multiplied by
// GAMEOBJECT_PARENTROTATION (0x004f4320: slerp ⊗ parent), after the last key the car holds it to the path's end; with
// fewer keys the object keeps its own rotation. 0x0070daa0: the path offset is turned by PARENTROTATION's matrix
// (0x004c5100), not by the spawn's orientation. Ghidra notes: .runtime/re-2026-11-11/transport/.
import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { liftCarrierPose, liftPoseAt } from "../dist/code/browser/LiftClock.js";
import {
  transportMultiply, transportPathRotation, transportSlerp, turnByParent,
} from "../dist/code/browser/TransportRotation.js";
import { addTransportRotations, parseTransportPaths } from "../dist/code/gateway/TransportPaths.js";

const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const PARENT = UPDATE_FIELDS.GAMEOBJECT_PARENTROTATION.offset;
const PERIOD = 10_000;

const bits = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};
const yaw = (angle) => ({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) });
const near = (a, b, epsilon = 1e-5) => Math.abs(a - b) <= epsilon;
const nearQuat = (q, r, message) => {
  const same = near(q.x, r.x) && near(q.y, r.y) && near(q.z, r.z) && near(q.w, r.w);
  const flipped = near(q.x, -r.x) && near(q.y, -r.y) && near(q.z, -r.z) && near(q.w, -r.w);
  assert.ok(same || flipped, `${message}: ${JSON.stringify(q)} vs ${JSON.stringify(r)}`);
};

/** A type 11 lift at the origin whose path time is `now` modulo the period; `parent` is PARENTROTATION or absent. */
function lift({ parent, orientation = 0 } = {}) {
  const fields = new Map([[BYTES_1, (11 << 8) | 1], [ENTRY, 7]]);
  if (parent !== undefined) [parent.x, parent.y, parent.z, parent.w].forEach((value, index) => {
    if (value !== 0) fields.set(PARENT + index, bits(value));
  });
  return { guid: 1n, typeId: 5, position: { x: 100, y: 200, z: 30, orientation }, fields, transportTime: 0, transportTimeAt: 0 };
}

const FRAMES = [{ time: 0, x: 0, y: 0, z: 0 }, { time: 5000, x: 10, y: 0, z: 0 }, { time: PERIOD, x: 0, y: 0, z: 0 }];

test("the keys either side of the time are slerped, then multiplied by the parent rotation", () => {
  const keys = [{ time: 0, ...yaw(0) }, { time: 4000, ...yaw(Math.PI / 2) }, { time: 8000, ...yaw(Math.PI / 2) }];
  const out = { x: 0, y: 0, z: 0, w: 1 };
  nearQuat(transportPathRotation(keys, PERIOD, 2000, yaw(0), out), yaw(Math.PI / 4), "half way between 0 and 90°");
  nearQuat(transportPathRotation(keys, PERIOD, 2000, yaw(Math.PI / 3), out), yaw(Math.PI / 4 + Math.PI / 3), "and the parent's yaw on top");
  nearQuat(transportPathRotation(keys, PERIOD, 6000, yaw(0), out), yaw(Math.PI / 2), "equal keys hold");
});

test("the product is slerp ⊗ parent, in that order (0x004f4320 with the parent pushed first)", () => {
  const tilt = { x: Math.sin(0.3), y: 0, z: 0, w: Math.cos(0.3) };
  const keys = [{ time: 0, ...tilt }, { time: 4000, ...tilt }];
  const parent = yaw(1.1);
  const out = transportPathRotation(keys, PERIOD, 1000, parent, { x: 0, y: 0, z: 0, w: 1 });
  nearQuat(out, transportMultiply(tilt, parent, { x: 0, y: 0, z: 0, w: 1 }), "tilt ⊗ yaw");
  const other = transportMultiply(parent, tilt, { x: 0, y: 0, z: 0, w: 1 });
  assert.ok(!near(out.y, other.y, 1e-3), "not yaw ⊗ tilt");
});

test("after the last key the car holds it to the end of the path (Wow.exe's unsigned wrap span)", () => {
  const keys = [{ time: 0, ...yaw(0) }, { time: 4000, ...yaw(Math.PI / 2) }];
  const out = { x: 0, y: 0, z: 0, w: 1 };
  nearQuat(transportPathRotation(keys, PERIOD, 9999, yaw(0), out), yaw(Math.PI / 2), "not on its way back to the first key");
  nearQuat(transportPathRotation(keys, PERIOD, 0, yaw(0), out), yaw(0), "the first key at the start");
});

test("fewer than two keys, or a time no segment holds, leave the object's own rotation", () => {
  const out = { x: 0, y: 0, z: 0, w: 1 };
  assert.equal(transportPathRotation(undefined, PERIOD, 100, yaw(0), out), undefined);
  assert.equal(transportPathRotation([{ time: 0, ...yaw(1) }], PERIOD, 100, yaw(0), out), undefined);
  // A first key past 0 (193459, 194350, both without TransportAnimation rows): Wow.exe would search forever.
  assert.equal(transportPathRotation([{ time: 1600, ...yaw(0) }, { time: 1633, ...yaw(1) }], PERIOD, 100, yaw(0), out), undefined);
});

test("an all-zero parent comes back as the identity through the rotation word", () => {
  const keys = [{ time: 0, ...yaw(0.5) }, { time: 4000, ...yaw(0.5) }];
  nearQuat(transportPathRotation(keys, PERIOD, 10, { x: 0, y: 0, z: 0, w: 0 }, { x: 0, y: 0, z: 0, w: 1 }), { x: 0, y: 0, z: 0, w: 1 }, "identity");
});

test("0x00982460: the shorter arc, and the first key when the two are one", () => {
  const out = { x: 0, y: 0, z: 0, w: 1 };
  const a = yaw(0.2);
  const b = yaw(0.6);
  const negated = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  nearQuat(transportSlerp(a, negated, 0.5, out), yaw(0.4), "a negated key is the same rotation");
  nearQuat(transportSlerp(a, a, 0.7, out), a, "identical keys");
});

test("0x0070daa0: the path offset is turned by PARENTROTATION, not by the spawn's orientation", () => {
  const out = [0, 0, 0];
  turnByParent(yaw(Math.PI / 2), 10, 0, 5, out);
  assert.ok(near(out[0], 0) && near(out[1], 10) && near(out[2], 5), "a quarter turn left");
  turnByParent({ x: 0, y: 0, z: 0, w: 0 }, 10, 0, 5, out);
  assert.deepEqual(out, [10, 0, 5], "an all-zero parent is the identity matrix");

  const path = { entry: 7, period: PERIOD, frames: FRAMES };
  const pose = { x: 0, y: 0, z: 0, orientation: 0 };
  // The core fills PARENTROTATION from gameobject_addon, else the identity (GameObject.cpp:338-342).
  const turned = liftPoseAt(lift({ parent: yaw(Math.PI / 2), orientation: Math.PI / 2 }), path, 5000, pose);
  assert.ok(near(turned.x, 100) && near(turned.y, 210), `by the parent: ${turned.x}, ${turned.y}`);
  const unturned = liftPoseAt(lift({ parent: yaw(0), orientation: Math.PI / 2 }), path, 5000, pose);
  assert.ok(near(unturned.x, 110) && near(unturned.y, 200), `an identity parent leaves it, whatever o says: ${unturned.x}, ${unturned.y}`);
  assert.equal(unturned.rotated, false, "no keys: the object's own rotation");
  assert.ok(near(unturned.orientation, Math.PI / 2), "and the spawn's heading");
});

test("a car with keys is drawn with their rotation, and its colliders and passengers take that heading", () => {
  const keys = [{ time: 0, ...yaw(0) }, { time: 5000, ...yaw(Math.PI / 2) }, { time: 9000, ...yaw(Math.PI / 2) }];
  const path = { entry: 7, period: PERIOD, frames: FRAMES, rotations: keys };
  const object = lift({ parent: yaw(0.25), orientation: 0.25 });
  const pose = liftPoseAt(object, path, 2500, { x: 0, y: 0, z: 0, orientation: 0 });
  assert.equal(pose.rotated, true);
  nearQuat(pose.rotation, yaw(Math.PI / 4 + 0.25), "slerp ⊗ parent");
  assert.ok(near(pose.orientation, Math.PI / 4 + 0.25), `the heading: ${pose.orientation}`);

  const carrier = liftCarrierPose({ path: () => path });
  const at = carrier(object, 2500, { x: 0, y: 0, z: 0, orientation: 0 });
  assert.ok(near(at.orientation, Math.PI / 4 + 0.25), "a rider's frame turns with the car");
});

test("the gateway reads TransportRotation.dbc onto the paths by template entry, in time order", () => {
  const anim = dbc(7, 28, [[1, 7, 0, 0, 0, 0, 0], [2, 7, 5000, 1, 2, 3, 0]], [false, false, false, true, true, true, false]);
  const rot = dbc(7, 28, [[10, 7, 4000, 0, 0, 0.5, 0.8660254], [11, 7, 0, 0, 0, 0, 1], [12, 9, 0, 0, 0, 0, 1]],
    [false, false, false, true, true, true, true]);
  const paths = addTransportRotations(parseTransportPaths(anim), rot);
  const seven = paths.get(7);
  assert.deepEqual(seven.rotations.map((key) => key.time), [0, 4000]);
  assert.ok(near(seven.rotations[1].z, 0.5) && near(seven.rotations[1].w, 0.8660254));
  assert.equal(seven.period, 5000);
  assert.deepEqual(paths.get(9), { entry: 9, period: 0, frames: [], rotations: [{ time: 0, x: 0, y: 0, z: 0, w: 1 }] },
    "rotations without a path: a car that stands");
});

/** A WDBC image of `fields` words a row; `floats[i]` says word i is a float. */
function dbc(fields, recordSize, rows, floats) {
  const data = Buffer.alloc(20 + rows.length * recordSize + 1);
  data.write("WDBC");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => row.forEach((value, word) => {
    const at = 20 + index * recordSize + word * 4;
    if (floats[word]) data.writeFloatLE(value, at);
    else data.writeInt32LE(value, at);
  }));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
