// 06.10-7.24 — which way a game object's model faces (owner: «поворот модели стула смещён»), and
// the box a click on it lands in («границы, где курсор определяет… слишком маленькие»).
// Core: GameObjectModel.cpp:129/:174 put the model at position + Rz(o)·v, v in the M2's own axes
// (vmap4_extractor model.cpp:56 + :118-123); GameObject.cpp:1808 seats the player facing o.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { sceneYaw, toRenderAxes, unpackRotation } from "../dist/code/world/GameObjectRotation.js";
import { passengerGameObjectTilt } from "../dist/code/world/TransportPassengers.js";
import {
  gameObjectNodeYaw, gameObjectWorldRotation, placedBoxCorners,
} from "../dist/code/world/GameObjectModelFrame.js";

const GO = 0xf110000000000001n;
// `VMAP_TO_THREE` / `ADT_MODEL_TO_SCENE` (WorldRenderer3D.ts), the frame every GO mesh is built in.
const MESH_FRAME = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
// The stock chair's GameObjectDisplayInfo row 39 (GeneralChairLoEnd01), dataset DBC: GeoBoxMin/Max.
const CHAIR_BOX = { minX: -0.999, minY: -0.553, minZ: -0.007, maxX: 0.179, maxY: 0.553, maxZ: 1.328 };

const close = (a, b, epsilon, label) => {
  for (let index = 0; index < a.length; index++) assert.ok(Math.abs(a[index] - b[index]) < epsilon, `${label}: ${a} ≠ ${b}`);
};
const toScene = ([x, y, z]) => [x, z, -y];

/** CREATE for a game object in `Object::BuildMovementUpdate` order, with the packed word as sent. */
function created(orientation, packed) {
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(GO).u8(5).u16(0x0350);
  writer.u8(0).f32(100).f32(200).f32(30).f32(100).f32(200).f32(30).f32(orientation).f32(0);
  writer.u32(0x42).i64(packed).u8(0);
  const state = new WorldState();
  state.applyUpdate(writer.toUint8Array(), 0);
  return state.objects.get(GO);
}

/** What `#placeGameObject` composes for a node, applied to one model-space vector, in scene axes. */
function rendered(object, orientation, v) {
  const yaw = sceneYaw(gameObjectNodeYaw(orientation), { x: 0, y: 0, z: 0, w: 1 });
  const node = new THREE.Quaternion(yaw.x, yaw.y, yaw.z, yaw.w);
  const tilt = { x: 0, y: 0, z: 0, w: 1 };
  if (passengerGameObjectTilt(object, orientation, tilt)) {
    toRenderAxes(tilt, tilt);
    node.premultiply(new THREE.Quaternion(tilt.x, tilt.y, tilt.z, tilt.w));
  }
  const p = new THREE.Vector3(...v).applyQuaternion(MESH_FRAME).applyQuaternion(node);
  return [p.x, p.y, p.z];
}

// Two Stormwind inn chairs as the realm sends them (world DB `gameobject` 26270 and 26276, the same
// rows as TDB 335.24081): orientation, and the packed word `UpdatePackedRotation` makes of
// rotation2/rotation3 = 0.378649/0.92554 and −0.932008/0.362437.
const CHAIRS = [
  { guid: 26270, orientation: 0.776672, packed: 0x60ef2n },
  { guid: 26276, orientation: -2.39983, packed: 0x11167fn },
];

test("a stock chair's model faces where the core seats the player (Rz(o), not Rz(o + π))", () => {
  for (const chair of CHAIRS) {
    const object = created(chair.orientation, chair.packed);
    const q = unpackRotation(chair.packed);
    // The packed yaw is the orientation: nothing in the data turns the chair by itself.
    assert.ok(Math.abs(Math.atan2(Math.sin(2 * Math.atan2(q.z, q.w) - chair.orientation),
      Math.cos(2 * Math.atan2(q.z, q.w) - chair.orientation))) < 1e-4, `chair ${chair.guid} packed yaw`);
    const o = chair.orientation;
    // The seat opens towards model +x (the back is the −x end of the GeoBox): it must face o.
    close(rendered(object, o, [1, 0, 0]), toScene([Math.cos(o), Math.sin(o), 0]), 1e-4, `chair ${chair.guid} +x`);
    // And the back stays behind the seated player.
    const back = rendered(object, o, [CHAIR_BOX.minX, 0, CHAIR_BOX.maxZ]);
    close(back, toScene([CHAIR_BOX.minX * Math.cos(o), CHAIR_BOX.minX * Math.sin(o), CHAIR_BOX.maxZ]), 1e-4,
      `chair ${chair.guid} back`);
  }
});

