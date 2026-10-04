import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import {
  advancePhysics, beginHeld, endHeld, forgetMovementState, releaseAllInput, setMouseRun, toggleAutoRun, turnCharacterBy,
} from "../dist/code/browser/input/Movement.js";
import {
  FOLLOW_START_DISTANCE, FOLLOW_STOP_DISTANCE, cancelFollow, followTargetGuid, onFollowChange, startFollow,
} from "../dist/code/browser/input/Follow.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// 5.18: following (Wow.exe 0x005224C0 → 0x0072B4A0 type 3 → 0x00727400; per frame 0x007317A0).

const F = UPDATE_FIELDS;

function player(guid, x, { typeId = 4, health = 100, flags = 0, faction = 1, charmedBy = 0, channel = 0 } = {}) {
  return {
    guid, typeId,
    position: { x, y: 0, z: 0, orientation: Math.PI / 2 },
    fields: new Map([
      [F.UNIT_FIELD_HEALTH.offset, health],
      [F.UNIT_FIELD_FLAGS.offset, flags],
      [F.UNIT_FIELD_FACTIONTEMPLATE.offset, faction],
      [F.UNIT_FIELD_CHARMEDBY.offset, charmedBy],
      [F.UNIT_CHANNEL_SPELL.offset, channel],
    ]),
  };
}

