import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  admitEnvironmentInto, environmentCandidatesInRange, selectEnvironmentAdmission,
} from "../dist/code/browser/WorldRenderer3D.js";
import { BoundedTopK, stableBoundedTopKWhere } from "../dist/code/browser/RenderAdmission.js";

// P2-04c: the renderer admits in one pass into reusable heaps and alternating arrays; the
// four-pass `selectEnvironmentAdmission` stays as the reference, and the two must pick the same
// entries in the same order.

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const NAMES = [
  "World\\Generic\\Human\\Passive Doodads\\Barrel\\Barrel01.m2",
  "World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTreeCanopy01.m2",
  "World\\Generic\\Human\\Passive Doodads\\Lamps\\StormwindStreetLamp01.m2",
  "World\\Expansion02\\Doodads\\Generic\\Bush\\Bush01.m2",
];

function placements(seed, count) {
  const next = random(seed);
  const out = [];
  for (let id = 1; id <= count; id++) {
    const kind = next() < 0.08 ? "wmo" : "m2";
    // Ties on purpose: positions on a coarse lattice.
    const x = Math.round((next() - 0.5) * 120) * 5;
    const y = Math.round((next() - 0.5) * 120) * 5;
    const object = {
      id, kind, name: kind === "wmo" ? `World\\wmo\\Building${id % 7}.wmo` : NAMES[id % NAMES.length],
      x, y, z: Math.round(next() * 20), rotationX: 0, rotationY: 0, rotationZ: next() * 6, scale: 0.5 + next(),
    };
    if (kind === "wmo") {
      const half = 10 + next() * 60;
      object.bounds = { minX: x - half, minY: y - half, minZ: -5, maxX: x + half, maxY: y + half, maxZ: 40 };
    } else if (next() < 0.5) {
      object.interior = next() < 0.6;
    }
    if (kind === "m2" && next() < 0.4) object.admissionRadius = next() * 8;
    out.push(object);
  }
  return out;
}

function frustum(next) {
  const camera = new THREE.PerspectiveCamera(60 + next() * 30, 1.6, 0.5, 900);
  camera.position.set((next() - 0.5) * 200, 20 + next() * 40, (next() - 0.5) * 200);
  camera.lookAt((next() - 0.5) * 400, 0, (next() - 0.5) * 400);
  camera.updateMatrixWorld();
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return new THREE.Frustum().setFromProjectionMatrix(matrix).planes;
}

test("one pass picks what four passes picked, in the same order, on 200 seeded scenes", () => {
  let picked = 0;
  const buffers = [[], []];
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed * 7919);
    const objects = placements(seed, 200 + Math.floor(next() * 1600));
    const candidates = environmentCandidatesInRange(objects, { x: (next() - 0.5) * 100, y: (next() - 0.5) * 100, z: 0 },
      [0.5, 0.75, 1, 1.25, 1.5][seed % 5]);
    const planes = seed % 11 === 0 ? [] : frustum(next);
    const spheres = new Map();
    const retained = seed % 3 === 0 ? (object) => {
      if (!spheres.has(object)) spheres.set(object, next() < 0.5 ? undefined : { x: object.x, y: 0, z: -object.y, radius: next() * 10 });
      return spheres.get(object);
    } : undefined;
    const padding = seed % 4 === 0 ? 1.5 : 0;
    const expected = selectEnvironmentAdmission(candidates, planes, retained, padding);
    const out = buffers[seed & 1];
    const actual = admitEnvironmentInto(candidates, planes, retained, padding, out);
    assert.strictEqual(actual, out, "written into the caller's array");
    assert.equal(actual.length, expected.length, `seed ${seed}`);
    for (let index = 0; index < expected.length; index++) {
      assert.strictEqual(actual[index], expected[index], `seed ${seed}: entry ${index}`);
    }
    picked += expected.length;
  }
  assert.ok(picked > 10000, `the scenes exercise the budgets (${picked} picks)`);
});

test("the reusable heap keeps what stableBoundedTopKWhere keeps, across resets", () => {
  const heap = new BoundedTopK();
  const next = random(42);
  for (let round = 0; round < 300; round++) {
    const k = Math.floor(next() * 40);
    const items = Array.from({ length: Math.floor(next() * 120) }, (_, index) => ({ index, score: Math.round(next() * 20) }));
    const accept = (item) => item.index % 3 !== 0;
    const expected = stableBoundedTopKWhere(items, accept, k, (item) => item.score);
    heap.reset(k);
    for (const item of items) if (accept(item)) heap.offer(item, item.score);
    const out = [];
    heap.drainInto(out);
    assert.deepEqual(out, expected, `round ${round}, k ${k}`);
  }
  heap.reset(0);
  heap.offer({}, Number.NaN);
  const none = [];
  heap.drainInto(none);
  assert.deepEqual(none, [], "K = 0 keeps nothing and never reads the score");
  heap.reset(2);
  assert.throws(() => heap.offer({}, Number.POSITIVE_INFINITY), RangeError);
});
