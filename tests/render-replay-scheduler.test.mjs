import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderReplayScheduler,
} from "../dist/code/browser/RenderReplayScheduler.js";

const scheduler = (overrides = {}) => new RenderReplayScheduler({
  frameCount: 3,
  frameStepMs: 10,
  ...overrides,
});

function finishCompleteAt(durationMs) {
  const subject = scheduler({ frameCount: 1 });
  subject.start(1_000);
  subject.poll(1_000);
  return subject.finish(1_000 + durationMs);
}

test("logical tickets start at zero and high-refresh callbacks skip until due", () => {
  const subject = scheduler();
  subject.start(100);

  const first = subject.poll(100);
  assert.equal(first.status, "frame");
  assert.deepEqual(first.ticket, {
    frameIndex: 0,
    nowMs: 0,
    elapsedSeconds: 0,
  });
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.ticket));

  const early = subject.poll(104);
  assert.deepEqual(early, {
    status: "not-due",
    nextFrameIndex: 1,
    dueAtWallMs: 110,
  });
  assert.ok(Object.isFrozen(early));
  assert.equal(subject.poll(109.999).status, "not-due");

  const second = subject.poll(110);
  assert.equal(second.status, "frame");
  assert.deepEqual(second.ticket, {
    frameIndex: 1,
    nowMs: 10,
    elapsedSeconds: 0.01,
  });
});

test("summary records the configured ticket step and half-open logical duration", () => {
  const subject = scheduler({ frameCount: 3, frameStepMs: 10 });
  subject.start(100);
  subject.poll(100);
  const summary = subject.finish(90_100);

  assert.equal(summary.frameStepMs, 10);
  assert.equal(summary.logicalDurationMs, 30);
});

test("a late callback keeps absolute deadlines while emitting at most one sequential frame", () => {
  const subject = scheduler({ frameCount: 4 });
  subject.start(0);
  assert.equal(subject.poll(0).ticket.frameIndex, 0);

  const late = subject.poll(100);
  assert.equal(late.status, "frame");
  assert.deepEqual(late.ticket, {
    frameIndex: 1,
    nowMs: 10,
    elapsedSeconds: 0.01,
  });
  assert.equal(subject.poll(101).ticket.frameIndex, 2);
  assert.equal(subject.poll(102).ticket.frameIndex, 3);
});

test("a repeated late poll at one RAF timestamp cannot drain the backlog", () => {
  const subject = scheduler({ frameCount: 4 });
  subject.start(0);
  assert.equal(subject.poll(0).ticket.frameIndex, 0);
  assert.equal(subject.poll(100).ticket.frameIndex, 1);
  assert.throws(
    () => subject.poll(100),
    /once per wall timestamp/,
  );
  assert.equal(subject.finish(100).finishedAtWallMs, 100,
    "finish at the last poll timestamp remains allowed");
});

test("a repeated not-due poll at one timestamp is rejected too", () => {
  const subject = scheduler({ frameCount: 2 });
  subject.start(0);
  assert.equal(subject.poll(0).status, "frame");
  assert.deepEqual(subject.poll(5), {
    status: "not-due",
    nextFrameIndex: 1,
    dueAtWallMs: 10,
  });
  assert.throws(
    () => subject.poll(5),
    /once per wall timestamp/,
  );
});

test("144 Hz callback cadence emits all 5,400 60 Hz tickets before 90 seconds", () => {
  const subject = scheduler({ frameCount: 5_400, frameStepMs: 1_000 / 60 });
  const callbackStepMs = 1_000 / 144;
  const startedAt = 1_000;
  let emittedFrames = 0;
  let finalTicketWallMs = startedAt;

  subject.start(startedAt);
  for (let callbackIndex = 0; callbackIndex <= 90 * 144; callbackIndex++) {
    const wallNowMs = startedAt + callbackIndex * callbackStepMs;
    const result = subject.poll(wallNowMs);
    if (result.status === "frame") {
      assert.equal(result.ticket.frameIndex, emittedFrames);
      emittedFrames++;
      finalTicketWallMs = wallNowMs;
      if (emittedFrames === 5_400) break;
    }
  }

  assert.equal(emittedFrames, 5_400);
  assert.ok(finalTicketWallMs <= startedAt + 90_000);
  assert.equal(subject.finish(startedAt + 90_000).valid, true);
});

