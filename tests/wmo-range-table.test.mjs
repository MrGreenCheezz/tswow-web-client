import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { WmoRangeTable, sameWmoSelection } from "../dist/code/browser/WmoGroupRange.js";
import { wmoGroupsInRange, wmoShellRange } from "../dist/code/browser/WorldRenderer3D.js";

// P1-12a (ENV-7): a placed building's distance rooms answered from a rest radius. The reference is
// the unchanged `wmoGroupsInRange`; the table must agree with it on every call, bit for bit.

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 300 groups over 2000 x 2000 yards: 10 % without a box, 5 % empty, shells and rooms mixed. */
function syntheticBuilding(seed) {
  const next = random(seed);
  const groups = [];
  const boxes = [];
  for (let index = 0; index < 300; index++) {
    const roll = next();
    const exterior = next() < 0.3;
    const indoor = next() < 0.7;
    groups.push({ triangleCount: roll < 0.05 ? 0 : 1 + Math.floor(next() * 500), exterior, indoor });
    if (roll >= 0.05 && roll < 0.15) {
      boxes.push(undefined);
      continue;
    }
    const x = -1000 + next() * 2000;
    const z = -1000 + next() * 2000;
    const y = next() * 50;
    // Mostly rooms; one in eight wide enough for the far shell leash.
    const size = next() < 0.125 ? 90 + next() * 120 : 2 + next() * 40;
    boxes.push(new THREE.Box3(new THREE.Vector3(x, y, z), new THREE.Vector3(x + size * next(), y + size * next(), z + size)));
  }
  return { model: { groups }, boxes };
}

const reference = ({ model, boxes }, x, y, shell) => wmoGroupsInRange(model, boxes, { x, y, z: 7 }, 60, shell);

test("P1-12a: 20,000 walk steps of up to 3 yards answer exactly what wmoGroupsInRange does", () => {
  for (const seed of [1, 2, 3]) {
    const building = syntheticBuilding(seed);
    const table = new WmoRangeTable(building.model, building.boxes, 60, wmoShellRange);
    const next = random(seed + 100);
    let x = -200 + next() * 400;
    let y = -200 + next() * 400;
    let previous;
    for (let step = 0; step < 20_000; step++) {
      const roll = next();
      if (roll < 0.2) {
        // Standing still.
      } else if (roll < 0.995) {
        const angle = next() * Math.PI * 2;
        const distance = next() * 3;
        x += Math.cos(angle) * distance;
        y += Math.sin(angle) * distance;
      } else {
        // A teleport.
        x = -1200 + next() * 2400;
        y = -1200 + next() * 2400;
      }
      const answer = table.select(x, y);
      const expected = reference(building, x, y);
      assert.deepEqual(answer, expected, `seed ${seed} step ${step} at ${x}, ${y}`);
      if (previous && sameWmoSelection(previous, expected)) {
        assert.equal(answer, previous, `seed ${seed} step ${step}: an unchanged set is the same array`);
      }
      previous = answer;
    }
  }
});

test("P1-12a: at walking pace at least nine frames in ten reuse the set", () => {
  for (const seed of [4, 5, 6]) {
    const building = syntheticBuilding(seed);
    const table = new WmoRangeTable(building.model, building.boxes, 60, wmoShellRange);
    const next = random(seed + 200);
    let x = -100 + next() * 200;
    let y = -100 + next() * 200;
    let heading = next() * Math.PI * 2;
    const frames = 20_000;
    for (let frame = 0; frame < frames; frame++) {
      // Run speed (7 yd/s) at 60 frames a second, turning a little; a quarter of frames stand still.
      if (next() >= 0.25) {
        heading += (next() - 0.5) * 0.2;
        x += Math.cos(heading) * 7 / 60;
        y += Math.sin(heading) * 7 / 60;
      }
      assert.deepEqual(table.select(x, y), reference(building, x, y), `seed ${seed} frame ${frame}`);
    }
    const reuse = 1 - table.recomputes / frames;
    assert.ok(reuse >= 0.9, `seed ${seed}: ${(reuse * 100).toFixed(1)} % of frames reused the set`);
  }
});

test("P1-12a: NaN and infinite positions answer as the reference and never stick", () => {
  const building = syntheticBuilding(7);
  const table = new WmoRangeTable(building.model, building.boxes, 60, wmoShellRange);
  const points = [[0, 0], [Number.NaN, 0], [0, Number.NaN], [0, 0], [Infinity, 0], [Infinity, 0], [-Infinity, 5],
    [0, Infinity], [10, 10], [Number.NaN, Number.NaN], [10, 10], [-Infinity, -Infinity], [10.5, 10]];
  for (const [x, y] of points) assert.deepEqual(table.select(x, y), reference(building, x, y), `${x}, ${y}`);
});

test("P1-12a: the transport shell leash is honoured and switching it recomputes", () => {
  const building = syntheticBuilding(8);
  const table = new WmoRangeTable(building.model, building.boxes, 60, wmoShellRange);
  const next = random(9);
  let x = 0;
  let y = 0;
  for (let step = 0; step < 2000; step++) {
    const shell = next() < 0.3 ? 900 : next() < 0.1 ? 30 : undefined;
    x += (next() - 0.5) * 4;
    y += (next() - 0.5) * 4;
    assert.deepEqual(table.select(x, y, shell), reference(building, x, y, shell), `step ${step} shell ${shell}`);
  }
});

test("P1-12a: a building with no ranged group never recomputes after the first answer", () => {
  const model = { groups: [{ triangleCount: 3, exterior: true, indoor: false }, { triangleCount: 0, exterior: false, indoor: true }] };
  const table = new WmoRangeTable(model, [undefined, new THREE.Box3()], 60, wmoShellRange);
  const first = table.select(0, 0);
  assert.deepEqual(first, [0]);
  assert.equal(table.select(5000, -3000), first);
  assert.equal(table.recomputes, 1);
});

test("P1-12a: the reference and the shell rule stay untouched in the renderer", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(Math\.hypot\(outsideX, outsideZ\) < range\) chosen\.push\(index\);/);
  assert.match(source, /ranges: new WmoRangeTable\(model, boxes, INTERIOR_RANGE, wmoShellRange\), \/\/ P1-12a/);
  const placed = source.slice(source.indexOf("interface PlacedWmo {"), source.indexOf("\n}\n", source.indexOf("interface PlacedWmo {")));
  assert.ok(!placed.includes("rangePlayer") && !placed.includes("rangeGroups"), "the exact-position cache is gone");
});
