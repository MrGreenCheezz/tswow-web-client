import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  PACKET_READ_WAIT_MS, PACKET_SLICE_MS, PacketSlice, yieldToEventLoop,
} from "../dist/code/transport/PacketPump.js";

// The world loop used to run a whole buffered burst inside the task that delivered it: every
// `await` on the buffered stream settled at once, so no frame could be drawn until the last packet
// of a 64 KB message had been dispatched. These pin the slices that replaced that, and that the
// slices change nothing but *when* the next packet is read.

test("a slice is spent after its budget, and only then", () => {
  let now = 100;
  const slice = new PacketSlice({ now: () => now, yieldToEventLoop: async () => {} });
  assert.equal(slice.exhausted, false);
  now += PACKET_SLICE_MS - 0.5;
  assert.equal(slice.exhausted, false, "under budget");
  now += 0.5;
  assert.equal(slice.exhausted, true, "at budget");
});

test("a read answered from the buffer stays in the slice; one that waited starts a new one", () => {
  let now = 0;
  const slice = new PacketSlice({ now: () => now, yieldToEventLoop: async () => {} });
  now = 3;
  // Buffered: no time passes inside the read, so the three milliseconds already worked still count.
  slice.readStarted();
  slice.readFinished();
  now = 4;
  assert.equal(slice.exhausted, true);
  // Waited: the thread was free while the loop slept, so the budget restarts at the answer.
  slice.readStarted();
  now += PACKET_READ_WAIT_MS + 5;
  slice.readFinished();
  assert.equal(slice.exhausted, false);
  now += PACKET_SLICE_MS;
  assert.equal(slice.exhausted, true);
});

test("a pause yields exactly once and starts the next slice", async () => {
  let now = 0;
  let pauses = 0;
  const slice = new PacketSlice({ now: () => now, yieldToEventLoop: async () => { pauses += 1; now += 2; } });
  now = PACKET_SLICE_MS;
  assert.equal(slice.exhausted, true);
  await slice.pause();
  assert.equal(pauses, 1);
  assert.equal(slice.exhausted, false, "the time spent paused is not work");
});

test("the default pause is a macrotask, not a microtask", async () => {
  const order = [];
  const paused = yieldToEventLoop().then(() => order.push("resumed"));
  queueMicrotask(() => order.push("microtask"));
  await paused;
  assert.deepEqual(order, ["microtask", "resumed"]);
});

/** The fake connection of `attack.test.mjs`: a parked read is woken by the next push. */
function fakeConnection() {
  const queue = [];
  let wake;
  return {
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send() {},
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

const notification = (text) => new PacketWriter().cString(text).toUint8Array();

function busy(milliseconds) {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) { /* a handler that costs something */ }
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
  return { connection, client };
}

async function until(predicate, rounds = 400) {
  for (let round = 0; round < rounds && !predicate(); round += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

test("a burst that outlasts the budget lets a macrotask run in its middle, in packet order", async () => {
  const { connection, client } = await loggedIn();
  const delivered = [];
  client.events.on("SESSION_MESSAGE", ({ text }) => {
    delivered.push(text);
    busy(1.5);
  });
  const burst = Array.from({ length: 12 }, (_, index) => `n${index}`);
  for (const text of burst) connection.push(OPCODES.SMSG_NOTIFICATION, notification(text));
  let seenByMacrotask;
  // Queued behind the burst: without a pause it could only run once all twelve were handled.
  setImmediate(() => {
    seenByMacrotask = delivered.length;
    // Arrives while the loop is paused; it must still come after everything read before it.
    connection.push(OPCODES.SMSG_NOTIFICATION, notification("late"));
  });
  await until(() => delivered.length === burst.length + 1);
  assert.deepEqual(delivered, [...burst, "late"], "nothing reordered, nothing lost");
  assert.ok(seenByMacrotask !== undefined && seenByMacrotask > 0 && seenByMacrotask < burst.length,
    `the loop paused mid-burst (the macrotask saw ${seenByMacrotask} of ${burst.length})`);
  client.close();
});

test("a burst inside the budget is still handled in one go", async () => {
  const { connection, client } = await loggedIn();
  const delivered = [];
  client.events.on("SESSION_MESSAGE", ({ text }) => delivered.push(text));
  // Warm the path first, so the measured burst is the ordinary cost rather than the first call's.
  connection.push(OPCODES.SMSG_NOTIFICATION, notification("warm"));
  await until(() => delivered.length === 1);
  delivered.length = 0;
  for (const text of ["a", "b", "c"]) connection.push(OPCODES.SMSG_NOTIFICATION, notification(text));
  let seenByMacrotask;
  setImmediate(() => { seenByMacrotask = delivered.length; });
  await until(() => delivered.length === 3 && seenByMacrotask !== undefined);
  assert.equal(seenByMacrotask, 3, "no pause without a spent budget");
  client.close();
});

test("closing the client during a pause ends the loop before the next packet", async () => {
  const { connection, client } = await loggedIn();
  const delivered = [];
  client.events.on("SESSION_MESSAGE", ({ text }) => {
    delivered.push(text);
    busy(1.5);
  });
  for (let index = 0; index < 12; index += 1) connection.push(OPCODES.SMSG_NOTIFICATION, notification(`c${index}`));
  let closedAt;
  setImmediate(() => {
    closedAt = delivered.length;
    client.close();
  });
  await until(() => closedAt !== undefined);
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(closedAt > 0 && closedAt < 12, `closed mid-burst after ${closedAt}`);
  assert.equal(delivered.length, closedAt, "no packet is dispatched after close, exactly as before the slices");
});
