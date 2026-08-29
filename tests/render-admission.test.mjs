import assert from "node:assert/strict";
import test from "node:test";
import { stableBoundedTopK } from "../dist/code/browser/RenderAdmission.js";
import { ENVIRONMENT_RANGE, placementDistance, selectEnvironment } from "../dist/code/browser/WorldRenderer3D.js";

function referenceTopK(items, k, scoreOf) {
  return items
    .map((item, ordinal) => ({ item, ordinal, score: scoreOf(item) }))
    .sort((left, right) => left.score - right.score || left.ordinal - right.ordinal)
    .slice(0, k)
    .map(({ item }) => item);
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("stableBoundedTopK exactly matches stable sort over fixed-seed randomized inputs", () => {
  const random = lcg(0x5eed1234);
  for (let run = 0; run < 200; run++) {
    const length = Math.floor(random() * 80);
    const items = Array.from({ length }, (_, ordinal) => ({
      id: `run-${run}-${ordinal}`,
      score: Math.floor(random() * 13) - 4,
    }));
    const k = Math.floor(random() * (length + 8));
    const before = structuredClone(items);
    const expected = referenceTopK(items, k, (item) => item.score);
    const actual = stableBoundedTopK(items, k, (item) => item.score);
    assert.deepEqual(actual, expected, `run ${run}, N=${length}, K=${k}`);
    assert.deepEqual(items, before, `run ${run} must not mutate input`);
    assert.deepEqual(
      actual.map(({ id, score }) => [id, score]),
      expected.map(({ id, score }) => [id, score]),
    );
  }
});

test("stableBoundedTopK preserves input ordinal through adversarial ties and handles K edges", () => {
  const items = [
    { id: "late-low", score: 1 },
    { id: "first-tie", score: 2 },
    { id: "second-tie", score: 2 },
    { id: "third-tie", score: 2 },
    { id: "negative", score: -1 },
    { id: "fourth-tie", score: 2 },
  ];
  assert.deepEqual(
    stableBoundedTopK(items, 3, (item) => item.score).map(({ id, score }) => [id, score]),
    [["negative", -1], ["late-low", 1], ["first-tie", 2]],
  );
  assert.deepEqual(stableBoundedTopK(items, 0, () => Number.NaN), []);
  assert.deepEqual(stableBoundedTopK(items, items.length + 10, (item) => item.score), referenceTopK(items, items.length + 10, (item) => item.score));
});

test("stableBoundedTopK validates K and rejects non-finite scores", () => {
  for (const k of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => stableBoundedTopK([1, 2], k, (item) => item), RangeError);
  }
  for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => stableBoundedTopK(["item"], 1, () => score), RangeError);
  }
});

function environment(id, x, interior = false) {
  return {
    id, kind: "m2", name: `Object${id}.m2`, x, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
    ...(interior ? { interior: true } : {}),
  };
}

test("selectEnvironment keeps exterior and interior quotas independent with strict ranges", () => {
  const exterior = Array.from({ length: 400 }, (_, index) => environment(`exterior-${index}`, 100 + index % 7));
  const interior = Array.from({ length: 200 }, (_, index) => environment(`interior-${index}`, 10 + index % 5, true));
  const objects = [
    ...exterior,
    ...interior,
    environment("exterior-boundary", ENVIRONMENT_RANGE),
    environment("interior-boundary", 60, true),
    environment("exterior-inside", 0.001),
    environment("interior-inside", 0.001, true),
  ];
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const selected = selectEnvironment(objects, player);
  const expected = [
    ...referenceTopK(
      objects.filter((object) => object.interior !== true && placementDistance(object, player) < ENVIRONMENT_RANGE),
      320,
      (object) => placementDistance(object, player),
    ),
    ...referenceTopK(
      objects.filter((object) => object.interior === true && placementDistance(object, player) < 60),
      120,
      (object) => placementDistance(object, player),
    ),
  ];
  assert.deepEqual(
    selected.map(({ object, distance }) => [object.id, distance]),
    expected.map((object) => [object.id, placementDistance(object, player)]),
  );
  assert.equal(selected.length, 440);
  assert.equal(selected.slice(0, 320).every(({ object }) => object.interior !== true), true);
  assert.equal(selected.slice(320).every(({ object }) => object.interior === true), true);
  assert.equal(selected.some(({ object }) => object.id === "exterior-boundary"), false);
  assert.equal(selected.some(({ object }) => object.id === "interior-boundary"), false);
  assert.equal(selected.some(({ object }) => object.id === "exterior-inside"), true);
  assert.equal(selected.some(({ object }) => object.id === "interior-inside"), true);
});
