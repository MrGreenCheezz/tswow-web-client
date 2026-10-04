import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { JUMP_VELOCITY } from "../dist/code/browser/game/Physics.js";
import {
  advancePhysics, applyKnockback, beginHeld, characterMotion, forgetMovementState, releaseAllInput, sendMovement,
} from "../dist/code/browser/input/Movement.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { knockbackImpulse, knockbackJump } from "../dist/code/world/KnockbackImpulse.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

function stubWorld() {
  const sent = [];
  const mover = { position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const world = {
    mapId: 0,
    movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(),
    sendMovement: (opcode, flags, position, extra) => {
      sent.push({ opcode, flags, extra: structuredClone(extra) });
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

test("5.01: a jump goes on the wire with up negative, as the core and Wow.exe write it", () => {
  const stub = stubWorld();
  withWorld(stub, () => {
    beginHeld("jump");
    advancePhysics(1 / 60);
    const jump = stub.sent.find((packet) => packet.opcode === OPCODES.MSG_MOVE_JUMP);
    assert.ok(jump, "the jump was sent");
    assert.equal(jump.extra.jump.velocity, -JUMP_VELOCITY);
    assert.ok(characterMotion().velocityZ > 0, "while the physics keeps up positive");
  });
});

test("5.01: a knock back throws the body along its own velocity, keys or not, and says nothing itself", () => {
  const stub = stubWorld();
  withWorld(stub, () => {
    // Wire form: away along +y at 10 yards a second, 8 up (sent as -8).
    const impulse = knockbackImpulse({ guid: 1n, counter: 0, directionCos: 0, directionSin: 1, speedXY: 10, speedZ: -8 });
    assert.equal(impulse.upSpeed, 8);
    beginHeld("moveForward");
    stub.sent.length = 0;
    applyKnockback(impulse);
    assert.deepEqual(stub.sent, [], "the acknowledgement was the packet");
    assert.equal(characterMotion().mode, "air");
    assert.equal(characterMotion().fallTime, 0);

    advancePhysics(0.2);
    assert.ok(Math.abs(stub.mover.position.y - 2) < 0.02, `carried ${stub.mover.position.y} of 2 along y`);
    assert.ok(Math.abs(stub.mover.position.x) < 1e-9, `the forward key steered it to x ${stub.mover.position.x}`);

    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    const heartbeat = stub.sent.at(-1);
    assert.ok(heartbeat.flags & MOVEMENT_FLAGS.falling);
    assert.deepEqual(heartbeat.extra.jump, knockbackJump(impulse));
    // M7-0: the live snapshot every later acknowledgement is built from says the same.
    const snapshot = stub.world.movementSnapshot?.(1n);
    assert.ok(snapshot && snapshot.flags & MOVEMENT_FLAGS.falling, "the movement layer registered its snapshot");
    assert.deepEqual(snapshot.jump, knockbackJump(impulse));
    assert.equal(stub.world.movementSnapshot(2n), undefined, "and answers for its own character only");

    // Down again: the keys steer once more.
    for (let i = 0; i < 120 && characterMotion().mode !== "ground"; i++) advancePhysics(1 / 60);
    assert.equal(characterMotion().mode, "ground");
    const x = stub.mover.position.x;
    const y = stub.mover.position.y;
    advancePhysics(0.1);
    assert.ok(stub.mover.position.x > x + 0.6, "running forward again after the landing");
    assert.ok(Math.abs(stub.mover.position.y - y) < 1e-9);
  });
});
