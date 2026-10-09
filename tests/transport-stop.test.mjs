import assert from "node:assert/strict";
import test from "node:test";

// 11.01, L16: transports that can be stopped (`moTransport.canBeStopped`, template data8 — the ICC
// and Halls of Reflection gunships, the Isle of Conquest gunships). The core holds such a transport
// at a stop node: `EnableMovement(false)` raises `_pendingStop`, and when the timer next reaches a
// stop frame `Transport::Update` snaps `PathProgress` to its arrival and sets GO_STATE_READY
// (Transport.cpp:133-180, 564-570); `EnableMovement(true)` lets the timer run through the rest of the
// wait and the state goes back to ACTIVE at the departure (:174-179). A transport that cannot be
// stopped is READY for good (:98). The client never hears PathProgress again, only the state.
//
// What Wow.exe does with it (notes .runtime/re-2026-10-04/l16-transport/): the state callback
// 0x00711050 → handler 0x007101c0 acts only when data8 is set; a READY asks the path clock
// (0x007f8000) to hold at the end of the wait of the stop at or after the running phase
// (0x007f7d30); the clock runs on until it crosses that point within a frame (0x007f7840 /
// 0x007f77d0) and then holds there; ACTIVE resumes from that point at once (0x007f78c0). At creation
// GO_DYNFLAG_LO_STOPPED (0x10) in GAMEOBJECT_DYNAMIC holds it straight away (0x007100d0 → 0x007f80a0).
const motion = await import("../dist/code/browser/TransportMotion.js");
const ships = await import("../dist/code/gateway/TransportShipPaths.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const LEVEL = UPDATE_FIELDS.GAMEOBJECT_LEVEL.offset;
const DYNAMIC = UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset;
const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;
const ACTIVE = 0;
const READY = 1;

/** Twelve nodes along +x, stops (10 s) at nodes 3 and 8: the gateway's own model and bake. */
const NODES = Array.from({ length: 12 }, (_, i) => ({
  pathId: 1, nodeIndex: i, mapId: 0, x: 1000 + i * 100, y: 500, z: 20,
  flags: i === 3 || i === 8 ? 2 : 0, delay: i === 3 || i === 8 ? 10 : 0, arrivalEventId: 0, departureEventId: 0,
}));
const MODEL = ships.generateShipPath(NODES, 10, 1);
const TRACK = JSON.parse(JSON.stringify(ships.bakeShipTrack(MODEL, 1)));
const STOPS = MODEL.keyFrames.filter((frame) => frame.node.flags === 2)
  .map((frame) => ({ arrive: frame.arriveTime, departure: frame.departureTime, x: frame.node.x }));
const pose = (phase) => motion.shipPoseAt(TRACK, phase, { map: 0, x: 0, y: 0, z: 0, orientation: 0, stop: false });

const SHIP = 0x1fc0000000000001n;
const STOPPABLE = { type: 15, data: [1, 10, 1, 0, 0, 0, 0, 0, 1] };
const ORDINARY = { type: 15, data: [1, 10, 1, 0, 0, 0, 0, 0, 0] };

function shipObject({ transportTime, state = ACTIVE, dynamic = 0 }) {
  return {
    guid: SHIP, typeId: 5,
    position: { x: 1, y: 2, z: 3, orientation: 0 },
    movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined,
    transport: undefined, speeds: undefined, motion: undefined, glide: undefined, splineTier: undefined,
    transportTime, transportTimeAt: 1_000,
    fields: new Map([[ENTRY, 20808], [LEVEL, TRACK.period], [BYTES_1, (15 << 8) | state], [DYNAMIC, dynamic >>> 0]]),
    drift: undefined, pitch: undefined, rotation: undefined, positionTransport: undefined, vehicleId: undefined,
  };
}

function harness(template, object) {
  const state = new WorldState();
  const ship = new motion.ShipMotion({ paths: { track: () => TRACK }, template: () => template, mapId: () => 0 });
  state.poseProvider = (s, now) => ship.update(s, now);
  state.objects.set(SHIP, object);
  state.revision++;
  const at = () => state.objects.get(SHIP).position;
  const setState = (value) => {
    const fields = state.objects.get(SHIP).fields;
    fields.set(BYTES_1, (15 << 8) | value);
    state.revision++;
  };
  return { state, ship, at, setState };
}

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
function assertAt(actual, expected, label) {
  assert.ok(near(actual.x, expected.x) && near(actual.y, expected.y) && near(actual.z, expected.z),
    `${label}: ${actual.x.toFixed(3)},${actual.y.toFixed(3)} vs ${expected.x.toFixed(3)},${expected.y.toFixed(3)}`);
}

test("the hold point is the end of the wait of the stop at or after the phase, within one sample of the core's departure", () => {
  assert.equal(STOPS.length, 2);
  const [first, second] = STOPS;
  const within = (hold, stop) => hold > stop.departure - 1e-9 && hold <= stop.departure + TRACK.step;
  assert.ok(within(motion.shipHoldPhase(TRACK, 0), first), "from the start: the first stop");
  assert.ok(within(motion.shipHoldPhase(TRACK, first.arrive - 500), first), "just before it");
  assert.ok(within(motion.shipHoldPhase(TRACK, first.arrive + 5_000), first), "inside its wait: the same stop");
  assert.ok(within(motion.shipHoldPhase(TRACK, first.departure + 300), second), "past its departure: the next one");
  assert.ok(within(motion.shipHoldPhase(TRACK, second.departure + 300), first), "past the last: round the cycle");
  // The pose there is the node: the ship stands where the core holds it.
  const held = pose(motion.shipHoldPhase(TRACK, 0));
  assert.ok(Math.abs(held.x - first.x) < 0.05 && near(held.y, 500, 1e-3), `${held.x}`);
  assert.equal(motion.shipHoldPhase({ ...TRACK, flags: TRACK.flags.map((flags) => flags & ~motion.SHIP_SAMPLE_STOP) }, 0),
    undefined, "no stop on the path: nowhere to hold");
});

test("READY on a stoppable transport: it sails on to the next stop's departure and holds there; ACTIVE resumes from it", () => {
  const stoppable = harness(STOPPABLE, shipObject({ transportTime: 5_000 }));
  const ordinary = harness(ORDINARY, shipObject({ transportTime: 5_000 }));
  for (const env of [stoppable, ordinary]) env.state.updateMotions(1_000);
  assertAt(stoppable.at(), pose(5_000), "moving at first");
  // The server is asked to stop it (EnableMovement(false)); its state shows when it is held.
  for (const env of [stoppable, ordinary]) {
    env.state.updateMotions(2_000);
    env.setState(READY);
  }
  const hold = motion.shipHoldPhase(TRACK, 6_000);
  // Frames of an uneven length: the hold point is crossed between two of them, never landed on.
  let now = 3_000;
  for (; now <= 100_000; now += 997) {
    for (const env of [stoppable, ordinary]) env.state.updateMotions(now);
    const running = 5_000 + now - 1_000;
    // The ordinary one: READY is its state for good, it means nothing to the clock.
    assertAt(ordinary.at(), pose(running), `ordinary at ${now}`);
    if (running < hold) assertAt(stoppable.at(), pose(running), `stoppable still sailing at ${now}`);
    else assertAt(stoppable.at(), pose(hold), `stoppable held at ${now}`);
  }
  assert.ok(Math.abs(stoppable.at().x - STOPS[0].x) < 0.05, "at the stop node");
  // EnableMovement(true): ACTIVE at the departure — it leaves from where it holds, now.
  stoppable.setState(ACTIVE);
  stoppable.state.updateMotions(now);
  assertAt(stoppable.at(), pose(hold), "the resume frame");
  stoppable.state.updateMotions(now + 1_000);
  assertAt(stoppable.at(), pose(hold + 1_000), "a second later");
  stoppable.state.updateMotions(now + 31_000);
  assertAt(stoppable.at(), pose(hold + 31_000), "and on its timetable from there");
});

test("a held stoppable transport in a create block stays at its stop; an ordinary one in the same place sails on", () => {
  const [first] = STOPS;
  // `PathProgress` snapped to the stop's arrival, three cycles in (Transport.cpp:160-162).
  const progress = 3 * TRACK.period + first.arrive;
  const stoppable = harness(STOPPABLE, shipObject({ transportTime: progress, state: READY }));
  const ordinary = harness(ORDINARY, shipObject({ transportTime: progress, state: READY }));
  let now = 1_000;
  for (; now <= 61_000; now += 499) {
    stoppable.state.updateMotions(now);
    ordinary.state.updateMotions(now);
    assert.ok(Math.abs(stoppable.at().x - first.x) < 0.05 && near(stoppable.at().y, 500, 1e-3), `held at ${now}: ${stoppable.at().x}`);
  }
  assertAt(ordinary.at(), pose(first.arrive + now - 499 - 1_000), "the ordinary one left after its wait");
  assert.ok(ordinary.at().x > first.x + 100);
});

test("GO_DYNFLAG_LO_STOPPED in the create block holds a stoppable transport at once", () => {
  const stoppable = harness(STOPPABLE, shipObject({ transportTime: 6_000, dynamic: 0x10 }));
  const ordinary = harness(ORDINARY, shipObject({ transportTime: 6_000, dynamic: 0x10 }));
  const hold = motion.shipHoldPhase(TRACK, 6_000 - 1);
  for (const now of [1_000, 5_000, 30_000]) {
    stoppable.state.updateMotions(now);
    ordinary.state.updateMotions(now);
    assertAt(stoppable.at(), pose(hold), `held at ${now}`);
    assertAt(ordinary.at(), pose(6_000 + now - 1_000), `ordinary at ${now}`);
  }
});

test("L16-review: a READY seen less than a frame before the end of the wait still holds at that stop", () => {
  const hold = motion.shipHoldPhase(TRACK, 6_000);
  const env = harness(STOPPABLE, shipObject({ transportTime: hold - 300 }));
  env.state.updateMotions(1_000);
  env.setState(READY);
  env.state.updateMotions(1_000);
  // The next frame is 500 ms on: the clock crosses the hold point inside it.
  for (const now of [1_500, 2_000, 20_000]) {
    env.state.updateMotions(now);
    assertAt(env.at(), pose(hold), `held at ${now}`);
  }
});

test("L16-review: created stopped exactly at a hold point, it holds there and not at the next stop (0x007f80a0 looks from phase − 1)", () => {
  const hold = motion.shipHoldPhase(TRACK, 6_000);
  const stoppable = harness(STOPPABLE, shipObject({ transportTime: hold, dynamic: 0x10 }));
  for (const now of [1_000, 20_000]) {
    stoppable.state.updateMotions(now);
    assertAt(stoppable.at(), pose(hold), `held at ${now}`);
  }
  assert.notEqual(motion.shipHoldPhase(TRACK, hold), hold, "from the hold point itself the next stop would be found");
});

test("L16-review: a stop's wait ends at a cut — the cycle's end or a teleport — where the core sends ACTIVE", () => {
  // The core leaves a held frame as soon as its timer is past that frame's DepartureTime: ACTIVE, then
  // MoveToNextWaypoint / TeleportTransport (Transport.cpp:174-193); the cycle ends at the last frame's
  // departure (TransportMgr.cpp:354). A stop on the far side of the jump is the next frame's own wait,
  // already sailed under ACTIVE — the hold is not carried across it. The gateway marks the sample before
  // a jump, and always the last one, with SHIP_SAMPLE_CUT (TransportShipPaths.ts `bakeShipTrack`).
  const S = motion.SHIP_SAMPLE_STOP;
  const C = motion.SHIP_SAMPLE_CUT;
  const flags = [S, S, 0, 0, S, S | C, S, 0, S, S | C];
  const zeros = flags.map(() => 0);
  const track = { path: 1, speed: 1, accel: 1, period: 1_000, step: 100, map: zeros, x: zeros, y: zeros, z: zeros, o: zeros, flags };
  assert.equal(motion.shipHoldPhase(track, 850), 0, "the last frame's wait ends with the cycle, not after the first frame's");
  assert.equal(motion.shipHoldPhase(track, 350), 600, "a wait before a teleport ends at the jump");
  assert.equal(motion.shipHoldPhase(track, 0), 200, "the first frame's own wait");
  assert.equal(motion.shipHoldPhase(track, 650), 700, "the wait after the jump, once there");
});

// L16-review: a page gets no frames while hidden (Loop.ts runs `updateMotions` per animation frame),
// but its WorldClient keeps reading packets, so the state can flip and flip back between two looks.
// The core's `GAMEOBJECT_DYNAMIC` word (GameObject.cpp:2866-2873) still says where its timer was.
/** The high half of `GAMEOBJECT_DYNAMIC` for a timer, as the core writes it (int16 of timer/period×65535). */
const dynamicAt = (timer) => ((Math.trunc((timer / TRACK.period) * 65535) & 0xffff) << 16) >>> 0;

function heldAtFirstStop() {
  const env = harness(STOPPABLE, shipObject({ transportTime: 5_000 }));
  env.state.updateMotions(1_000);
  env.setState(READY);
  env.state.updateMotions(2_000);
  for (let now = 3_000; now <= 60_000; now += 1_000) env.state.updateMotions(now);
  const hold = motion.shipHoldPhase(TRACK, 6_000);
  assertAt(env.at(), pose(hold), "held at the first stop");
  const setDynamic = (value) => {
    env.state.objects.get(SHIP).fields.set(DYNAMIC, value);
    env.state.revision++;
  };
  return { ...env, setDynamic };
}

test("L16-review: ACTIVE and the next READY both missed behind a hidden page: the ship is at the stop the server holds it at", () => {
  const [, second] = STOPS;
  const env = heldAtFirstStop();
  // Hidden: EnableMovement(true), the departure (ACTIVE), the next stop's arrival (READY, PathProgress
  // snapped to its ArriveTime). Only the last of it is in the fields when the frames come back.
  env.setState(ACTIVE);
  env.setState(READY);
  env.setDynamic(dynamicAt(second.arrive));
  env.state.updateMotions(150_000);
  assert.ok(Math.abs(env.at().x - second.x) < 0.05, `at the second stop: ${env.at().x.toFixed(2)} vs ${second.x}`);
  for (let now = 151_000; now <= 200_000; now += 1_000) env.state.updateMotions(now);
  const hold = motion.shipHoldPhase(TRACK, second.arrive);
  assertAt(env.at(), pose(hold), "held at the second stop's departure");
  // EnableMovement(true) once more: it leaves from there.
  env.setState(ACTIVE);
  env.setDynamic(dynamicAt(second.departure));
  env.state.updateMotions(201_000);
  env.state.updateMotions(202_000);
  assert.ok(env.at().x > second.x + 0.1 && env.at().x < second.x + 20, `sailing on from the second stop: ${env.at().x.toFixed(2)}`);
});

test("L16-review: a hold the server has long since sailed past is not where a missed departure resumes from", () => {
  const [, second] = STOPS;
  const env = heldAtFirstStop();
  // Hidden through ACTIVE, the next READY and its ACTIVE: the server left the second stop as well.
  env.setState(ACTIVE);
  env.setState(READY);
  env.setState(ACTIVE);
  const timer = second.departure + 2_000;
  env.setDynamic(dynamicAt(timer));
  env.state.updateMotions(150_000);
  assert.ok(Math.abs(env.at().x - pose(timer).x) < 2, `past the second stop with the server: ${env.at().x.toFixed(2)} vs ${pose(timer).x.toFixed(2)}`);
  env.state.updateMotions(151_000);
  assert.ok(Math.abs(env.at().x - pose(timer + 1_000).x) < 2, `and on its timetable: ${env.at().x.toFixed(2)}`);
});

test("L16-review: the usual departure still resumes from the hold point when its word moved too", () => {
  const [first] = STOPS;
  const env = heldAtFirstStop();
  // ACTIVE seen as it comes, its word at the departure (the timer ran through the rest of the wait).
  env.setState(ACTIVE);
  env.setDynamic(dynamicAt(first.departure + 40));
  env.state.updateMotions(61_000);
  const hold = motion.shipHoldPhase(TRACK, 6_000);
  assertAt(env.at(), pose(hold), "the resume frame: the hold point");
  env.state.updateMotions(62_000);
  assertAt(env.at(), pose(hold + 1_000), "a second later");
});

test("a re-sent create block starts the hold over with the new block", () => {
  const env = harness(STOPPABLE, shipObject({ transportTime: 5_000 }));
  env.state.updateMotions(1_000);
  env.setState(READY);
  env.state.updateMotions(2_000);
  for (let now = 3_000; now <= 80_000; now += 1_000) env.state.updateMotions(now);
  const hold = motion.shipHoldPhase(TRACK, 6_000);
  assertAt(env.at(), pose(hold), "held");
  // Back in view, moving (ACTIVE) at a new PathProgress: the new block's clock, no hold.
  env.state.objects.set(SHIP, shipObject({ transportTime: 70_000 }));
  env.state.revision++;
  env.state.updateMotions(80_000);
  env.state.updateMotions(81_000);
  assertAt(env.at(), pose(70_000 + 80_000), "the new block's timetable");
});
