import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { TRAINER_SPELL_AVAILABLE, TRAINER_SPELL_KNOWN, TRAINER_SPELL_UNAVAILABLE } from "../dist/code/world/TrainerProtocol.js";

function fakeConnection() {
  const queue = [];
  const waiters = [];
  return {
    sent: [],
    closeCalls: 0,
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    push(opcode, payload) {
      const packet = { opcode, payload };
      const resolve = waiters.shift();
      if (resolve) resolve(packet);
      else queue.push(packet);
    },
    close() { this.closeCalls += 1; },
  };
}

function trainer() {
  return { guid: 0x1234n, trainerType: 0, greeting: "Welcome", spells: [] };
}

const LOGIN_VERIFY = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array();

async function loggedInClient() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, LOGIN_VERIFY);
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await settle();
  return { client, connection };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
}

function trainerListPacket(guid, spells = [], greeting = "Welcome") {
  const writer = new PacketWriter().u64(guid).i32(0).i32(spells.length);
  for (const spell of spells) {
    writer.i32(spell.spellId).u8(spell.usable).i32(spell.moneyCost ?? 0)
      .i32(spell.pointCost?.[0] ?? 0).i32(spell.pointCost?.[1] ?? 0)
      .u8(spell.requiredLevel ?? 0).i32(spell.requiredSkillLine ?? 0)
      .i32(spell.requiredSkillRank ?? 0)
      .i32(spell.requiredAbilities?.[0] ?? 0).i32(spell.requiredAbilities?.[1] ?? 0)
      .i32(spell.requiredAbilities?.[2] ?? 0);
  }
  return writer.cString(greeting).toUint8Array();
}

function buySucceededPacket(guid, spellId) {
  return new PacketWriter().u64(guid).i32(spellId).toUint8Array();
}

function buyFailedPacket(guid, spellId, reason) {
  return new PacketWriter().u64(guid).i32(spellId).i32(reason).toUint8Array();
}

test("close clears the trainer snapshot before notifying and does not notify twice", () => {
  const connection = fakeConnection();
  const client = new WorldClient(connection);
  client.trainer = trainer();
  client.merchantMessage = { text: "trainer result", error: false };

  const snapshots = [];
  client.onTrainerChanged = () => snapshots.push({
    trainer: client.trainer,
    message: client.merchantMessage,
  });

  client.close();

  assert.equal(client.trainer, undefined);
  assert.equal(client.merchantMessage, undefined);
  assert.deepEqual(snapshots, [{ trainer: undefined, message: undefined }]);

  client.close();
  assert.equal(snapshots.length, 1);
  assert.equal(connection.closeCalls, 1);
});

test("close without a trainer does not emit a trainer callback", () => {
  const connection = fakeConnection();
  const client = new WorldClient(connection);
  let notifications = 0;
  client.onTrainerChanged = () => { notifications += 1; };

  client.close();

  assert.equal(client.trainer, undefined);
  assert.equal(notifications, 0);
});

test("trainer lists accept only the most recently requested guid", async () => {
  const { client, connection } = await loggedInClient();
  const first = 0xaan;
  const second = 0xbbn;
  client.state.objects.set(first, {});
  client.state.objects.set(second, {});
  let notifications = 0;
  client.onTrainerChanged = () => { notifications += 1; };

  client.openTrainer(first);
  client.openTrainer(second);
  connection.push(OPCODES.SMSG_TRAINER_LIST, trainerListPacket(first));
  await settle();
  assert.equal(client.trainer, undefined, "a late response for A is ignored after opening B");
  assert.equal(notifications, 0);

  connection.push(OPCODES.SMSG_TRAINER_LIST, trainerListPacket(second));
  await settle();
  assert.equal(client.trainer?.guid, second);
  assert.equal(notifications, 1);
  client.close();
});

test("buy results for another trainer do not change the current snapshot", async () => {
  const { client, connection } = await loggedInClient();
  const current = 0x11n;
  const other = 0x22n;
  client.trainer = { guid: current, trainerType: 0, greeting: "Welcome", spells: [] };
  const oldMessage = { text: "still current", error: false };
  client.merchantMessage = oldMessage;
  let notifications = 0;
  client.onTrainerChanged = () => { notifications += 1; };

  connection.push(OPCODES.SMSG_TRAINER_BUY_SUCCEEDED, buySucceededPacket(other, 42));
  connection.push(OPCODES.SMSG_TRAINER_BUY_FAILED, buyFailedPacket(other, 42, 1));
  await settle();

  assert.equal(client.merchantMessage, oldMessage);
  assert.equal(notifications, 0);
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_TRAINER_LIST).length, 0);
  client.close();
});

test("matching trainer success survives the refresh request until the new list arrives", async () => {
  const { client, connection } = await loggedInClient();
  const guid = 0x23n;
  client.state.objects.set(guid, {});
  client.trainer = { guid, trainerType: 0, greeting: "Welcome", spells: [] };
  let notifications = 0;
  client.onTrainerChanged = () => { notifications += 1; };

  connection.push(OPCODES.SMSG_TRAINER_BUY_SUCCEEDED, buySucceededPacket(guid, 42));
  await settle();

  assert.deepEqual(client.merchantMessage, { text: "Изучено заклинание 42", error: false });
  assert.equal(notifications, 1);
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_TRAINER_LIST).length, 1);
  client.close();
});

test("trainer learning sends exactly one request for a known available row", async () => {
  const connection = fakeConnection();
  const client = new WorldClient(connection);
  const guid = 0x33n;
  client.trainer = {
    guid,
    trainerType: 0,
    greeting: "Welcome",
    spells: [
      { spellId: 10, usable: TRAINER_SPELL_UNAVAILABLE, moneyCost: 0, pointCost: [0, 0], requiredLevel: 0, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0] },
      { spellId: 11, usable: TRAINER_SPELL_KNOWN, moneyCost: 0, pointCost: [0, 0], requiredLevel: 0, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0] },
      { spellId: 12, usable: TRAINER_SPELL_AVAILABLE, moneyCost: 0, pointCost: [0, 0], requiredLevel: 0, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0] },
    ],
  };

  client.learnFromTrainer(999);
  client.learnFromTrainer(10);
  client.learnFromTrainer(11);
  client.learnFromTrainer(12);

  const requests = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_TRAINER_BUY_SPELL);
  assert.equal(requests.length, 1);
  client.close();
});

test("close while a read is pending drops a late trainer packet and clears the request target", async () => {
  const { client, connection } = await loggedInClient();
  const guid = 0x44n;
  client.state.objects.set(guid, {});
  client.openTrainer(guid);
  let notifications = 0;
  client.onTrainerChanged = () => { notifications += 1; };

  client.close();
  connection.push(OPCODES.SMSG_TRAINER_LIST, trainerListPacket(guid));
  await settle();

  assert.equal(client.trainer, undefined);
  assert.equal(client.merchantMessage, undefined);
  assert.equal(notifications, 0);
  const requestsBefore = connection.sent.length;
  client.openTrainer(guid);
  assert.equal(connection.sent.length, requestsBefore, "closed clients cannot reopen the trainer");
});
