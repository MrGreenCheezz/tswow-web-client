import assert from "node:assert/strict";
import test from "node:test";
import { stableBoundedTopK, stableBoundedTopKWhere } from "../dist/code/browser/RenderAdmission.js";
import {
  ENVIRONMENT_RANGE, ENVIRONMENT_SCENERY_BUDGET, placementDistance, selectEnvironment,
} from "../dist/code/browser/WorldRenderer3D.js";

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
    assert.throws(() => stableBoundedTopKWhere([1, 2], () => true, k, (item) => item), RangeError);
  }
  for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => stableBoundedTopK(["item"], 1, () => score), RangeError);
    // Every accepted item is scored and checked, admitted or not; a rejected one is not scored.
    assert.throws(() => stableBoundedTopKWhere([0, 1, "item"], () => true, 1, (item) => item === "item" ? score : item), RangeError);
    assert.deepEqual(stableBoundedTopKWhere([0, "item"], (item) => item !== "item", 1, (item) => item === "item" ? score : item), [0]);
  }
});

test("stableBoundedTopKWhere is stableBoundedTopK over the accepted items, in their order", () => {
  const random = lcg(0x0ddba11);
  for (let run = 0; run < 300; run++) {
    const length = Math.floor(random() * 90);
    const items = Array.from({ length }, (_, ordinal) => ({
      id: `run-${run}-${ordinal}`,
      // Few distinct scores, -0 among them: ties and zero signs decide most places.
      score: [-2, -0, 0, 1, 1.5, 3][Math.floor(random() * 6)],
      keep: random() < 0.6,
    }));
    const k = Math.floor(random() * (length + 4));
    const accepted = [];
    const expected = stableBoundedTopK(items.filter((item) => item.keep), k, (item) => item.score);
    const actual = stableBoundedTopKWhere(items, (item) => { accepted.push(item.id); return item.keep; }, k, (item) => item.score);
    assert.deepEqual(actual, expected, `run ${run}, N=${length}, K=${k}`);
    if (k > 0) assert.deepEqual(accepted, items.map((item) => item.id), "every item is offered once, in order");
  }
  assert.deepEqual(stableBoundedTopKWhere([1, 2], () => { throw new Error("not called"); }, 0, () => 0), []);
});

function environment(id, x, interior = false) {
  return {
    id, kind: "m2", name: `Object${id}.m2`, x, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
    ...(interior ? { interior: true } : {}),
  };
}

test("selectEnvironment keeps exterior and interior quotas independent with strict ranges", () => {
  // Loose outdoor M2s share the scenery quota; unsized ones keep the legacy 400-yard leash, and at
  // one leash their share-of-leash rank is plain nearest-first.
  const exteriorQuota = ENVIRONMENT_SCENERY_BUDGET;
  const exterior = Array.from({ length: exteriorQuota + 80 }, (_, index) => environment(`exterior-${index}`, 100 + index % 7));
  const interior = Array.from({ length: 400 }, (_, index) => environment(`interior-${index}`, 10 + index % 5, true));
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
      exteriorQuota,
      (object) => placementDistance(object, player),
    ),
    ...referenceTopK(
      objects.filter((object) => object.interior === true && placementDistance(object, player) < 60),
      360,
      (object) => placementDistance(object, player),
    ),
  ];
  assert.deepEqual(
    selected.map(({ object, distance }) => [object.id, distance]),
    expected.map((object) => [object.id, placementDistance(object, player)]),
  );
  assert.equal(selected.length, exteriorQuota + 360);
  assert.equal(selected.slice(0, exteriorQuota).every(({ object }) => object.interior !== true), true);
  assert.equal(selected.slice(exteriorQuota).every(({ object }) => object.interior === true), true);
  assert.equal(selected.some(({ object }) => object.id === "exterior-boundary"), false);
  assert.equal(selected.some(({ object }) => object.id === "interior-boundary"), false);
  assert.equal(selected.some(({ object }) => object.id === "exterior-inside"), true);
  assert.equal(selected.some(({ object }) => object.id === "interior-inside"), true);
});
