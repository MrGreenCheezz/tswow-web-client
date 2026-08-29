import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acquireFormalRenderBenchmarkExclusiveLease,
  assertFormalRenderBenchmarkExclusiveLease,
  formalRenderBenchmarkExclusiveActive,
} from "../dist/code/browser/RenderBenchmarkExclusiveLease.js";

test("formal render lease is exclusive, opaque, and idempotently released", () => {
  assert.equal(formalRenderBenchmarkExclusiveActive(), false);
  const first = acquireFormalRenderBenchmarkExclusiveLease();
  try {
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Number.isSafeInteger(first.id), true);
    assert.equal(first.id > 0, true);
    assert.equal(formalRenderBenchmarkExclusiveActive(), true);
    assert.equal(assertFormalRenderBenchmarkExclusiveLease(first), undefined);
    assert.throws(
      () => acquireFormalRenderBenchmarkExclusiveLease(),
      /already active/,
    );
    assert.throws(
      () => assertFormalRenderBenchmarkExclusiveLease({ id: first.id, release: first.release }),
      /not active/,
      "a structurally similar object cannot forge ownership",
    );
  } finally {
    first.release();
    first.release();
  }
  assert.equal(formalRenderBenchmarkExclusiveActive(), false);

  const second = acquireFormalRenderBenchmarkExclusiveLease();
  try {
    assert.equal(second.id > first.id, true);
    first.release();
    assert.equal(formalRenderBenchmarkExclusiveActive(), true,
      "a stale release must not remove the new lease");
    assert.equal(assertFormalRenderBenchmarkExclusiveLease(second), undefined);
  } finally {
    second.release();
    second.release();
  }
  assert.equal(formalRenderBenchmarkExclusiveActive(), false);
});

test("formal render lease API is input-free and protects its safe-integer id", async () => {
  assert.equal(acquireFormalRenderBenchmarkExclusiveLease.length, 0);
  assert.equal(formalRenderBenchmarkExclusiveActive.length, 0);
  const source = await readFile(new URL("../src/browser/RenderBenchmarkExclusiveLease.ts", import.meta.url), "utf8");
  assert.match(source, /Number\.isSafeInteger\(nextFormalRenderBenchmarkExclusiveLeaseId\)/);
  assert.match(source, /nextFormalRenderBenchmarkExclusiveLeaseId >= Number\.MAX_SAFE_INTEGER/);
  assert.match(source, /Object\.freeze\(token\)/);
});
