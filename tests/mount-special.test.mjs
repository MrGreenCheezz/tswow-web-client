// 6.20 (line A7a, slice G, 05.10): the jump key on a standing ground mount is the mount's trick —
// Wow.exe 0x005fbf80 → 0x0072eb80 plays it locally and sends an empty CMSG_MOUNTSPECIAL_ANIM 0x171;
// the core relays SMSG_MOUNTSPECIAL_ANIM to everyone but the sender (MovementHandler.cpp:603-609).
import assert from "node:assert/strict";
import test from "node:test";

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { MOVEMENT_FLAGS: F } = await import("../dist/code/world/MovementProtocol.js");
const {
  jumpKeyOutcome, mountSpecialJumpPress, mountSpecialJumpRelease, jumpSpentByMountSpecial,
} = await import("../dist/code/browser/input/MountSpecial.js");

const HORSE = 2402;

test("a standing rider on a ground mount gets the trick, not a jump", () => {
  assert.equal(jumpKeyOutcome(0, HORSE, false), "mountSpecial");
  assert.equal(jumpKeyOutcome(F.walking, HORSE, false), "mountSpecial", "walk mode is not movement");
  assert.equal(jumpKeyOutcome(F.root, HORSE, false), "mountSpecial", "a root holds no movement bit");
});

test("everything else keeps the jump the client already has", () => {
  assert.equal(jumpKeyOutcome(0, 0, false), "default", "not mounted");
  assert.equal(jumpKeyOutcome(0, HORSE, true), "default", "CreatureModelData flag 0x400 (the motorcycle)");
  assert.equal(jumpKeyOutcome(F.canFly, HORSE, false), "default", "CAN_FLY rises instead");
  assert.equal(jumpKeyOutcome(F.swimming, HORSE, false), "default", "the swimmer's own key");
  assert.equal(jumpKeyOutcome(F.flying | F.canFly, HORSE, false), "default");
  for (const bit of [F.forward, F.backward, F.strafeLeft, F.strafeRight]) {
    assert.equal(jumpKeyOutcome(bit, HORSE, false), "default", `moving (0x${bit.toString(16)}) jumps`);
  }
  assert.equal(jumpKeyOutcome(F.falling, HORSE, false), "default", "in the air the physics refuses as it does now");
});

test("moving with gravity disabled is the trick again (Wow.exe 0x006e9ad0)", () => {
  assert.equal(jumpKeyOutcome(F.forward | F.disableGravity, HORSE, false), "mountSpecial");
});

test("turning on the spot does nothing at all", () => {
  assert.equal(jumpKeyOutcome(F.turnLeft, HORSE, false), "none");
  assert.equal(jumpKeyOutcome(F.turnRight, HORSE, false), "none");
  assert.equal(jumpKeyOutcome(F.turnLeft | F.forward, HORSE, false), "default", "moving decides first");
});

test("the press sends and plays once and spends the key until it is released", () => {
  const log = [];
  const host = (flags, mount = HORSE, refuses = false) => ({
    flags, mountDisplayId: mount, mountRefuses: refuses,
    send: () => log.push("send"), play: () => log.push("play"),
  });
  mountSpecialJumpRelease();
  assert.equal(mountSpecialJumpPress(host(0)), true);
  assert.deepEqual(log, ["play", "send"]);
  assert.equal(jumpSpentByMountSpecial(), true);
  mountSpecialJumpRelease();
  assert.equal(jumpSpentByMountSpecial(), false);

  log.length = 0;
  assert.equal(mountSpecialJumpPress(host(F.turnLeft)), true, "turning spends the key too");
  assert.deepEqual(log, []);
  mountSpecialJumpRelease();

  assert.equal(mountSpecialJumpPress(host(F.forward)), false, "moving: the jump goes ahead");
  assert.equal(mountSpecialJumpPress(host(0, 0)), false);
  assert.equal(jumpSpentByMountSpecial(), false);
  assert.deepEqual(log, []);
});

