// 5.27 — a game object's whole rotation (docs/implementation/line-A4.ru.md).
// The create block is written by hand in `Object::BuildMovementUpdate` order (Object.cpp:314-473),
// and the rotation is packed here as `GameObject::UpdatePackedRotation` (GameObject.cpp:2451-2464)
// packs it, never through the module under test.
import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import {
  gameObjectTilt, packRotation, toRenderAxes, unpackRotation,
} from "../dist/code/world/GameObjectRotation.js";

const GO = 0xf110_0000_0000_0042n;
const TRANSPORT = 0x1fc0_0000_0000_0007n;
const PARENT = 10; // GAMEOBJECT_PARENTROTATION, four floats

/** The core's packer, transcribed: int32 truncation, the sign of w folded in, 22/21/21 bits. */
function corePack({ x, y, z, w }) {
  const sign = w >= 0 ? 1 : -1;
  const px = BigInt(Math.trunc(x * 2 ** 21) * sign) & ((1n << 22n) - 1n);
  const py = BigInt(Math.trunc(y * 2 ** 20) * sign) & ((1n << 21n) - 1n);
  const pz = BigInt(Math.trunc(z * 2 ** 20) * sign) & ((1n << 21n) - 1n);
  return BigInt.asIntN(64, pz | (py << 21n) | (px << 42n));
}

const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const axisAngle = (ax, ay, az, angle) => ({ x: ax * Math.sin(angle / 2), y: ay * Math.sin(angle / 2), z: az * Math.sin(angle / 2), w: Math.cos(angle / 2) });
const yaw = (angle) => axisAngle(0, 0, 1, angle);
function rotate(q, v) {
  const p = qmul(qmul(q, { x: v[0], y: v[1], z: v[2], w: 0 }), { x: -q.x, y: -q.y, z: -q.z, w: q.w });
  return [p.x, p.y, p.z];
}
const close = (a, b, epsilon, label) => {
  for (let index = 0; index < a.length; index++) assert.ok(Math.abs(a[index] - b[index]) < epsilon, `${label}: ${a} ≠ ${b}`);
};
const f32bits = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};

/**
 * CREATE for a game object: `u16` flags LOWGUID|STATIONARY|POSITION|ROTATION (GameObject.cpp:124);
 * POSITION: transport packed guid or `u8 0`, x, y, z, then the transport offset or x, y, z again,
 * orientation, `f32 0`; LOWGUID `u32`; ROTATION `i64`. Then a values block with `fields`.
 */
function gameObjectCreate({ orientation, rotation, fields = new Map(), transport }) {
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(GO).u8(5).u16(0x0350);
  if (transport) writer.packedGuid(transport.guid);
  else writer.u8(0);
  writer.f32(100).f32(200).f32(30);
  if (transport) writer.f32(transport.x).f32(transport.y).f32(transport.z);
  else writer.f32(100).f32(200).f32(30);
  writer.f32(orientation).f32(0);
  writer.u32(0x42);
  writer.i64(corePack(rotation));
  const words = fields.size === 0 ? 0 : Math.floor(Math.max(...fields.keys()) / 32) + 1;
  writer.u8(words);
  const masks = new Array(words).fill(0);
  for (const index of fields.keys()) masks[index >> 5] |= 1 << (index & 31);
  for (const mask of masks) writer.u32(mask >>> 0);
  for (const index of [...fields.keys()].sort((a, b) => a - b)) writer.u32(fields.get(index));
  return writer.toUint8Array();
}

function created(options) {
  const state = new WorldState();
  state.applyUpdate(gameObjectCreate(options), 0);
  return state.objects.get(GO);
}

test("the packed rotation unpacks to the same rotation, whatever the sign of w", () => {
  const cases = [
    axisAngle(0, 0, 1, 0.7), axisAngle(1, 0, 0, 0.35), qmul(yaw(2.5), axisAngle(0, 1, 0, -0.4)),
    { ...axisAngle(0.6, 0, 0.8, 1.1) }, // then negated below
  ];
  cases.push({ x: -cases[3].x, y: -cases[3].y, z: -cases[3].z, w: -cases[3].w });
  for (const q of cases) {
    const back = unpackRotation(corePack(q));
    assert.ok(back.w >= 0);
    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) close(rotate(back, v), rotate(q, v), 1e-5, "same action");
    assert.equal(packRotation(q), corePack(q), "packRotation is the core's packer");
  }
});

test("a level object has no tilt; its rotation is its yaw", () => {
  const object = created({ orientation: Math.PI / 6, rotation: yaw(Math.PI / 6) });
  close([object.rotation.x, object.rotation.y, object.rotation.z, object.rotation.w],
    [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)], 1e-6, "yaw 30°");
  assert.equal(gameObjectTilt(object, object.position.orientation, { x: 0, y: 0, z: 0, w: 1 }), false);
});

