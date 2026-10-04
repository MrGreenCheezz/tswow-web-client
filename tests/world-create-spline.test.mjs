// 5.02: the spline a create block carries (docs/implementation/line-A4.ru.md, 5.02 and М-A4-1).
//
// The server sends a unit's path exactly once — `MoveSplineInit::Launch` broadcasts its
// SMSG_MONSTER_MOVE at launch — so a unit that comes into view mid-path is only ever told about
// that path by `WriteCreate` inside its create block. The fixtures write that block by hand
// (tests/fixtures/world-packets.mjs, `livingSplineCreatePacket`, after
// MovementPacketBuilder.cpp:147-186), nodes laid out as `InitCatmullRom` lays out `Spline::points`.
import assert from "node:assert/strict";
import test from "node:test";
import { WorldState, serverControlsMovement } from "../dist/code/world/WorldState.js";
import { livingSplineCreatePacket, splineNodes } from "./fixtures/world-packets.mjs";

const SPLINE_SCRUB_MASK = 0x0cc0300f; // MOVEMENTFLAG_MASK_MOVING | MOVEMENTFLAG_SPLINE_ENABLED
const GUID = 0xf130000000005002n;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-3, `${message}: ${actual} vs ${expected}`);

const path = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }];

test("a creature caught mid-path goes on from where the block says, and arrives", () => {
  const state = new WorldState();
  const finished = [];
  state.onSplineFinished = (guid, splineId) => finished.push([guid, splineId]);
  // The virtual first node is c0 − (cos o, sin o, 0) with o = π/2: (0, −1, 0), not c0, so cutting
  // the path in the wrong place moves the creature.
  const nodes = splineNodes(path, { orientation: Math.PI / 2 });
  assert.equal(nodes.length, 5);
  state.applyUpdate(livingSplineCreatePacket(GUID, {
    position: { x: 10, y: 5, z: 0, orientation: Math.PI / 2 },
    spline: { timePassed: 3000, duration: 4000, splineId: 77, nodes },
  }), 1000);
  const creature = state.objects.get(GUID);
  assert.ok(creature.motion, "the creature is moving, not standing");
  assert.equal(creature.motion.splineId, 77);
  near(creature.position.x, 10, "x three quarters along");
  near(creature.position.y, 5, "y three quarters along");
  near(creature.position.orientation, Math.PI / 2, "facing along the second leg");
  assert.notEqual(creature.movementFlags & 0x08000000, 0, "its flags still say it is on a spline");

  state.updateMotions(1500);
  near(creature.position.y, 7.5, "the path continues from timePassed: 3.5 s of 4 is 17.5 of 20 yd");
  state.updateMotions(2000);
  near(creature.position.x, 10, "x at the end");
  near(creature.position.y, 10, "y at the end");
  assert.equal(creature.motion, undefined);
  assert.equal(creature.movementFlags & SPLINE_SCRUB_MASK, 0);
  assert.deepEqual(finished, [[GUID, 77]]);
});

test("a cycle closes on c1 under Enter_Cycle, and later laps leave c0 out", () => {
  const square = [...path, { x: 0, y: 10, z: 0 }];
  const nodes = splineNodes(square, { cyclic: true, cyclicPoint: 1 });
  assert.equal(nodes.length, 7, "N + 3");
  const state = new WorldState();
  state.applyUpdate(livingSplineCreatePacket(GUID, {
    movementFlags: 0x08000000 | 0x02000000 | 0x00000400, // SPLINE_ENABLED | FLYING | CAN_FLY
    spline: { flags: 0x40000 | 0x80000 | 0x100000, duration: 4000, nodes, mode: 1 },
  }), 0);
  const flyer = state.objects.get(GUID);
  assert.ok(flyer.motion?.cyclic);
  state.updateMotions(4000);
  near(flyer.position.x, 10, "one lap later it is back at c1");
  near(flyer.position.y, 0, "one lap later it is back at c1");
  // The second lap is c1 → c2 → c3 → c1 (34.14 yd) in the same four seconds: a quarter of it in
  // is 8.54 yd past c1, on the first leg.
  state.updateMotions(5000);
  near(flyer.position.x, 10, "second lap starts at c1");
  near(flyer.position.y, (10 + 10 + Math.SQRT2 * 10) / 4, "second lap runs without c0");
  assert.ok(flyer.motion, "a cycle never finishes");
});