test("a tilted object is drawn with its whole quaternion, the same one the pick box turns by", () => {
  const o = 0.52;
  const lean = { x: Math.sin(0.35 / 2), y: 0, z: 0, w: Math.cos(0.35 / 2) };
  const yaw = { x: 0, y: 0, z: Math.sin(o / 2), w: Math.cos(o / 2) };
  // q = yaw ⊗ lean: a bridge leaning about its own x.
  const q = {
    w: yaw.w * lean.w - yaw.z * lean.z, x: yaw.w * lean.x - yaw.z * lean.y,
    y: yaw.w * lean.y + yaw.z * lean.x, z: yaw.w * lean.z + yaw.z * lean.w,
  };
  const sign = q.w >= 0 ? 1 : -1;
  const packed = BigInt.asIntN(64,
    (BigInt(Math.trunc(q.z * 2 ** 20) * sign) & ((1n << 21n) - 1n))
    | ((BigInt(Math.trunc(q.y * 2 ** 20) * sign) & ((1n << 21n) - 1n)) << 21n)
    | ((BigInt(Math.trunc(q.x * 2 ** 21) * sign) & ((1n << 22n) - 1n)) << 42n));
  const object = created(o, packed);
  const world = gameObjectWorldRotation(object, o, { x: 0, y: 0, z: 0, w: 1 });
  const W = new THREE.Quaternion(world.x, world.y, world.z, world.w);
  for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -2, 1.5]]) {
    const expected = new THREE.Vector3(...v).applyQuaternion(W);
    close(rendered(object, o, v), toScene([expected.x, expected.y, expected.z]), 2e-5, `tilted ${v}`);
  }
  // The world rotation is the packed quaternion itself (up to the packer's precision).
  close([world.x, world.y, world.z, world.w], [q.x, q.y, q.z, q.w], 2e-6, "world rotation");
});

test("the pick box is the display's box, scaled, turned by the object's rotation and placed", () => {
  const object = created(CHAIRS[0].orientation, CHAIRS[0].packed);
  const o = CHAIRS[0].orientation;
  const rotation = gameObjectWorldRotation(object, o, { x: 0, y: 0, z: 0, w: 1 });
  const corners = placedBoxCorners(CHAIR_BOX, { x: 100, y: 200, z: 30 }, rotation, 1.5, new Float64Array(24));
  for (let corner = 0; corner < 8; corner++) {
    const vx = ((corner & 1) ? CHAIR_BOX.maxX : CHAIR_BOX.minX) * 1.5;
    const vy = ((corner & 2) ? CHAIR_BOX.maxY : CHAIR_BOX.minY) * 1.5;
    const vz = ((corner & 4) ? CHAIR_BOX.maxZ : CHAIR_BOX.minZ) * 1.5;
    close([...corners.subarray(corner * 3, corner * 3 + 3)],
      [100 + vx * Math.cos(o) - vy * Math.sin(o), 200 + vx * Math.sin(o) + vy * Math.cos(o), 30 + vz], 1e-4,
      `corner ${corner}`);
  }
});

test("the renderer turns game objects, their build placement and the placement ghost by the node yaw", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const place = source.slice(source.indexOf("  #placeGameObject("), source.indexOf("  #poseGameObject("));
  assert.match(place, /sceneYaw\(gameObjectNodeYaw\(position\.orientation\), GAME_OBJECT_TILT\)/);
  assert.match(source, /rotationY: THREE\.MathUtils\.radToDeg\(gameObjectNodeYaw\(position\.orientation\)\)/);
  assert.match(source, /radToDeg\(gameObjectNodeYaw\(preview\.orientation\)\)/);
  // The click box turns with the same world rotation, from where the node is drawn (scene → world).
  const pick = source.slice(source.indexOf("  gameObjectPickCorners("), source.indexOf("  unitPivotHeight("));
  assert.match(pick, /GAME_OBJECT_PICK_AT\.y = -at\.z;[\s\S]*GAME_OBJECT_PICK_AT\.z = at\.y;/);
  assert.match(pick, /gameObjectWorldRotation\(object, rendered\.base\.orientation, GAME_OBJECT_PICK_ROTATION\)/);
  assert.match(pick, /placedBoxCorners\(rendered\.pickBox, GAME_OBJECT_PICK_AT, GAME_OBJECT_PICK_ROTATION, rendered\.node\.scale\.x, out\)/);
});

