import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

/**
 * WORK_PLAN 5.24: a pet is called by the name its owner gave it. `CMSG_PET_NAME_QUERY` is
 * `u32 petNumber, u64 petGuid` (PetHandler.cpp:393-404) and the answer is keyed by the number alone
 * (:406-434). The core never touches UNIT_FIELD_PET_NAME_TIMESTAMP and sends no name after a rename
 * (HandlePetRename, :619-624): the pet's CAN_BE_RENAMED bit dropping is the only sign of a rename.
 * Pet flags are byte 2 of UNIT_FIELD_BYTES_2: CAN_BE_RENAMED 0x01, CAN_BE_ABANDONED 0x02 (UnitDefines.h:125-126);
 * a fresh hunter pet carries 0x03 (Pet.cpp:858), a renamed one 0x02 (Pet.cpp:270) — review 02.10.
 */

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

const SELF = 0x1234n;
const PET = 0xf140000500000042n;

/** One VALUES block (update type 0): packed guid, the mask blocks, then the words in index order. */
function valuesUpdate(guid, values) {
  const indices = Object.keys(values).map(Number).sort((a, b) => a - b);
  const blocks = Math.floor(indices.at(-1) / 32) + 1;
  const mask = new Array(blocks).fill(0);
  for (const index of indices) mask[index >> 5] |= 1 << (index & 31);
  const writer = new PacketWriter().u32(1).u8(0).packedGuid(guid).u8(blocks);
  for (const word of mask) writer.u32(word >>> 0);
  for (const index of indices) writer.u32(values[index] >>> 0);
  return writer.toUint8Array();
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(SELF).typeId = 4;
  connection.sent.length = 0;
  const queries = () => connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_PET_NAME_QUERY);
  return { client, connection, queries };
}

function pet(client, guid, petNumber, renameable) {
  client.state.move(guid, { flags: 0, position: { x: 2, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(guid).typeId = 3;
  client.state.setField(guid, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 299);
  if (petNumber) client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_PETNUMBER.offset, petNumber);
  client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, renameable ? 0x00030000 : 0x00020000);
}

const nameAnswer = (petNumber, name) => new PacketWriter().u32(petNumber).cString(name).u32(0).u8(0).toUint8Array();
const summon = { [UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset]: Number(PET & 0xffffffffn), [UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset + 1]: Number(PET >> 32n) };

test("the character's own pet is asked for by number once, and answers UnitName with its given name", async () => {
  const { client, connection, queries } = await loggedIn();
  pet(client, PET, 5, true);
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(SELF, summon));
  await settle();
  assert.deepEqual(queries().map((packet) => [...packet.payload]),
    [[...new PacketWriter().u32(5).u64(PET).toUint8Array()]], "u32 number first, then the guid");
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(SELF, { [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset]: 90 }));
  await settle();
  assert.equal(queries().length, 1, "not again while the answer is on its way");
  assert.equal(client.petNameOf(client.state.objects.get(PET)), undefined, "the kind's name stands in until then");
  connection.push(OPCODES.SMSG_PET_NAME_QUERY_RESPONSE, nameAnswer(5, "Рекс"));
  await settle();
  assert.equal(client.petNameOf(client.state.objects.get(PET)), "Рекс");
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(SELF, { [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset]: 80 }));
  await settle();
  assert.equal(queries().length, 1, "answered: nothing more to ask");
  client.close();
});

test("a rename that went through (CAN_BE_RENAMED drops) asks for the name again, once", async () => {
  const { client, connection, queries } = await loggedIn();
  pet(client, PET, 5, true);
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(SELF, summon));
  connection.push(OPCODES.SMSG_PET_NAME_QUERY_RESPONSE, nameAnswer(5, "Волк"));
  await settle();
  client.renamePet("Клык");
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(PET, { [UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset]: 0x00020000 }));
  await settle();
  assert.equal(queries().length, 2, "the flag dropped: the new name is asked for");
  connection.push(OPCODES.SMSG_PET_NAME_QUERY_RESPONSE, nameAnswer(5, "Клык"));
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(PET, { [UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset]: 0x00020000 }));
  await settle();
  assert.equal(client.petNameOf(client.state.objects.get(PET)), "Клык");
  assert.equal(queries().length, 2);
  client.close();
});

test("another player's pet in view is asked for once; a plain creature never", async () => {
  const { client, queries } = await loggedIn();
  const other = 0xf140000700000099n;
  pet(client, other, 7, false);
  const boar = 0xf130000000000055n;
  pet(client, boar, 0, false);
  client.noticeObject(other);
  client.noticeObject(other);
  client.noticeObject(boar);
  assert.deepEqual(queries().map((packet) => [...packet.payload]), [[...new PacketWriter().u32(7).u64(other).toUint8Array()]]);
  client.close();
});

test("an empty answer (a pet the server cannot see) is not asked about on every update", async () => {
  const { client, connection, queries } = await loggedIn();
  pet(client, PET, 5, false);
  connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(SELF, summon));
  connection.push(OPCODES.SMSG_PET_NAME_QUERY_RESPONSE, nameAnswer(5, ""));
  for (let health = 1; health <= 3; health++) {
    connection.push(OPCODES.SMSG_UPDATE_OBJECT, valuesUpdate(SELF, { [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset]: health }));
  }
  await settle();
  assert.equal(queries().length, 1);
  assert.equal(client.petNameOf(client.state.objects.get(PET)), undefined);
  client.close();
});
