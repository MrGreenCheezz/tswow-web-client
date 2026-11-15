// 15.11 (7.66 tail, 7.03): the faithful levels draw the world's objects as Wow.exe does — map objects to the far clip,
// doodads by size class (0x007bdb10, 0x0078f570, 0x00791cb0), the reach ending where the fog closes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DOODAD_CLASS_DISTANCES, clearDoodadModelBoxes, doodadClassDistance, doodadOriginalReach, doodadSizeClass, doodadWorldSide,
  recordDoodadModelBox,
} from "../dist/code/browser/DoodadReach.js";
import { environmentHouseRange, environmentShellRange, environmentStreamRange, faithfulReach } from "../dist/code/browser/SceneryReach.js";
import { environmentDrawRange, environmentRankInRange } from "../dist/code/browser/WorldRenderer3D.js";

const m2 = (name, extra = {}) => ({
  id: 1, kind: "m2", name, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, ...extra,
});

test("a doodad's class is set by the largest side of its world box: under 1, 4, 15 and 100 yards (0x00adf350)", () => {
  assert.deepEqual([0.99, 1, 3.99, 4, 14.99, 15, 99.9, 100, 400].map(doodadSizeClass), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test("each class's distance: 30, 100·d, 200·d, 750·d, 1250 (0x0078f570; classes 0 and 4 unscaled)", () => {
  assert.deepEqual(DOODAD_CLASS_DISTANCES, [30, 100, 200, 750, 1250]);
  assert.deepEqual([0, 1, 2, 3, 4].map((c) => doodadClassDistance(c, 1)), [30, 100, 200, 750, 1250]);
  assert.deepEqual([0, 1, 2, 3, 4].map((c) => doodadClassDistance(c, 1.5)), [30, 150, 300, 1125, 1250]);
  assert.deepEqual([0, 1, 2, 3, 4].map((c) => doodadClassDistance(c, 0.5)), [30, 50, 100, 375, 1250]);
});

test("Netherstorm's NS_Rock_03 at the stand's environmentDetail 1.5 is class 3, drawn to 1,125 yards", () => {
  clearDoodadModelBoxes();
  // The model's header box (World\Expansion01\Doodads\Netherstorm\Rocks\NS_Rock_03.m2, 0xA0) and its origin radius
  // 10.0926; the stand frame fog6-o-netherstorm drew one of them, scale 1.437, at 1,125 yards.
  const rock = m2("World\\Expansion01\\Doodads\\Netherstorm\\Rocks\\NS_Rock_03.m2", { scale: 1.437, admissionRadius: 10.0926 });
  assert.equal(doodadWorldSide(rock), undefined, "no box before a placement of the model is built");
  assert.equal(doodadOriginalReach(rock, 1.5), 1125, "the bound from twice the radius (29 yards) is class 3 too");
  recordDoodadModelBox(rock.name.toUpperCase(), { min: [-5.7834, -2.8641, -0.7777], max: [6.9587, 3.2378, 9.8572] });
  assert.ok(Math.abs(doodadWorldSide(rock) - 12.7421 * 1.437) < 1e-3);
  assert.equal(doodadOriginalReach(rock, 1.5), 1125);
  assert.equal(doodadOriginalReach(rock, 1), 750);
});

test("the box is carried through the placement's rotation; before it is known the radius bound never under-reaches", () => {
  clearDoodadModelBoxes();
  const plank = m2("plank.m2", { rotationY: 45, admissionRadius: 5.1 });
  // Twice the radius bounds every side: 10.2 yards, class 2.
  assert.equal(doodadOriginalReach(plank, 1), 200);
  recordDoodadModelBox("plank.m2", { min: [-5, -1, 0], max: [5, 1, 0.5] });
  // Turned 45° about the vertical, its 10 × 2 footprint spans (10 + 2)/√2 on both axes.
  assert.ok(Math.abs(doodadWorldSide(plank) - 12 / Math.SQRT2) < 1e-6);
  assert.equal(doodadOriginalReach(plank, 1), 200);
  const small = m2("pebble.m2", { admissionRadius: 0.4 });
  recordDoodadModelBox("pebble.m2", { min: [-0.3, -0.3, 0], max: [0.3, 0.3, 0.2] });
  assert.equal(doodadOriginalReach(small, 1.5), 30, "class 0 is 30 yards whatever the detail");
  // A WMO's doodad carries a quaternion in the scene's frame: a quarter turn about the scene's vertical (y).
  const turned = m2("plank.m2", { quaternionX: 0, quaternionY: Math.SQRT1_2, quaternionZ: 0, quaternionW: Math.SQRT1_2 });
  assert.ok(Math.abs(doodadWorldSide(turned) - 10) < 1e-6, "a quarter turn keeps the 10-yard side");
  recordDoodadModelBox("empty.m2", { min: [0, 0, 0], max: [0, 0, 0] });
  assert.equal(doodadWorldSide(m2("empty.m2")), undefined, "a model written without a header box has none");
});

test("the faithful reach is the far clip where the fog reaches it, never under 750, in 50-yard steps", () => {
  assert.equal(faithfulReach(1277), 1277, "maps from 530 up: the fog ends at the far clip");
  assert.equal(faithfulReach(500), 750, "Stormwind's 500-yard fog (725 at the screen's corner) keeps the levels' former 750");
  assert.equal(faithfulReach(700), 1050, "a 700-yard fog still shows 1,015 yards out at the corner");
  assert.equal(faithfulReach(2880), 1277);
  assert.equal(faithfulReach(Number.NaN), 750);
  assert.equal(environmentShellRange(3, faithfulReach(1277)), 1277);
  assert.equal(environmentShellRange(0, faithfulReach(1277)), 1277);
  assert.equal(environmentShellRange(2, faithfulReach(1277)), 1100, "the enhanced path keeps its own skyline");
  assert.equal(environmentStreamRange(1277, 1.5), 1337, "the placements are streamed to the reach");
  assert.equal(environmentHouseRange(1277, true), 1277, "Wow.exe has no house leash");
  assert.equal(environmentHouseRange(1277), 1100);
  assert.equal(environmentHouseRange(750, true), 0, "at 750 the faithful levels need no house leash");
});

test("on the faithful levels every outdoor map object reaches the far clip and a doodad its class", () => {
  clearDoodadModelBoxes();
  const hut = { id: 2, kind: "wmo", name: "World\\wmo\\hut.wmo", x: 1000, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
    bounds: { minX: 990, minY: -7, minZ: 0, maxX: 1010, maxY: 7, maxZ: 10 } };
  assert.equal(environmentDrawRange(hut, 1, 1277, true), 1277);
  assert.equal(environmentDrawRange(hut, 1, 1277), 1100, "the enhanced path: the house leash");
  assert.equal(environmentRankInRange([hut], { x: 0, y: 0 }, 1, 1277, true).candidates.length, 1, "a 14-yard hut 990 yards out");
  assert.equal(environmentRankInRange([hut], { x: 0, y: 0 }, 1, 750).candidates.length, 0, "before: past 400 yards");
  const tree = m2("tree.m2", { admissionRadius: 40 });
  recordDoodadModelBox("tree.m2", { min: [-20, -20, 0], max: [20, 20, 60] });
  assert.equal(environmentDrawRange(tree, 1, 1277, true), 750, "a 60-yard tree is class 3");
  assert.equal(environmentDrawRange(tree, 1, 750), 600, "the size-scaled leash the enhanced path keeps");
  const big = m2("biodome.m2", { admissionRadius: 420 });
  assert.equal(environmentDrawRange(big, 1, 1277, true), 1250, "class 4");
  assert.equal(environmentDrawRange(big, 1, 900, true), 900, "held to the reach where the fog closes first");
  const unknown = m2("emitter.m2");
  assert.equal(environmentDrawRange(unknown, 1, 1277, true), 1277, "no size known: the reach until the model is built");
  assert.equal(environmentDrawRange(unknown, 1, 1277), 400, "the enhanced path keeps the former leash");
  recordDoodadModelBox("emitter.m2", { min: [-2, -2, 0], max: [2, 2, 3] });
  assert.equal(environmentDrawRange(unknown, 1, 1277, true), 200, "then its class: a 4-yard model is class 2");
  assert.equal(recordDoodadModelBox("emitter.m2", { min: [-9, -9, 0], max: [9, 9, 9] }), false, "a model's box is learnt once");
  const room = m2("chair.m2", { interior: true });
  assert.equal(environmentDrawRange(room, 1, 1277, true), 60, "rooms keep their own leash");
});
