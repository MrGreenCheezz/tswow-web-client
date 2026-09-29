import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ENVIRONMENT_SPATIAL_CELL_SIZE,
  ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES,
  ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT,
  EnvironmentSpatialIndex,
} from "../dist/code/browser/EnvironmentSpatialIndex.js";
import { ENVIRONMENT_RANGE, ENVIRONMENT_SCENERY_BUDGET, selectEnvironment, environmentCandidatesInRange,
  environmentResidentsInRange, selectEnvironmentAdmission } from "../dist/code/browser/WorldRenderer3D.js";
import { ENVIRONMENT_RESIDENT_HYSTERESIS, ENVIRONMENT_STREAM_RANGE } from "../dist/code/browser/Terrain.js";

const CELL_SIZE = 128;

function placement(id, x, y, bounds) {
  return {
    id,
    kind: "m2",
    name: `World\\Object${id}.m2`,
    x,
    y,
    z: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scale: 1,
    ...(bounds === undefined ? {} : { bounds }),
  };
}

function bounds(minX, minY, maxX, maxY) {
  return { minX, minY, minZ: -1, maxX, maxY, maxZ: 1 };
}

function ids(result) {
  return result.objects.map((object) => object.id);
}

function frozenObjects(objects) {
  return Object.freeze(objects.map((object) => Object.freeze(
    object.bounds === undefined
      ? object
      : { ...object, bounds: Object.freeze({ ...object.bounds }) },
  )));
}

test("EnvironmentSpatialIndex exports the fixed conservative-bin contract", () => {
  assert.equal(ENVIRONMENT_SPATIAL_CELL_SIZE, CELL_SIZE);
  assert.equal(ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT, 256);
  assert.equal(typeof EnvironmentSpatialIndex, "function");

  const source = frozenObjects([placement("one", 0, 0)]);
  const index = new EnvironmentSpatialIndex(source);
  assert.deepEqual(ids(index.query(0, 0, 1)), ["one"]);
});

test("spatial bins include negative, edge, and corner placements once in source order", () => {
  const objects = frozenObjects([
    placement("corner-ne", CELL_SIZE + 0.001, CELL_SIZE + 0.001),
    placement("corner-sw", CELL_SIZE - 0.001, CELL_SIZE - 0.001),
    placement("corner-nw", CELL_SIZE - 0.001, CELL_SIZE + 0.001),
    placement("corner-se", CELL_SIZE + 0.001, CELL_SIZE - 0.001),
    placement("exact-edge", CELL_SIZE, CELL_SIZE),
    placement("negative-edge", -CELL_SIZE, -CELL_SIZE),
  ]);
  const index = new EnvironmentSpatialIndex(objects, CELL_SIZE);

  const aroundPositiveCorner = index.query(CELL_SIZE, CELL_SIZE, 1);
  assert.deepEqual(ids(aroundPositiveCorner), [
    "corner-ne", "corner-sw", "corner-nw", "corner-se", "exact-edge",
  ]);
  assert.equal(new Set(ids(aroundPositiveCorner)).size, aroundPositiveCorner.objects.length);

  const aroundNegativeCorner = index.query(-CELL_SIZE, -CELL_SIZE, 1);
  assert.deepEqual(ids(aroundNegativeCorner), ["negative-edge"]);
});

test("an AABB spanning cells is conservatively admitted and never duplicated", () => {
  const spanning = placement("spanning", 384, 0, bounds(-1, -1, CELL_SIZE + 1, 1));
  const objects = frozenObjects([
    placement("far", 1_000, 0),
    spanning,
    placement("near", 0, 0),
  ]);
  const result = new EnvironmentSpatialIndex(objects, CELL_SIZE).query(0, 0, 0);

  assert.deepEqual(ids(result), ["spanning", "near"]);
  assert.equal(new Set(result.objects).size, result.objects.length);
});