// 06.10: ревью 7.24 — the same chair model placed by Blizzard. GoldshireInn.wmo (client
// WORLD\WMO\AZEROTH\BUILDINGS\GOLDSHIREINN, doodad set 2) seats three GeneralChairLoEnd01 doodads
// round an InnTable, each turned so its model +x points at the table: the seat opens towards +x,
// read from the WMO's own frame with no world convention involved. Its MODF (ADT 30_49 of map 0:
// position, yaw −97°) puts the two InnTableTiny of the same set in the world by the rule the
// renderer draws every doodad with (world yaw = MODF yaw + 180°, the vmap internal frame), and the
// six «Wooden Chair» spawns of the TDB (`gameobject` 26800-26805, display 39) stand 1-2 yards from
// them — under Rz(o) every one faces a table, under Rz(o + π) every one turns its back on it.
const INN = { x: -9464.247395940001, y: 24.399088434998703, yaw: (-97 + 180) * Math.PI / 180 };
const INN_TABLE = { x: 8.581, y: 10.219 };
const INN_CHAIRS = [
  { x: 7.511, y: 10.219, qz: -0.01309, qw: 0.99991 },
  { x: 8.676, y: 10.724, qz: -0.7163, qw: 0.69779 },
  { x: 8.595, y: 9.84, qz: 0.69779, qw: 0.7163 },
];
const INN_TINY_TABLES = [{ x: 2.416, y: 11.656 }, { x: 2.416, y: 8.845 }];
const TDB_CHAIRS = [
  { guid: 26800, x: -9476.91, y: 29.6716, o: -0.846484 },
  { guid: 26801, x: -9475.51, y: 29.7921, o: -1.67552 },
  { guid: 26802, x: -9472.31, y: 29.4276, o: -1.80642 },
  { guid: 26803, x: -9473.92, y: 29.6083, o: -1.67552 },
  { guid: 26804, x: -9477.27, y: 28.3755, o: -0.095995 },
  { guid: 26805, x: -9470.65, y: 28.9553, o: -2.34747 },
];
const angleBetween = (ax, ay, bx, by) => Math.acos((ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by));

test("06.10 review: Blizzard's own inn chairs open towards model +x, and the TDB chairs face their tables under Rz(o)", () => {
  for (const chair of INN_CHAIRS) {
    const yaw = 2 * Math.atan2(chair.qz, chair.qw);
    const off = angleBetween(Math.cos(yaw), Math.sin(yaw), INN_TABLE.x - chair.x, INN_TABLE.y - chair.y);
    assert.ok(off < 0.2, `doodad chair at ${chair.x},${chair.y} faces the table (${off})`);
  }
  const tables = INN_TINY_TABLES.map(({ x, y }) => ({
    x: INN.x + x * Math.cos(INN.yaw) - y * Math.sin(INN.yaw), y: INN.y + x * Math.sin(INN.yaw) + y * Math.cos(INN.yaw),
  }));
  for (const chair of TDB_CHAIRS) {
    const table = tables.reduce((a, b) => (Math.hypot(a.x - chair.x, a.y - chair.y) <= Math.hypot(b.x - chair.x, b.y - chair.y) ? a : b));
    assert.ok(Math.hypot(table.x - chair.x, table.y - chair.y) < 2.5, `chair ${chair.guid} stands at a table`);
    const object = { fields: new Map(), rotation: undefined, transport: undefined };
    for (const [yawOf, faces] of [[chair.o, true], [chair.o + Math.PI, false]]) {
      const q = gameObjectWorldRotation(object, yawOf, { x: 0, y: 0, z: 0, w: 1 });
      const front = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      const off = angleBetween(front.x, front.y, table.x - chair.x, table.y - chair.y);
      assert.equal(off < Math.PI / 3, faces, `chair ${chair.guid} at yaw ${yawOf.toFixed(3)}: ${off.toFixed(3)} rad off the table`);
    }
    // And the renderer's node yaw is what turns the mesh to exactly that rotation.
    const front = rendered(object, chair.o, [1, 0, 0]);
    close(front, toScene([Math.cos(chair.o), Math.sin(chair.o), 0]), 1e-6, `chair ${chair.guid} drawn front`);
  }
});
