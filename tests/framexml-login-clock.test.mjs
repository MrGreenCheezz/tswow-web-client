import assert from "node:assert/strict";
import test from "node:test";

const { waitForFrameXmlLoginClock } = await import("../dist/code/browser/framexml/FrameXmlLoginClock.js");

function manualClock() {
  let elapsed = 0;
  const delays = [];
  return {
    now: () => elapsed,
    sleep: async (delay) => { delays.push(delay); elapsed += delay; },
    delays,
  };
}

test("ready clock returns immediately without scheduling a retry", async () => {
  const scheduler = manualClock();
  const authoritative = { minuteOfDay: 0 };
  let reads = 0;
  const result = await waitForFrameXmlLoginClock({
    read: () => { reads++; return authoritative; },
    stillCurrent: () => true,
    ...scheduler,
  });
  assert.deepEqual(result, { status: "ready", clock: authoritative });
  assert.equal(reads, 1);
  assert.deepEqual(scheduler.delays, []);
});

test("clock arriving after login verify is used on the first ready retry", async () => {
  const scheduler = manualClock();
  let reads = 0;
  const authoritative = { minuteOfDay: 123.5 };
  const result = await waitForFrameXmlLoginClock({
    read: () => ++reads === 3 ? authoritative : undefined,
    stillCurrent: () => true,
    timeoutMs: 120,
    pollIntervalMs: 50,
    ...scheduler,
  });
  assert.deepEqual(result, { status: "ready", clock: authoritative });
  assert.equal(reads, 3);
  assert.deepEqual(scheduler.delays, [50, 50]);
});

test("world replacement cancels before touching the old world again", async () => {
  const scheduler = manualClock();
  let active = true;
  let reads = 0;
  const result = await waitForFrameXmlLoginClock({
    read: () => { reads++; return undefined; },
    stillCurrent: () => active,
    sleep: async (delay) => { await scheduler.sleep(delay); active = false; },
    now: scheduler.now,
  });
  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(reads, 1);
  assert.deepEqual(scheduler.delays, [50]);
});

test("missing packet times out after five seconds without inventing a clock", async () => {
  const scheduler = manualClock();
  let reads = 0;
  const result = await waitForFrameXmlLoginClock({
    read: () => { reads++; return undefined; },
    stillCurrent: () => true,
    pollIntervalMs: 700,
    ...scheduler,
  });
  assert.deepEqual(result, { status: "timeout" });
  assert.equal(scheduler.delays.reduce((sum, delay) => sum + delay, 0), 5_000);
  assert.equal(scheduler.delays.at(-1), 100);
  assert.equal(reads, 9);
});

test("already cancelled mount neither reads nor sleeps", async () => {
  const scheduler = manualClock();
  const result = await waitForFrameXmlLoginClock({
    read: () => { throw new Error("must not read stale world"); },
    stillCurrent: () => false,
    ...scheduler,
  });
  assert.deepEqual(result, { status: "cancelled" });
  assert.deepEqual(scheduler.delays, []);
});
