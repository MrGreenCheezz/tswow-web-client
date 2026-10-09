import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, flushFacing, forgetMovementState, movementBlocked, movementFlags, releaseAllInput, toggleWalkRun, turnCharacterBy,
} from "../dist/code/browser/input/Movement.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

function stubWorld({ speeds = [], fields = [], created } = {}) {
  const sent = [];
  const mover = { position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map(fields) };
  // The nine rates of the CREATE block, as `WorldState` keeps them on the object.
  if (created) mover.speeds = new Map(created);
  const world = {
    mapId: 0,
    movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(speeds),
    sendMovement: (...args) => {
      sent.push(args);
      mover.position = { ...mover.position };
    },
  };
  return { world, mover, sent };
}

function withWorld(stub, run) {
  forgetMovementState();
  game.world = stub.world;
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  try {
    run();
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
  }
}

test("5.08: backwards runs at the server's run-back rate", () => {
  const stub = stubWorld({ speeds: [["runBack", 3]] });
  withWorld(stub, () => {
    beginHeld("moveBackward");
    for (let i = 0; i < 60; i++) advancePhysics(1 / 60);
    assert.ok(Math.abs(stub.mover.position.x + 3) < 0.05, `ran back ${stub.mover.position.x}`);
  });
});

test("5.08: with no forced rate, backwards is the base 4.5", () => {
  const stub = stubWorld();
  withWorld(stub, () => {
    beginHeld("moveBackward");
    for (let i = 0; i < 60; i++) advancePhysics(1 / 60);
    assert.ok(Math.abs(stub.mover.position.x + 4.5) < 0.05, `ran back ${stub.mover.position.x}`);
  });
});

test("5.08: before any forced change the CREATE block's rates apply, the walk rate too", () => {
  const back = stubWorld({ created: [["runBack", 3]] });
  withWorld(back, () => {
    beginHeld("moveBackward");
    for (let i = 0; i < 60; i++) advancePhysics(1 / 60);
    assert.ok(Math.abs(back.mover.position.x + 3) < 0.05, `ran back ${back.mover.position.x}`);
  });
  const walk = stubWorld({ created: [["walk", 2], ["run", 9]] });
  withWorld(walk, () => {
    toggleWalkRun();
    beginHeld("moveForward");
    for (let i = 0; i < 60; i++) advancePhysics(1 / 60);
    assert.ok(Math.abs(walk.mover.position.x - 2) < 0.05, `walked to ${walk.mover.position.x}`);
  });
});

test("5.11: a stun holds the facing against keys and mouse, and says nothing", () => {
  const stub = stubWorld({ fields: [[UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x00040000]] });
  withWorld(stub, () => {
    assert.equal(movementBlocked(), "stun");
    beginHeld("turnLeft");
    advancePhysics(0.5);
    assert.equal(stub.mover.position.orientation, 0);
    assert.equal(movementFlags() & (MOVEMENT_FLAGS.turnLeft | MOVEMENT_FLAGS.turnRight), 0);
    assert.equal(turnCharacterBy(0.3), false);
    assert.equal(stub.mover.position.orientation, 0);
    // The end of a right-button drag under the stun: Wow.exe sets no facing then (0x005fb260 runs
    // only past 0x005fa6b0, which refuses UNIT_FLAG_STUNNED), so nothing goes out.
    flushFacing();
    assert.ok(!stub.sent.some(([opcode]) => opcode === OPCODES.MSG_MOVE_SET_FACING
      || opcode === OPCODES.MSG_MOVE_START_TURN_LEFT));
  });
});

test("5.11: without a stun the mouse turn is accepted", () => {
  const stub = stubWorld();
  withWorld(stub, () => {
    assert.equal(movementBlocked(), undefined);
    assert.equal(turnCharacterBy(0.3), true);
    assert.ok(Math.abs(stub.mover.position.orientation - 0.3) < 1e-9);
  });
});