test("a leaning object returns the lean in world axes, and the scene gets (x, z, −y)", () => {
  const lean = axisAngle(1, 0, 0, Math.PI / 9); // 20° about world x, after the yaw
  const object = created({ orientation: Math.PI / 6, rotation: qmul(lean, yaw(Math.PI / 6)) });
  const tilt = { x: 0, y: 0, z: 0, w: 1 };
  assert.equal(gameObjectTilt(object, object.position.orientation, tilt), true);
  close([tilt.x, tilt.y, tilt.z, tilt.w], [Math.sin(Math.PI / 18), 0, 0, Math.cos(Math.PI / 18)], 1e-5, "tilt");
  const scene = toRenderAxes(axisAngle(0, 1, 0, 0.5), { x: 0, y: 0, z: 0, w: 1 });
  close([scene.x, scene.y, scene.z, scene.w], [0, 0, -Math.sin(0.25), Math.cos(0.25)], 1e-9, "world y is scene −z");
  // The yaw the renderer applies, then the tilt, is the whole rotation: check on a vector.
  const whole = qmul(tilt, yaw(Math.PI / 6));
  close(rotate(whole, [1, 2, 3]), rotate(qmul(lean, yaw(Math.PI / 6)), [1, 2, 3]), 1e-5, "tilt ⊗ yaw = rotation");
});

test("a rotation whose yaw disagrees with the orientation is drawn by the rotation", () => {
  // A unit quaternion the core keeps as it is (ObjectMgr.cpp:2693 only replaces non-unit ones).
  const object = created({ orientation: 1.2, rotation: { x: 0, y: 0, z: 0, w: 1 } });
  const tilt = { x: 0, y: 0, z: 0, w: 1 };
  assert.equal(gameObjectTilt(object, 1.2, tilt), true);
  close(rotate(qmul(tilt, yaw(1.2)), [1, 0, 0]), [1, 0, 0], 1e-5, "back to the identity");
});

test("the parent rotation turns the whole object", () => {
  const fields = new Map([
    [PARENT + 2, f32bits(Math.sin(Math.PI / 4))],
    [PARENT + 3, f32bits(Math.cos(Math.PI / 4))],
  ]);
  const level = created({ orientation: Math.PI / 2, rotation: { x: 0, y: 0, z: 0, w: 1 }, fields });
  assert.equal(gameObjectTilt(level, Math.PI / 2, { x: 0, y: 0, z: 0, w: 1 }), false, "a 90° parent is the 90° yaw");
  // An identity parent arrives as its w alone (zero fields are left out of a create block).
  const identity = created({ orientation: 0.3, rotation: yaw(0.3), fields: new Map([[PARENT + 3, f32bits(1)]]) });
  assert.equal(gameObjectTilt(identity, 0.3, { x: 0, y: 0, z: 0, w: 1 }), false);
});

test("POSITION keeps the transport and its offset; ROTATION is read as 64 bits", () => {
  const object = created({
    orientation: 0, rotation: yaw(0), transport: { guid: TRANSPORT, x: 1.5, y: -2, z: 3 },
  });
  assert.equal(object.positionTransport?.guid, TRANSPORT);
  assert.deepEqual([object.positionTransport.x, object.positionTransport.y, object.positionTransport.z], [1.5, -2, 3]);
  assert.deepEqual([object.position.x, object.position.y, object.position.z], [100, 200, 30]);
  const plain = created({ orientation: 0, rotation: yaw(0) });
  assert.equal(plain.positionTransport, undefined);
});

// Review 02.10 (А-линза): a ship or a zeppelin is created with an identity local rotation and an
// identity parent (Transport.cpp:102-103) while its orientation is the path's (TransportMgr.cpp:396),
// so "the rotation wins" would turn every one of them to face yaw 0.
test("an MO_TRANSPORT is turned by its orientation: the core gives it an identity rotation", () => {
  const BYTES_1 = 17; // GAMEOBJECT_BYTES_1, type in byte 1 (GameObject.h SetGoType)
  const ship = created({ orientation: 1.2, rotation: { x: 0, y: 0, z: 0, w: 1 }, fields: new Map([[BYTES_1, (15 << 8) | 1]]) });
  assert.equal(gameObjectTilt(ship, 1.2, { x: 0, y: 0, z: 0, w: 1 }), false, "no tilt cancels the ship's yaw");
  // An elevator (type 11) keeps its spawn rotation, which the client draws.
  const lift = created({ orientation: 1.2, rotation: { x: 0, y: 0, z: 0, w: 1 }, fields: new Map([[BYTES_1, (11 << 8) | 1]]) });
  assert.equal(gameObjectTilt(lift, 1.2, { x: 0, y: 0, z: 0, w: 1 }), true);
});

// Review 02.10 (D-линза): the renderer's yaw used to go through four Matrix4 allocations per object
// per frame (`mappedVmapRotation`); the closed form must be the same rotation.
test("sceneYaw is the renderer's VMAP-conjugated yaw, in closed form", async () => {
  const rotation = await import("../dist/code/world/GameObjectRotation.js");
  assert.equal(typeof rotation.sceneYaw, "function", "sceneYaw is exported");
  const THREE = await import("three");
  const vmap = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  for (const orientation of [0, 0.3, 1.2, Math.PI, 4.5, -2.2]) {
    const expected = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().copy(vmap).multiply(new THREE.Matrix4().makeRotationZ(orientation)).multiply(vmap));
    const out = rotation.sceneYaw(orientation, { x: 9, y: 9, z: 9, w: 9 });
    const v = new THREE.Vector3(1, 2, 3);
    const a = v.clone().applyQuaternion(expected);
    const b = v.clone().applyQuaternion(new THREE.Quaternion(out.x, out.y, out.z, out.w));
    close([b.x, b.y, b.z], [a.x, a.y, a.z], 1e-9, `yaw ${orientation}`);
  }
});
