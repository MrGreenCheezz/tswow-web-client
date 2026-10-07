import assert from "node:assert/strict";
import test from "node:test";
import { RECENCY_STAMP_LIMIT, renumberByUsed, renumberRecency } from "../dist/code/browser/RecencyStamps.js";

test("P1-10: the stamp limit stays a small integer", () => {
  assert.equal(RECENCY_STAMP_LIMIT, 1 << 29);
  assert.ok(RECENCY_STAMP_LIMIT < 2 ** 30, "under the 31-bit Smi range with room for the last increment");
});

test("P1-10: renumberRecency keeps the order, numbers 1..n and returns n", () => {
  const stamps = new Map([["c", RECENCY_STAMP_LIMIT], ["a", 7], ["d", 9_000_000], ["b", 8]]);
  assert.equal(renumberRecency(stamps), 4);
  assert.deepEqual([...stamps].sort((left, right) => left[1] - right[1]), [["a", 1], ["b", 2], ["d", 3], ["c", 4]]);
  assert.deepEqual([...stamps.keys()], ["c", "a", "d", "b"], "the map keeps its own key order");
  assert.equal(renumberRecency(new Map()), 0);
});

test("P1-10: renumberByUsed keeps the order of the entries' stamps and returns n", () => {
  const entries = [{ id: "x", used: 50 }, { id: "y", used: 3 }, { id: "z", used: RECENCY_STAMP_LIMIT }];
  assert.equal(renumberByUsed(entries), 3);
  assert.deepEqual(entries.map(({ id, used }) => [id, used]), [["x", 2], ["y", 1], ["z", 3]]);
  assert.equal(renumberByUsed(new Set()), 0);
});

test("P1-10: the test seam lowers the stamp limit and restores the default", async () => {
  const stamps = await import("../dist/code/browser/RecencyStamps.js");
  assert.equal(stamps.recencyStampLimit, RECENCY_STAMP_LIMIT);
  stamps.setRecencyStampLimitForTests(5);
  assert.equal(stamps.recencyStampLimit, 5, "a live binding every cache reads");
  stamps.setRecencyStampLimitForTests();
  assert.equal(stamps.recencyStampLimit, RECENCY_STAMP_LIMIT);
  for (const bad of [0, -1, 1.5, RECENCY_STAMP_LIMIT + 1]) {
    assert.throws(() => stamps.setRecencyStampLimitForTests(bad), RangeError);
  }
});
