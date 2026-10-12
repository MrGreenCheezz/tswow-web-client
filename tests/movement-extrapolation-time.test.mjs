// Lane L8 (WORK_PLAN 5.04, 04.10): the rest of other players between their packets — the pitch keys turning a
// swimmer's or flier's pitch (PITCH_UP 0x40 / PITCH_DOWN 0x80) and a packet taken at its sender's moment rather
// than at its arrival (the core stamps relayed moves with the server's time of the move, MovementHandler.cpp:362-372;
// Wow.exe applies a remote packet at that moment, 0x006EB730, window −500…+1000 ms). Times are explicit.
import assert from "node:assert/strict";
import test from "node:test";
import { WorldState } from "../dist/code/world/WorldState.js";
import { MOVEMENT_FLAGS as F } from "../dist/code/world/MovementProtocol.js";
import {
  CORRECTION_MS, REMOTE_PITCH_LIMIT, advanceDrift, driftPitch, emptyDrift, kinematicsFor, realignDrift,
} from "../dist/code/world/MovementExtrapolation.js";
import {
  MOVE_SCHEDULE_EARLY_MS, MOVE_SCHEDULE_LATE_MS, MOVE_SMOOTHING_SAMPLES, MoverClock,
} from "../dist/code/world/MovementSchedule.js";

