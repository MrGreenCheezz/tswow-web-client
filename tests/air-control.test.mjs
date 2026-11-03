// 03.11 (6.36): what keys do to a jump, as Wow.exe does it. Measured on the stand (F:\WowOracle\runs\air-control.txt,
// air-control2.txt): a jump with a direction flies where it left for; a jump from a standstill takes one key, at the walk's speed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { airMovementFlags } from "../dist/code/browser/input/AirKeys.js";
import {
  AIR_KEY_BACKWARD, AIR_KEY_FORWARD, AIR_KEY_LEFT, AIR_KEY_RIGHT, GRAVITY, JUMP_VELOCITY, latchAirKey, newCharacterMotion, stepCharacter,
} from "../dist/code/browser/game/Physics.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { MOVEMENT_FLAGS as F, readMovementInfo, writeMovementInfoBody } from "../dist/code/world/MovementProtocol.js";

const STEP = 1 / 120;
const probe = { ground: () => 0, liquid: () => undefined, hole: () => false };
const input = (overrides = {}) => ({
  forward: 0, strafe: 0, ascend: false, descend: false, pitch: 0, runSpeed: 7, runBackSpeed: 4.5, walkSpeed: 2.5, swimSpeed: 4.72, flightSpeed: 7,
  collisionHeight: 2, radius: 0.389, rooted: false, waterWalking: false, featherFall: false, hovering: false, hoverHeight: 0, canFly: false, gravityDisabled: false,
  ...overrides,
});
const FACING = 0.7;
const flight = JUMP_VELOCITY * 2 / GRAVITY;