function setup(targetX = 10, targetOptions = {}) {
  const sent = [];
  const self = player(1n, 0);
  const target = player(2n, targetX, targetOptions);
  const world = {
    mapId: 0, movementReady: true, controlledGuid: undefined,
    state: { selfGuid: 1n, objects: new Map([[1n, self], [2n, target]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(),
    sendMovement: (opcode) => {
      sent.push(opcode);
      const mover = world.state.objects.get(1n);
      mover.position = { ...mover.position };
    },
  };
  movement();
  game.world = world;
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  const events = [];
  const stop = onFollowChange((change) => events.push(change.kind === "begin" ? `begin:${change.name}` : "end"));
  return { world, self: () => world.state.objects.get(1n), target, sent, events, stop };
}

function movement() {
  cancelFollow();
  forgetMovementState();
}

function teardown(context) {
  context.stop();
  cancelFollow();
  releaseAllInput();
  forgetMovementState();
  game.world = undefined;
  game.terrain = undefined;
}

const RULES = {
  canAttack: () => false,
  factionGroup: (template) => (template === 1 ? 3 : template === 2 ? 5 : undefined),
  name: () => "Друг",
};

test("the original's numbers: start under 30 yards, stand inside 3", () => {
  assert.equal(FOLLOW_START_DISTANCE, 30);
  assert.equal(FOLLOW_STOP_DISTANCE, 3);
});

test("following a player 10 yards ahead: one START_FORWARD, facing the target, closing in, then standing", () => {
  const context = setup(10);
  try {
    assert.equal(startFollow(context.world, context.target, RULES), undefined);
    assert.deepEqual(context.events, ["begin:Друг"], "AUTOFOLLOW_BEGIN carries the name");
    assert.equal(followTargetGuid(), 2n);
    for (let frame = 0; frame < 30; frame++) advancePhysics(1 / 30);
    assert.deepEqual(context.sent.filter((op) => op === OPCODES.MSG_MOVE_START_FORWARD), [OPCODES.MSG_MOVE_START_FORWARD],
      "the run goes out once, as a held forward key");
    assert.ok(Math.abs(context.self().position.orientation) < 1e-9, "the character faces the target");
    assert.ok(context.self().position.x > 3, "and has closed in");
    for (let frame = 0; frame < 60; frame++) advancePhysics(1 / 30);
    const x = context.self().position.x;
    assert.ok(Math.abs(x - (10 - FOLLOW_STOP_DISTANCE)) < 0.3, `stood just inside 3 yards of it, at ${x}`);
    assert.equal(context.sent.at(-1), OPCODES.MSG_MOVE_STOP, "the stop goes out");
    assert.equal(followTargetGuid(), 2n, "and the follow goes on (it is not autorun)");
    // The target walks off: the character runs again.
    context.target.position = { x: 20, y: 0, z: 0, orientation: 0 };
    advancePhysics(1 / 30);
    assert.equal(context.sent.at(-1), OPCODES.MSG_MOVE_START_FORWARD);
    assert.deepEqual(context.events, ["begin:Друг"], "no END along the way");
  } finally {
    teardown(context);
  }
});

test("too far to start, too far to keep: ERR_AUTOFOLLOW_TOO_FAR, and 30 yards later the follow ends", () => {
  const context = setup(45);
  try {
    assert.equal(startFollow(context.world, context.target, RULES), "ERR_AUTOFOLLOW_TOO_FAR");
    assert.deepEqual(context.events, [], "nothing begins");
    context.target.position = { x: 29, y: 0, z: 0, orientation: 0 };
    assert.equal(startFollow(context.world, context.target, RULES), undefined);
    context.target.position = { x: 70, y: 0, z: 0, orientation: 0 };
    advancePhysics(1 / 30);
    assert.deepEqual(context.events, ["begin:Друг", "end"], "AUTOFOLLOW_END when the target is 30 yards off");
    assert.equal(followTargetGuid(), undefined);
    // A new FollowUnit ends the old follow first, even when the new one is refused (0x00727400).
    context.target.position = { x: 5, y: 0, z: 0, orientation: 0 };
    startFollow(context.world, context.target, RULES);
    const far = { ...context.target, guid: 3n, position: { x: 50, y: 0, z: 0, orientation: 0 } };
    context.world.state.objects.set(3n, far);
    assert.equal(startFollow(context.world, far, RULES), "ERR_AUTOFOLLOW_TOO_FAR");
    assert.deepEqual(context.events.slice(-2), ["begin:Друг", "end"]);
  } finally {
    teardown(context);
  }
});

test("who may be followed: a friendly player only; a dead, stunned or channelling character may not follow", () => {
  const context = setup(5);
  try {
    assert.equal(startFollow(context.world, undefined, RULES), "ERR_GENERIC_NO_TARGET");
    assert.equal(startFollow(context.world, undefined, RULES, true), "ERR_UNIT_NOT_FOUND");
    assert.equal(startFollow(context.world, context.self(), RULES), "ERR_INVALID_FOLLOW_TARGET", "not oneself");
    const npc = player(4n, 5, { typeId: 3 });
    assert.equal(startFollow(context.world, npc, RULES), "ERR_INVALID_FOLLOW_TARGET", "players only (0x00729BD0)");
    assert.equal(startFollow(context.world, player(5n, 5, { faction: 2 }), RULES), "ERR_INVALID_FOLLOW_TARGET",
      "another faction group");
    assert.equal(startFollow(context.world, player(6n, 5, { charmedBy: 9 }), RULES), "ERR_INVALID_FOLLOW_TARGET");
    assert.equal(startFollow(context.world, context.target, { ...RULES, canAttack: () => true }), "ERR_INVALID_FOLLOW_TARGET",
      "an enemy");
    context.self().fields.set(F.UNIT_FIELD_HEALTH.offset, 0);
    assert.equal(startFollow(context.world, context.target, RULES), "ERR_PLAYER_DEAD");
    context.self().fields.set(F.UNIT_FIELD_HEALTH.offset, 100);
    context.self().fields.set(F.UNIT_FIELD_FLAGS.offset, 0x40000);
    assert.equal(startFollow(context.world, context.target, RULES), "ERR_GENERIC_STUNNED");
    context.self().fields.set(F.UNIT_FIELD_FLAGS.offset, 0);
    context.self().fields.set(F.UNIT_CHANNEL_SPELL.offset, 133);
    assert.equal(startFollow(context.world, context.target, RULES), "ERR_TOOBUSYTOFOLLOW");
    assert.deepEqual(context.events, []);
  } finally {
    teardown(context);
  }
});

test("a movement key, both buttons, autorun or the mouse turning the character ends it; a jump on land does not", () => {
  const context = setup(10);
  try {
    const follow = () => {
      cancelFollow();
      assert.equal(startFollow(context.world, context.target, RULES), undefined);
      advancePhysics(1 / 60);
    };
    follow();
    beginHeld("jump");
    assert.equal(followTargetGuid(), 2n, "a jump on land keeps following");
    endHeld("jump");
    beginHeld("pitchUp");
    assert.equal(followTargetGuid(), 2n, "a pitch key on land does nothing (0x005FACE0 runs only aloft)");
    endHeld("pitchUp");
    for (const action of ["moveForward", "moveBackward", "strafeLeft", "turnRight"]) {
      follow();
      beginHeld(action);
      assert.equal(followTargetGuid(), undefined, `${action} ends it`);
      endHeld(action);
    }
    follow();
    setMouseRun(true);
    assert.equal(followTargetGuid(), undefined, "both buttons");
    setMouseRun(false);
    follow();
    toggleAutoRun();
    assert.equal(followTargetGuid(), undefined, "autorun");
    toggleAutoRun();
    follow();
    turnCharacterBy(0.2);
    assert.equal(followTargetGuid(), undefined, "the mouse turning the character");
    assert.equal(context.events.at(-1), "end");
  } finally {
    teardown(context);
  }
});

test("a dead or vanished target, a stun, another mover end it, and the run stops on the wire", () => {
  const context = setup(10);
  try {
    startFollow(context.world, context.target, RULES);
    advancePhysics(1 / 60);
    assert.equal(context.sent.at(-1), OPCODES.MSG_MOVE_START_FORWARD);
    context.target.fields.set(F.UNIT_FIELD_HEALTH.offset, 0);
    advancePhysics(1 / 60);
    assert.equal(followTargetGuid(), undefined);
    assert.equal(context.sent.at(-1), OPCODES.MSG_MOVE_STOP);
    context.target.fields.set(F.UNIT_FIELD_HEALTH.offset, 100);
    startFollow(context.world, context.target, RULES);
    context.world.controlledGuid = 77n;
    advancePhysics(1 / 60);
    assert.equal(followTargetGuid(), undefined, "a vehicle or a charmed unit is not the follower");
    context.world.controlledGuid = undefined;
    startFollow(context.world, context.target, RULES);
    context.world.state.objects.delete(2n);
    advancePhysics(1 / 60);
    assert.equal(followTargetGuid(), undefined, "out of sight");
  } finally {
    teardown(context);
  }
});

test("the stock seam hears AUTOFOLLOW_BEGIN with the name and AUTOFOLLOW_END (ZoneText.lua's AutoFollowStatus)", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  assert.equal(FRAMEXML_SEAM_EVENTS.autofollowBegin, "AUTOFOLLOW_BEGIN");
  assert.equal(FRAMEXML_SEAM_EVENTS.autofollowEnd, "AUTOFOLLOW_END");
  const context = setup(10);
  const listeners = new Map();
  context.world.events = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
    emit() {},
  };
  context.world.actionButtons = [];
  context.world.casts = new Map();
  context.world.cooldownRemaining = () => 0;
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => context.world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  try {
    startFollow(context.world, context.target, RULES);
    cancelFollow();
    assert.deepEqual(fired.filter(([event]) => event.startsWith("AUTOFOLLOW")),
      [["AUTOFOLLOW_BEGIN", "Друг"], ["AUTOFOLLOW_END"]]);
    seam.detach();
    startFollow(context.world, context.target, RULES);
    assert.equal(fired.filter(([event]) => event.startsWith("AUTOFOLLOW")).length, 2, "a detached seam hears nothing");
  } finally {
    seam.detach();
    teardown(context);
  }
});
