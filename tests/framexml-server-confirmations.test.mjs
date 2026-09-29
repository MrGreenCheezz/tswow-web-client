import assert from "node:assert/strict";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

// М1 «Серверное подтверждение» (docs/implementation/line-A3.ru.md) as three questions: the
// innkeeper (2.03, SMSG_BINDER_CONFIRM → CMSG_BINDER_ACTIVATE), the trainer's talent wipe (2.04,
// MSG_TALENT_WIPE_CONFIRM both ways) and the instance lock (2.09, SMSG_INSTANCE_LOCK_WARNING_QUERY →
// CMSG_INSTANCE_LOCK_RESPONSE). The bytes; a real WorldClient fed packets through a fake connection;
// the stock popup model over the canned world and over that WorldClient; the native
// InteractionPrompts sections. The stock dialogs themselves are tests/framexml-popups-vertical.test.mjs.
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const progress = await import("../dist/code/world/CharacterProgressProtocol.js");
const instance = await import("../dist/code/world/InstanceProtocol.js");
const pvp = await import("../dist/code/world/PvpProtocol.js");
const lfg = await import("../dist/code/world/LfgProtocol.js");
const format = await import("../dist/code/browser/ui/Format.js");
const confirmation = await import("../dist/code/world/ConfirmationProtocol.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const popups = await import("../dist/code/browser/framexml/FrameXmlPopups.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlPopupsController.js");
const talentController = await import("../dist/code/browser/framexml/FrameXmlTalentController.js");
const { frameXmlPopupsLiveContext } = await import("../dist/code/browser/framexml/FrameXmlPopupsLive.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const canned = await import("../dist/code/browser/framexml/FrameXmlPopupsCanned.js");
const { FRAMEXML_POPUPS_DIALOGS } = await import("../dist/code/browser/framexml/FrameXmlPopupsOwner.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const SELF = 0x42n;
const INNKEEPER = 0xf130_0000_1a54_0001n;
const TRAINER = 0xf130_0000_1568_0002n;
const bytes = (payload) => [...payload];
const guidOnly = (guid) => new PacketWriter().u64(guid).toUint8Array();
const quote = (guid, cost) => new PacketWriter().u64(guid).u32(cost).toUint8Array();
const lockWarning = (mask, milliseconds = 60_000, previouslySaved = 0) =>
  new PacketWriter().u32(milliseconds).u32(mask).u8(previouslySaved).toUint8Array();
const newWorld = (mapId) => new PacketWriter().u32(mapId).f32(0).f32(0).f32(0).f32(0).toUint8Array();

// ---- bytes ------------------------------------------------------------------------------------

test("2.03 bytes: CMSG_BINDER_ACTIVATE is the innkeeper's guid, full (HandleBinderActivateOpcode)", () => {
  assert.deepEqual(bytes(progress.buildBinderActivate(0x1234n)), [0x34, 0x12, 0, 0, 0, 0, 0, 0]);
});

test("2.04 bytes: the server's MSG_TALENT_WIPE_CONFIRM is guid and cost; any other length is refused", () => {
  assert.deepEqual(progress.parseTalentWipeConfirm(quote(0x1234n, 10_000)), { guid: 0x1234n, cost: 10_000 });
  assert.throws(() => progress.parseTalentWipeConfirm(guidOnly(0x1234n)), RangeError, "the client's 8-byte form is not a quote");
  assert.throws(() => progress.parseTalentWipeConfirm(new PacketWriter().u64(1n).u32(1).u8(0).toUint8Array()), RangeError);
});

test("2.09 bytes: the lock warning is milliseconds, the killed-boss mask and a byte; the answer one byte", () => {
  assert.deepEqual(instance.parseInstanceLockWarning(lockWarning(0b101)),
    { milliseconds: 60_000, encounterMask: 5, previouslySaved: false });
  assert.equal(instance.parseInstanceLockWarning(lockWarning(0, 30_000, 1)).previouslySaved, true);
  assert.deepEqual(bytes(instance.buildInstanceLockResponse(true)), [1]);
  assert.deepEqual(bytes(instance.buildInstanceLockResponse(false)), [0]);
});

// ---- a real WorldClient -----------------------------------------------------------------------

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

function stand(client, guid, x) {
  client.state.move(guid, { flags: 0, position: { x, y: 0, z: 0, orientation: 0 } });
}

/** A float update field as the wire carries it: the IEEE bits in a word. */
function floatBits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

const COINAGE = UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset;
const REACH = UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset;

/** Logged in at the origin, 100 gold in the bags, the innkeeper and the trainer three yards away. */
async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  await client.loginCharacter(SELF);
  await settle();
  stand(client, SELF, 0);
  client.state.setField(SELF, COINAGE, 1_000_000);
  stand(client, INNKEEPER, 3);
  stand(client, TRAINER, 3);
  connection.sent.length = 0;
  const sent = (opcode) => connection.sent.filter((packet) => packet.opcode === opcode);
  const push = async (opcode, payload) => { connection.push(opcode, payload); await settle(); };
  return { client, connection, sent, push };
}

function record(client, ...names) {
  const seen = [];
  for (const name of names) client.events.on(name, (payload) => seen.push([name, payload]));
  return seen;
}

test("2.03 WorldClient: SMSG_BINDER_CONFIRM waits for one answer; CMSG_BINDER_ACTIVATE goes once; Cancel, a walk or a new map drop it", async () => {
  const { client, sent, push } = await loggedIn();
  const events = record(client, "BINDER_CONFIRM");
  try {
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    assert.equal(client.binderConfirm?.guid, INNKEEPER);
    assert.deepEqual(events.map(([name, payload]) => [name, payload.guid]), [["BINDER_CONFIRM", INNKEEPER]]);
    assert.equal(client.confirmBinder(), true);
    assert.equal(client.confirmBinder(), false, "a second answer finds nothing pending");
    assert.deepEqual(sent(OPCODES.CMSG_BINDER_ACTIVATE).map((packet) => bytes(packet.payload)),
      [bytes(progress.buildBinderActivate(INNKEEPER))]);
    assert.equal(client.binderConfirm, undefined);

    // Cancel sends nothing: the home changes only with CMSG_BINDER_ACTIVATE.
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    client.declineBinder();
    assert.equal(client.binderConfirm, undefined);
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 1);

    // GetNPCIfCanInteractWith (Player.cpp:2325-2327): creature->IsWithinDistInMap(player, npcReach + 4),
    // which adds both combat reaches again and compares strictly — distance < 4 + 2·npcReach + playerReach.
    client.state.setField(SELF, REACH, floatBits(1.5));
    client.state.setField(INNKEEPER, REACH, floatBits(1.5));
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    stand(client, SELF, -5.4);
    client.expireInteractionRequests();
    assert.equal(client.binderConfirm?.guid, INNKEEPER, "8.4 yd, reaches 1.5 each: inside 4 + 3 + 1.5 (5 + 3 would have closed it)");
    stand(client, SELF, -5.5);
    client.expireInteractionRequests();
    assert.equal(client.binderConfirm, undefined, "8.5 yd: the core's comparison is strict");
    assert.equal(client.confirmBinder(), false);
    client.state.setField(SELF, REACH, floatBits(0.5));
    client.state.setField(INNKEEPER, REACH, floatBits(0.5));
    stand(client, SELF, -2.4);
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    client.expireInteractionRequests();
    assert.equal(client.binderConfirm?.guid, INNKEEPER, "5.4 yd, reaches 0.5 each: inside 4 + 1 + 0.5");
    stand(client, SELF, -2.6);
    client.expireInteractionRequests();
    assert.equal(client.binderConfirm, undefined, "5.6 yd: out, where 5 + 0.5 + 0.5 would still have let it answer");

    // The core ignores the answer of a dead or ghost player (NPCHandler.cpp:292): not sent, kept.
    stand(client, SELF, 0);
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    client.state.objects.get(SELF).typeId = 4;
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    assert.equal(client.confirmBinder(), false, "dead");
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
    client.state.setField(SELF, UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x10);
    assert.equal(client.confirmBinder(), false, "a ghost (PLAYER_FLAGS_GHOST)");
    assert.equal(client.binderConfirm?.guid, INNKEEPER, "kept for after the resurrection");
    client.state.setField(SELF, UPDATE_FIELDS.PLAYER_FLAGS.offset, 0);
    assert.equal(client.confirmBinder(), true, "alive again: answered");
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 2);

    // The innkeeper leaves view.
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    client.state.destroy(INNKEEPER);
    client.expireInteractionRequests();
    assert.equal(client.binderConfirm, undefined, "an innkeeper out of view cannot be answered");
    stand(client, INNKEEPER, 3);

    // The map changes.
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    await push(OPCODES.SMSG_NEW_WORLD, newWorld(1));
    assert.equal(client.binderConfirm, undefined, "SMSG_NEW_WORLD drops it");
    assert.equal(client.confirmBinder(), false);
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 2);
    assert.equal(events.length, 7);
  } finally {
    client.close();
  }
});

