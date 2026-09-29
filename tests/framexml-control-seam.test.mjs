import assert from "node:assert/strict";
import test from "node:test";

// `HasFullControl` and PLAYER_CONTROL_LOST/GAINED (FrameXmlControl.ts) over the live seam and a fake
// world, then over a real WorldClient fed the core's packets. The stock unit menu greys «Обмен» and
// «Дуэль» by `not HasFullControl()` (UnitPopup.lua:1048, :1092); PetActionBarFrame.lua:47 and
// UIParent.lua:800-835 listen to the two events.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_CONTROL_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlControl.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { clientControlUpdatePacket, settle, travelClient } = await import("./fixtures/world-packets.mjs");

const SELF = 0x10n;
const VEHICLE = 0xf150000000000077n;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
/** UnitDefines.h:153-159. */
const STUNNED = 0x00040000;
const ON_TAXI = 0x00100000;
const CONFUSED = 0x00400000;
const FLEEING = 0x00800000;
const POSSESSED = 0x01000000;
const PLAYER_CONTROLLED = 0x08;

function fixture() {
  const player = { guid: SELF, typeId: 4, fields: new Map([[FLAGS, PLAYER_CONTROLLED]]) };
  // WorldClient's words after the login claim, before any SMSG_CLIENT_CONTROL_UPDATE.
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player]]) },
    movementReady: true,
    controlledGuid: undefined,
    controlRefusedGuid: undefined,
    attacking: false,
    events: { on: () => () => {} },
    partyStats: new Map(),
    auras: new Map(),
    aurasFor: () => [],
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    names: new Map(),
    creatureTemplates: new Map(),
    totems: new Map(),
  };
  const fired = [];
  let now = 0;
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now };
  const flagListeners = new Set();
  const store = {
    field: (subject, name, listener) => {
      if (subject !== "self" || name !== "UNIT_FIELD_FLAGS") return () => {};
      flagListeners.add(listener);
      return () => flagListeners.delete(listener);
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => now * 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return {
    seam, world, player, fired, pump, call, flagListeners,
    /** A UNIT_FIELD_FLAGS update of the player, delivered as the store delivers it. */
    setFlags(flags) {
      player.fields.set(FLAGS, flags);
      for (const listener of [...flagListeners]) listener(player, SELF);
    },
    /** SMSG_CLIENT_CONTROL_UPDATE as WorldClient folds it (its handler). */
    control(guid, allowed) {
      world.movementReady = allowed;
      world.controlledGuid = allowed ? guid : undefined;
      world.controlRefusedGuid = allowed ? undefined : guid;
    },
    /** The next rendered frame past the seam's 60 ms poll. */
    frame() {
      now += 0.1;
      seam.tick(now);
    },
  };
}

const controlEvents = (fired) => fired.map(([name]) => name).filter((name) => /^PLAYER_CONTROL_/.test(name));

test("HasFullControl is the client's 1 with no loss flag and no control packet — the client claims its own", () => {
  const { seam, call, pump } = fixture();
  seam.attach(pump);
  assert.deepEqual(call("HasFullControl"), [1]);
  // A seam without the member keeps the empty world's «yes»; the name is the control module's own.
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.HasFullControl({}, []), [1]);
  assert.equal(FRAMEXML_SEAM_BINDINGS.HasFullControl, FRAMEXML_CONTROL_BINDINGS.HasFullControl, "not shadowed by a later key");
  seam.detach();
});

test("each loss flag on the player's UNIT_FIELD_FLAGS takes full control away (nil, not false)", () => {
  const { seam, call, pump, setFlags } = fixture();
  seam.attach(pump);
  for (const [name, flag] of [["STUNNED", STUNNED], ["ON_TAXI", ON_TAXI], ["CONFUSED", CONFUSED], ["FLEEING", FLEEING],
    ["POSSESSED", POSSESSED]]) {
    setFlags(PLAYER_CONTROLLED | flag);
    assert.deepEqual(call("HasFullControl"), [], name);
    setFlags(PLAYER_CONTROLLED);
    assert.deepEqual(call("HasFullControl"), [1], `${name} lifted`);
  }
  // Neighbouring bits are not control: in combat, silenced, pacified, mounted.
  setFlags(PLAYER_CONTROLLED | 0x00080000 | 0x00002000 | 0x00020000 | 0x08000000);
  assert.deepEqual(call("HasFullControl"), [1]);
  seam.detach();
});

