// 22.10 (7.44): the enhanced path's far leash for houses (small outdoor WMOs).
// Under 7.39's 2.5 km fog the 250-yard house shells and the 750-yard cap on big rocks showed; the
// faithful levels (shell range 750) keep every leash they had.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  ENVIRONMENT_FAR_RANGE, ENVIRONMENT_RANGE, environmentDrawRange, selectEnvironmentAdmission, wmoHousePlacement,
} from "../dist/code/browser/WorldRenderer3D.js";
import {
  ENVIRONMENT_HOUSE_RANGE, environmentHouseRange, environmentShellRange,
} from "../dist/code/browser/SceneryReach.js";
import { WmoRangeTable } from "../dist/code/browser/WmoGroupRange.js";

const ENHANCED = environmentShellRange(2);
const FAITHFUL = environmentShellRange(0);

function wmo(id, x, size, options = {}) {
  return {
    id, kind: "wmo", name: options.name ?? `World\\wmo\\Azeroth\\Buildings\\${id}.wmo`, x, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
    bounds: { minX: x - size / 2, maxX: x + size / 2, minY: -size / 2, maxY: size / 2, minZ: 0, maxZ: size / 4 },
  };
}

function m2(id, x, radius, name = `World\\Doodads\\${id}.m2`) {
  return { id, kind: "m2", name, x, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, admissionRadius: radius };
}

test("a house keeps the house leash on the enhanced path and 400 yards on the faithful ones", () => {
  assert.equal(ENHANCED, 1100);
  assert.equal(FAITHFUL, ENVIRONMENT_FAR_RANGE);
  const house = wmo("farm", 0, 40);
  assert.equal(wmoHousePlacement(house), true);
  assert.equal(wmoHousePlacement(wmo("castle", 0, 300)), false, "a far-tier WMO is not a house");
  assert.equal(environmentHouseRange(FAITHFUL), 0);
  assert.equal(environmentHouseRange(ENHANCED), ENVIRONMENT_HOUSE_RANGE);
  assert.equal(environmentDrawRange(house, 1.5, ENHANCED), ENVIRONMENT_HOUSE_RANGE);
  assert.equal(environmentDrawRange(house, 1.5, FAITHFUL), ENVIRONMENT_RANGE);
  assert.equal(environmentDrawRange(wmo("castle", 0, 300), 1.5, ENHANCED), ENHANCED, "the skyline as before");
});

test("a house past the near leash is admitted on the far quota when ranked with the house leash", () => {
  const house = wmo("farm", 600, 40);
  const planes = [];
  const enhanced = selectEnvironmentAdmission([{ object: house, distance: 600, range: environmentDrawRange(house, 1.5, ENHANCED) }], planes);
  assert.deepEqual(enhanced.map(({ object }) => object.id), ["farm"]);
  const faithful = selectEnvironmentAdmission([{ object: house, distance: 600, range: environmentDrawRange(house, 1.5, FAITHFUL) }], planes);
  assert.deepEqual(faithful, []);
});

test("a house's outdoor shell groups take the house leash; its rooms do not", () => {
  const model = { groups: [
    { triangleCount: 10, exterior: true, indoor: false },
    { triangleCount: 10, exterior: false, indoor: true },
  ] };
  const box = (x) => new THREE.Box3(new THREE.Vector3(x - 10, 0, -10), new THREE.Vector3(x + 10, 10, 10));
  const boxes = [box(600), box(600)];
  const shell = () => 250; // a small shell's box-earned leash (WMO_EXTERIOR_RANGE)
  const house = new WmoRangeTable(model, boxes, 60, shell, true);
  house.setShellCap(FAITHFUL, environmentHouseRange(FAITHFUL));
  assert.deepEqual([...house.select(0, 0)], [], "faithful: 250 yards, as before");
  house.setShellCap(ENHANCED, environmentHouseRange(ENHANCED));
  assert.deepEqual([...house.select(0, 0)], [0], "enhanced: the shell at 590 yards, never the room");
  const notHouse = new WmoRangeTable(model, boxes, 60, shell);
  notHouse.setShellCap(ENHANCED, environmentHouseRange(ENHANCED));
  assert.deepEqual([...notHouse.select(0, 0)], [], "a big WMO's small exterior bits keep 250");
});

test("loose M2s keep the scenery cap on both paths: the landmark step was measured and left out", () => {
  const rock = m2("cliffrock", 0, 20);
  assert.equal(environmentDrawRange(rock, 1.5, ENHANCED), ENVIRONMENT_FAR_RANGE);
  assert.equal(environmentDrawRange(rock, 1.5, FAITHFUL), ENVIRONMENT_FAR_RANGE);
  assert.equal(environmentDrawRange(m2("crate", 0, 4), 1.5, ENHANCED), 300, "small M2s unchanged");
});