test("2.03 WorldClient: SMSG_PLAYER_BOUND says the new home once; SMSG_BIND_POINT_UPDATE (every login and port) says nothing", async () => {
  const { client, push } = await loggedIn();
  client.worldNames = { area: (id) => (id === 87 ? "Златоземье" : undefined) };
  const lines = record(client, "WORLD_MESSAGE");
  try {
    await push(OPCODES.SMSG_BIND_POINT_UPDATE, new PacketWriter().f32(-9460).f32(62).f32(56).u32(0).u32(87).toUint8Array());
    assert.deepEqual(lines, []);
    assert.equal(client.bindPoint?.areaId, 87);
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    await push(OPCODES.SMSG_PLAYER_BOUND, new PacketWriter().u64(INNKEEPER).u32(87).toUint8Array());
    assert.deepEqual(lines.map(([, { text, kind }]) => [text, kind]), [["Ваш новый дом – Златоземье.", "system"]],
      "ERR_DEATHBIND_SUCCESS_S with the bound area");
    assert.equal(client.binderConfirm, undefined, "the bind settles a question still up");
    client.worldNames = {};
    await push(OPCODES.SMSG_PLAYER_BOUND, new PacketWriter().u64(INNKEEPER).u32(3000).toUint8Array());
    assert.equal(lines.at(-1)[1].text, "Ваш новый дом – зона.", "a name not loaded yet is a word, never the number");
  } finally {
    client.close();
  }
});

test("2.04 WorldClient: the quote waits for one answer; Accept sends the 8-byte guid once, Cancel nothing; guid 0 asks nothing", async () => {
  const { client, sent, push } = await loggedIn();
  const events = record(client, "TALENT_WIPE_CONFIRM", "TALENTS_CHANGED");
  try {
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 10_000));
    assert.deepEqual([client.talentWipeConfirm?.guid, client.talentWipeConfirm?.cost], [TRAINER, 10_000]);
    assert.deepEqual(events.map(([name, payload]) => [name, payload.guid, payload.cost]),
      [["TALENT_WIPE_CONFIRM", TRAINER, 10_000]], "a question, not a talents change");
    assert.equal(client.answerTalentWipe(true), "sent");
    assert.equal(client.answerTalentWipe(true), "none", "a second answer finds nothing pending");
    assert.deepEqual(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).map((packet) => bytes(packet.payload)), [bytes(guidOnly(TRAINER))],
      "the guid alone (ConfirmRespecWipe::Read), never the quote back");

    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 10_000));
    assert.equal(client.answerTalentWipe(false), "declined");
    assert.equal(client.talentWipeConfirm, undefined);
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 1, "Cancel sends nothing");

    // guid 0: ResetTalents found nothing to reset — no talents spent (Player.cpp:4002-4006).
    const statuses = [];
    client.onSpellStatus = (message, error) => statuses.push([message, error]);
    events.length = 0;
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(0n, 10_000));
    assert.equal(client.talentWipeConfirm, undefined);
    assert.deepEqual(events, [], "no question and no talents change");
    assert.deepEqual(statuses, [["Очки талантов не расходовались.", true]], "ERR_TALENT_WIPE_ERROR, said once");
    await push(OPCODES.SMSG_TALENTS_INVOLUNTARILY_RESET, new PacketWriter().u8(0).toUint8Array());
    assert.deepEqual(events.map(([name, payload]) => [name, payload.pet]), [["TALENTS_CHANGED", false]],
      "SMSG_TALENTS_INVOLUNTARILY_RESET is still a talents change");
    assert.equal(statuses.length, 1);

    // The core ignores an answer it cannot charge for without a word; the client says it instead.
    client.state.setField(SELF, COINAGE, 9_999);
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 10_000));
    assert.equal(client.answerTalentWipe(true), "unaffordable");
    assert.equal(client.talentWipeConfirm, undefined);
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 1);
    // A CREATE block leaves zero fields out (Object.cpp:490): no coinage field is no money.
    client.state.objects.get(SELF).fields.delete(COINAGE);
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 10_000));
    assert.equal(client.answerTalentWipe(true), "unaffordable", "a missing PLAYER_FIELD_COINAGE is zero copper");
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 1);
    client.state.setField(SELF, COINAGE, 10_000);

    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 10_000));
    stand(client, SELF, 40);
    client.expireInteractionRequests();
    assert.equal(client.talentWipeConfirm, undefined, "out of the trainer's reach");
    stand(client, SELF, 0);
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 10_000));
    await push(OPCODES.SMSG_NEW_WORLD, newWorld(1));
    assert.equal(client.talentWipeConfirm, undefined, "SMSG_NEW_WORLD drops it");
    assert.equal(client.answerTalentWipe(true), "none");
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 1);
  } finally {
    client.close();
  }
});