test("SMSG_CLIENT_CONTROL_UPDATE: the mover refused or handed to another unit is not full control", () => {
  const { seam, call, pump, control } = fixture();
  seam.attach(pump);
  control(SELF, false);
  assert.deepEqual(call("HasFullControl"), [], "allowed = 0 on the character: a fear, a charm, the battleground's end");
  control(VEHICLE, true);
  assert.deepEqual(call("HasFullControl"), [], "the client moves a vehicle, not the character");
  control(SELF, true);
  assert.deepEqual(call("HasFullControl"), [1], "control back on the character's own guid");
  seam.detach();
});

test("PLAYER_CONTROL_LOST/GAINED fire once per loss and return; a stun or a vehicle greys the menu without them", () => {
  const { seam, fired, pump, setFlags, control, frame, call } = fixture();
  seam.attach(pump);
  frame();
  assert.deepEqual(controlEvents(fired), [], "attached in control: nothing to announce");

  setFlags(PLAYER_CONTROLLED | FLEEING);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST"], "the flag's store edge, at once");
  control(SELF, false);
  frame();
  frame();
  setFlags(PLAYER_CONTROLLED | FLEEING);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST"], "the packet and later polls say the same: no repeat");

  control(SELF, true);
  frame();
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST"], "the flag still holds it");
  setFlags(PLAYER_CONTROLLED);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"]);

  // A stun is on the wire as UNIT_FLAG_STUNNED alone; stock's control edge closes every window
  // (UIParent.lua:800-819), so only HasFullControl follows it.
  setFlags(PLAYER_CONTROLLED | STUNNED);
  frame();
  assert.deepEqual(call("HasFullControl"), []);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"]);
  setFlags(PLAYER_CONTROLLED);

  // Driving a vehicle (or a possessed unit) is control of something else: the menu greys, no edge.
  // Leaving it is allowed = 0 on the vehicle, then allowed = 1 on the character (Unit.cpp:12637-12644);
  // the world loop may yield between the two, so a poll can see the refusal alone: still no edge.
  control(VEHICLE, true);
  frame();
  assert.deepEqual(call("HasFullControl"), []);
  control(VEHICLE, false);
  frame();
  control(SELF, true);
  frame();
  assert.deepEqual(call("HasFullControl"), [1]);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"],
    "a refusal of another unit is not the player's");

  // A packet-only loss (a charm, the battleground's end) reaches the edge on the seam's poll.
  control(SELF, false);
  frame();
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED", "PLAYER_CONTROL_LOST"]);
  seam.detach();
});

test("a taxi flight is out of control: LOST at take-off (UIParent's own UnitOnTaxi guard keeps the windows), GAINED on landing", () => {
  const { seam, fired, pump, setFlags, call } = fixture();
  seam.attach(pump);
  // FlightPathMovementGenerator.cpp:75 sets UNIT_FLAG_REMOVE_CLIENT_CONTROL | UNIT_FLAG_ON_TAXI, no packet.
  setFlags(PLAYER_CONTROLLED | 0x04 | ON_TAXI);
  assert.deepEqual(call("HasFullControl"), [], "TradeHandler.cpp:648 refuses a trade in flight");
  setFlags(PLAYER_CONTROLLED);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"]);
  seam.detach();
});

test("a loss already under way at attach is published once; after detach nothing fires", () => {
  const { seam, fired, pump, setFlags, control, frame, flagListeners } = fixture();
  control(SELF, false);
  seam.attach(pump);
  frame();
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST"]);
  seam.detach();
  assert.equal(flagListeners.size, 0, "the flag subscription is released");
  fired.length = 0;
  control(SELF, true);
  setFlags(PLAYER_CONTROLLED | CONFUSED);
  seam.tick(10);
  assert.deepEqual(controlEvents(fired), []);
  // A second attach starts over from «in control» and publishes the state it finds.
  seam.attach(pump);
  frame();
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST"]);
  setFlags(PLAYER_CONTROLLED);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"]);
  seam.detach();
});

test("the canned seam answers HasFullControl and fires the same edges through setControlLost", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.HasFullControl(seam, []), [1], "the canned player holds the reins");
  assert.equal(seam.setControlLost(true), 1, "one handler ran");
  assert.equal(seam.setControlLost(true), 0, "no change, no edge");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.HasFullControl(seam, []), []);
  seam.setControlLost(false);
  assert.deepEqual(controlEvents(fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"]);
  seam.detach();
});