test("WorldClient.sendMountSpecial sends CMSG_MOUNTSPECIAL_ANIM 0x171 with an empty body", () => {
  assert.equal(OPCODES.CMSG_MOUNTSPECIAL_ANIM, 0x171);
  const connection = {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload: [...payload] }); },
    read: () => new Promise(() => {}),
    close() {},
  };
  const world = new WorldClient(connection);
  world.sendMountSpecial();
  assert.deepEqual(connection.sent, [{ opcode: 0x171, payload: [] }]);
  world.close();
  world.sendMountSpecial();
  assert.equal(connection.sent.length, 1, "nothing after close");
});

// The gateway half: CreatureModelData.Flags 0x400 on the dataset is one model, MotorcycleVehicle
// (2862), worn by displays 25870 and 25871 (`.runtime/re-2026-10-05/A7a-G/probe-model-flags.mjs`).
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { parseCreatureModelMetadata } = await import("../dist/code/gateway/CreatureModelMetadata.js");
let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
  if (!existsSync(join(dbcDirectory, "CreatureModelData.dbc"))) dbcDirectory = undefined;
} catch {
  dbcDirectory = undefined;
}

test("the creature-models answer marks the motorcycle and nothing else",
  { skip: dbcDirectory ? false : "no tswow dataset on this machine" }, () => {
    const metadata = parseCreatureModelMetadata(
      readFileSync(join(dbcDirectory, "CreatureDisplayInfo.dbc")),
      readFileSync(join(dbcDirectory, "CreatureModelData.dbc")));
    const marked = [...metadata.values()].filter((entry) => entry.noMountSpecial).map((entry) => entry.id);
    assert.deepEqual(marked.sort((a, b) => a - b), [25870, 25871]);
    assert.equal(metadata.get(25870).noMountSpecial, true);
    assert.equal("noMountSpecial" in metadata.get(49), false, "absent, not false, everywhere else");
  });

// The hook in input/Movement.ts (05.10-A7a-G): the held jump key over the physics.
const { game } = await import("../dist/code/browser/game/Context.js");
const { advancePhysics, beginHeld, endHeld, forgetMovementState, releaseAllInput } =
  await import("../dist/code/browser/input/Movement.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function riding(mountDisplayId, run) {
  const sent = [];
  const specials = [];
  const played = [];
  const mover = {
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, mountDisplayId]]),
  };
  forgetMovementState();
  game.world = {
    mapId: 0,
    movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(),
    sendMovement: (opcode) => sent.push(opcode),
    sendMountSpecial: () => specials.push("special"),
  };
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  game.renderer = { playMountSpecial: (guid) => played.push(guid) };
  game.creatureModels = { get: (id) => (id === 25870 ? { noMountSpecial: true } : { id }) };
  try {
    run({ sent, specials, played });
  } finally {
    releaseAllInput();
    forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
    game.renderer = undefined;
    game.creatureModels = undefined;
  }
}

test("Movement: a standing rider's jump key plays and sends the trick and does not jump", () => {
  riding(HORSE, ({ sent, specials, played }) => {
    beginHeld("jump");
    for (let i = 0; i < 30; i++) advancePhysics(1 / 60);
    assert.deepEqual(specials, ["special"]);
    assert.deepEqual(played, [1n]);
    assert.equal(sent.includes(OPCODES.MSG_MOVE_JUMP), false, "held after the trick, still no jump");
    endHeld("jump");
    beginHeld("jump");
    assert.equal(specials.length, 2, "a new press is a new trick");
  });
});

test("Movement: on foot and on the motorcycle the jump key jumps as before", () => {
  for (const mount of [0, 25870]) {
    riding(mount, ({ sent, specials, played }) => {
      beginHeld("jump");
      for (let i = 0; i < 5; i++) advancePhysics(1 / 60);
      assert.equal(sent.includes(OPCODES.MSG_MOVE_JUMP), true, `mount ${mount}: jumped`);
      assert.deepEqual(specials, []);
      assert.deepEqual(played, []);
    });
  }
});