test("2.09 WorldClient: the lock question keeps the server's deadline; one answer; expiry and a new map drop it without a packet", async () => {
  const { client, sent, push } = await loggedIn();
  const events = record(client, "INSTANCE_LOCK_START", "INSTANCE_LOCK_STOP", "WORLD_MESSAGE");
  try {
    await push(OPCODES.SMSG_NEW_WORLD, newWorld(574));
    await push(OPCODES.SMSG_INSTANCE_DIFFICULTY, new PacketWriter().u32(1).u32(0).toUint8Array());
    const before = performance.now();
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b101));
    const lock = client.instanceLock;
    assert.deepEqual([lock?.encounterMask, lock?.previouslySaved, lock?.mapId, lock?.difficulty], [5, false, 574, 1]);
    assert.ok(lock.expiresAt >= before + 60_000 && lock.expiresAt <= performance.now() + 60_000, "60 s from arrival");
    assert.deepEqual(events.map(([name]) => name), ["INSTANCE_LOCK_START"], "the dialog replaces the old chat line");
    assert.equal(client.respondInstanceLock(true), true);
    assert.equal(client.respondInstanceLock(false), false, "a second answer finds nothing pending");
    assert.deepEqual(sent(OPCODES.CMSG_INSTANCE_LOCK_RESPONSE).map((packet) => bytes(packet.payload)), [[1]]);
    assert.deepEqual(events.map(([name]) => name), ["INSTANCE_LOCK_START", "INSTANCE_LOCK_STOP"]);

    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
    assert.equal(client.respondInstanceLock(false), true);
    assert.deepEqual(sent(OPCODES.CMSG_INSTANCE_LOCK_RESPONSE).map((packet) => bytes(packet.payload)), [[1], [0]]);

    // Sixty seconds without an answer: the core binds by itself (Player::Update), nothing is sent.
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
    client.expireInteractionRequests(client.instanceLock.expiresAt - 1);
    assert.ok(client.instanceLock, "a millisecond before the deadline it still asks");
    client.expireInteractionRequests(client.instanceLock.expiresAt);
    assert.equal(client.instanceLock, undefined);
    assert.equal(client.respondInstanceLock(true), false);

    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
    await push(OPCODES.SMSG_NEW_WORLD, newWorld(0));
    assert.equal(client.instanceLock, undefined, "leaving the instance drops it");
    assert.equal(sent(OPCODES.CMSG_INSTANCE_LOCK_RESPONSE).length, 2);
    assert.equal(events.filter(([name]) => name === "INSTANCE_LOCK_STOP").length, 4, "each question that went said so");
    assert.equal(events.filter(([name]) => name === "WORLD_MESSAGE").length, 0);
  } finally {
    client.close();
  }
});

test("M1 WorldClient: close() forgets all three questions", async () => {
  const { client, push } = await loggedIn();
  await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
  await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 10_000));
  await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
  assert.ok(client.binderConfirm && client.talentWipeConfirm && client.instanceLock);
  client.close();
  assert.deepEqual([client.binderConfirm, client.talentWipeConfirm, client.instanceLock], [undefined, undefined, undefined]);
});

test("M1 money: unknown only while the player's object is missing; a missing coinage field is zero", () => {
  const state = new WorldState();
  assert.equal(confirmation.canAfford(state, 10), true, "no player yet: the server decides");
  state.selfGuid = SELF;
  assert.equal(confirmation.canAfford(state, 10), true, "a guid, no object yet: still unknown");
  state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  assert.equal(confirmation.canAfford(state, 10), false, "CREATE blocks omit zero fields (Object.cpp:490)");
  assert.equal(confirmation.canAfford(state, 0), true);
  state.setField(SELF, COINAGE, 10);
  assert.deepEqual([confirmation.canAfford(state, 10), confirmation.canAfford(state, 11)], [true, false]);
});

test("M1 reach: the core's rule — distance < 4 + 2·npcReach + playerReach, strictly", () => {
  const unit = (x, reach) => ({
    position: { x, y: 0, z: 0, orientation: 0 },
    fields: reach === undefined ? new Map() : new Map([[REACH, floatBits(reach)]]),
  });
  assert.equal(confirmation.withinNpcInteraction(unit(0, 1.5), unit(8.4, 1.5)), true);
  assert.equal(confirmation.withinNpcInteraction(unit(0, 1.5), unit(8.5, 1.5)), false, "strict");
  assert.equal(confirmation.withinNpcInteraction(unit(0, 1.5), unit(8.9, 1.5 + 0.5)), true, "the NPC's reach counts twice");
  assert.equal(confirmation.withinNpcInteraction(unit(0), unit(3.9)), true, "no reach fields: 4 yd");
  assert.equal(confirmation.withinNpcInteraction(unit(0), unit(4)), false);
  assert.equal(confirmation.withinNpcInteraction({ fields: new Map() }, unit(1)), undefined, "a position unknown: undecided");
});

