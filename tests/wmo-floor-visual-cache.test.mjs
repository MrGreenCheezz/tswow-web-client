import assert from "node:assert/strict";
import test from "node:test";

import {
  UniqueVisualWmoPlacementCache, uniqueVisualWmoPlacement,
} from "../dist/code/browser/WorldRenderer3D.js";

const raw = {
  spawnId: 1, map: 0, key: "0:1", modelName: "GoldshireInn.wmo", canonicalModelName: "goldshireinn.wmo",
  x: -9464.5, y: 62.25, z: 55.9, rotationX: 0, rotationY: 270, rotationZ: 0, scale: 1,
};
const visual = (id, name = "World\\wmo\\Azeroth\\Buildings\\GoldshireInn.wmo") => ({
  id, kind: "wmo", name, x: raw.x, y: raw.y, z: raw.z, rotationX: 0, rotationY: -90, rotationZ: 0, scale: 1,
});
const doodad = (id) => ({ id, kind: "m2", name: `World\\tree${id}.m2`, x: id, y: id, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 });

/** An array whose element reads are counted: one full scan reads every index once. */
function counted(objects) {
  let reads = 0;
  const proxy = new Proxy(objects, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, reads: () => reads };
}

test("the same floor over the same loaded placements is answered without a second scan", () => {
  const objects = [...Array.from({ length: 500 }, (_, index) => doodad(index)), visual(71414)];
  const { proxy, reads } = counted(objects);
  const cache = new UniqueVisualWmoPlacementCache();
  assert.equal(cache.lookup(raw, proxy)?.id, 71414);
  const afterFirst = reads();
  assert.equal(afterFirst, objects.length, "the first answer is one full scan");
  for (let frame = 0; frame < 60; frame++) assert.equal(cache.lookup(raw, proxy)?.id, 71414);
  assert.equal(reads(), afterFirst, "sixty more frames read nothing");
});

test("a landed tile (new array), another floor or another map scans again", () => {
  const cache = new UniqueVisualWmoPlacementCache();
  const first = [visual(1)];
  assert.equal(cache.lookup(raw, first)?.id, 1);
  const landed = [visual(1), doodad(2)];
  assert.equal(cache.lookup(raw, landed)?.id, 1);
  const { proxy, reads } = counted([visual(3)]);
  assert.equal(cache.lookup({ ...raw, key: "0:2" }, proxy)?.id, 3, "a different placement key is looked up");
  assert.equal(reads(), 1);
  assert.equal(cache.lookup({ ...raw, key: "0:2", map: 1 }, proxy)?.id, 3, "the same key on another map is looked up");
  assert.equal(reads(), 2);
  // An ambiguous answer is remembered as such: still no rescan for equal inputs.
  const twins = [visual(5), visual(6)];
  assert.equal(cache.lookup(raw, twins), undefined);
  assert.equal(cache.lookup(raw, twins), undefined);
});

test("the cached answer is exactly the scan's answer", () => {
  const cache = new UniqueVisualWmoPlacementCache();
  for (const objects of [[], [doodad(1)], [visual(9)], [visual(9), visual(10)], [doodad(1), visual(11), doodad(2)]]) {
    assert.equal(cache.lookup(raw, objects), uniqueVisualWmoPlacement(raw, objects));
  }
});