test("spatial query is output-equivalent to legacy selection across mixed quota scenes", () => {
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  // Loose outdoor M2s: the scenery quota, saturated by ten past it.
  const exteriorNear = ENVIRONMENT_SCENERY_BUDGET - 10;
  const exterior = Array.from({ length: ENVIRONMENT_SCENERY_BUDGET + 10 }, (_, index) =>
    placement(
      `exterior-${index}`,
      index % 2 === 0
        ? -(index < exteriorNear ? 96 : ENVIRONMENT_RANGE - 0.0001)
        : (index < exteriorNear ? 96 : ENVIRONMENT_RANGE - 0.0001),
      0,
    ),
  );
  const exteriorBoxes = Array.from({ length: 4 }, (_, index) =>
    placement(`exterior-box-${index}`, 1_000 + index, 1_000, bounds(-2, -2, 2, 2)),
  );
  const interior = Array.from({ length: 365 }, (_, index) =>
    placement(
      `interior-${index}`,
      index % 2 === 0
        ? -(index < 355 ? 32 : 59.9999)
        : (index < 355 ? 32 : 59.9999),
      0,
    ),
  ).map((object) => ({ ...object, interior: true }));
  const interiorBoxes = Array.from({ length: 4 }, (_, index) =>
    ({ ...placement(`interior-box-${index}`, -1_000 - index, -1_000, bounds(-2, -2, 2, 2)), interior: true }),
  );
  const all = frozenObjects([
    ...exterior,
    ...exteriorBoxes,
    placement("exterior-inside-boundary", ENVIRONMENT_RANGE - 0.001, 0),
    placement("exterior-strict-boundary", ENVIRONMENT_RANGE, 0),
    ...interior,
    ...interiorBoxes,
    { ...placement("interior-inside-boundary", 59.999, 0), interior: true },
    { ...placement("interior-strict-boundary", 60, 0), interior: true },
  ]);

  const legacy = selectEnvironment(all, player);
  const spatialObjects = new EnvironmentSpatialIndex(all).query(player.x, player.y, ENVIRONMENT_RANGE).objects;
  const spatial = selectEnvironment(spatialObjects, player);

  assert.equal(legacy.length, ENVIRONMENT_SCENERY_BUDGET + 360, "both quotas are saturated in the mixed scene");
  assert.equal(spatial.length, legacy.length);
  for (let index = 0; index < legacy.length; index++) {
    assert.equal(spatial[index].object, legacy[index].object, `object identity at rank ${index}`);
    assert.equal(spatial[index].distance, legacy[index].distance, `distance at rank ${index}`);
  }
  for (const id of ["exterior-strict-boundary", "interior-strict-boundary"]) {
    assert.equal(legacy.some(({ object }) => object.id === id), false, `${id} stays strictly out`);
    assert.equal(spatial.some(({ object }) => object.id === id), false, `${id} stays strictly out after bins`);
  }
  for (const id of ["exterior-inside-boundary", "interior-inside-boundary"]) {
    assert.equal(legacy.some(({ object }) => object.id === id), true, `${id} remains eligible`);
    assert.equal(spatial.some(({ object }) => object.id === id), true, `${id} remains eligible after bins`);
  }
});