// ---- the stock popup model over the canned world ------------------------------------------------

function scripted(overrides = {}) {
  const clock = { now: 50_000 };
  const { model, world } = canned.createCannedFrameXmlPopups(new canned.FrameXmlCannedPopupsWorld(() => clock.now), overrides);
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  const take = () => fired.splice(0);
  return { model, world, clock, take };
}

const call = (model, name, ...args) => popups.FRAMEXML_POPUPS_BINDINGS[name]({ popups: model }, args);

test("M1 names: the events UIParent registers, the dialogs the gate requires, one owner per C API", () => {
  for (const event of ["CONFIRM_BINDER", "CONFIRM_TALENT_WIPE", "INSTANCE_LOCK_START", "INSTANCE_LOCK_STOP"]) {
    assert.ok(popups.FRAMEXML_POPUPS_EVENTS.includes(event), `${event} is in the gate's event list`);
  }
  for (const dialog of ["CONFIRM_BINDER", "CONFIRM_TALENT_WIPE", "INSTANCE_LOCK"]) {
    assert.ok(FRAMEXML_POPUPS_DIALOGS.includes(dialog), `${dialog} must exist in StaticPopupDialogs`);
  }
  for (const name of ["ConfirmBinder", "CheckBinderDist", "GetBindLocation", "ConfirmTalentWipe", "CheckTalentMasterDist",
    "GetInstanceLockTimeRemaining", "GetInstanceLockTimeRemainingEncounter", "RespondInstanceLock"]) {
    assert.equal(typeof popups.FRAMEXML_POPUPS_BINDINGS[name], "function", name);
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], popups.FRAMEXML_POPUPS_BINDINGS[name], `${name} has one owner`);
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} is a seam name`);
    assert.deepEqual(popups.FRAMEXML_POPUPS_BINDINGS[name]({}, []), [], `${name} without the model answers nothing`);
  }
});

test("2.03 model: CONFIRM_BINDER waits for publication, names the place, answers once", () => {
  const { model, world, take } = scripted();
  world.binder();
  model.tick();
  assert.deepEqual(take(), [], "before publication the native prompt asks");
  call(model, "ConfirmBinder");
  assert.deepEqual(world.calls, [], "… and answers");
  model.popupsOwned = true;
  assert.deepEqual(take(), [["CONFIRM_BINDER", "Златоземье"]]);
  model.tick();
  model.tick();
  assert.deepEqual(take(), [], "once, not once per frame");
  assert.deepEqual(call(model, "CheckBinderDist"), [true]);
  world.npcInRange = false;
  assert.deepEqual(call(model, "CheckBinderDist"), [false], "out of reach: stock's OnUpdate hides it");
  world.npcInRange = true;
  model.muted(() => call(model, "ConfirmBinder"));
  assert.deepEqual(world.calls, [], "a gate probe never binds");
  call(model, "ConfirmBinder");
  call(model, "ConfirmBinder");
  assert.deepEqual(world.calls, [{ kind: "binder", guid: canned.FRAMEXML_CANNED_INNKEEPER_GUID }], "CMSG_BINDER_ACTIVATE once");
  assert.deepEqual(call(model, "CheckBinderDist"), [false], "nothing is asking any more");
  world.binder();
  model.tick();
  assert.deepEqual(take(), [["CONFIRM_BINDER", "Златоземье"]], "a new SMSG_BINDER_CONFIRM is a new question");
  // Stock's Cancel calls nothing, so the question stays (`/run ConfirmBinder()` still binds), but
  // 3.3.5 fires CONFIRM_BINDER on the packet only: a /reload does not ask it again.
  model.popupsOwned = false;
  model.popupsOwned = true;
  model.tick();
  assert.deepEqual(take(), [], "re-publication does not re-ask a question stock already asked");
  const { model: next } = canned.createCannedFrameXmlPopups(world);
  next.attach({ fire: (event) => { assert.fail(`a remount re-asked: ${event}`); return 1; } });
  next.popupsOwned = true;
  next.tick();
  call(next, "ConfirmBinder");
  assert.equal(world.calls.length, 2, "still pending, still answerable");
  next.detach();
});

test("2.03 model: the place is the player's sub-zone, else the zone — never the server's stale area — else «Это место»; GetBindLocation", () => {
  const { model, world, clock, take } = scripted({ playerAreaName: undefined });
  model.popupsOwned = true;
  // SMSG_INIT_WORLD_STATES comes on a zone change only: its area is where the zone was entered.
  world.worldStateContext = { mapId: 0, zoneId: 12, areaId: 87 };
  world.binder();
  model.tick();
  assert.deepEqual(take(), [["CONFIRM_BINDER", "Элвиннский лес"]]);
  call(model, "ConfirmBinder");
  model.tick();
  world.worldStateContext = { mapId: 0, zoneId: 9999, areaId: 0 };
  world.binder();
  model.tick();
  assert.deepEqual(take(), [], "a name still loading is waited for");
  clock.now += popups.FRAMEXML_POPUP_NAME_WAIT_MS;
  model.tick();
  assert.deepEqual(take(), [["CONFIRM_BINDER", "Это место"]], "… 1.5 s, then asked with the native prompt's words");
  assert.deepEqual(call(model, "GetBindLocation"), [], "no SMSG_BIND_POINT_UPDATE yet");
  world.bound(87);
  assert.deepEqual(call(model, "GetBindLocation"), ["Златоземье"]);
});

test("2.04 model: CONFIRM_TALENT_WIPE with the quote once the talent UI is loaded; ConfirmTalentWipe once; the trainer's reach", () => {
  const { model, world, take } = scripted();
  world.talentUiState = "ready";
  world.talentWipe(50_000);
  model.tick();
  assert.deepEqual(take(), [], "before publication the native prompt asks");
  model.popupsOwned = true;
  assert.deepEqual(take(), [["CONFIRM_TALENT_WIPE", 50_000]], "MoneyFrame_Update's copper");
  model.tick();
  assert.deepEqual(take(), []);
  model.popupsOwned = false;
  model.popupsOwned = true;
  assert.deepEqual(take(), [], "a /reload does not re-ask it: 3.3.5 fires CONFIRM_TALENT_WIPE on the packet only");
  assert.deepEqual(call(model, "CheckTalentMasterDist"), [true]);
  world.npcInRange = false;
  assert.deepEqual(call(model, "CheckTalentMasterDist"), [false]);
  world.npcInRange = true;
  model.muted(() => call(model, "ConfirmTalentWipe"));
  call(model, "ConfirmTalentWipe");
  call(model, "ConfirmTalentWipe");
  assert.deepEqual(world.calls, [{ kind: "talentWipe", guid: canned.FRAMEXML_CANNED_TRAINER_GUID }], "one answer");
  assert.deepEqual(call(model, "CheckTalentMasterDist"), [false]);
  // The core ignores an answer it cannot charge for; stock says why in UIErrorsFrame.
  world.money = 10_000;
  world.talentWipe(50_000);
  model.tick();
  take();
  call(model, "ConfirmTalentWipe");
  assert.deepEqual(take(), [["UI_ERROR_MESSAGE", "У вас недостаточно денег."]]);
  assert.equal(world.calls.length, 1);
  assert.equal(world.talentWipeConfirm, undefined, "the dialog's Accept closed the question");
});

test("2.04 model: never fired into a VM whose TalentFrame_LoadUI would fail; the load starts; a question stock cannot take stays native", () => {
  const { model, world, clock, take } = scripted();
  model.popupsOwned = true;
  world.talentUiState = "idle";
  world.talentWipe(50_000);
  model.tick();
  assert.deepEqual(take(), [], "Blizzard_TalentUI not loaded: UIParentLoadAddOn would raise");
  assert.deepEqual(world.calls, [{ kind: "loadTalentUi" }], "the lazy talent owner's load starts");
  model.tick();
  assert.equal(world.calls.length, 1, "once per question");
  clock.now += 400;
  world.talentUiState = "ready";
  model.tick();
  assert.deepEqual(take(), [["CONFIRM_TALENT_WIPE", 50_000]], "shown once the tree can open with it");
  assert.equal(controller.frameXmlPopupsLeftToNative(world.talentWipeConfirm), false);

  world.talentWipeConfirm = undefined;
  model.tick();
  world.talentUiState = "loading";
  world.talentWipe(60_000);
  model.tick();
  clock.now += popups.FRAMEXML_TALENT_UI_WAIT_MS - 1;
  model.tick();
  assert.equal(controller.frameXmlPopupsLeftToNative(world.talentWipeConfirm), false, "still waiting for the load");
  clock.now += 1;
  model.tick();
  assert.deepEqual(take(), []);
  assert.equal(controller.frameXmlPopupsLeftToNative(world.talentWipeConfirm), true, "1.5 s: the native prompt asks instead");
  world.talentUiState = "ready";
  model.tick();
  assert.deepEqual(take(), [], "and keeps it: never two prompts for one question");

  // A host without a lazy talent owner (the canned default): native at once.
  world.talentUiState = undefined;
  world.talentWipe(70_000);
  model.tick();
  assert.deepEqual(take(), []);
  assert.equal(controller.frameXmlPopupsLeftToNative(world.talentWipeConfirm), true);
  world.talentUiState = "failed";
  world.talentWipe(70_000);
  model.tick();
  assert.equal(controller.frameXmlPopupsLeftToNative(world.talentWipeConfirm), true, "a failed load likewise");
  // Unpublished, nothing is marked: the native prompt holds every question anyway.
  model.popupsOwned = false;
  world.talentWipe(80_000);
  model.tick();
  assert.equal(controller.frameXmlPopupsLeftToNative(world.talentWipeConfirm), false);
  assert.equal(controller.frameXmlPopupsLeftToNative(undefined), false);
});

test("2.09 model: INSTANCE_LOCK_START once; the remaining seconds, the bosses and one answer as stock reads them", () => {
  const { model, world, clock, take } = scripted();
  assert.deepEqual(call(model, "GetInstanceLockTimeRemaining"), [0, false, 0, 0], "no question: four values stock compares");
  world.lockWarning(60_000, 0b101, 574, 0);
  model.tick();
  assert.deepEqual(take(), []);
  model.popupsOwned = true;
  assert.deepEqual(take(), [["INSTANCE_LOCK_START"]]);
  model.tick();
  assert.deepEqual(take(), []);
  model.popupsOwned = false;
  model.popupsOwned = true;
  assert.deepEqual(take(), [["INSTANCE_LOCK_START"]], "a /reload shows the lock again, at what is left of its minute");
  clock.now += 20_500;
  assert.deepEqual(call(model, "GetInstanceLockTimeRemaining"), [39.5, false, 3, 2],
    "what is left of the server's 60 s (a /reload must not restart it), three bosses, two killed");
  assert.deepEqual([1, 2, 3, 4].map((index) => call(model, "GetInstanceLockTimeRemainingEncounter", index)), [
    ["Принц Келесет", "", true], ["Скарвальд и Далронн", "", false], ["Ингвар Расхититель", "", true], [],
  ]);
  model.muted(() => call(model, "RespondInstanceLock", true));
  assert.deepEqual(world.calls, [], "a gate probe never answers");
  call(model, "RespondInstanceLock", false);
  call(model, "RespondInstanceLock", true);
  assert.deepEqual(world.calls, [{ kind: "instanceLock", accept: false }], "one CMSG_INSTANCE_LOCK_RESPONSE");
  model.tick();
  assert.deepEqual(take(), [["INSTANCE_LOCK_STOP"]], "answered: StaticPopup_Hide finds nothing left to hide");
  assert.deepEqual(call(model, "GetInstanceLockTimeRemaining"), [0, false, 0, 0]);

  // The deadline passes: the core binds by itself, the dialog closes, nothing is sent.
  world.lockWarning(60_000, 0b1, 574, 0);
  model.tick();
  assert.deepEqual(take(), [["INSTANCE_LOCK_START"]]);
  clock.now += 60_000;
  assert.equal(call(model, "GetInstanceLockTimeRemaining")[0], 0, "<= 0: stock's OnShow/OnUpdate close it");
  model.tick();
  assert.deepEqual(take(), [["INSTANCE_LOCK_STOP"]]);
  call(model, "RespondInstanceLock", true);
  assert.equal(world.calls.length, 1, "an expired question is not answered");
  world.lockWarning(60_000, 0b1, 574, 0, true);
  assert.equal(call(model, "GetInstanceLockTimeRemaining")[1], true, "isPreviousInstance from the packet's byte");
});

test("2.09 model: a boss is killed by its DungeonEncounter bit, not its row; without the table stock is not asked at all", () => {
  const { model, world } = scripted({
    dungeonEncounters: () => [{ bit: 2, name: "Второй в таблице" }, { bit: 0, name: "Первый в таблице" }],
  });
  world.lockWarning(60_000, 0b100, 574, 0);
  assert.deepEqual(call(model, "GetInstanceLockTimeRemaining").slice(1), [false, 2, 1]);
  assert.deepEqual(call(model, "GetInstanceLockTimeRemainingEncounter", 1), ["Второй в таблице", "", true]);
  assert.deepEqual(call(model, "GetInstanceLockTimeRemainingEncounter", 2), ["Первый в таблице", "", false]);
  // Without the table stock's «Убито боссов: %d/%d» would be invented, so the native prompt (which
  // says only the killed count) keeps the question — after the same 1.5 s a name gets.
  const bare = scripted({ dungeonEncounters: undefined });
  bare.model.popupsOwned = true;
  bare.world.lockWarning(60_000, 0b1011, 999, 0);
  bare.model.tick();
  assert.deepEqual(bare.take(), [], "the table may still be on its way");
  assert.equal(controller.frameXmlPopupsLeftToNative(bare.world.instanceLock), false);
  bare.clock.now += popups.FRAMEXML_POPUP_NAME_WAIT_MS;
  bare.model.tick();
  assert.deepEqual(bare.take(), [], "no INSTANCE_LOCK_START without its boss line");
  assert.equal(controller.frameXmlPopupsLeftToNative(bare.world.instanceLock), true);
  assert.deepEqual(call(bare.model, "GetInstanceLockTimeRemaining").slice(1), [false, 0, 0], "nothing invented for an addon either");
  assert.deepEqual(call(bare.model, "GetInstanceLockTimeRemainingEncounter", 1), []);
  call(bare.model, "RespondInstanceLock", true);
  assert.deepEqual(bare.world.calls, [{ kind: "instanceLock", accept: true }], "still answerable through the C API");
});

// ---- the stock popup model over a real WorldClient -------------------------------------------------

test("M1 over a real WorldClient: packets become the stock events, answers the right opcodes, once; a new map ends the question", async () => {
  const { client, sent, push } = await loggedIn();
  const fired = [];
  const model = new popups.FrameXmlPopupsModel({
    world: () => client, playerLife: () => "alive", playerPosition: () => undefined, playerFieldBytes: () => 0,
    selfResurrectSpell: () => 0, playerLevel: () => 60, unitGuid: () => undefined, monotonic: () => performance.now(),
    playerAreaName: () => "Златоземье", talentUi: () => "ready",
    dungeonEncounters: () => [{ bit: 0, name: "Первый" }, { bit: 1, name: "Второй" }, { bit: 2, name: "Третий" }],
  });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.popupsOwned = true;
  try {
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 50_000));
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b11));
    model.tick();
    assert.deepEqual(fired.splice(0), [["CONFIRM_BINDER", "Златоземье"], ["CONFIRM_TALENT_WIPE", 50_000], ["INSTANCE_LOCK_START"]]);
    const left = call(model, "GetInstanceLockTimeRemaining");
    assert.ok(left[0] > 59 && left[0] <= 60, `the server's 60 s, counted from arrival (${left[0]})`);
    for (const name of ["ConfirmBinder", "ConfirmBinder", "ConfirmTalentWipe", "ConfirmTalentWipe"]) call(model, name);
    call(model, "RespondInstanceLock", true);
    call(model, "RespondInstanceLock", true);
    assert.deepEqual([sent(OPCODES.CMSG_BINDER_ACTIVATE).length, sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length,
      sent(OPCODES.CMSG_INSTANCE_LOCK_RESPONSE).length], [1, 1, 1]);
    model.tick();
    assert.deepEqual(fired.splice(0), [["INSTANCE_LOCK_STOP"]]);

    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    model.tick();
    assert.deepEqual(fired.splice(0), [["CONFIRM_BINDER", "Златоземье"]]);
    assert.deepEqual(call(model, "CheckBinderDist"), [true]);
    await push(OPCODES.SMSG_NEW_WORLD, newWorld(1));
    assert.deepEqual(call(model, "CheckBinderDist"), [false], "the map changed: stock's OnUpdate closes the dialog");
    model.tick();
    model.popupsOwned = false;
    model.popupsOwned = true;
    assert.deepEqual(fired.filter(([event]) => event === "CONFIRM_BINDER"), [], "nothing is left to show again");
    call(model, "ConfirmBinder");
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 1);
  } finally {
    model.detach();
    client.close();
  }
});

