// Lane L8 (WORK_PLAN 5.04, 04.10): the rest of other players between their packets — the pitch keys turning a
// swimmer's or flier's pitch (PITCH_UP 0x40 / PITCH_DOWN 0x80) and a packet taken at its sender's moment rather
// than at its arrival (the core stamps relayed moves with the server's time of the move, MovementHandler.cpp:362-372;
// Wow.exe applies a remote packet at that moment, 0x006EB730, window −500…+1000 ms). Times are explicit.
import assert from "node:assert/strict";
import test from "node:test";
import { WorldState } from "../dist/code/world/WorldState.js";
import { MOVEMENT_FLAGS as F } from "../dist/code/world/MovementProtocol.js";
import {
  CORRECTION_MS, PACKET_CLOCK_RELAX, PACKET_LATE_WINDOW_MS, PacketClock, REMOTE_PITCH_LIMIT, advanceDrift, driftPitch,
  emptyDrift, kinematicsFor, realignDrift,
} from "../dist/code/world/MovementExtrapolation.js";

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

test("the packet clock takes the fastest delivery as on time and the excess as lateness", () => {
  const clock = new PacketClock();
  assert.equal(clock.lateness(undefined, 100), 0, "no stamp, no lateness");
  assert.equal(clock.lateness(5_000, 1_000), 0, "the first packet sets the clock");
  assert.equal(clock.lateness(5_100, 1_100), 0, "on time");
  near(clock.lateness(5_300, 1_500), 200 - 400 * PACKET_CLOCK_RELAX, 1e-9, "two hundred late");
  // L8-review 5.04: was «past the window: taken at arrival» (0). Wow.exe clamps the catch-up to its window instead
  // (0x006EB730: application − arrival held in −500…+1000 ms, late is the negative side).
  assert.equal(PACKET_LATE_WINDOW_MS, 500);
  assert.equal(clock.lateness(5_400, 2_500), PACKET_LATE_WINDOW_MS, "past the window: caught up by the window, no more");
  // A faster delivery than any before is the new on time.
  assert.equal(clock.lateness(6_000, 1_950), 0);
  // Arrivals earlier than the latest seen do not relax it.
  near(clock.lateness(6_100, 2_100), 50, 1e-9);
  // The best is forgotten slowly: ten seconds later a delivery 20 ms slower than it is on time again.
  const forgetting = new PacketClock();
  forgetting.lateness(0, 0);
  assert.equal(forgetting.lateness(10_000, 10_000 + 1_000 * 10_000 * PACKET_CLOCK_RELAX / 1_000), 0);
});

test("a late packet is carried forward from its sender's moment, and the picture stays where it was", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at(), time: 10_000 }, 1_000);
  state.updateMotions(1_400);
  const drawn = { ...state.objects.get(OTHER).position };
  // Sent 400 ms after the first one but arriving 300 ms late, from 2.8 yards on (7 yd/s · 0.4 s).
  state.move(OTHER, { flags: F.forward, position: at(2.8), time: 10_400 }, 1_700);
  const object = state.objects.get(OTHER);
  near(object.drift.at, 1_700 - (300 - 700 * PACKET_CLOCK_RELAX), 1e-9);
  assert.equal(object.drift.fadeAt, 1_700);
  state.updateMotions(1_700);
  near(object.position.x, drawn.x, 1e-9, "continuous at the arrival");
  // Once the correction has faded the unit is where its packet and its lateness put it.
  const later = 1_700 + CORRECTION_MS + 20;
  state.updateMotions(later);
  near(object.position.x, 2.8 + 7 * (later - object.drift.at) / 1000, 1e-9);
  // Without a stamp nothing changes: the packet is taken at its arrival, as before.
  const plain = world();
  plain.move(OTHER, { flags: F.forward, position: at() }, 1_000);
  plain.move(OTHER, { flags: F.forward, position: at(2.8) }, 1_700);
  assert.equal(plain.objects.get(OTHER).drift.at, 1_700);
});

test("realignDrift keys its clock by the world state, and a pitching drift's pitch runs from the sender's moment", () => {
  const owner = {};
  const first = drifting(F.flying | F.forward | F.pitchUp, { pitch: 0 });
  first.at = 1_000;
  realignDrift(owner, first, 20_000, 1_000);
  const second = drifting(F.flying | F.forward | F.pitchUp, { pitch: 0 });
  second.at = 1_500;
  realignDrift(owner, second, 20_400, 1_500);
  near(second.at, 1_400 + 500 * PACKET_CLOCK_RELAX, 1e-9, "100 ms late on the owner's clock");
  near(driftPitch(second, 1_500), RATE * (100 - 500 * PACKET_CLOCK_RELAX) / 1000, 1e-9);
  // Another owner has its own clock: its first packet is on time.
  const other = drifting(F.flying | F.forward, { pitch: 0 });
  other.at = 1_500;
  realignDrift({}, other, 20_400, 1_500);
  assert.equal(other.at, 1_500);
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
  assert.ok(object.drift.fadeAt > object.drift.at, "taken at its sender's moment");
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

// L8-review 5.04: Wow.exe keeps the time relation per unit (0x006EB730: mover+0xc0 the local moment a packet was
// applied, +0xc4 its stamp, set from the unit's first packet; each next one is applied at the last plus its stamps'
// difference), so a sender's own steady latency is never caught up — only a packet later than that sender's usual is.
// One clock for every sender took the fastest of them as on time and drew the slower ones ahead of their packets by
// their extra latency, which their STOP then pulled back at every stop.
test("each unit keeps its own packet clock: a steady slower sender is on time, its STOP pulls nothing back", () => {
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

test("a packet later than its sender's usual is caught up by at most the window (Wow.exe clamps at 500 ms)", () => {
  const clock = new PacketClock();
  clock.lateness(1_000, 100);
  near(clock.lateness(1_100, 600), 400 - 500 * PACKET_CLOCK_RELAX, 1e-9, "inside the window");
  assert.equal(clock.lateness(1_200, 2_000), PACKET_LATE_WINDOW_MS, "a hitch's backlog: the window, no more");
});
