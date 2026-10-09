import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const ItemTooltip = await import("../dist/code/browser/ui/ItemTooltip.js");
const { GLOBAL_STRING_DATA_AVAILABLE, GLOBAL_STRINGS } = await import("../dist/code/generated/globalStrings.js");

/**
 * WORK_PLAN 5.22: the inbound branches that parsed a packet and dropped it now react the way
 * Wow.exe 3.3.5a (12340) does (`.runtime/re-2026-10-02/a3-mech/`, d1/d5/d6):
 * * SMSG_SET_PROFICIENCY 0x6cdeb0 — one subclass word per item class (0x00c9d4f0); read by the item
 *   checks 0x5e9250/0x6dc3f0 and the tooltip, a zero word restricting nothing (0x6cde90);
 * * SMSG_INVALIDATE_PLAYER 0x635400 → 0x67a430 — the cached name goes and is asked for again;
 * * SMSG_STANDSTATE_UPDATE 0x73f540 → 0x73f060 — the active player's stand state, at once;
 * * SMSG_DURABILITY_DAMAGE_DEATH 0x50c810 — DURABILITYDAMAGE_DEATH as a system line;
 * * SMSG_ITEM_TIME_UPDATE 0x6e6330 → 0x707070 — the item's remaining seconds.
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
  return { client, connection };
}

async function deliver(connection, opcode, payload = new Uint8Array()) {
  connection.push(opcode, payload);
  await settle();
}

/** What the client sent, without the mover claim that the login fixture triggers on its own. */
const sent = (connection) => connection.sent.filter((packet) => packet.opcode !== OPCODES.CMSG_SET_ACTIVE_MOVER);
const ignored = (client, opcode) => client.ignoredOpcodes.entries.get(opcode)?.count ?? 0;

test("SET_PROFICIENCY keeps one subclass word per class; a class without a word is not restricted", async () => {
  const { client, connection } = await loggedIn();
  assert.equal(client.isProficient(2, 0), true, "nothing known yet: nothing restricted");
  // Weapons: daggers only (subclass 15), as a rogue's first passives send it.
  await deliver(connection, OPCODES.SMSG_SET_PROFICIENCY, new PacketWriter().u8(2).u32(1 << 15).toUint8Array());
  assert.equal(client.isProficient(2, 15), true);
  assert.equal(client.isProficient(2, 0), false, "an axe needs bit 0");
  assert.equal(client.isProficient(4, 4), true, "armour has no word yet");
  // A later packet replaces the class's word rather than adding to it (0x6cdeb0 stores it).
  await deliver(connection, OPCODES.SMSG_SET_PROFICIENCY, new PacketWriter().u8(2).u32(1 | (1 << 15)).toUint8Array());
  assert.equal(client.isProficient(2, 0), true);
  await deliver(connection, OPCODES.SMSG_SET_PROFICIENCY, new PacketWriter().u8(4).u32((1 << 0) | (1 << 1)).toUint8Array());
  assert.equal(client.isProficient(4, 1), true, "cloth and leather");
  assert.equal(client.isProficient(4, 4), false, "plate needs bit 4");
  assert.equal(ignored(client, OPCODES.SMSG_SET_PROFICIENCY), 0, "no longer counted as ignored");
  assert.deepEqual(sent(connection), [], "no answer is sent");
});

test("the stock item tooltip paints the subclass word red without the proficiency",
  { skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data" }, () => {
    const plate = {
      found: true, entry: 10, name: "Латный нагрудник", quality: 2, itemClass: 4, subClass: 4, inventoryType: 5,
      itemLevel: 10, flags: 0, maxCount: 0, bonding: 0, containerSlots: 0, block: 0,
      damage: [{ min: 0, max: 0, type: 0 }], delay: 0, resistances: [0, 0, 0, 0, 0, 0, 0], stats: [],
      requiredLevel: 1, maxDurability: 0, spells: [], requiredSkill: 0, requiredSkillRank: 0,
      requiredReputationFaction: 0, requiredReputationRank: 0, allowableClass: 0, allowableRace: 0,
      sockets: [], socketBonus: 0, gemProperties: 0, startQuest: 0, description: "", sellPrice: 0, stackable: 1,
    };
    const slotRow = (proficient) => ItemTooltip.itemTooltipContent({ entry: 10, template: plate }, {
      layout: "stock", subclassName: () => "Латы", ...(proficient === undefined ? {} : { proficient: () => proficient }),
    }).lines.find((line) => line.text === GLOBAL_STRINGS.INVTYPE_CHEST);
    assert.deepEqual(slotRow(false), { text: GLOBAL_STRINGS.INVTYPE_CHEST, right: "Латы", rightColor: "#ff2020" });
    assert.deepEqual(slotRow(true), { text: GLOBAL_STRINGS.INVTYPE_CHEST, right: "Латы" });
    assert.deepEqual(slotRow(undefined), { text: GLOBAL_STRINGS.INVTYPE_CHEST, right: "Латы" }, "no world: white");
  });