// ---- the native InteractionPrompts sections ------------------------------------------------------

class Element {
  children = []; listeners = {}; attributes = new Map(); disabled = false; hidden = false; textContent = ""; className = "";
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  remove() {}
  click() { if (!this.disabled) this.listeners.click?.(); }
}

/** A panel body that counts how often the panel is rebuilt. */
class Body extends Element {
  rebuilds = 0;
  replaceChildren(...children) { this.rebuilds += 1; super.replaceChildren(...children); }
}

async function nativePrompts(world) {
  const panels = [];
  const state = { published: false };
  const original = globalThis.document;
  globalThis.document = { createElement: () => new Element(), createTextNode: (textContent) => ({ textContent }) };
  class Panel {
    body = new Body(); visible = false;
    constructor() { panels.push(this); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
  }
  const areas = { 87: "Златоземье", 12: "Элвиннский лес" };
  const game = {
    world,
    areas: { area: (id) => (areas[id] ? { id, name: areas[id] } : undefined), map: (id) => (id === 574 ? { name: "Крепость Утгард" } : undefined) },
    terrain: { areaAt: () => 87 },
  };
  const ui = await isolatedUi("InteractionPrompts", {
    "../game/Context.js": { game },
    "./Widgets.js": { Panel },
    "./Format.js": format,
    "../../world/ConfirmationProtocol.js": confirmation,
    "../../world/PvpProtocol.js": pvp,
    "../../world/LfgProtocol.js": lfg,
    "../framexml/FrameXmlLfdController.js": { frameXmlLfdPublished: () => false },
    // The real left-to-native registry, the one the stock model marks.
    "../framexml/FrameXmlPopupsController.js": {
      frameXmlPopupsPublished: () => state.published, frameXmlPopupsOwnBattlefieldEntry: () => false,
      frameXmlPopupsLeftToNative: controller.frameXmlPopupsLeftToNative,
    },
  });
  const nodes = () => panels.flatMap((panel) => panel.body.children.flatMap((row) => row.children));
  return {
    ...ui, panels, state,
    visible: () => panels[0]?.visible === true,
    text: () => nodes().map((node) => node.textContent).join(" | "),
    button: (text) => nodes().find((node) => node.textContent === text),
    dispose: () => { globalThis.document = original; },
  };
}

test("2.03 native: a question with no EnterWorld edge opens the panel on the next frame; one CMSG_BINDER_ACTIVATE; stock's while published", async () => {
  const { client, sent, push } = await loggedIn();
  const ui = await nativePrompts(client);
  try {
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), false, "nothing to ask");
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), true, "the panel's own frame tick found it");
    assert.match(ui.text(), /Златоземье станет вашим новым домом\. Согласны\?/);
    const accept = ui.button("Сделать домом");
    accept.click();
    accept.click();
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 1);
    assert.equal(ui.visible(), false);
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    ui.updateInteractionPrompts(performance.now());
    ui.button("Не менять дом").click();
    assert.equal(client.binderConfirm, undefined);
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 1, "Cancel sends nothing");
    // Walking away: the frame tick expires the question and the panel follows.
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), true);
    stand(client, SELF, 40);
    ui.updateInteractionPrompts(performance.now() + 1000);
    assert.equal(client.binderConfirm, undefined);
    assert.equal(ui.visible(), false);
    // Dead: the core ignores the answer (NPCHandler.cpp:292) — the row says why and waits.
    stand(client, SELF, 0);
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    ui.updateInteractionPrompts(performance.now());
    client.state.objects.get(SELF).typeId = 4;
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    ui.updateInteractionPrompts(performance.now() + 1000);
    assert.equal(ui.button("Сделать домом").disabled, true, "the second's tick repaints the row");
    assert.match(ui.text(), /после воскрешения/);
    ui.button("Сделать домом").click();
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 1);
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
    ui.updateInteractionPrompts(performance.now() + 2100);
    ui.button("Сделать домом").click();
    assert.equal(sent(OPCODES.CMSG_BINDER_ACTIVATE).length, 2, "alive again: answered");
    // Published: stock CONFIRM_BINDER asks instead.
    ui.state.published = true;
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), false, "never two prompts for one question");
  } finally {
    ui.dispose();
    client.close();
  }
});

