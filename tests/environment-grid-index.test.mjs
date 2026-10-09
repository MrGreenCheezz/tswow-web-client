import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT,
  ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES,
  EnvironmentSpatialIndex,
} from "../dist/code/browser/EnvironmentSpatialIndex.js";
import { EnvironmentGridIndex } from "../dist/code/browser/EnvironmentGridIndex.js";

// P2-04a: the renderer's grid index answers every query exactly as the reference index does — the
// same objects in the same order, the same visit counts, the same fail-open answers — and keeps the
// reference's `queryCached` reuse and freezing.

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function placement(id, x, y, extra = {}) {
  return { id, kind: "m2", name: `World\\Object${id}.m2`, x, y, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, ...extra };
}

function world(seed) {
  const next = random(seed);
  const objects = [];
  const spread = next() < 0.2 ? 5e8 : 3000; // a fifth of the worlds reach past the packed cell keys
  for (let index = 0, count = 20 + Math.floor(next() * 600); index < count; index++) {
    const x = (next() - 0.5) * spread, y = (next() - 0.5) * spread;
    const roll = next();
    if (roll < 0.04) objects.push(placement(index, Number.NaN, y));
    else if (roll < 0.25) {
      const w = next() < 0.1 ? 128 * 40 : next() * 400, h = next() < 0.1 ? 128 * 40 : next() * 400;
      objects.push(placement(index, x, y, { bounds: { minX: x - w, maxX: x + w, minY: y - h, maxY: y + h, minZ: 0, maxZ: 1 } }));
    } else if (roll < 0.28) {
      objects.push(placement(index, x, y, { bounds: { minX: x + 1, maxX: x, minY: y, maxY: y + 1, minZ: 0, maxZ: 1 } }));
    } else objects.push(placement(index, x, y));
  }
  return objects;
}

function same(actual, expected, label) {
  assert.equal(actual.visitedCells, expected.visitedCells, `${label}: visitedCells`);
  assert.equal(actual.visitedEntries, expected.visitedEntries, `${label}: visitedEntries`);
  assert.equal(actual.objects.length, expected.objects.length, `${label}: pool size`);
  for (let index = 0; index < expected.objects.length; index++) {
    assert.equal(actual.objects[index], expected.objects[index], `${label}: pool order at ${index}`);
  }
}

test("every query equals the reference over 200 random worlds, cell sizes and query shapes", () => {
  let nonEmpty = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed * 7919);
    const objects = world(seed);
    const cellSize = [128, 128, 64, 300, 0, Number.NaN, -5][seed % 7];
    const reference = new EnvironmentSpatialIndex(objects, cellSize);
    const grid = new EnvironmentGridIndex(objects, cellSize);
    for (let query = 0; query < 25; query++) {
      const x = query === 0 ? Number.NaN : (next() - 0.5) * (seed % 5 === 0 ? 5e8 : 3000);
      const y = (next() - 0.5) * 3000;
      const range = [0, 10, 400, 810, -1, 1e9, Number.POSITIVE_INFINITY][query % 7];
      const expected = reference.query(x, y, range);
      same(grid.query(x, y, range), expected, `seed ${seed} query ${query}`);
      if (expected.objects.length > 0 && expected.objects.length < objects.length) nonEmpty++;
    }
  }
  assert.ok(nonEmpty > 1000, `real narrowing occurs (${nonEmpty} partial pools)`);
});

test("the per-object cell limit and the global entry cap fall back exactly as the reference does", () => {
  const span = Math.sqrt(ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT) * 128;
  const count = Math.ceil(ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES / ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT) + 3;
  const objects = [];
  // Cell-aligned boxes of exactly the per-object limit, so the running total reaches the global cap
  // and the last few boxes fall back because of it (not because of their own size).
  for (let index = 0; index < count; index++) {
    const x = (index % 7) * 128, y = Math.floor(index / 7) * 128;
    objects.push(placement(index, x, y, { bounds: { minX: x, maxX: x + span - 1, minY: y, maxY: y + span - 1, minZ: 0, maxZ: 1 } }));
  }
  objects.push(placement("wide", 0, 0, { bounds: { minX: 0, maxX: span * 2, minY: 0, maxY: span * 2, minZ: 0, maxZ: 1 } }));
  objects.push(placement("point", 5000, 5000));
  const reference = new EnvironmentSpatialIndex(objects);
  const grid = new EnvironmentGridIndex(objects);
  const far = reference.query(1e6, 1e6, 1);
  assert.ok(far.objects.some((object) => typeof object.id === "number"), "boxes past the cap sit in the fallback list");
  for (const [x, y, range] of [[0, 0, 1], [5000, 5000, 1], [1e6, 1e6, 1], [3000, 3000, 2000]]) {
    same(grid.query(x, y, range), reference.query(x, y, range), `cap query ${x},${y},${range}`);
  }
});

test("cells a packed key cannot hold keep apart from the cells they would alias", () => {
  // Cell 5 and cell 5 + 2^20 (and the same far to the negative side) are different cells.
  const near = placement("near", 5 * 128 + 1, 1);
  const alias = placement("alias", (5 + 2 ** 20) * 128 + 1, 1);
  const negative = placement("negative", (5 - 2 ** 21) * 128 + 1, 1);
  const grid = new EnvironmentGridIndex([near, alias, negative]);
  const reference = new EnvironmentSpatialIndex([near, alias, negative]);
  for (const object of [near, alias, negative]) {
    const result = grid.query(object.x, object.y, 1);
    assert.deepEqual(result.objects.map((entry) => entry.id), [object.id], `${object.id} alone`);
    same(result, reference.query(object.x, object.y, 1), object.id);
  }
});

test("queryCached reuses its frozen pool while the cell rectangle holds, like the reference", () => {
  const objects = world(42).filter((object) => Math.abs(object.x) < 3000);
  const grid = new EnvironmentGridIndex(objects);
  const reference = new EnvironmentSpatialIndex(objects);
  const first = grid.queryCached(100, 100, 400);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.objects));
  assert.equal(grid.queryCached(101, 99, 400), first, "same rectangle: the same result object");
  same(first, reference.queryCached(100, 100, 400), "cached pool");
  const moved = grid.queryCached(100 + 128, 100, 400);
  assert.notEqual(moved, first);
  same(moved, reference.query(100 + 128, 100, 400), "moved pool");
  const open = grid.queryCached(Number.NaN, 0, 400);
  assert.equal(open.objects.length, objects.length, "a bad query fails open");
  assert.notEqual(grid.queryCached(100, 100, 400), first, "a fail-open query forgets the cached rectangle");
});
