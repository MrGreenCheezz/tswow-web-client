// 15.11 (7.03, far8): Wow.exe has no room or furniture distance — 0x007b6110 keeps a map object's groups while their
// boxes meet the ±far-clip box and the portal walk decides; a map object's doodads go by the outdoor size classes
// (0x007babc0, 0x007bc490). The faithful lighting levels follow it: the open-air room leash is the reach, small outdoor
// groups of big map objects are held to it too, and a bound doodad takes its class within the rooms' leash.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { WmoRangeTable } from "../dist/code/browser/WmoGroupRange.js";
import { WMO_OPEN_AIR_ROOM_RANGE, wmoOpenAirRoomRange } from "../dist/code/browser/WmoOpenAir.js";
import { boundDoodadClassLeash, clearDoodadModelBoxes, recordDoodadModelBox } from "../dist/code/browser/DoodadReach.js";
import { admitEnvironmentInto, wmoShellRange } from "../dist/code/browser/WorldRenderer3D.js";
import { FAITHFUL_ADMISSION_QUOTA, admissionQuota } from "../dist/code/browser/AdmissionQuotas.js";

const box = (x, z, size) => new THREE.Box3(new THREE.Vector3(x, 0, z), new THREE.Vector3(x + size, size, z + size));

/** A big map object's groups: a 20-yard outdoor kiosk, a 150-yard outdoor plaza and a 10-yard room, 600 yards east. */
function city() {
  const groups = [
    { triangleCount: 10, exterior: true, indoor: false },
    { triangleCount: 10, exterior: true, indoor: false },
    { triangleCount: 10, exterior: false, indoor: true },
  ];
  return { model: { groups }, boxes: [box(600, 0, 20), box(600, 30, 150), box(600, -40, 10)] };
}

test("the open-air room leash is the faithful reach and 150 yards on the enhanced levels", () => {
  assert.equal(wmoOpenAirRoomRange(true, 1277), 1277);
  assert.equal(wmoOpenAirRoomRange(true, 750), 750);
  assert.equal(wmoOpenAirRoomRange(false, 1100), WMO_OPEN_AIR_ROOM_RANGE);
  assert.equal(wmoOpenAirRoomRange(true, Number.NaN), WMO_OPEN_AIR_ROOM_RANGE, "a broken reach keeps the old leash");
});

test("from 600 yards the faithful table holds the kiosk and, through its portals, the room; the enhanced one neither", () => {
  const { model, boxes } = city();
  const skyline = (b) => wmoShellRange(b, 1277);
  const enhanced = new WmoRangeTable(model, boxes, WMO_OPEN_AIR_ROOM_RANGE, skyline);
  enhanced.setShellCap(1100, 0, false);
  enhanced.setRoomRange(wmoOpenAirRoomRange(false, 1100));
  assert.deepEqual(enhanced.select(0, 0), [1], "the kiosk stops at 250 yards, the room at 150; the plaza is skyline");
  const faithful = new WmoRangeTable(model, boxes, WMO_OPEN_AIR_ROOM_RANGE, skyline);
  faithful.setShellCap(1277, 0, true);
  faithful.setRoomRange(wmoOpenAirRoomRange(true, 1277));
  assert.deepEqual(faithful.select(0, 0), [0, 1, 2]);
  // Switching back recomputes at once, on the same spot.
  faithful.setShellCap(1100, 0, false);
  faithful.setRoomRange(WMO_OPEN_AIR_ROOM_RANGE);
  assert.deepEqual(faithful.select(0, 0), [1]);
});

test("a bound doodad takes its size class within the rooms' leash on the faithful levels only", () => {
  clearDoodadModelBoxes();
  const doodad = (name) => ({ id: -1, kind: "m2", name, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0,
    scale: 1, interior: true, quaternionX: 0, quaternionY: 0, quaternionZ: 0, quaternionW: 1 });
  const cup = doodad("cup.m2");
  const shelf = doodad("shelf.m2");
  assert.equal(boundDoodadClassLeash(cup, 1277, 1), 1277, "before its box is known the rooms' leash holds it");
  recordDoodadModelBox("cup.m2", { min: [-0.2, -0.2, 0], max: [0.2, 0.2, 0.3] });
  recordDoodadModelBox("shelf.m2", { min: [-1, -0.5, 0], max: [1, 0.5, 2.5] });
  assert.equal(boundDoodadClassLeash(cup, 1277, 1), 30, "class 0");
  assert.equal(boundDoodadClassLeash(shelf, 1277, 1.5), 150, "class 1 at environmentDetail 1.5");
  assert.equal(boundDoodadClassLeash(shelf, 60, 1.5), 60, "never past the rooms' own leash");
  assert.equal(boundDoodadClassLeash(cup, 150, undefined), 150, "the enhanced levels keep the leash");
});

test("7.05: the faithful levels admit every candidate their distance rules keep; the enhanced ones keep 1,024 doodads", () => {
  assert.equal(admissionQuota(48, false), 48);
  assert.equal(admissionQuota(48, true), FAITHFUL_ADMISSION_QUOTA);
  // 1,500 loose doodads in range (Dalaran's view held 2,817 candidates over the 1,024 quota).
  const candidates = Array.from({ length: 1500 }, (_, index) => ({
    object: { id: index + 1, kind: "m2", name: "x.m2", x: index, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 },
    distance: index * 0.5, range: 1250,
  }));
  assert.equal(admitEnvironmentInto(candidates, [], undefined, 0, []).length, 1024);
  assert.equal(admitEnvironmentInto(candidates, [], undefined, 0, [], undefined, undefined, true).length, 1500);
});