test("2.04 native: the quote in gold, one 8-byte answer, a shortfall said in the row; stock's while published unless left to the native prompt", async () => {
  const { client, sent, push } = await loggedIn();
  const ui = await nativePrompts(client);
  try {
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 50_000));
    ui.updateInteractionPrompts(performance.now());
    assert.match(ui.text(), /Отказаться от всех талантов\? Стоимость: 5з\./);
    const wipe = ui.button("Сбросить таланты");
    wipe.click();
    wipe.click();
    assert.deepEqual(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).map((packet) => bytes(packet.payload)), [bytes(guidOnly(TRAINER))]);
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 50_000));
    ui.updateInteractionPrompts(performance.now());
    ui.button("Не сбрасывать").click();
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 1, "Cancel sends nothing");
    // The core would ignore it without a word: the row says so and does not send.
    client.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 100);
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 50_000));
    ui.updateInteractionPrompts(performance.now());
    assert.match(ui.text(), /У вас недостаточно денег\./);
    assert.equal(ui.button("Сбросить таланты").disabled, true);
    ui.button("Сбросить таланты").click();
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 1);
    client.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 50_000);
    ui.updateInteractionPrompts(performance.now() + 1000);
    assert.doesNotMatch(ui.text(), /недостаточно денег/, "the money arrived: the second's tick repaints the row");
    ui.button("Сбросить таланты").click();
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 2);
    // The money goes between the repaint and the click: the refusal is said, not swallowed.
    const statuses = [];
    client.onSpellStatus = (message, error) => statuses.push([message, error]);
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 50_000));
    ui.updateInteractionPrompts(performance.now());
    client.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 10);
    ui.button("Сбросить таланты").click();
    assert.deepEqual(statuses, [["У вас недостаточно денег.", true]]);
    assert.equal(sent(OPCODES.MSG_TALENT_WIPE_CONFIRM).length, 2);
    client.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 50_000);

    // Published: stock asks — unless the stock model left this question to the native prompt.
    const model = new popups.FrameXmlPopupsModel({
      world: () => client, playerLife: () => "alive", playerPosition: () => undefined, playerFieldBytes: () => 0,
      selfResurrectSpell: () => 0, playerLevel: () => 60, unitGuid: () => undefined, monotonic: () => performance.now(),
    });
    model.attach({ fire: () => 1 });
    ui.state.published = true;
    model.popupsOwned = true;
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 50_000));
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), false, "the stock model has not looked yet");
    model.tick();
    assert.equal(controller.frameXmlPopupsLeftToNative(client.talentWipeConfirm), true, "no talent UI owner: stock cannot take it");
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), true, "the native prompt asks, the next frame");
    assert.match(ui.text(), /Стоимость: 5з\./);
    model.detach();
  } finally {
    ui.dispose();
    client.close();
  }
});

