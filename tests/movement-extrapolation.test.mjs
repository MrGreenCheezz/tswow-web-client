// 5.04 — other players between their movement packets (docs/implementation/line-A4.ru.md, М-A4-2).
// Times are passed explicitly; nothing here touches the network.
import assert from "node:assert/strict";
import test from "node:test";
import { WorldState } from "../dist/code/world/WorldState.js";
import { MOVEMENT_FLAGS as F } from "../dist/code/world/MovementProtocol.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";

const SELF = 1n;
const OTHER = 2n;
const GRAVITY = 19.29110527038574;

function world() {
  const state = new WorldState();
  state.selfGuid = SELF;
  state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } }, 0);
  return state;
}

const at = (x = 0, y = 0, z = 0, orientation = 0) => ({ x, y, z, orientation });
const near = (actual, expected, epsilon = 1e-6, label = "") =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} ≠ ${expected}`);

function positionAfter(flags, ms, extra = {}, position = at()) {
  const state = world();
  state.move(OTHER, { flags, position, ...extra }, 0);
  state.updateMotions(ms);
  return state.objects.get(OTHER).position;
}

test("a runner goes on running at the speed its flags select, in the core's order", () => {
  near(positionAfter(F.forward, 500).x, 3.5, 1e-6, "run 7");
  near(positionAfter(F.forward | F.walking, 500).x, 1.25, 1e-6, "walk 2.5");
  near(positionAfter(F.backward, 500).x, -2.25, 1e-6, "run back 4.5");
  // SelectSpeedType (MoveSplineInit.cpp:30-55) asks about walking before backwards.
  near(positionAfter(F.backward | F.walking, 500).x, -1.25, 1e-6, "walking backwards is walk speed");
  const diagonal = positionAfter(F.forward | F.strafeLeft, 500);
  near(Math.hypot(diagonal.x, diagonal.y), 3.5, 1e-6, "a diagonal is the speed, not √2 of it");
  near(diagonal.y, 3.5 * Math.SQRT1_2, 1e-6, "strafe left is +y at orientation 0");
  const facingWest = positionAfter(F.forward, 1000, {}, at(0, 0, 0, Math.PI / 2));
  near(facingWest.x, 0, 1e-6);
  near(facingWest.y, 7, 1e-6);
});

test("a speed the server set is the speed extrapolated", () => {
  const state = world();
  state.move(OTHER, { flags: 0, position: at() }, 0);
  state.setSpeed(OTHER, "run", 14, 0);
  state.move(OTHER, { flags: F.forward, position: at() }, 0);
  state.updateMotions(1000);
  near(state.objects.get(OTHER).position.x, 14);
});

test("turning turns, and running while turning follows the arc", () => {
  const turning = positionAfter(F.turnLeft, 500);
  near(turning.orientation, 3.141594 / 2, 1e-6, "left is counter-clockwise");
  near(positionAfter(F.turnRight, 500).orientation, -3.141594 / 2, 1e-6);
  // A quarter turn at 7 yd/s and π rad/s: radius 7/π, ending at (r, r).
  const arc = positionAfter(F.forward | F.turnLeft, 500);
  const radius = 7 / 3.141594;
  near(arc.x, radius, 1e-5, "arc x");
  near(arc.y, radius, 1e-5, "arc y");
});

test("a swimmer's pitch tilts the forward motion and nothing else", () => {
  const pitch = -0.5;
  const swim = positionAfter(F.forward | F.swimming, 1000, { pitch });
  near(swim.z, Math.sin(pitch) * 4.722222, 1e-6, "vz = sin(pitch)·swim");
  near(swim.x, Math.cos(pitch) * 4.722222, 1e-6, "ground = cos(pitch)·swim");
  near(positionAfter(F.flying | F.ascending, 1000).z, 7, 1e-6, "ascending at flight speed");
  near(positionAfter(F.forward | F.root, 1000).x, 0, 0, "a root holds whatever the word says");
});

test("a jump falls along the jump block, minus-up on the wire, from the fall clock it reports", () => {
  const jump = { velocity: -7.9558, sinAngle: 0, cosAngle: 1, speed: 7 };
  // Keys do not steer a fall: backward is ignored, the block says forward along +x.
  const one = positionAfter(F.falling | F.backward, 1000, { fallTime: 0, jump });
  near(one.x, 7, 1e-6, "ground velocity from the block");
  near(one.z, 7.9558 - 0.5 * GRAVITY, 1e-5, "computeFallElevation with an upward start");
  const apexTime = 7.9558 / GRAVITY;
  const apex = positionAfter(F.falling, Math.round(apexTime * 1000), { fallTime: 0, jump });
  near(apex.z, 7.9558 * apexTime - 0.5 * GRAVITY * apexTime * apexTime, 2e-3, "apex");
  // The same packet written half a second into the fall: the remaining curve, not a new jump.
  const late = positionAfter(F.falling, 500, { fallTime: 500, jump });
  const fallen = (t) => t * (-7.9558 + t * GRAVITY * 0.5);
  near(late.z, -(fallen(1) - fallen(0.5)), 1e-5, "continues from fallTime");
  // A long drop reaches the terminal velocity, 60.148 yd/s.
  const drop = positionAfter(F.falling, 2000, { fallTime: 10000, jump: { velocity: 0, sinAngle: 0, cosAngle: 1, speed: 0 } });
  near(drop.z, -60.148003 * 2, 1e-3, "terminal");
});

test("a correction is continuous where it lands and gone 180 ms later", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at() }, 0);
  state.updateMotions(500);
  const object = state.objects.get(OTHER);
  const drawn = { ...object.position };
  near(drawn.x, 3.5);
  // The next heartbeat says it is a yard to the side of where it was guessed to be.
  state.move(OTHER, { flags: F.forward, position: at(3.5, 1, 0) }, 500);
  state.updateMotions(500);
  near(object.position.x, drawn.x, 1e-9, "no jump in x");
  near(object.position.y, drawn.y, 1e-9, "no jump in y");
  state.updateMotions(590);
  near(object.position.y, 0.5, 1e-9, "half closed half way");
  state.updateMotions(680);
  near(object.position.x, 3.5 + 7 * 0.18, 1e-9, "the prediction from the new packet");
  near(object.position.y, 1, 1e-9);
});

test("a stop stops, and nothing runs on past the horizon", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at() }, 0);
  state.updateMotions(500);
  state.move(OTHER, { flags: 0, position: at(3.5, 0, 0) }, 500);
  state.updateMotions(1000);
  near(state.objects.get(OTHER).position.x, 3.5, 1e-9, "stood where the stop put it");
  assert.equal(state.objects.get(OTHER).drift, undefined);

  const lost = world();
  lost.move(OTHER, { flags: F.forward, position: at() }, 0);
  lost.updateMotions(1000);
  lost.updateMotions(5000);
  near(lost.objects.get(OTHER).position.x, 7 * 2, 1e-9, "two seconds of running, no more");
  assert.equal(lost.objects.get(OTHER).drift, undefined, "the drift is dropped once spent");
  lost.updateMotions(9000);
  near(lost.objects.get(OTHER).position.x, 14, 1e-9);
});

test("the character, a passenger and a unit on a spline are not extrapolated; far is a snap", () => {
  const state = world();
  state.move(SELF, { flags: F.forward, position: at(1, 0, 0) }, 0);
  state.updateMotions(1000);
  near(state.objects.get(SELF).position.x, 1, 0, "own character is predicted locally");

  state.move(3n, {
    flags: F.forward | F.onTransport, position: at(5, 5, 0),
    transport: { guid: 99n, x: 0, y: 0, z: 0, orientation: 0, time: 0, seat: 0 },
  }, 0);
  state.updateMotions(1000);
  near(state.objects.get(3n).position.x, 5, 0, "a passenger rides, it does not run");

  state.move(OTHER, { flags: F.forward, position: at() }, 0);
  state.startSpline({
    guid: OTHER, transportGuid: undefined, points: [at(0, 0, 0), at(0, 10, 0)],
    duration: 1000, cyclic: false, flying: false, finalOrientation: undefined,
  }, 0);
  state.updateMotions(500);
  near(state.objects.get(OTHER).position.x, 0, 1e-9, "the spline owns it");
  near(state.objects.get(OTHER).position.y, 5, 1e-9);

  const far = world();
  far.move(OTHER, { flags: F.forward, position: at() }, 0);
  far.updateMotions(100);
  far.move(OTHER, { flags: F.forward, position: at(100, 0, 0) }, 100);
  far.updateMotions(100);
  near(far.objects.get(OTHER).position.x, 100, 0, "beyond 25 yd: at once");
});

test("a teleport lands at once and a runner runs on from there", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at() }, 0);
  state.teleport(OTHER, { flags: F.forward, position: at(20, 0, 0) }, 100);
  near(state.objects.get(OTHER).position.x, 20, 0, "no glide across the blink");
  state.updateMotions(600);
  near(state.objects.get(OTHER).position.x, 23.5, 1e-9);
  state.teleport(OTHER, { flags: 0, position: at(40, 0, 0) }, 700);
  state.updateMotions(1700);
  near(state.objects.get(OTHER).position.x, 40, 0, "standing after a standing teleport");
});

test("a mount bought mid-run speeds the run up from that moment", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at() }, 0);
  state.setSpeed(OTHER, "run", 14, 1000);
  state.updateMotions(2000);
  near(state.objects.get(OTHER).position.x, 7 + 14, 1e-9);
});

test("the terrain: a walker follows the slope, a faller stops on it, a cave ignores it", () => {
  const slope = (x) => x * 0.5; // a hill rising half a yard a yard
  const walker = world();
  walker.groundProbe = (x) => slope(x);
  walker.move(OTHER, { flags: F.forward, position: at(0, 0, 0.2) }, 0);
  walker.updateMotions(1000);
  near(walker.objects.get(OTHER).position.z, 3.5 + 0.2, 1e-9, "up the hill, same height above it");

  const faller = world();
  faller.groundProbe = () => 0;
  faller.move(OTHER, { flags: F.falling, position: at(0, 0, 3), fallTime: 0, jump: { velocity: 0, sinAngle: 0, cosAngle: 1, speed: 0 } }, 0);
  faller.updateMotions(2000);
  near(faller.objects.get(OTHER).position.z, 0, 0, "not under the ground before FALL_LAND");

  const cave = world();
  cave.groundProbe = () => 50; // the surface far above, as over Undercity
  cave.move(OTHER, { flags: F.forward, position: at(0, 0, 0) }, 0);
  cave.updateMotions(1000);
  near(cave.objects.get(OTHER).position.z, 0, 0, "under the terrain the terrain says nothing");
});

/**
 * A player CREATE block by hand, `Object::BuildMovementUpdate` (Object.cpp:314-339): `u16` flags
 * LIVING, the MovementInfo (`Unit::BuildMovementPacket`), the nine speeds in walk, run, runBack,
 * swim, swimBack, flight, flightBack, turn, pitch order; then an empty values block.
 */
function playerCreate(guid, flags, speeds, { pitch = 0 } = {}) {
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(guid).u8(4).u16(0x0020);
  writer.u32(flags).u16(0).u32(0).f32(0).f32(0).f32(0).f32(0);
  if (flags & (F.swimming | F.flying)) writer.f32(pitch);
  writer.u32(0);
  for (const speed of speeds) writer.f32(speed);
  return writer.u8(0).toUint8Array();
}

test("the create block keeps all nine speeds, and a player seen swimming swims on", () => {
  const state = world();
  const speeds = [2.5, 7, 4.5, 9.5, 2.5, 7, 4.5, 3.141594, 3.14];
  state.applyUpdate(playerCreate(OTHER, F.forward | F.swimming, speeds), 0);
  const object = state.objects.get(OTHER);
  assert.equal(object.speeds?.get("swim"), 9.5);
  assert.equal(object.speeds?.get("pitchRate"), Math.fround(3.14));
  assert.equal(object.runSpeed, 7);
  state.updateMotions(1000);
  near(object.position.x, 9.5, 1e-6, "the block's swim speed");
});

test("per-frame extrapolation allocates nothing and stays cheap", () => {
  const state = world();
  for (let index = 0; index < 64; index++) {
    state.move(BigInt(100 + index), { flags: F.forward | F.turnLeft | F.strafeRight, position: at(index, 0, 0) }, 0);
  }
  // Warm up, then count: a frame over 64 moving players.
  for (let frame = 0; frame < 2000; frame++) state.updateMotions(frame % 1500);
  const frames = 20000;
  const started = process.hrtime.bigint();
  for (let frame = 0; frame < frames; frame++) state.updateMotions(frame % 1500);
  const nsPerPlayer = Number(process.hrtime.bigint() - started) / frames / 64;
  // Generous: a regression to per-frame allocation or a slow path shows as an order of magnitude.
  assert.ok(nsPerPlayer < 2000, `${nsPerPlayer.toFixed(0)} ns per player per frame`);
});

// Review 02.10: a heartbeat built from a server-moved unit's own movement info (`Unit::BuildHeartBeatMsg`,
// Object.cpp:1842, sent by `SendMovementFlagUpdate`) carries the spline's FORWARD|SPLINE_ENABLED —
// that unit is on a path nobody announced here, not running straight ahead.
test("a movement packet that says SPLINE_ENABLED is never extrapolated", () => {
  const ran = positionAfter(F.forward | F.splineEnabled, 500, {}, at(0, 0, 0));
  near(ran.x, 0, 1e-6, "a creature's heartbeat glides it to the packet and no further");
  near(positionAfter(F.forward, 500).x, 3.5, 1e-6, "a player still runs on");
});
