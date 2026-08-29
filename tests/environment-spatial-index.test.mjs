import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ENVIRONMENT_SPATIAL_CELL_SIZE,
  ENVIRONMENT_SPATIAL_MAX_INDEX_ENTRIES,
  ENVIRONMENT_SPATIAL_MAX_CELLS_PER_OBJECT,
  EnvironmentSpatialIndex,
} from "../dist/code/browser/EnvironmentSpatialIndex.js";
import { selectEnvironment } from "../dist/code/browser/WorldRenderer3D.js";

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
  const exterior = Array.from({ length: 330 }, (_, index) =>
    placement(
      `exterior-${index}`,
      index % 2 === 0
        ? -(index < 310 ? 96 : 299.9999)
        : (index < 310 ? 96 : 299.9999),
      0,
    ),
  );
  const exteriorBoxes = Array.from({ length: 4 }, (_, index) =>
    placement(`exterior-box-${index}`, 1_000 + index, 1_000, bounds(-2, -2, 2, 2)),
  );
  const interior = Array.from({ length: 125 }, (_, index) =>
    placement(
      `interior-${index}`,
      index % 2 === 0
        ? -(index < 115 ? 32 : 59.9999)
        : (index < 115 ? 32 : 59.9999),
      0,
    ),
  ).map((object) => ({ ...object, interior: true }));
  const interiorBoxes = Array.from({ length: 4 }, (_, index) =>
    ({ ...placement(`interior-box-${index}`, -1_000 - index, -1_000, bounds(-2, -2, 2, 2)), interior: true }),
  );
  const all = frozenObjects([
    ...exterior,
    ...exteriorBoxes,
    placement("exterior-inside-boundary", 299.999, 0),
    placement("exterior-strict-boundary", 300, 0),
    ...interior,
    ...interiorBoxes,
    { ...placement("interior-inside-boundary", 59.999, 0), interior: true },
    { ...placement("interior-strict-boundary", 60, 0), interior: true },
  ]);

  const legacy = selectEnvironment(all, player);
  const spatialObjects = new EnvironmentSpatialIndex(all).query(player.x, player.y, 300).objects;
  const spatial = selectEnvironment(spatialObjects, player);

  assert.equal(legacy.length, 440, "both quotas are saturated in the mixed scene");
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

  const queryAt = update.indexOf(".query(");
  assert.ok(queryAt > identityAt && queryAt < candidatesAt,
    "the spatial query feeds exact range filtering before environmentCandidatesInRange runs");
  assert.match(update.slice(candidatesAt, admissionAt), /#environmentCandidatesAt\s*=\s*\{/,
    "only distance candidates share the four-yard cache; frustum admission stays outside it");
});