test("2.09 native: the lock with its countdown and killed bosses; Accept and Leave answer once; the deadline closes it", async () => {
  const { client, sent, push } = await loggedIn();
  const ui = await nativePrompts(client);
  try {
    await push(OPCODES.SMSG_NEW_WORLD, newWorld(574));
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b101));
    const now = performance.now();
    ui.updateInteractionPrompts(now);
    const text = ui.text();
    assert.match(text, /Крепость Утгард/);
    assert.match(text, /Убито боссов: 2/);
    assert.match(text, /Осталось (59|60) с/);
    const accept = ui.button("Принять сохранение");
    accept.click();
    accept.click();
    assert.deepEqual(sent(OPCODES.CMSG_INSTANCE_LOCK_RESPONSE).map((packet) => bytes(packet.payload)), [[1]]);
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
    ui.updateInteractionPrompts(performance.now());
    ui.button("Выйти из подземелья").click();
    assert.deepEqual(sent(OPCODES.CMSG_INSTANCE_LOCK_RESPONSE).map((packet) => bytes(packet.payload)), [[1], [0]]);
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), true);
    const stale = ui.button("Принять сохранение");
    ui.updateInteractionPrompts(client.instanceLock.expiresAt + 1);
    assert.equal(ui.visible(), false, "the server's deadline passed: it binds by itself");
    stale.click();
    assert.equal(sent(OPCODES.CMSG_INSTANCE_LOCK_RESPONSE).length, 2, "a stale button answers nothing");
    ui.state.published = true;
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), false, "stock INSTANCE_LOCK asks while published");
    // Published, but no DungeonEncounter table: stock would invent «Убито боссов: N/N», so the stock
    // model leaves the question here, where only the killed count is said.
    const clock = { now: performance.now() };
    const model = new popups.FrameXmlPopupsModel({
      world: () => client, playerLife: () => "alive", playerPosition: () => undefined, playerFieldBytes: () => 0,
      selfResurrectSpell: () => 0, playerLevel: () => 60, unitGuid: () => undefined, monotonic: () => clock.now,
    });
    const fired = [];
    model.attach({ fire: (event) => { fired.push(event); return 1; } });
    model.popupsOwned = true;
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b101));
    model.tick();
    ui.updateInteractionPrompts(performance.now());
    assert.equal(ui.visible(), false, "the table may still be on its way");
    clock.now += popups.FRAMEXML_POPUP_NAME_WAIT_MS;
    model.tick();
    ui.updateInteractionPrompts(performance.now());
    assert.deepEqual(fired, [], "no INSTANCE_LOCK_START");
    assert.equal(ui.visible(), true, "the native prompt keeps it, the next frame");
    assert.match(ui.text(), /Убито боссов: 2/);
    assert.doesNotMatch(ui.text(), /Убито боссов: 2\/2/);
    model.detach();
  } finally {
    ui.dispose();
    client.close();
  }
});

