import assert from "node:assert/strict";
import test from "node:test";
import { queueFrameTask, runFrameTasks } from "../dist/code/transport/PacketPump.js";

// A burst of packets asks for the same refresh once per packet; the frame after the burst runs it
// once. `WorldView.drainWorldState` calls `runFrameTasks` at the start of every frame's world pass.

test("a refresh queued by every packet of a burst runs once, on the next frame", () => {
  let runs = 0;
  const refresh = () => { runs += 1; };
  for (let packet = 0; packet < 200; packet += 1) queueFrameTask(refresh);
  assert.equal(runs, 0, "nothing runs inside the packet task");
  runFrameTasks();
  assert.equal(runs, 1, "one run for the whole burst");
  runFrameTasks();
  assert.equal(runs, 1, "and none on a frame nobody asked for");
});

test("different refreshes run in the order they were first asked for", () => {
  const order = [];
  const auras = () => order.push("auras");
  const names = () => order.push("names");
  queueFrameTask(auras);
  queueFrameTask(names);
  queueFrameTask(auras);
  runFrameTasks();
  assert.deepEqual(order, ["auras", "names"]);
});

test("one failing refresh costs the others nothing, and a refresh queued while they run waits a frame", () => {
  const ran = [];
  const errors = [];
  const previous = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const later = () => ran.push("later");
    queueFrameTask(() => { throw new Error("broken panel"); });
    queueFrameTask(() => { ran.push("after"); queueFrameTask(later); });
    runFrameTasks();
    assert.deepEqual(ran, ["after"]);
    assert.equal(errors.length, 1, "the failure is reported");
    runFrameTasks();
    assert.deepEqual(ran, ["after", "later"]);
  } finally {
    console.error = previous;
  }
});