test("INVALIDATE_PLAYER forgets a held name and asks for it once; an unknown guid costs nothing", async () => {
  const { client, connection } = await loggedIn();
  const friend = 0x77n;
  client.names.accept({ guid: friend, known: true, name: "Старое", realm: "", race: 1, gender: 0, classId: 1, declined: [] });
  await deliver(connection, OPCODES.SMSG_INVALIDATE_PLAYER, new PacketWriter().u64(friend).toUint8Array());
  assert.equal(client.names.get(friend), undefined);
  assert.deepEqual(sent(connection).map((packet) => packet.opcode), [OPCODES.CMSG_NAME_QUERY]);
  assert.deepEqual([...sent(connection)[0].payload], [...new PacketWriter().u64(friend).toUint8Array()]);
  await deliver(connection, OPCODES.SMSG_INVALIDATE_PLAYER, new PacketWriter().u64(0x99n).toUint8Array());
  assert.equal(sent(connection).length, 1, "nothing was held for 0x99, nothing to ask again");
  assert.equal(ignored(client, OPCODES.SMSG_INVALIDATE_PLAYER), 0);
});

test("STANDSTATE_UPDATE writes the player's stand byte at once and keeps the other three", async () => {
  const { client, connection } = await loggedIn();
  const offset = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;
  client.state.setField(SELF, offset, 0x0a0b0c00);
  const before = client.state.revision;
  await deliver(connection, OPCODES.SMSG_STANDSTATE_UPDATE, new PacketWriter().u8(1).toUint8Array());
  assert.equal(client.state.objects.get(SELF).fields.get(offset), 0x0a0b0c01, "sitting, the rest untouched");
  const after = client.state.revision;
  assert.ok(after > before);
  await deliver(connection, OPCODES.SMSG_STANDSTATE_UPDATE, new PacketWriter().u8(1).toUint8Array());
  assert.equal(client.state.revision, after, "the same state twice changes nothing");
  await deliver(connection, OPCODES.SMSG_STANDSTATE_UPDATE, new PacketWriter().u8(0).toUint8Array());
  assert.equal(client.state.objects.get(SELF).fields.get(offset), 0x0a0b0c00, "standing again");
  assert.deepEqual(sent(connection), []);
  assert.equal(ignored(client, OPCODES.SMSG_STANDSTATE_UPDATE), 0);
});

test("DURABILITY_DAMAGE_DEATH says DURABILITYDAMAGE_DEATH once, as a system line", async () => {
  const { client, connection } = await loggedIn();
  const lines = [];
  client.events.on("WORLD_MESSAGE", (message) => lines.push(message));
  await deliver(connection, OPCODES.SMSG_DURABILITY_DAMAGE_DEATH);
  // GlobalStrings.lua:2096 (ruRU).
  const expected = "Предметы вашей экипировки утратили 10% прочности.";
  assert.deepEqual(lines, [{ text: expected, kind: "system" }]);
  assert.equal(ignored(client, OPCODES.SMSG_DURABILITY_DAMAGE_DEATH), 0);
});

test("ITEM_TIME_UPDATE writes the remaining seconds into the item's own field, for a held item only", async () => {
  const { client, connection } = await loggedIn();
  const item = 0x4000000000000123n;
  client.state.setField(item, UPDATE_FIELDS.ITEM_FIELD_DURATION.offset, 3600);
  await deliver(connection, OPCODES.SMSG_ITEM_TIME_UPDATE, new PacketWriter().u64(item).u32(1795).toUint8Array());
  assert.equal(client.state.objects.get(item).fields.get(UPDATE_FIELDS.ITEM_FIELD_DURATION.offset), 1795);
  const stranger = 0x4000000000000999n;
  await deliver(connection, OPCODES.SMSG_ITEM_TIME_UPDATE, new PacketWriter().u64(stranger).u32(60).toUint8Array());
  assert.equal(client.state.objects.has(stranger), false, "no object is made up for an item this client never saw");
  assert.equal(ignored(client, OPCODES.SMSG_ITEM_TIME_UPDATE), 0);
});

test("SERVER_FIRST_ACHIEVEMENT stays counted as ignored by design: its only effect is a chat line", async () => {
  const { client, connection } = await loggedIn();
  await deliver(connection, OPCODES.SMSG_SERVER_FIRST_ACHIEVEMENT,
    new PacketWriter().cString("Кто-то").u64(5n).u32(457).u32(0).toUint8Array());
  assert.equal(client.ignoredOpcodes.entries.get(OPCODES.SMSG_SERVER_FIRST_ACHIEVEMENT)?.reason?.kind, "by-design");
});
