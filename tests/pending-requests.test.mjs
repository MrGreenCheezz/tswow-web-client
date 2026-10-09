import assert from "node:assert/strict";
import test from "node:test";
import { PendingRequests } from "../dist/code/world/PendingRequests.js";

test("a pending request waits until its deadline, then counts as absent", () => {
  const pending = new PendingRequests();
  pending.begin("attack", undefined, 1500, 1000);
  assert.equal(pending.has("attack", 1000), true);
  assert.equal(pending.has("attack", 2499), true);
  assert.equal(pending.has("attack", 2500), false, "the deadline itself is already late");
  assert.equal(pending.has("other", 1000), false);
});

test("confirm and rollback close the entry and hand back the snapshot once", () => {
  const pending = new PendingRequests();
  pending.begin(3, { name: "old" }, Infinity, 0);
  assert.equal(pending.has(3, 1e12), true, "Infinity never lapses");
  assert.deepEqual(pending.confirm(3), { name: "old" });
  assert.equal(pending.has(3, 0), false);
  assert.equal(pending.confirm(3), undefined, "a second answer finds nothing");

  pending.begin(4, "before", 10, 0);
  assert.equal(pending.rollback(4), "before");
  assert.equal(pending.size, 0);
});

test("expire sweeps only lapsed entries and reports each snapshot", () => {
  const pending = new PendingRequests();
  pending.begin("a", 1, 100, 0);
  pending.begin("b", 2, 300, 0);
  const lapsed = [];
  pending.expire(200, (key, snapshot) => lapsed.push([key, snapshot]));
  assert.deepEqual(lapsed, [["a", 1]]);
  assert.equal(pending.has("b", 200), true);
  pending.clear();
  assert.equal(pending.size, 0);
});
