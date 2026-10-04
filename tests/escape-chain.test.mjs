// 4.04: Escape is stock ToggleGameMenu's chain — the first step that dismisses something spends the
// press, and the steps after it are not asked.
import assert from "node:assert/strict";
import test from "node:test";

const { runEscapeChain } = await import("../dist/code/browser/input/EscapeChain.js");

test("the first step that dismisses something wins and the rest are not asked", () => {
  const asked = [];
  const step = (name, answer) => () => { asked.push(name); return answer; };
  assert.equal(runEscapeChain([step("popups", false), step("cast", true), step("windows", true)]), true);
  assert.deepEqual(asked, ["popups", "cast"]);
});

test("a chain with nothing to dismiss asks every step and answers false", () => {
  const asked = [];
  assert.equal(runEscapeChain([() => { asked.push(1); return false; }, () => { asked.push(2); return false; }]), false);
  assert.deepEqual(asked, [1, 2]);
  assert.equal(runEscapeChain([]), false);
});