test("the index-entry budget sends a valid overflow placement to the ordered fail-open fallback", () => {
  assert.equal(ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES, 262_144);
  assert.equal(ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES % ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT, 0);
  const cellsPerFootprint = ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT;
  const footprintCount = ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES / cellsPerFootprint;
  const footprint = bounds(0, 0, CELL_SIZE * 15, CELL_SIZE * 15);
  const repeated = Array.from({ length: footprintCount }, (_, index) =>
    placement(`budget-${index}`, 1, 1, footprint),
  );
  const malformed = placement("fallback-before", Number.NaN, 0);
  const overflow = placement("overflow-after-budget", 20_000, 20_000);
  const objects = frozenObjects([malformed, ...repeated, overflow]);
  const index = new EnvironmentSpatialIndex(objects, CELL_SIZE);

  // The 16x16 query covers exactly the repeated AABB footprint. Every one of its 1024 objects
  // contributes 256 indexed entries; malformed and overflow entries are the only fallback work.
  const indexed = index.query(CELL_SIZE * 7.5, CELL_SIZE * 7.5, CELL_SIZE * 7.5);
  assert.equal(indexed.visitedEntries, ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES + 2);
  assert.equal(indexed.objects.length, objects.length);

  // This cell is outside both the repeated footprint and the overflow point. The overflow object
  // is therefore observable only if the total index-entry cap placed it in the fallback bucket.
  const outsideIndexedFootprint = index.query(30_000, 30_000, 0);
  assert.deepEqual(ids(outsideIndexedFootprint), ["fallback-before", "overflow-after-budget"]);
  assert.equal(outsideIndexedFootprint.objects[0], malformed);
  assert.equal(outsideIndexedFootprint.objects[1], overflow);
});

test("malformed and over-wide placements use a per-object fail-open fallback", () => {
  const malformedCoordinate = placement("bad-coordinate", Number.NaN, 0);
  const malformedBounds = placement("bad-bounds", 0, 0, bounds(0, 0, 1, 1));
  malformedBounds.bounds.minX = Number.NaN;
  const huge = placement("huge", 0, 0, bounds(-2_048, -2_048, 2_048, 2_048));
  const objects = frozenObjects([
    placement("far", 10_000, 10_000),
    malformedCoordinate,
    malformedBounds,
    placement("near", 0, 0),
    huge,
  ]);
  const result = new EnvironmentSpatialIndex(objects, CELL_SIZE).query(0, 0, 1);

  assert.deepEqual(ids(result), ["bad-coordinate", "bad-bounds", "near", "huge"]);
  assert.equal(new Set(result.objects).size, result.objects.length);
});

test("invalid queries fail open with every original object in original order", () => {
  const objects = frozenObjects([
    placement("first", -100, 0),
    placement("second", 100, 0),
    placement("third", 10_000, 10_000),
  ]);
  const index = new EnvironmentSpatialIndex(objects, CELL_SIZE);
  for (const query of [
    [Number.NaN, 0, 10],
    [0, Number.POSITIVE_INFINITY, 10],
    [0, 0, Number.NaN],
    [0, 0, Number.POSITIVE_INFINITY],
    [0, 0, -1],
  ]) {
    const result = index.query(...query);
    assert.deepEqual(result.objects, objects, `invalid query ${query.join(", ")} fails open`);
    assert.deepEqual(result.objects.map((object) => object.id), ["first", "second", "third"]);
  }
});