// ---- over a real WorldClient ------------------------------------------------------------------

/** `SMSG_NEW_WORLD` — `u32 map, f32 x, f32 y, f32 z, f32 orientation` (Player::TeleportTo). */
function newWorldPacket(mapId) {
  return new PacketWriter().u32(mapId).f32(1).f32(2).f32(3).f32(0).toUint8Array();
}

function liveOver(client) {
  const fired = [];
  let now = 0;
  const seam = new LiveWorldSeam({
    world: () => client, store: () => undefined, spell: () => undefined,
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now });
  return {
    seam, fired,
    call: (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args),
    frame() { now += 0.1; seam.tick(now); },
  };
}

const MOVE = { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } };

test("a battleground's end refuses the mover until the worldport, which gives it back (Battleground.cpp BlockMovement)", async () => {
  const { client, connection } = await travelClient([], SELF);
  const live = liveOver(client);
  try {
    live.frame();
    connection.push(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, clientControlUpdatePacket(SELF, false));
    await settle();
    live.frame();
    assert.deepEqual(live.call("HasFullControl"), []);
    assert.deepEqual(controlEvents(live.fired), ["PLAYER_CONTROL_LOST"]);
    client.sendMovement(OPCODES.MSG_MOVE_HEARTBEAT, MOVE.flags, MOVE.position);
    assert.equal(connection.sentOf(OPCODES.MSG_MOVE_HEARTBEAT).length, 0, "the core dropped the mover: nothing is sent");

    // The core re-allows the mover on arrival without a packet (Player.cpp SendInitialPacketsBeforeAddToMap)
    // and expects the client to let go of the refusal at the teleport; the claim follows WORLDPORT_ACK,
    // with the arrival's first world packet (the core's self CREATE; empty here).
    const sentBefore = connection.sent.length;
    connection.push(OPCODES.SMSG_NEW_WORLD, newWorldPacket(0));
    await settle();
    connection.push(OPCODES.SMSG_UPDATE_OBJECT, new PacketWriter().u32(0).toUint8Array());
    await settle();
    const order = connection.sent.slice(sentBefore).map((packet) => packet.opcode);
    const ack = order.indexOf(OPCODES.MSG_MOVE_WORLDPORT_ACK);
    const claim = order.indexOf(OPCODES.CMSG_SET_ACTIVE_MOVER);
    assert.ok(ack >= 0 && claim > ack, `CMSG_SET_ACTIVE_MOVER after MSG_MOVE_WORLDPORT_ACK: ${order.join(",")}`);
    client.sendMovement(OPCODES.MSG_MOVE_HEARTBEAT, MOVE.flags, MOVE.position);
    assert.equal(connection.sentOf(OPCODES.MSG_MOVE_HEARTBEAT).length, 1, "movement is sent again");
    live.frame();
    live.frame();
    assert.deepEqual(live.call("HasFullControl"), [1]);
    assert.deepEqual(controlEvents(live.fired), ["PLAYER_CONTROL_LOST", "PLAYER_CONTROL_GAINED"], "GAINED once");
  } finally {
    live.seam.detach();
    client.close();
  }
});

test("leaving a vehicle with a frame between the refusal and the new mover announces nothing", async () => {
  const { client, connection } = await travelClient([
    { opcode: OPCODES.SMSG_CLIENT_CONTROL_UPDATE, payload: clientControlUpdatePacket(VEHICLE, true) },
  ], SELF);
  const live = liveOver(client);
  try {
    live.frame();
    assert.deepEqual(live.call("HasFullControl"), [], "driving the vehicle");
    connection.push(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, clientControlUpdatePacket(VEHICLE, false));
    await settle();
    live.frame();
    connection.push(OPCODES.SMSG_CLIENT_CONTROL_UPDATE, clientControlUpdatePacket(SELF, true));
    await settle();
    live.frame();
    assert.equal(client.controlledGuid, SELF);
    assert.deepEqual(live.call("HasFullControl"), [1]);
    assert.deepEqual(controlEvents(live.fired), [], "the vehicle's refusal is not the player's loss");
  } finally {
    live.seam.detach();
    client.close();
  }
});
