import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  MAX_SUBSTEPS, PHYSICS_MAX_FRAME, advancePhysics, beginHeld, characterMotion, forgetMovementState,
  lastPhysicsSubsteps, physicsElapsed, releaseAllInput,
} from "../dist/code/browser/input/Movement.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";

/**
 * 5.13: a stub world whose `sendMovement` replaces the mover's position object, exactly as
 * `WorldState.move` does for the controlled character.
 */
function stubWorld({ z = 0, speeds = [], movementState = {} } = {}) {
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

test("5.13: a slow frame moves the character its real distance, not a tenth of a second's", () => {
  const stub = stubWorld();
  withWorld(stub, () => {
    beginHeld("moveForward");
    advancePhysics(0.3);
    assert.ok(Math.abs(stub.mover.position.x - 2.1) < 0.05, `ran ${stub.mover.position.x}`);
  });
});

test("5.13: the physics frame is bounded by the substeps and by half a second", () => {
  assert.equal(physicsElapsed(2, 7, 0.389), Math.min(PHYSICS_MAX_FRAME, MAX_SUBSTEPS * 0.389 * 0.5 / 7));
  assert.ok(physicsElapsed(0.3, 28, 0.389) * 28 <= MAX_SUBSTEPS * 0.389 * 0.5 + 1e-9);
  assert.equal(physicsElapsed(1 / 60, 7, 0.389), 1 / 60);
  assert.equal(physicsElapsed(-1, 7, 0.389), 0);
});

test("5.13: a jump's packet mid-frame does not lose the rest of the frame", () => {
  const stub = stubWorld();
  withWorld(stub, () => {
    beginHeld("moveForward");
    beginHeld("jump");
    advancePhysics(0.2);
    assert.ok(stub.sent.some(([opcode]) => opcode === OPCODES.MSG_MOVE_JUMP), "the jump was sent");
    assert.ok(Math.abs(stub.mover.position.x - 1.4) < 0.02, `moved ${stub.mover.position.x} of 1.4`);
  });
});

test("5.13: substeps follow the mode's own speed, so a fast flight is cut finer", () => {
  const stub = stubWorld({ z: 50, speeds: [["flight", 28]], movementState: { canFly: true } });
  withWorld(stub, () => {
    beginHeld("moveForward");
    advancePhysics(1 / 60);
    assert.equal(characterMotion().mode, "air");
    advancePhysics(1 / 60);
    assert.ok(lastPhysicsSubsteps() >= 3, `${lastPhysicsSubsteps()} substeps at 28 yards a second`);
  });
});
