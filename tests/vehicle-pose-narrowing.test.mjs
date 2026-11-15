// 11.02 (15.11, vehicle9): Wow.exe 0x00724500 → 0x00756f40: a unit whose own Vehicle row has Flags 0x10000, while its
// precast animation is on (+0xa38 0x400), takes its base pose from 0x00724330 alone — the cast's own animation or no change —
// so the precast keeps the whole body moving or standing; when the mark drops the ordinary chain chooses again.
import assert from "node:assert/strict";
import test from "node:test";
import { narrowedActionDisplay, vehicleNarrowsPose } from "../dist/code/browser/VehiclePoseNarrowing.js";

// Rows of the dataset's Vehicle.dbc (.runtime/re-2026-11-15/vehicle9/probe1.txt): 26 Flags 0x470d6677 and 113 Flags 0x90000
// have 0x10000 (12 rows do); 24 Flags 0x41081e77 does not.
const ROW_26 = 0x470d6677, ROW_113 = 0x90000, ROW_24 = 0x41081e77;

test("15.11: which Vehicle rows narrow the pose (0x00756f40)", () => {
  assert.equal(vehicleNarrowsPose(ROW_26), true);
  assert.equal(vehicleNarrowsPose(ROW_113), true);
  assert.equal(vehicleNarrowsPose(ROW_24), false);
  assert.equal(vehicleNarrowsPose(undefined), false, "a unit that is no vehicle");
});

test("15.11: such a vehicle's held precast takes the whole body whatever its base, and nothing else changes", () => {
  const narrows = vehicleNarrowsPose(ROW_26);
  assert.equal(narrowedActionDisplay("upper", narrows, "cast", true, false), "full", "moving: no run under it");
  assert.equal(narrowedActionDisplay("yield", narrows, "cast", true, false), "full", "a whole-body precast does not give way");
  assert.equal(narrowedActionDisplay("full", narrows, "cast", true, false), "full", "standing: as before");
  assert.equal(narrowedActionDisplay("upper", narrows, "cast", true, true), "upper", "a channel is not 0x007fa2e0's mark");
  assert.equal(narrowedActionDisplay("upper", narrows, "cast", false, false), "upper", "the cast's one-shot release: not a hold");
  assert.equal(narrowedActionDisplay("yield", narrows, "emote", true, false), "yield", "an emote is no cast mark");
  assert.equal(narrowedActionDisplay("upper", vehicleNarrowsPose(ROW_24), "cast", true, false), "upper", "row 24: ordinary choice");
});