test("native: three questions pending, the panel is built once — not once per frame", async () => {
  const { client, push } = await loggedIn();
  const ui = await nativePrompts(client);
  try {
    await push(OPCODES.SMSG_BINDER_CONFIRM, guidOnly(INNKEEPER));
    await push(OPCODES.MSG_TALENT_WIPE_CONFIRM, quote(TRAINER, 50_000));
    await push(OPCODES.SMSG_INSTANCE_LOCK_WARNING_QUERY, lockWarning(0b1));
    const start = performance.now();
    for (let frame = 0; frame < 150; frame += 1) ui.updateInteractionPrompts(start + frame * 16);
    assert.equal(ui.visible(), true);
    assert.match(ui.text(), /станет вашим новым домом[\s\S]*Отказаться от всех талантов[\s\S]*Вы вошли в подземелье/);
    assert.equal(ui.panels[0].body.rebuilds, 1, "150 frames (2.4 s, two 1 Hz ticks): built once, labels refreshed in place");
  } finally {
    ui.dispose();
    client.close();
  }
});

test("live context: the sub-zone from the terrain, the NPC's reach by the core's rule, the talent UI through the published owners", async () => {
  const { client } = await loggedIn();
  const saved = { terrain: game.terrain, areas: game.areas };
  const opened = [];
  let loaded = false;
  const releaseTalent = talentController.publishFrameXmlTalent({
    isOpen: () => opened.at(-1) === "show", show: () => { opened.push("show"); }, hide: () => { opened.push("hide"); },
  });
  const releasePopups = controller.publishFrameXmlPopups({ isOpen: () => false, close: () => {} }, () => loaded);
  try {
    game.terrain = { areaAt: (mapId) => (mapId === 0 ? 87 : 0) };
    game.areas = { area: (id) => (id === 87 ? { id, name: "Златоземье" } : undefined) };
    const context = frameXmlPopupsLiveContext({
      world: () => client, self: () => client.state.objects.get(SELF), unitGuid: () => undefined,
      playerLevel: () => 60, spellName: () => undefined, monotonic: () => performance.now(),
    });
    assert.equal(context.playerAreaName(), "Златоземье", "the terrain's area under the player, not SMSG_INIT_WORLD_STATES'");
    // No combat reach fields: 4 yd (4 + 2·0 + 0), strictly.
    assert.equal(context.npcInRange(INNKEEPER), true, "3 yd");
    stand(client, SELF, -1.1);
    assert.equal(context.npcInRange(INNKEEPER), false, "4.1 yd: out (5 yd + reaches would have allowed it)");
    assert.equal(context.spiritHealerInRange(INNKEEPER), false, "the spirit healer's check is the same rule");
    stand(client, SELF, 0);
    assert.equal(context.spiritHealerInRange(INNKEEPER), true);
    assert.equal(context.npcInRange(0xdeadn), false, "an NPC out of view");
    assert.equal(context.talentUi(), "idle", "published, Blizzard_TalentUI not loaded");
    context.loadTalentUi();
    context.loadTalentUi();
    assert.deepEqual(opened, ["show"], "the published talent owner's own lazy load, once — a second look never closes it");
    loaded = true;
    assert.equal(context.talentUi(), "ready");
    releasePopups();
    assert.equal(context.talentUi(), undefined, "no published stock popups: no answer");
  } finally {
    game.terrain = saved.terrain;
    game.areas = saved.areas;
    releaseTalent();
    releasePopups();
    client.close();
  }
});