test("a flying spline is flying, and not cyclic", () => {
  const state = new WorldState();
  state.applyUpdate(livingSplineCreatePacket(GUID, {
    spline: { flags: 0x2000, duration: 2000, nodes: splineNodes(path), mode: 1 },
  }), 0);
  const motion = state.objects.get(GUID).motion;
  assert.equal(motion.flying, true);
  assert.equal(motion.cyclic, false);
});

test("a finished, empty or stopped spline leaves the unit standing with clean flags", () => {
  for (const spline of [
    { timePassed: 2000, duration: 2000, nodes: splineNodes(path) },
    { timePassed: 0, duration: 0, nodes: [] },
    { flags: 0x100, timePassed: 0, duration: 0, nodes: [] }, // Done: `MoveSpline::Initialize` clears the spline
  ]) {
    const state = new WorldState();
    state.applyUpdate(livingSplineCreatePacket(GUID, { position: { x: 3, y: 4, z: 5, orientation: 1 }, spline }), 0);
    const creature = state.objects.get(GUID);
    assert.equal(creature.motion, undefined);
    assert.deepEqual(creature.position, { x: 3, y: 4, z: 5, orientation: 1 });
    assert.equal(creature.movementFlags & SPLINE_SCRUB_MASK, 0);
  }
});

test("a spline aboard a transport out of view is not placed, and one in view is composed", () => {
  const transportGuid = 0x1fc0000000000042n;
  const create = (state) => state.applyUpdate(livingSplineCreatePacket(GUID, {
    movementFlags: 0x08000001 | 0x200,
    position: { x: 105, y: 200, z: 10, orientation: 0 },
    transport: { guid: transportGuid, x: 5, y: 0, z: 0, orientation: 0 },
    spline: { timePassed: 500, duration: 2000, nodes: splineNodes([{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }]) },
  }), 0);

  const alone = new WorldState();
  assert.doesNotThrow(() => create(alone));
  assert.equal(alone.objects.get(GUID).motion, undefined);
  assert.deepEqual(alone.objects.get(GUID).position, { x: 105, y: 200, z: 10, orientation: 0 });

  const aboard = new WorldState();
  aboard.move(transportGuid, { flags: 0, position: { x: 100, y: 200, z: 10, orientation: 0 } }, 0);
  create(aboard);
  const rider = aboard.objects.get(GUID);
  assert.ok(rider.motion);
  near(rider.position.x, 105, "a quarter along the deck-frame path, put into the world");
  near(rider.position.y, 200, "on the ship's line");
});

