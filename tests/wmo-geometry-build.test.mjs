import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { WmoGeometryBuild } from "../dist/code/browser/WmoGeometryBuild.js";

function fixture({ limit = 1.5, cap = 128, cost = 0.4, steps = 8 } = {}) {
  const state = { now: 0, advances: 0, cancelled: 0, created: 0 };
  const build = function* () {
    let done = false;
    state.created++;
    try {
      for (let index = 0; index < steps; index++) {
        state.now += cost;
        state.advances++;
        yield;
      }
      done = true;
      return new THREE.BufferGeometry();
    } finally { if (!done) state.cancelled++; }
  };
  return { state, queue: new WmoGeometryBuild(limit, cap, () => state.now, build),
    model: { groups: [{ mesh: {} }, { mesh: {} }] } };
}

test("a large room continues across frames; repeated placements share the same slice", () => {
  const { state, queue, model } = fixture();
  assert.equal(queue.request("room", model, 0, 1), undefined);
  assert.equal(state.advances, 4);
  for (let i = 0; i < 10; i++) assert.equal(queue.request("room", model, 0, 1), undefined);
  assert.equal(state.advances, 4, "placements do not each receive another 1.5 ms");
  queue.finishFrame(1);
  assert.equal(queue.request("room", model, 0, 2), undefined);
  assert.equal(state.advances, 8);
  const geometry = queue.request("room", model, 0, 3);
  assert.ok(geometry?.isBufferGeometry);
  assert.equal(state.created, 1);
  queue.clear();
  assert.equal(state.cancelled, 0, "completed geometry belongs to the renderer");
  geometry.dispose();
});

test("finishing one room does not reset time or step allowance for the next room", () => {
  const { state, queue, model } = fixture({ steps: 2, cost: 0.5 });
  assert.ok(queue.request("first", model, 0, 1));
  assert.equal(queue.request("second", model, 1, 1), undefined);
  assert.equal(state.advances, 3);
  assert.equal(queue.request("second", model, 1, 1), undefined);
  assert.equal(state.advances, 3);
  assert.ok(queue.request("second", model, 1, 2));
});

test("unfinished buffers are bounded to one room and unrelated requests cannot starve it", () => {
  const { state, queue, model } = fixture({ steps: 5 });
  queue.request("second", model, 1, 1);
  for (let i = 0; i < 20; i++) queue.request("first", model, 0, 2);
  assert.equal(state.created, 1);
  assert.ok(queue.request("second", model, 1, 2));
  assert.equal(state.cancelled, 0);
});

test("final demand keeps shared rooms across placement detaches and cancels obsolete jobs", () => {
  const { state, queue, model } = fixture();
  queue.request("room", model, 0, 1);
  queue.retain("room", model.groups[0].mesh, 2);
  queue.finishFrame(2);
  assert.equal(state.cancelled, 0);
  queue.finishFrame(3);
  queue.clear();
  assert.equal(state.cancelled, 1);
  assert.ok(queue.request("next", model, 1, 4) === undefined);
  assert.equal(state.created, 2);
});

test("replacement source and session reset cannot publish obsolete geometry", () => {
  const { state, queue, model } = fixture();
  queue.request("room", model, 0, 1);
  model.groups[0].mesh = {};
  queue.retain("room", model.groups[0].mesh, 2);
  assert.equal(state.cancelled, 1);
  queue.request("room", model, 0, 2);
  assert.equal(state.created, 2);
  queue.clear();
  assert.equal(state.cancelled, 2);
});

test("zero-resolution clocks still have bounded work and failures release the active job", () => {
  const { state, queue, model } = fixture({ cost: 0, cap: 3 });
  queue.request("room", model, 0, 1);
  assert.equal(state.advances, 3);
  queue.request("room", model, 0, 1);
  assert.equal(state.advances, 3);
  queue.clear();
  let closed = 0;
  const failed = new WmoGeometryBuild(1.5, 128, () => 0, function* () {
    try { throw new Error("broken input"); } finally { closed++; }
  });
  assert.throws(() => failed.request("room", model, 0, 1), /broken input/);
  failed.clear();
  assert.equal(closed, 1);
});
