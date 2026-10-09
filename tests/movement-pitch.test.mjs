import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, characterMotion, characterPitchNow, endHeld, forgetMovementState, movementFlags,
  releaseAllInput, setSteering,
} from "../dist/code/browser/input/Movement.js";
import { HELD_ACTIONS, INPUT_ACTIONS } from "../dist/code/browser/input/Bindings.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

function stubWorld({ z = 0, movementState = {} } = {}) {
  const sent = [];
  const mover = { position: { x: 0, y: 0, z, orientation: 0 }, fields: new Map() };
  const world = {
    mapId: 0,
    movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0, ...movementState,
    },
    speeds: new Map(),
    sendMovement: (...args) => {
      sent.push(args);
      mover.position = { ...mover.position };
    },
  };
  return { world, mover, sent };
}

function withWorld(stub, terrain, run) {
  forgetMovementState();
  game.world = stub.world;
  game.worldLoading = false;
  game.terrain = terrain;
  const pitch = game.camera.pitch;
  try {
    run();
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
    game.camera.pitch = pitch;
  }
}

const flat = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
const lake = { heightAt: () => -20, liquidAt: () => ({ height: 0, type: 1 }), isHole: () => false };
const opcodes = (sent) => sent.map(([opcode]) => opcode);

test("5.09: the pitch keys are stock held actions (PITCHUP/PITCHDOWN)", () => {
  const rows = new Map(INPUT_ACTIONS.map((row) => [row.action, row]));
  assert.equal(rows.get("pitchUp")?.command, "PITCHUP");
  assert.equal(rows.get("pitchDown")?.command, "PITCHDOWN");
  assert.ok(HELD_ACTIONS.has("pitchUp") && HELD_ACTIONS.has("pitchDown"));
});

test("5.09: in flight a pitch key starts and stops the pitch once, and both keys cancel", () => {
  const stub = stubWorld({ z: 50, movementState: { canFly: true } });
  withWorld(stub, flat, () => {
    advancePhysics(1 / 60);
    assert.equal(characterMotion().mode, "air");
    stub.sent.length = 0;
    beginHeld("pitchUp");
    assert.deepEqual(opcodes(stub.sent), [OPCODES.MSG_MOVE_START_PITCH_UP]);
    assert.ok(stub.sent[0][1] & MOVEMENT_FLAGS.pitchUp);
    advancePhysics(0.1);
    assert.ok(characterPitchNow() > 0.25, `pitched only ${characterPitchNow()}`);
    beginHeld("pitchDown");
    assert.equal(movementFlags() & (MOVEMENT_FLAGS.pitchUp | MOVEMENT_FLAGS.pitchDown), 0);
    endHeld("pitchDown");
    stub.sent.length = 0;
    endHeld("pitchUp");
    assert.deepEqual(opcodes(stub.sent), [OPCODES.MSG_MOVE_STOP_PITCH]);
  });
});

test("5.09: on land the pitch keys send nothing", () => {
  const stub = stubWorld();
  withWorld(stub, flat, () => {
    beginHeld("pitchUp");
    advancePhysics(1 / 60);
    endHeld("pitchUp");
    assert.deepEqual(opcodes(stub.sent), []);
    assert.equal(characterPitchNow(), 0);
  });
});

test("5.10: a swimmer goes where the character points, not where the camera rests", () => {
  const stub = stubWorld({ z: -5 });
  withWorld(stub, lake, () => {
    game.camera.pitch = -0.4137;
    advancePhysics(1 / 60);
    assert.equal(characterMotion().mode, "swim");
    // Settle at the float line first.
    for (let i = 0; i < 120; i++) advancePhysics(1 / 60);
    const floatZ = stub.mover.position.z;
    beginHeld("moveForward");
    for (let i = 0; i < 30; i++) advancePhysics(1 / 60);
    assert.ok(Math.abs(stub.mover.position.z - floatZ) < 1e-6, `W alone dived to ${stub.mover.position.z}`);

    setSteering(true);
    for (let i = 0; i < 30; i++) advancePhysics(1 / 60);
    assert.ok(stub.mover.position.z < floatZ - 0.5, `steering down did not dive: ${stub.mover.position.z}`);
    assert.ok(Math.abs(characterPitchNow() + 0.4137) < 1e-6);

    setSteering(false);
    endHeld("moveForward");
    for (let i = 0; i < Math.ceil(0.4137 / 3.14 * 60) + 1; i++) advancePhysics(1 / 60);
    assert.equal(characterPitchNow(), 0, "the swimmer levels out once the steer is let go");
  });
});
