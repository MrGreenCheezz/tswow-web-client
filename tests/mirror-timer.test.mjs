import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import {
  MIRROR_TIMER_BREATH, MIRROR_TIMER_FATIGUE, MIRROR_TIMER_FIRE, mirrorTimerRemaining,
  parsePauseMirrorTimer, parseStartMirrorTimer, parseStopMirrorTimer,
} from "../dist/code/world/MirrorTimerProtocol.js";

test("a started timer decodes the way the core writes it", () => {
  // `WorldPackets::Misc::StartMirrorTimer::Write`, MiscPackets.cpp:44.
  const payload = new PacketWriter()
    .u32(MIRROR_TIMER_BREATH).u32(45_000).u32(60_000).i32(-1).u8(0).u32(0)
    .toUint8Array();
  const timer = parseStartMirrorTimer(payload);
  assert.deepEqual(timer, { timer: 1, value: 45_000, maxValue: 60_000, scale: -1, paused: false, spellId: 0 });
});

test("the rate is signed, because a timer that is coming back has a negative one going out", () => {
  // Read as unsigned, -1 is 4,294,967,295 milliseconds a millisecond: the bar would empty in one
  // frame and the player would see nothing at all.
  const payload = new PacketWriter()
    .u32(MIRROR_TIMER_FATIGUE).u32(10_000).u32(60_000).i32(-1).u8(0).u32(0)
    .toUint8Array();
  assert.equal(parseStartMirrorTimer(payload).scale, -1);
});

test("pause and stop carry only what they need", () => {
  assert.deepEqual(parsePauseMirrorTimer(new PacketWriter().u32(MIRROR_TIMER_FIRE).u8(1).toUint8Array()),
    { timer: 2, paused: true });
  assert.equal(parseStopMirrorTimer(new PacketWriter().u32(MIRROR_TIMER_BREATH).toUint8Array()), 1);
});

test("the bar runs itself between packets", () => {
  // The server sends one packet and expects the client to keep it moving; it does not send three
  // timers a frame.
  const timer = { timer: 1, value: 30_000, maxValue: 60_000, scale: -1, paused: false, spellId: 0 };
  assert.equal(mirrorTimerRemaining(timer, 1_000, 1_000), 30_000);
  assert.equal(mirrorTimerRemaining(timer, 1_000, 11_000), 20_000);
  assert.equal(mirrorTimerRemaining(timer, 1_000, 41_000), 0, "and it stops at empty rather than going negative");

  // Coming back on dry land, and never past the maximum.
  const refilling = { ...timer, value: 50_000, scale: 10 };
  assert.equal(mirrorTimerRemaining(refilling, 0, 500), 55_000);
  assert.equal(mirrorTimerRemaining(refilling, 0, 5_000), 60_000);

  const paused = { ...timer, paused: true };
  assert.equal(mirrorTimerRemaining(paused, 0, 100_000), 30_000, "a paused timer is where it was left");
});
