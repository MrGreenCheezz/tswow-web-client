import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, forgetMovementState, movementFlags, releaseAllInput,
} from "../dist/code/browser/input/Movement.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

function worldWithMover(sent) {
  const mover = {
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map(),
  };
  return {
    mapId: 0,
    movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(),
    sendMovement: (...args) => {
      sent.push(args);
      // WorldState.move snaps the controlled position into a fresh object on every send.
      mover.position = { ...mover.position };
    },
  };
}

test("a forced root stops held movement on the wire and release resumes it once", () => {
  const sent = [];
  const world = worldWithMover(sent);
  forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  game.terrain = {
    heightAt: () => 0, liquidAt: () => undefined, isHole: () => false,
  };
  try {
    beginHeld("moveForward");
    assert.deepEqual(sent.map(([opcode]) => opcode), [OPCODES.MSG_MOVE_START_FORWARD]);

    // SMSG_FORCE_MOVE_ROOT has been acknowledged and applied to WorldClient.movementState.
    world.movementState.rooted = true;
    advancePhysics(1 / 60);
    assert.equal(world.state.objects.get(1n).position.x, 0, "root blocks local translation");
    assert.deepEqual(sent.map(([opcode]) => opcode),
      [OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_STOP]);
    assert.equal(sent.at(-1)[1] & MOVEMENT_FLAGS.forward, 0,
      "the stop packet must not keep a contradictory moving bit");
    assert.equal(movementFlags() & MOVEMENT_FLAGS.forward, 0);

    // The key stays down. Once the server removes root, the client announces the axis again.
    world.movementState.rooted = false;
    advancePhysics(1 / 60);
    assert.deepEqual(sent.map(([opcode]) => opcode),
      [OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_STOP, OPCODES.MSG_MOVE_START_FORWARD]);
    assert.ok(world.state.objects.get(1n).position.x > 0,
      "physics continues on the live position after the restart packet");
    advancePhysics(1 / 60);
    assert.equal(sent.length, 3, "the same transition is not repeated each frame");
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
    game.worldLoading = false;
  }
});

test("input pressed while rooted does not claim movement", () => {
  const sent = [];
  const world = worldWithMover(sent);
  world.movementState.rooted = true;
  forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  try {
    beginHeld("moveForward");
    assert.equal(sent.length, 0);
    assert.equal(movementFlags() & MOVEMENT_FLAGS.forward, 0);
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.worldLoading = false;
  }
});