const SELF = 1n;
const OTHER = 2n;
const RATE = 3.14;
const at = (x = 0, y = 0, z = 0, orientation = 0) => ({ x, y, z, orientation });
const near = (actual, expected, epsilon = 1e-6, label = "") =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} ≠ ${expected}`);

function world() {
  const state = new WorldState();
  state.selfGuid = SELF;
  state.move(SELF, { flags: 0, position: at() }, 0);
  return state;
}

/** A drift filled from flags as WorldState fills it, at `at` 0. */
function drifting(flags, extra = {}) {
  const drift = emptyDrift();
  kinematicsFor({ flags, ...extra }, undefined, drift);
  return drift;
}

function sample(drift, now) {
  const out = { x: 0, y: 0, z: 0, orientation: 0 };
  advanceDrift(drift, now, out);
  return out;
}

test("the pitch keys turn a flier's pitch at pitchRate and its forward travel follows it", () => {
  const flier = drifting(F.flying | F.forward | F.pitchUp, { pitch: 0 });
  assert.equal(flier.pitchTurn, RATE);
  // Under the band: z = 7/ω·(1 − cos ωt), x = 7/ω·sin ωt.
  const t = 0.4;
  const early = sample(flier, t * 1000);
  near(early.z, (7 / RATE) * (1 - Math.cos(RATE * t)), 1e-4, "z");
  near(early.x, (7 / RATE) * Math.sin(RATE * t), 1e-4, "x");
  near(driftPitch(flier, t * 1000), RATE * t, 1e-12);
  // Past π/2 it climbs straight up at the whole forward speed.
  const reach = (Math.PI / 2) / RATE;
  const late = sample(flier, 2000);
  near(late.z, 7 / RATE + 7 * (2 - reach), 1e-4, "clamped z (split at the clamp)");
  near(late.x, 7 / RATE, 1e-4, "clamped x");
  assert.equal(driftPitch(flier, 2000), REMOTE_PITCH_LIMIT);
  // Down is the other way; a swimmer too; both keys cancel; on foot the keys say nothing.
  assert.equal(drifting(F.swimming | F.forward | F.pitchDown).pitchTurn, -RATE);
  assert.equal(drifting(F.flying | F.forward | F.pitchUp | F.pitchDown).pitchTurn, 0);
  assert.equal(drifting(F.forward | F.pitchUp).pitchTurn, 0);
  // Pitching while turning: the integration agrees with a fine one.
  const both = drifting(F.flying | F.forward | F.turnLeft | F.pitchDown | F.strafeLeft, { pitch: 0.3 });
  const fine = { x: 0, y: 0, z: 0 };
  const steps = 20000;
  for (let index = 0; index < steps; index++) {
    const s = ((index + 0.5) / steps) * 1.5;
    const facing = 3.141594 * s;
    const pitch = Math.max(-Math.PI / 2, 0.3 - RATE * s);
    const forward = both.along * Math.cos(pitch);
    fine.x += (Math.cos(facing) * forward - Math.sin(facing) * both.across) * (1.5 / steps);
    fine.y += (Math.sin(facing) * forward + Math.cos(facing) * both.across) * (1.5 / steps);
    fine.z += both.along * Math.sin(pitch) * (1.5 / steps);
  }
  const integrated = sample(both, 1500);
  near(integrated.x, fine.x, 2e-3, "x");
  near(integrated.y, fine.y, 2e-3, "y");
  near(integrated.z, fine.z, 2e-3, "z");
});

test("without the pitch keys the closed form is untouched", () => {
  const flier = drifting(F.flying | F.forward, { pitch: 0.5 });
  const out = sample(flier, 1000);
  near(out.z, 7 * Math.sin(0.5), 1e-9);
  near(out.x, 7 * Math.cos(0.5), 1e-9);
  assert.equal(flier.pitchTurn, 0);
});

// 5.04: a relayed packet takes effect at its unit's own schedule, Wow.exe 0x006EB730 → 0x006E97D0 (MovementSchedule.ts):
// the last packet's moment plus the stamps' difference, held in −500…+1000 ms of its arrival; a standing unit's
// schedule takes up the worst of its last 32 deliveries; a packet whose moment is ahead is held (0x006EC950) and
// applied by the frame that reaches it (0x006EF860). Was the L8 `PacketClock` (the fastest delivery as on time).
test("5.04 the schedule: the sender's spacing from the first packet, held in −500…+1000 ms of the arrival", () => {
  const clock = new MoverClock();
  assert.equal(clock.schedule(10_000, 1_000, false), 1_000, "the first packet is on time");
  assert.equal(clock.schedule(10_400, 1_700, false), 1_400, "300 late: taken at the sender's spacing, run on from there");
  assert.equal(clock.schedule(10_900, 1_600, false), 1_900, "early: its moment is ahead of its arrival");
  assert.equal(clock.schedule(11_000, 3_000, false), 3_000 - MOVE_SCHEDULE_LATE_MS, "a backlog is caught up by 500 at most");
  assert.equal(clock.schedule(15_000, 2_600, false), 2_600 + MOVE_SCHEDULE_EARLY_MS, "and nothing is held over a second");
  assert.equal(MOVE_SCHEDULE_LATE_MS, 500);
  assert.equal(MOVE_SCHEDULE_EARLY_MS, 1_000);
  // A stamp that goes back counts as no time at all (0x006EB730: `< 1` is 0, the last stamp kept).
  const back = new MoverClock();
  back.schedule(5_000, 100, false);
  assert.equal(back.schedule(4_000, 150, false), 100, "0 ms after the last, which stood at 100");
  // A unit on a server spline takes its packet as it comes, and its schedule runs on unclamped (param_6).
  const spline = new MoverClock();
  spline.schedule(1_000, 100, false);
  assert.equal(spline.schedule(4_000, 200, false, true), 200, "early by 2 900, applied at once");
  assert.equal(spline.schedule(4_100, 2_600, false), 3_200, "from 3 100 + 100, not from a clamped 1 200");
});

test("5.04 0x006E97D0: the worst of the last 32 deliveries, taken up only by a unit standing still", () => {
  // One sender, a packet every 500 ms, its deliveries 100, 200, 100 ms: standing, the schedule settles on the
  // worst — the third packet waits 100 ms for it; moving, it keeps the first one's and catches the late one up.
  const standing = new MoverClock();
  assert.equal(standing.schedule(0, 100, true), 100);
  assert.equal(standing.schedule(500, 700, true), 700, "the 100 late one sets the smoothing to 100");
  assert.equal(standing.smoothing, 100);
  assert.equal(standing.schedule(1_000, 1_100, true), 1_200, "and the next is held 100 ms: sent + 200, the worst");
  const moving = new MoverClock();
  moving.schedule(0, 100, false);
  assert.equal(moving.schedule(500, 700, false), 600, "moving, the late one is run on from 600");
  assert.equal(moving.schedule(1_000, 1_100, false), 1_100);
  assert.equal(moving.smoothing, 100, "the ring is fed all the same");
  // The window holds 32 deliveries: the 200 is forgotten 32 packets on.
  const forgetting = new MoverClock();
  forgetting.schedule(0, 100, true);
  forgetting.schedule(500, 700, true);
  for (let index = 2; index < 33; index++) forgetting.schedule(index * 500, 100 + index * 500, true);
  assert.equal(forgetting.smoothing, 100, "31 on, still remembered");
  forgetting.schedule(33 * 500, 100 + 33 * 500, true);
  assert.equal(forgetting.smoothing, 0, "32 on, gone");
  // Never before the packet applied last, when the smoothing falls.
  assert.ok(MOVE_SMOOTHING_SAMPLES === 32);
});

test("5.04 a packet whose moment is ahead is held, the unit runs on its last one, and the frame applies it", () => {
  const state = world();
  state.move(OTHER, { flags: 0, position: at(), time: 0 }, 100);
  state.move(OTHER, { flags: F.forward, position: at(), time: 500 }, 700);
  const object = state.objects.get(OTHER);
  assert.equal(object.drift.at, 700, "standing, taken at its arrival");
  // Running now: the next one arrives 100 ms sooner than the sender's spacing puts it — held to 1 200.
  state.move(OTHER, { flags: F.forward | F.turnLeft, position: at(3.5, 0, 0, 0), time: 1_000 }, 1_000);
  assert.equal(object.movementFlags, F.forward, "not yet");
  state.setSpeed(OTHER, "run", 14, 1_000);
  assert.equal(object.speeds?.get("run"), undefined, "the speed that came behind it waits with it");
  state.updateMotions(1_150);
  near(object.position.x, 7 * 0.45, 1e-9, "still running on the last packet");
  state.updateMotions(1_200);
  assert.equal(object.movementFlags, F.forward | F.turnLeft, "applied at its moment");
  assert.equal(object.drift.at, 1_200);
  assert.equal(object.speeds?.get("run"), 14, "and the speed with it");
  // Held ones go with a blink or with the unit.
  state.move(OTHER, { flags: F.forward, position: at(9), time: 2_400 }, 1_300);
  state.teleport(OTHER, { flags: 0, position: at(30) }, 1_300);
  state.updateMotions(3_000);
  assert.equal(object.movementFlags, 0, "the blink is the last word");
  assert.equal(object.position.x, 30);
});

test("a late packet is carried forward from its moment, and the picture stays where it was", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at(), time: 10_000 }, 1_000);
  state.updateMotions(1_400);
  const drawn = { ...state.objects.get(OTHER).position };
  // Sent 400 ms after the first one but arriving 300 ms late, from 2.8 yards on (7 yd/s · 0.4 s).
  state.move(OTHER, { flags: F.forward, position: at(2.8), time: 10_400 }, 1_700);
  const object = state.objects.get(OTHER);
  assert.equal(object.drift.at, 1_400, "its moment: the first one's plus the 400 between them");
  assert.equal(object.drift.fadeAt, 1_700);
  state.updateMotions(1_700);
  near(object.position.x, drawn.x, 1e-9, "continuous at the arrival");
  // Once the correction has faded the unit is where its packet and its moment put it.
  const later = 1_700 + CORRECTION_MS + 20;
  state.updateMotions(later);
  near(object.position.x, 2.8 + 7 * (later - 1_400) / 1000, 1e-9);
  // Without a stamp nothing changes: the packet is taken at its arrival, as before.
  const plain = world();
  plain.move(OTHER, { flags: F.forward, position: at() }, 1_000);
  plain.move(OTHER, { flags: F.forward, position: at(2.8) }, 1_700);
  assert.equal(plain.objects.get(OTHER).drift.at, 1_700);
});

test("realignDrift runs a drift on from its packet's moment, and a pitching drift's pitch with it", () => {
  const drift = drifting(F.flying | F.forward | F.pitchUp, { pitch: 0 });
  drift.at = 1_500;
  realignDrift(drift, 1_400, 1_500);
  assert.equal(drift.at, 1_400);
  assert.equal(drift.fadeAt, 1_500);
  near(driftPitch(drift, 1_500), RATE * 0.1, 1e-9);
  const onTime = drifting(F.flying | F.forward, { pitch: 0 });
  onTime.at = 1_500;
  realignDrift(onTime, 1_500, 1_500);
  assert.equal(onTime.at, 1_500);
});

// L8-review 5.04: a speed change (SMSG_SPLINE_SET_RUN_SPEED: a sprint, a mount) re-bases the drift where it is drawn.
// After a late packet the correction fades from the arrival (`fadeAt`), so the re-base must keep what is left of it
// from there too — from `at`, which a late packet moved back, it dropped the correction early and the unit jumped.
test("a speed change soon after a late packet keeps the picture where it was", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at(), time: 10_000 }, 1_000);
  state.updateMotions(1_400);
  // Sent 100 ms after the first, arriving 300 ms late, from 2.0 yards on: drawn ahead of it.
  state.move(OTHER, { flags: F.forward, position: at(2.0), time: 10_100 }, 1_400);
  const object = state.objects.get(OTHER);
  assert.ok(object.drift.fadeAt > object.drift.at, "taken at its moment");
  state.updateMotions(1_450);
  const drawn = { ...object.position };
  state.setSpeed(OTHER, "run", 14, 1_450);
  state.updateMotions(1_450);
  near(object.position.x, drawn.x, 1e-9, "no jump at the speed change");
  near(object.position.y, drawn.y, 1e-9);
  // And it still runs on at the new rate once the rest of the correction has faded.
  state.updateMotions(1_450 + CORRECTION_MS + 1);
  const settled = object.position.x;
  state.updateMotions(1_450 + CORRECTION_MS + 101);
  near(object.position.x - settled, 1.4, 1e-9, "14 yd/s");
});

// L8-review 5.04: a speed change re-fills the drift's kinematics from the unit's flags — and its pitch from the
// packet's, so the pitch the keys had turned since went back to the packet's: the flier's path bent back.
test("a speed change keeps the pitch a remote flier's pitch keys have turned", () => {
  const state = world();
  state.move(OTHER, { flags: F.flying | F.forward | F.pitchUp, position: at(), pitch: 0 }, 1_000);
  const object = state.objects.get(OTHER);
  near(driftPitch(object.drift, 1_300), RATE * 0.3, 1e-9);
  state.setSpeed(OTHER, "flight", 14, 1_300);
  near(driftPitch(object.drift, 1_300), RATE * 0.3, 1e-9, "the pitch where the keys had it");
  near(driftPitch(object.drift, 1_400), RATE * 0.4, 1e-9, "and turning on");
});

// Wow.exe keeps the time relation per unit (0x006EB730: mover+0xc0, +0xc4, set from the unit's first packet), so a
// sender's own steady latency is never caught up — only a packet later than that sender's usual is.
test("each unit keeps its own schedule: a steady slower sender is on time, its STOP pulls nothing back", () => {
  const state = world();
  const FAST = 3n;
  const SLOW = 4n;
  // FAST's packets take 20 ms, SLOW's 150 ms, steadily; both run on and stop.
  for (let index = 0; index < 4; index++) {
    const sent = 10_000 + index * 500;
    state.move(FAST, { flags: F.forward, position: at(3.5 * index, 10), time: sent }, sent - 9_000 + 20);
    state.move(SLOW, { flags: F.forward, position: at(3.5 * index, 20), time: sent }, sent - 9_000 + 150);
  }
  const slow = state.objects.get(SLOW);
  assert.equal(slow.drift.at, 11_500 - 9_000 + 150, "the slower sender's packet is taken at its arrival");
  assert.equal(slow.drift.fadeAt, slow.drift.at);
  // Its STOP, sent 300 ms after the last heartbeat at 1.4 yards on, finds it drawn there — nothing to pull back.
  const stopArrival = 12_100 - 9_000 + 150 - 300;
  state.updateMotions(stopArrival);
  const drawn = slow.position.x;
  near(drawn, 10.5 + 7 * 0.3, 1e-9, "drawn where the sender stopped");
  state.move(SLOW, { flags: 0, position: at(10.5 + 2.1, 20), time: 11_800 }, stopArrival);
  state.updateMotions(stopArrival + 200);
  near(slow.position.x, 12.6, 1e-9);
});
