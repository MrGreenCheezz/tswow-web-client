// 11.01, read off Wow.exe 04.11 (0x00711f20, 0x007105d0, 0x00710820, 0x00710780, 0x00710640): a lift with a pause
// (GAMEOBJECT_LEVEL ≠ 0) is driven by its GO state. Segment 0 runs from the start to the pause and holds; the other runs
// on to the end of the path and then stands at the start. A state change starts the other segment only near the end of
// the one running; before that it re-anchors, the segment finishes and holds.
import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { liftPhaseMs, liftPoseAt } from "../dist/code/browser/LiftClock.js";

const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const LEVEL = UPDATE_FIELDS.GAMEOBJECT_LEVEL.offset;
const DYNAMIC = UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset;
const PERIOD = 10_000;
const PAUSE = 4000;
const CLOSED = 1;
const OPEN = 0;

function lift({ state, pause = PAUSE, phaseWord = 0 }) {
  return {
    guid: 1n, typeId: 5,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([[BYTES_1, (11 << 8) | state], [LEVEL, pause], [DYNAMIC, (phaseWord << 16) >>> 0]]),
    transportTime: 5_000_000, transportTimeAt: 0,
  };
}
const setState = (object, state) => object.fields.set(BYTES_1, (11 << 8) | state);

test("state 0 runs from the start to the pause and holds there", () => {
  const object = lift({ state: OPEN });
  assert.equal(liftPhaseMs(object, PERIOD, 0), 0);
  assert.equal(liftPhaseMs(object, PERIOD, 1000), 1000);
  assert.equal(liftPhaseMs(object, PERIOD, PAUSE), PAUSE);
  assert.equal(liftPhaseMs(object, PERIOD, 60_000), PAUSE, "held, not cycling");
});

test("state 1 runs on from the pause to the end, then stands at the start", () => {
  const object = lift({ state: CLOSED });
  assert.equal(liftPhaseMs(object, PERIOD, 0), PAUSE);
  assert.equal(liftPhaseMs(object, PERIOD, 2000), PAUSE + 2000);
  assert.equal(liftPhaseMs(object, PERIOD, PERIOD - PAUSE), 0, "the last keyframe's time reads as the start");
  assert.equal(liftPhaseMs(object, PERIOD, 60_000), 0);
});

test("set up mid segment by the phase word, as a share of that segment", () => {
  const object = lift({ state: OPEN, phaseWord: 32768 });
  assert.ok(Math.abs(liftPhaseMs(object, PERIOD, 0) - PAUSE / 2) <= 1);
  const other = lift({ state: CLOSED, phaseWord: 32768 });
  assert.ok(Math.abs(liftPhaseMs(other, PERIOD, 0) - (PAUSE + (PERIOD - PAUSE) / 2)) <= 1);
});

test("a state change at the end of the segment starts the other one from its beginning", () => {
  const object = lift({ state: OPEN });
  assert.equal(liftPhaseMs(object, PERIOD, 10_000), PAUSE, "held at the pause");
  setState(object, CLOSED);
  assert.equal(liftPhaseMs(object, PERIOD, 10_000), PAUSE, "the second segment starts where the first ended");
  assert.equal(liftPhaseMs(object, PERIOD, 13_000), PAUSE + 3000);
  assert.equal(liftPhaseMs(object, PERIOD, 40_000), 0, "ended at the start");
  setState(object, OPEN);
  assert.equal(liftPhaseMs(object, PERIOD, 40_000), 0);
  assert.equal(liftPhaseMs(object, PERIOD, 41_000), 1000, "and round again");
});

test("a state change well before the end only re-anchors: the segment finishes and holds, and the new one does not start", () => {
  const object = lift({ state: OPEN });
  assert.equal(liftPhaseMs(object, PERIOD, 1000), 1000);
  setState(object, CLOSED);
  const at = liftPhaseMs(object, PERIOD, 1000);
  assert.ok(Math.abs(at - 1000) <= 1, `no jump (${at})`);
  assert.ok(Math.abs(liftPhaseMs(object, PERIOD, 2000) - 2000) <= 1, "still on its way to the pause");
  assert.equal(liftPhaseMs(object, PERIOD, 30_000), PAUSE, "holds at the pause in state 1: Wow.exe waits for the next change");
  setState(object, OPEN);
  assert.equal(liftPhaseMs(object, PERIOD, 31_000), PAUSE, "a change back to the segment it is on does nothing");
});

test("the 95 % line: just past it the other segment starts, just before it does not", () => {
  const past = lift({ state: OPEN });
  liftPhaseMs(past, PERIOD, 0);
  setState(past, CLOSED);
  assert.equal(liftPhaseMs(past, PERIOD, PAUSE * 0.96), PAUSE, "at 96 %: the second segment, from the pause");
  const before = lift({ state: OPEN });
  liftPhaseMs(before, PERIOD, 0);
  setState(before, CLOSED);
  assert.ok(liftPhaseMs(before, PERIOD, PAUSE * 0.9) < PAUSE, "at 90 %: still the first");
});

test("a lift without a pause cycles as before, whatever its state says", () => {
  const object = lift({ state: OPEN, pause: 0 });
  assert.equal(liftPhaseMs(object, PERIOD, 1000), (5_000_000 + 1000) % PERIOD);
  setState(object, CLOSED);
  assert.equal(liftPhaseMs(object, PERIOD, 2000), (5_000_000 + 2000) % PERIOD);
});

test("the pose follows it: the car stands at the pause's keyframe", () => {
  const path = { entry: 1, period: PERIOD, frames: [{ time: 0, x: 0, y: 0, z: 0 }, { time: PAUSE, x: 0, y: 0, z: 40 }, { time: PERIOD, x: 0, y: 0, z: 0 }] };
  const object = lift({ state: OPEN });
  const out = { x: 0, y: 0, z: 0, orientation: 0 };
  assert.equal(liftPoseAt(object, path, 0, out).z, 0);
  assert.equal(liftPoseAt(object, path, 60_000, out).z, 40);
});