test("exactly 5,400 logical frames complete a 90 second 60 Hz run", () => {
  const frameStepMs = 1_000 / 60;
  const subject = scheduler({ frameCount: 5_400, frameStepMs });
  const startedAt = 1_000;

  subject.start(startedAt);
  for (let frameIndex = 0; frameIndex < 5_400; frameIndex++) {
    const wallNowMs = startedAt + frameIndex * frameStepMs;
    const result = subject.poll(wallNowMs);
    assert.equal(result.status, "frame");
    assert.equal(result.ticket.frameIndex, frameIndex);
    if (frameIndex === 0) {
      assert.equal(result.ticket.nowMs, 0);
      assert.equal(result.ticket.elapsedSeconds, 0);
    }
  }

  assert.throws(
    () => subject.poll(startedAt + 5_400 * frameStepMs),
    /all logical frames have been emitted/,
  );
  const summary = subject.finish(startedAt + 90_000);
  assert.deepEqual(summary, {
    startedAtWallMs: startedAt,
    finishedAtWallMs: startedAt + 90_000,
    wallDurationMs: 90_000,
    frameStepMs,
    logicalDurationMs: 90_000,
    expectedDurationMs: 90_000,
    toleranceMs: 250,
    expectedFrames: 5_400,
    emittedFrames: 5_400,
    complete: true,
    durationValid: true,
    valid: true,
    invalidReasons: [],
  });
});

test("duration validity is one-sided and inclusive at 90,000..90,250 ms", () => {
  assert.equal(finishCompleteAt(89_999.999).durationValid, false);
  assert.equal(finishCompleteAt(90_000).durationValid, true);
  assert.equal(finishCompleteAt(90_250).durationValid, true);
  assert.equal(finishCompleteAt(90_250.001).durationValid, false);
});

test("late overrun and incomplete runs are invalid with stable reason ordering", () => {
  const incomplete = scheduler();
  incomplete.start(5_000);
  const summary = incomplete.finish(5_001);
  assert.equal(summary.complete, false);
  assert.equal(summary.durationValid, false);
  assert.equal(summary.valid, false);
  assert.deepEqual(summary.invalidReasons, [
    "incomplete-frame-sequence",
    "duration-out-of-range",
  ]);

  const late = finishCompleteAt(90_251);
  assert.equal(late.complete, true);
  assert.equal(late.valid, false);
  assert.deepEqual(late.invalidReasons, ["duration-out-of-range"]);
});

test("finished summaries are deeply immutable and JSON-safe", () => {
  const subject = scheduler({ frameCount: 1 });
  subject.start(10);
  const frame = subject.poll(10);
  const summary = subject.finish(90_010);

  assert.ok(Object.isFrozen(frame));
  assert.ok(Object.isFrozen(frame.ticket));
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.invalidReasons));
  assert.deepEqual(JSON.parse(JSON.stringify(frame)), frame);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  assert.equal(subject.summary, summary);
  assert.throws(() => {
    summary.invalidReasons.push("changed");
  }, TypeError);
});

test("lifecycle permits one start and one finish only", () => {
  const subject = scheduler({ frameCount: 1 });
  assert.equal(subject.summary, undefined);
  assert.throws(() => subject.poll(0), /has not started/);
  assert.throws(() => subject.finish(0), /has not started/);

  subject.start(0);
  assert.throws(() => subject.start(0), /already started/);
  subject.poll(0);
  subject.finish(90_000);
  assert.throws(() => subject.poll(90_000), /already finished/);
  assert.throws(() => subject.finish(90_000), /already finished/);
  assert.throws(() => subject.start(90_000), /already started/);
});

test("configuration rejects nonfinite and nonsensical values", () => {
  for (const frameCount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => scheduler({ frameCount }), /frameCount/);
  }
  for (const frameStepMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => scheduler({ frameStepMs }), /frameStepMs/);
  }
  for (const expectedDurationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => scheduler({ expectedDurationMs }), /expectedDurationMs/);
  }
  for (const toleranceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => scheduler({ toleranceMs }), /toleranceMs/);
  }
  assert.throws(
    () => scheduler({ expectedDurationMs: Number.MAX_VALUE, toleranceMs: Number.MAX_VALUE }),
    /finite upper bound/,
  );
  assert.doesNotThrow(() => scheduler({ toleranceMs: 0 }));
});

test("wall timestamps must be finite and nondecreasing", () => {
  assert.throws(() => scheduler().start(Number.NaN), /wallNowMs must be finite/);
  assert.throws(() => scheduler().start(Number.POSITIVE_INFINITY), /wallNowMs must be finite/);

  const subject = scheduler({ frameCount: 1 });
  subject.start(10);
  assert.throws(() => subject.poll(9), /wallNowMs must be monotonic/);
  assert.throws(() => subject.poll(Number.NaN), /wallNowMs must be finite/);
  assert.equal(subject.poll(10).status, "frame");
  assert.throws(() => subject.finish(9), /wallNowMs must be monotonic/);
  assert.throws(() => subject.finish(Number.POSITIVE_INFINITY), /wallNowMs must be finite/);
  assert.equal(subject.finish(90_010).valid, true);
});