/** Stands the character still or runs it, jumps, and then does what `air` says at each moment of the flight. */
function jump({ keys = {}, air = () => ({}) } = {}) {
  const position = { x: 0, y: 0, z: 0, orientation: FACING };
  const motion = newCharacterMotion();
  stepCharacter(position, motion, input(keys), probe, STEP);
  const from = { x: position.x, y: position.y };
  stepCharacter(position, motion, input({ ...keys, ascend: true }), probe, STEP);
  assert.equal(motion.mode, "air");
  const takeoff = { ...motion.jump, keys: motion.airKeys };
  let t = 0;
  while (motion.mode === "air" && t < 3) {
    const step = air(t, position) ?? {};
    stepCharacter(position, motion, input({ ...step }), probe, STEP);
    t += STEP;
  }
  const dx = position.x - from.x;
  const dy = position.y - from.y;
  return { takeoff, t, distance: Math.hypot(dx, dy), along: Math.atan2(dy, dx), orientation: position.orientation };
}
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} vs ${expected}`);

test("a standing jump goes straight up, and says so: facing's direction, speed 0", () => {
  const { takeoff, distance } = jump();
  assert.equal(takeoff.speed, 0);
  near(takeoff.cosAngle, Math.cos(FACING), 1e-9, "cos");
  near(takeoff.sinAngle, Math.sin(FACING), 1e-9, "sin");
  assert.equal(takeoff.keys, 0);
  assert.equal(distance, 0);
});

test("a running jump flies on whatever the keys do: let go, S, a strafe", () => {
  const run = { forward: 1 };
  const plain = jump({ keys: run, air: () => run });
  near(plain.distance, 7 * flight, 0.15, "the flight's length");
  near(plain.along, FACING, 0.01, "along the takeoff");
  assert.equal(plain.takeoff.keys, AIR_KEY_FORWARD);
  for (const [name, keys] of [["let go", {}], ["S", { forward: -1 }], ["strafe", { forward: 1, strafe: -1 }]]) {
    const other = jump({ keys: run, air: (t) => (t >= 0.15 ? keys : run) });
    near(other.distance, plain.distance, 1e-6, name);
    near(other.along, plain.along, 1e-6, name);
  }
});

test("a turn in the air turns the character and not the flight", () => {
  const run = { forward: 1 };
  const plain = jump({ keys: run, air: () => run });
  const turned = jump({ keys: run, air: (t, position) => { if (t >= 0.1) position.orientation = 2.552; return run; } });
  near(turned.along, plain.along, 1e-6, "the flight");
  near(turned.distance, plain.distance, 1e-6, "its length");
  assert.equal(turned.orientation, 2.552);
});

test("the direction and speed are the keys' at the takeoff", () => {
  const right = jump({ keys: { strafe: -1 }, air: () => ({ strafe: -1 }) });
  near(right.along, FACING - Math.PI / 2, 0.01, "a strafe flies sideways");
  assert.equal(right.takeoff.speed, 7);
  assert.equal(right.takeoff.keys, AIR_KEY_RIGHT);
  const both = jump({ keys: { forward: 1, strafe: -1 } });
  near(both.along, FACING - Math.PI / 4, 0.01, "forward and right between the two");
  near(both.takeoff.cosAngle, 0.996, 1e-3, "Wow.exe's own packet said 0.996");
  near(both.takeoff.sinAngle, -0.085, 1e-3, "and -0.085");
  assert.equal(both.takeoff.keys, AIR_KEY_FORWARD | AIR_KEY_RIGHT);
  const back = jump({ keys: { forward: -1 } });
  assert.equal(back.takeoff.speed, 4.5, "the back rate");
  near(Math.abs(back.along - FACING), Math.PI, 0.01, "behind");
  assert.equal(back.takeoff.keys, AIR_KEY_BACKWARD);
});

test("a standing jump takes one key: the walk's speed, along where that key pointed, to the ground", () => {
  const delay = 0.14;
  for (const [name, keys, angle] of [["W", { forward: 1 }, FACING], ["S", { forward: -1 }, FACING + Math.PI], ["right", { strafe: -1 }, FACING - Math.PI / 2], ["left", { strafe: 1 }, FACING + Math.PI / 2]]) {
    const { distance, along, t } = jump({ air: (now) => (now >= delay ? keys : {}) });
    near(distance, 2.5 * (t - delay), 0.05, `${name}: 2.5 yd/s`);
    near(Math.cos(along), Math.cos(angle), 0.001, `${name}: where it points`);
    near(Math.sin(along), Math.sin(angle), 0.001, `${name}: where it points`);
  }
  // Let go, it goes on: measured 1.601 yd with W held for a moment, as with W held to the ground.
  const held = jump({ air: (now) => (now >= delay ? { forward: 1 } : {}) });
  const released = jump({ air: (now) => (now >= delay && now < delay + 0.28 ? { forward: 1 } : {}) });
  near(released.distance, held.distance, 1e-6, "let go in the air");
  // A turn after the key changes nothing; a turn before it counts.
  const turned = jump({ air: (now, position) => { if (now >= delay + 0.1) position.orientation = 2; return now >= delay ? { forward: 1 } : {}; } });
  near(turned.along, FACING, 1e-6, "turned after");
  // Every later key waits: S after W, a strafe after W.
  const changed = jump({ air: (now) => (now < delay ? {} : now < delay + 0.28 ? { forward: 1 } : { forward: -1 }) });
  near(changed.distance, held.distance, 1e-6, "S after W");
  const added = jump({ air: (now) => (now < delay ? {} : now < delay + 0.28 ? { forward: 1 } : { forward: 1, strafe: -1 }) });
  near(added.along, FACING, 1e-6, "a strafe after W");
  // Pressed together, forward wins: measured along 0.700.
  const together = jump({ air: (now) => (now >= delay ? { forward: 1, strafe: -1 } : {}) });
  near(together.along, FACING, 1e-6, "together");
});

test("what a key gives is the walk's speed, whatever the run and the back are", () => {
  const motion = newCharacterMotion();
  motion.jump = { velocity: JUMP_VELOCITY, sinAngle: 0, cosAngle: 1, speed: 0 };
  latchAirKey(motion, 1, 0, 0, { walkSpeed: 4, runSpeed: 14 });
  assert.equal(motion.jump.speed, 4, "4 with the walk at 4, measured");
  const slow = newCharacterMotion();
  slow.jump = { velocity: JUMP_VELOCITY, sinAngle: 0, cosAngle: 1, speed: 0 };
  latchAirKey(slow, 1, 0, 0, { walkSpeed: 4, runSpeed: 3 });
  assert.equal(slow.jump.speed, 3, "0x00987654: the lesser of the two");
  const base = newCharacterMotion();
  base.jump = { velocity: JUMP_VELOCITY, sinAngle: 0, cosAngle: 1, speed: 0 };
  latchAirKey(base, -1, 0, 0, { runSpeed: 7 });
  assert.equal(base.jump.speed, 2.5);
  // Taken once.
  latchAirKey(base, 1, 0, 1, { walkSpeed: 9, runSpeed: 9 });
  assert.equal(base.jump.speed, 2.5);
  assert.equal(base.airKeys, AIR_KEY_BACKWARD);
});

test("the wire says what Wow.exe's own packets said", () => {
  const fall = F.falling;
  // The flight's bits stay, and a key is a PENDING bit until the landing.
  assert.equal(airMovementFlags(fall, AIR_KEY_FORWARD, 1, 0), 0x1001, "running");
  assert.equal(airMovementFlags(fall, AIR_KEY_FORWARD, 0, 0), 0x5001, "W let go");
  assert.equal(airMovementFlags(fall, AIR_KEY_FORWARD, -1, 0), 0x21001, "S instead");
  assert.equal(airMovementFlags(fall, AIR_KEY_FORWARD, 1, -1), 0x81001, "a strafe to the right");
  assert.equal(airMovementFlags(fall, AIR_KEY_FORWARD | AIR_KEY_RIGHT, 0, -1), 0x5009, "forward and right, W let go");
  assert.equal(airMovementFlags(fall, AIR_KEY_FORWARD | AIR_KEY_RIGHT, 0, 0), 0xd009, "and the strafe too");
  assert.equal(airMovementFlags(fall, 0, 0, 0), 0x1000, "a standing jump");
  assert.equal(airMovementFlags(fall, AIR_KEY_FORWARD, 1, 0), 0x1001, "and the key it took");
  assert.equal(airMovementFlags(fall, AIR_KEY_BACKWARD, -1, 0), 0x1002);
  assert.equal(airMovementFlags(fall | F.forward | F.turnLeft, AIR_KEY_LEFT, 0, 1), 0x1014, "other bits stay, the direction is the flight's");
});

test("the jump block goes cos first: at facing 0.7 Wow.exe sends 0.765, then 0.644", () => {
  const info = {
    flags: F.falling, flags2: 0, time: 1, position: { x: 1, y: 2, z: 3, orientation: 0.7 }, fallTime: 5,
    jump: { velocity: -7.955547, cosAngle: Math.cos(0.7), sinAngle: Math.sin(0.7), speed: 7 },
  };
  const bytes = writeMovementInfoBody(new PacketWriter(), info).toUint8Array();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jumpAt = 4 + 2 + 4 + 16 + 4;
  near(view.getFloat32(jumpAt, true), -7.955547, 1e-5, "velocity");
  near(view.getFloat32(jumpAt + 4, true), 0.7648, 1e-3, "cos first");
  near(view.getFloat32(jumpAt + 8, true), 0.6442, 1e-3, "sin second");
  near(view.getFloat32(jumpAt + 12, true), 7, 1e-5, "speed");
  const read = readMovementInfo(new PacketReader(bytes));
  near(read.jump.cosAngle, Math.cos(0.7), 1e-5, "read back");
  near(read.jump.sinAngle, Math.sin(0.7), 1e-5, "read back");
});

test("a wall under a walk-off takes what it stops; a jump goes on along the wall and past it", () => {
  // A wall at x = 1: whatever goes past it is pushed back.
  const wall = { ...probe, pushOut: (x, y) => ({ x: Math.min(x, 1), y }) };
  const fallOff = () => {
    const position = { x: 0, y: 0, z: 10, orientation: Math.PI / 4 };
    const motion = newCharacterMotion();
    motion.mode = "air";
    motion.jump = { velocity: 0, cosAngle: Math.SQRT1_2, sinAngle: Math.SQRT1_2, speed: 7 };
    motion.airKeys = AIR_KEY_FORWARD;
    return { position, motion };
  };
  const off = fallOff();
  for (let t = 0; t < 0.5; t += STEP) stepCharacter(off.position, off.motion, input({ forward: 1 }), wall, STEP);
  near(off.motion.jump.cosAngle, 0, 1e-6, "now along the wall");
  near(off.motion.jump.sinAngle, 1, 1e-6, "now along the wall");
  // What is left along it, from step to step: the step that met the wall went partly along it already.
  assert.ok(off.motion.jump.speed < 7 && off.motion.jump.speed >= 7 * Math.SQRT1_2 - 1e-9, `${off.motion.jump.speed}`);
  const leap = fallOff();
  leap.motion.jump.velocity = JUMP_VELOCITY;
  for (let t = 0; t < 0.3; t += STEP) stepCharacter(leap.position, leap.motion, input({ forward: 1 }), wall, STEP);
  assert.equal(leap.motion.jump.speed, 7, "a jump keeps it");
  near(leap.motion.jump.cosAngle, Math.SQRT1_2, 1e-9, "and its direction");
});

test("a knock back is still its own: the keys do not steer it and the flight's rule does not touch it", () => {
  const position = { x: 0, y: 0, z: 10, orientation: 0 };
  const motion = newCharacterMotion();
  motion.mode = "air";
  motion.drift = { vx: 3, vy: 0 };
  motion.jump = { velocity: 5, cosAngle: 1, sinAngle: 0, speed: 3 };
  stepCharacter(position, motion, input({ forward: -1 }), probe, 0.1);
  near(position.x, 0.3, 1e-9, "the drift");
  assert.equal(motion.jump.speed, 3);
});
