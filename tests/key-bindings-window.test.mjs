import assert from "node:assert/strict";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

// The native key bindings window's list (ui/KeyBindings.ts): the stock rows of 3.11 join the groups
// the player already knows rather than repeating a heading, and the order inside a group stays.
const bindings = await import("../dist/code/browser/input/Bindings.js");

test("rows are grouped under one heading per group, in first-appearance order", async () => {
  const window = await isolatedUi("KeyBindings", { "../input/Bindings.js": bindings });
  const rows = window.groupedRows([
    { action: "a", group: "Движение" }, { action: "b", group: "Цель" }, { action: "c", group: "Движение" },
    { action: "d", group: "Интерфейс" }, { action: "e", group: "Цель" },
  ]);
  assert.deepEqual(rows.map((row) => row.action), ["a", "c", "b", "e", "d"]);
  const real = window.groupedRows(bindings.INPUT_ACTIONS);
  const headings = real.map((row) => row.group).filter((group, index, all) => group !== all[index - 1]);
  assert.equal(new Set(headings).size, headings.length, "no group heading appears twice");
  assert.equal(real.length, bindings.INPUT_ACTIONS.length);
});
