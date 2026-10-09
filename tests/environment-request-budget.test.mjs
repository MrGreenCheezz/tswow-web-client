import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_REQUEST_CRITICAL_SPARE, ENVIRONMENT_REQUEST_LIMIT, EnvironmentRequestBudget, environmentFetchPriority,
} from "../dist/code/browser/EnvironmentRequestBudget.js";

test("10.21 (c): the shared environment budget admits four, a critical request one more", () => {
  assert.equal(ENVIRONMENT_REQUEST_LIMIT, 4);
  assert.equal(ENVIRONMENT_REQUEST_CRITICAL_SPARE, 1);
  const released = [];
  const budget = new EnvironmentRequestBudget(4, (kind) => released.push(kind));
  const slots = [
    budget.tryAcquire("model", "normal"),
    budget.tryAcquire("group", "normal"),
    budget.tryAcquire("animation", "background"),
    budget.tryAcquire("model", "background"),
  ];
  assert.ok(slots.every((slot) => typeof slot === "function"));
  assert.equal(budget.active, 4);
  assert.equal(budget.tryAcquire("model", "normal"), undefined, "a fifth normal request waits");
  assert.equal(budget.tryAcquire("group", "background"), undefined);
  const spare = budget.tryAcquire("animation", "critical");
  assert.equal(typeof spare, "function", "a fifth critical request takes the spare slot");
  assert.equal(budget.tryAcquire("model", "critical"), undefined, "only one spare slot");
  assert.equal(budget.active, 5);
  assert.equal(budget.peak, 5);

  slots[1]();
  assert.deepEqual(released, ["group"], "releasing names the lane that gave the slot back");
  slots[1]();
  assert.equal(budget.active, 4, "a second release of the same slot is a no-op");
  assert.deepEqual(released, ["group"]);
  assert.equal(budget.tryAcquire("model", "normal"), undefined, "the spare is still held, so 4 + 1 stays full for normal work");
  spare();
  const next = budget.tryAcquire("model", "normal");
  assert.equal(typeof next, "function", "a released slot admits the next normal request");
  assert.equal(budget.admits("normal"), false);
  assert.equal(budget.admits("critical"), true);
});

test("10.21 (c): never more than the limit plus one critical, whatever the order", () => {
  const budget = new EnvironmentRequestBudget();
  const held = [];
  let max = 0;
  const priorities = ["background", "normal", "critical"];
  const kinds = ["model", "group", "animation"];
  // A fixed pseudo-random walk of acquires and releases.
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let step = 0; step < 5_000; step++) {
    if (held.length > 0 && random() < 0.45) {
      held.splice(Math.floor(random() * held.length), 1)[0]();
    } else {
      const slot = budget.tryAcquire(kinds[step % 3], priorities[Math.floor(random() * 3)]);
      if (slot) held.push(slot);
    }
    max = Math.max(max, budget.active);
    assert.equal(budget.active, held.length);
  }
  assert.equal(max, ENVIRONMENT_REQUEST_LIMIT + ENVIRONMENT_REQUEST_CRITICAL_SPARE);
  assert.equal(budget.peak, max);
});

test("10.21 (c): scenery asks Chromium for a low fetch priority, everything else keeps the default", () => {
  assert.equal(environmentFetchPriority("background"), "low");
  assert.equal(environmentFetchPriority("normal"), undefined);
  assert.equal(environmentFetchPriority("critical"), undefined);
});