test("SMSG_FLIGHT_SPLINE_SYNC paces the next lap and never moves the unit", () => {
  // Wow.exe 0x0098B5D0: the phase error, wrapped into ±½ lap, becomes the next lap's duration
  // modifier (clamped to ½…2), which 0x0098CA00 takes up at the lap boundary. Nothing jumps.
  const square = [...path, { x: 0, y: 10, z: 0 }]; // 40 yd round c0 → c1 → c2 → c3 → c0
  const state = new WorldState();
  state.applyUpdate(livingSplineCreatePacket(GUID, {
    spline: { flags: 0x80000, duration: 4000, nodes: splineNodes(square, { cyclic: true, cyclicPoint: 0 }) },
  }), 0);
  const unit = state.objects.get(GUID);
  state.updateMotions(1000);
  const before = { ...unit.position };
  state.resyncSpline(GUID, 0.30, 1000); // the server is 5 % ahead
  assert.equal(state.splineSyncDropped, 0);
  state.updateMotions(1000);
  assert.deepEqual(unit.position, before, "the sync moves nothing");
  state.updateMotions(4000);
  near(unit.position.x, 0, "this lap still takes its 4 s");
  near(unit.position.y, 0, "this lap still takes its 4 s");
  state.updateMotions(4000 + 1900);
  near(unit.position.x, 10, "the next lap is 5 % shorter: 3.8 s, half of it 1.9 s");
  near(unit.position.y, 10, "half a lap is c2");
  state.updateMotions(4000 + 3800);
  near(unit.position.x, 0, "back at c0 after 3.8 s");
  state.updateMotions(4000 + 3800 + 2000);
  near(unit.position.y, 10, "and the lap after it is 4 s again");
  near(unit.position.x, 10, "and the lap after it is 4 s again");

  state.resyncSpline(0x999n, 0.5, 10_000);
  assert.equal(state.splineSyncDropped, 1, "a sync for a unit with no path is counted");

  // A client just short of its lap end against a server just past it: the error is +4 %, not
  // −96 %, and the unit carries on round the loop instead of starting the lap over.
  const late = new WorldState();
  late.applyUpdate(livingSplineCreatePacket(GUID, {
    spline: { flags: 0x80000, duration: 4000, nodes: splineNodes(square, { cyclic: true, cyclicPoint: 0 }) },
  }), 0);
  late.updateMotions(3920);
  const lateUnit = late.objects.get(GUID);
  const edge = { ...lateUnit.position };
  late.resyncSpline(GUID, 0.02, 3920);
  late.updateMotions(3920);
  assert.deepEqual(lateUnit.position, edge);
  late.updateMotions(4000 + 3840);
  near(lateUnit.position.x, 0, "the next lap is 4 % shorter");
  near(lateUnit.position.y, 0, "the next lap is 4 % shorter");

  // And the mirror image: a client just past its lap end against a server just short of it is
  // 4 % ahead, so the lap after the current one is 4 % longer rather than halved.
  const early = new WorldState();
  early.applyUpdate(livingSplineCreatePacket(GUID, {
    spline: { flags: 0x80000, duration: 4000, nodes: splineNodes(square, { cyclic: true, cyclicPoint: 0 }) },
  }), 0);
  early.updateMotions(4080);
  early.resyncSpline(GUID, 0.98, 4080);
  const earlyUnit = early.objects.get(GUID);
  early.updateMotions(8000 + 2080);
  near(earlyUnit.position.x, 10, "half of a 4.16 s lap is c2");
  near(earlyUnit.position.y, 10, "half of a 4.16 s lap is c2");

  // Under Enter_Cycle a sync arriving after the first lap — with no frame drawn in between, as in a
  // hidden tab — must not bring c0 back, and later laps run c1 … c3, c1.
  const looping = new WorldState();
  looping.applyUpdate(livingSplineCreatePacket(GUID, {
    spline: { flags: 0x40000 | 0x80000 | 0x100000, duration: 4000, nodes: splineNodes(square, { cyclic: true }), mode: 1 },
  }), 0);
  looping.resyncSpline(GUID, 0.25, 5000);
  looping.updateMotions(5000);
  const flyer = looping.objects.get(GUID);
  near(flyer.position.x, 10, "a quarter into a later lap is on its first leg");
  near(flyer.position.y, (10 + 10 + Math.SQRT2 * 10) / 4, "measured from c1");
});

test("a sync for a path that does not loop changes nothing", () => {
  const state = new WorldState();
  state.applyUpdate(livingSplineCreatePacket(GUID, {
    spline: { duration: 4000, nodes: splineNodes(path) },
  }), 0);
  const unit = state.objects.get(GUID);
  state.resyncSpline(GUID, 0.9, 1000);
  state.updateMotions(2000);
  near(unit.position.x, 10, "half of 20 yd in 2 s of 4, as if no sync had come");
  near(unit.position.y, 0, "half of 20 yd in 2 s of 4, as if no sync had come");
});

test("a player created mid-flight is under server control until the flight ends", () => {
  const state = new WorldState();
  const self = 0x7n;
  state.applyUpdate(livingSplineCreatePacket(self, {
    typeId: 4, updateFlags: 0x0020 | 0x0001, movementFlags: 0x08000001 | 0x02000000,
    spline: { flags: 0x2000, timePassed: 1000, duration: 60_000, splineId: 5, nodes: splineNodes(path), mode: 1 },
  }), 0);
  assert.equal(state.selfGuid, self);
  assert.equal(serverControlsMovement(state.objects.get(self)), true);
});