test("indexing and querying frozen input does not mutate objects or invoke resource paths", () => {
  const resourceReads = [];
  const span = placement("span", 200, 0, bounds(0, -1, 256, 1));
  const near = placement("near", 0, 0);
  for (const object of [span, near]) {
    Object.defineProperty(object, "name", {
      configurable: true,
      enumerable: true,
      get() {
        resourceReads.push("name");
        return `World\\Object${object.id}.m2`;
      },
    });
    Object.defineProperty(object, "model", {
      configurable: true,
      enumerable: false,
      get() {
        resourceReads.push("model");
        return undefined;
      },
    });
    Object.freeze(object);
  }
  Object.freeze(span.bounds);
  const objects = Object.freeze([span, near]);
  const beforeKeys = objects.map((object) => Object.keys(object).sort());
  const beforeCoordinates = objects.map((object) => [object.id, object.x, object.y]);
  const index = new EnvironmentSpatialIndex(objects, CELL_SIZE);
  const result = index.query(0, 0, 1);

  assert.deepEqual(objects.map((object) => Object.keys(object).sort()), beforeKeys);
  assert.deepEqual(objects.map((object) => [object.id, object.x, object.y]), beforeCoordinates);
  assert.equal(result.objects.length, 2);
  assert.equal(result.objects[0], span);
  assert.equal(result.objects[1], near);
  assert.deepEqual(resourceReads, [], "bin build/query must not perform model/path lookups");
  for (const object of objects) {
    assert.equal(Object.prototype.hasOwnProperty.call(object, "bin"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(object, "ordinal"), false);
  }
});

test("100k far placements stay outside a bounded local query", () => {
  const near = placement("near", 0, 0);
  const far = Array.from({ length: 100_000 }, (_, index) =>
    placement(`far-${index}`, 1_000_000 + index * CELL_SIZE, 1_000_000),
  );
  const objects = frozenObjects([near, ...far]);
  const result = new EnvironmentSpatialIndex(objects, CELL_SIZE).query(0, 0, 1);

  assert.deepEqual(ids(result), ["near"]);
  assert.ok(result.visitedCells <= 64,
    `local query visited ${result.visitedCells} cells, not a bounded neighborhood`);
  assert.ok(result.visitedEntries <= 64,
    `local query visited ${result.visitedEntries} entries, not local candidates`);
  assert.ok(result.visitedEntries < objects.length / 100,
    "far resident entries must not be scanned by a local query");
});

test("WorldRenderer builds the spatial index on identity changes and queries it before cached range candidates", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const spatialSource = await readFile(new URL("../src/browser/EnvironmentSpatialIndex.ts", import.meta.url), "utf8");
  assert.match(spatialSource, /Immutable[\s\S]{0,220}(?:environment object array|snapshot)/i,
    "the index documents an immutable source snapshot precondition");
  assert.match(spatialSource, /Object\.freeze\(\[\.\.\.objects\]\)/,
    "the index owns a frozen source-array snapshot");
  const updateAt = source.indexOf("#updateEnvironment(player:");
  const endAt = source.indexOf("  #disposeEnvironment(", updateAt);
  assert.ok(updateAt >= 0 && endAt > updateAt, "WorldRenderer3D updateEnvironment is present");
  const update = source.slice(updateAt, endAt);

  const identityAt = update.indexOf("objects !== this.#environmentObjects");
  const candidatesAt = update.indexOf("this.#environmentCandidates = environmentCandidatesInRange(");
  const admissionAt = update.indexOf("selectEnvironmentAdmission(");
  assert.ok(identityAt >= 0, "environment identity is the rebuild key");
  assert.ok(candidatesAt > identityAt, "exact range candidates remain in the identity/movement-gated update");
  assert.ok(admissionAt > candidatesAt, "camera visibility admission follows the cached range answer");

  const guardStart = update.indexOf("{", identityAt);
  assert.ok(guardStart > identityAt, "identity guard has a body");
  let depth = 0;
  let guardEnd = -1;
  for (let index = guardStart; index < update.length; index++) {
    if (update[index] === "{") depth++;
    else if (update[index] === "}" && --depth === 0) {
      guardEnd = index + 1;
      break;
    }
  }
  assert.ok(guardEnd > guardStart, "identity guard closes");
  const identityBlock = update.slice(identityAt, guardEnd);
  assert.match(identityBlock, /new\s+EnvironmentSpatialIndex\s*\(/,
    "the index is constructed only in the objects-identity branch");

  const queryAt = update.indexOf(".queryCached(");
  assert.ok(queryAt > identityAt && queryAt < candidatesAt,
    "the spatial query feeds exact range filtering before environmentCandidatesInRange runs");
  assert.match(update.slice(candidatesAt, admissionAt), /#environmentCandidatesAt\s*=\s*\{/,
    "only distance candidates share the four-yard cache; frustum admission stays outside it");
});

test("cached queries reuse one exact cell rectangle and expose immutable pools without changing legacy query ownership", () => {
  const first = placement("first", 0, 0), second = placement("second", 128, 0);
  const index = new EnvironmentSpatialIndex(frozenObjects([first, second]));
  const cached = index.queryCached(4, 4, 1);
  assert.equal(index.queryCached(5, 5, 1), cached);
  assert.equal(index.queryCached(5, 5, 2), cached, "range changes are safe only when all cell edges remain identical");
  assert.equal(Object.isFrozen(cached), true);
  assert.equal(Object.isFrozen(cached.objects), true);
  assert.throws(() => cached.objects.push(second), TypeError);
  const legacy = index.query(4, 4, 1);
  legacy.objects.length = 0;
  assert.deepEqual(ids(index.queryCached(4, 4, 1)), ["first"]);
  assert.notEqual(index.query(4, 4, 1), legacy, "legacy queries remain fresh");
  const crossed = index.queryCached(128, 4, 1);
  assert.notEqual(crossed, cached);
  assert.deepEqual(crossed, index.query(128, 4, 1));
  assert.notEqual(index.queryCached(4, 4, 1), cached, "returning replaces the single entry instead of retaining old rectangles");
  const replacement = new EnvironmentSpatialIndex(frozenObjects([placement("replacement", 0, 0)]));
  assert.deepEqual(ids(replacement.queryCached(4, 4, 1)), ["replacement"]);
});

test("a cached raw pool still yields fresh strict-distance residents and draw admission while walking within a cell", () => {
  const source = frozenObjects([
    placement("new-candidate", ENVIRONMENT_RANGE + 3, 0),
    placement("new-resident", ENVIRONMENT_RANGE + ENVIRONMENT_RESIDENT_HYSTERESIS + 3, 0),
    placement("always", 0, 0),
  ]);
  const index = new EnvironmentSpatialIndex(source);
  const before = { x: 0, y: 0 }, after = { x: 4, y: 0 };
  const raw = index.queryCached(before.x, before.y, ENVIRONMENT_STREAM_RANGE);
  assert.equal(index.queryCached(after.x, after.y, ENVIRONMENT_STREAM_RANGE), raw);
  for (const player of [before, after]) {
    const candidates = environmentCandidatesInRange(raw.objects, player);
    const residents = environmentResidentsInRange(raw.objects, player);
    assert.deepEqual(candidates, environmentCandidatesInRange(source, player));
    assert.deepEqual(residents, environmentResidentsInRange(source, player));
    assert.deepEqual(selectEnvironmentAdmission(candidates, []), selectEnvironment(source, player));
  }
  assert.equal(environmentCandidatesInRange(raw.objects, before).some(v => v.object.id === "new-candidate"), false);
  assert.equal(environmentCandidatesInRange(raw.objects, after).some(v => v.object.id === "new-candidate"), true);
  assert.equal(environmentResidentsInRange(raw.objects, before).some(v => v.object.id === "new-resident"), false);
  assert.equal(environmentResidentsInRange(raw.objects, after).some(v => v.object.id === "new-resident"), true);
});

test("cached query parity covers custom cells, negative boundaries, spanning boxes, ordered fallbacks and invalid inputs", () => {
  const source = frozenObjects([
    placement("far", 10_000, 10_000), placement("bad", NaN, 0),
    placement("span", 250, 0, bounds(-128, -1, 129, 1)), placement("near", 0, 0),
  ]);
  for (const cellSize of [64, 128, NaN]) {
    const index = new EnvironmentSpatialIndex(source, cellSize);
    for (const args of [[0,0,0], [-128,0,1], [-127,0,1], [128,0,1], [128,1,2],
      [NaN,0,1], [0,Infinity,1], [0,0,-1], [0,0,Infinity], [Number.MAX_VALUE,0,Number.MAX_VALUE],
      [0,0,1_000_000], [0,0,0]]) {
      const cached = index.queryCached(...args);
      assert.deepEqual(cached, index.query(...args));
      assert.equal(Object.isFrozen(cached.objects), true);
    }
  }
});
