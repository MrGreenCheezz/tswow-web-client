import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { parseInspectTalent } from "../dist/code/world/InspectProtocol.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";

// SMSG_INSPECT_TALENT in TrinityCore's own layout (MiscHandler.cpp HandleInspectOpcode,
// Player::BuildPlayerTalentsInfoData, Player::BuildEnchantmentsInfoData), parsed and kept by guid.

/** One inspected player: two talent groups, glyphs, a head piece with three gems and a ring. */
function inspectPacket({ talents = true } = {}) {
  const writer = new PacketWriter().packedGuid(0x0600_0000_0000_2001n).u32(3);
  if (talents) {
    writer.u8(2).u8(1);
    // Group 1: two talents (id, zero-based highest rank), six glyph slots.
    writer.u8(2).u32(1845).u8(2).u32(1846).u8(0).u8(6);
    for (const glyph of [251, 0, 0, 0, 0, 0]) writer.u16(glyph);
    // Group 2: one talent, six glyph slots.
    writer.u8(1).u32(2001).u8(4).u8(6);
    for (let glyph = 0; glyph < 6; glyph++) writer.u16(0);
  } else {
    writer.u8(0).u8(0);
  }
  // Slots 0 (head) and 10 (finger 1).
  writer.u32((1 << 0) | (1 << 10));
  // Head: permanent 3820, gems 3621/3518/3531, bonus 2890.
  writer.u32(40416).u16((1 << 0) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5));
  for (const enchantment of [3820, 3621, 3518, 3531, 2890]) writer.u16(enchantment);
  writer.i16(0).packedGuid(0n).u32(0);
  // Ring: a random property (a negative id is a suffix) with its suffix factor, made by someone.
  writer.u32(39141).u16(0).i16(-39).packedGuid(0x0600_0000_0000_0042n).u32(56);
  return writer.toUint8Array();
}

test("the talents and every equipped item's enchantments are parsed as the core writes them", () => {
  const result = parseInspectTalent(inspectPacket());
  assert.equal(result.guid, 0x0600_0000_0000_2001n);
  assert.deepEqual(result.talents, {
    pet: false, unspentPoints: 3, activeSpec: 1,
    specs: [
      { talents: [{ talentId: 1845, rank: 3 }, { talentId: 1846, rank: 1 }], glyphs: [251, 0, 0, 0, 0, 0] },
      { talents: [{ talentId: 2001, rank: 5 }], glyphs: [0, 0, 0, 0, 0, 0] },
    ],
  });
  assert.deepEqual(result.items, [
    { slot: 0, entry: 40416, enchantments: [3820, 0, 3621, 3518, 3531, 2890, 0, 0, 0, 0, 0, 0], randomPropertyId: 0, creator: 0n, suffixFactor: 0 },
    { slot: 10, entry: 39141, enchantments: new Array(12).fill(0), randomPropertyId: -39, creator: 0x0600_0000_0000_0042n, suffixFactor: 56 },
  ]);
});

test("a realm that hides talents sends the header with no group, and the items still parse", () => {
  const result = parseInspectTalent(inspectPacket({ talents: false }));
  assert.deepEqual(result.talents, { pet: false, unspentPoints: 3, activeSpec: 0, specs: [] });
  assert.equal(result.items.length, 2);
  assert.throws(() => parseInspectTalent(inspectPacket().slice(0, -1)), "a truncated packet is refused");
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
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

test("WorldClient keeps the answer by guid and raises INSPECT_TALENT_READY", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  const ready = [];
  client.events.on("INSPECT_TALENT_READY", (event) => ready.push(event.guid));
  client.inspect(0x0600_0000_0000_2001n);
  assert.deepEqual(connection.sent.at(-1), {
    opcode: OPCODES.CMSG_INSPECT, payload: new PacketWriter().u64(0x0600_0000_0000_2001n).toUint8Array(),
  });
  connection.push(OPCODES.SMSG_INSPECT_TALENT, inspectPacket());
  await settle();
  assert.deepEqual(ready, [0x0600_0000_0000_2001n]);
  assert.equal(client.inspections.get(0x0600_0000_0000_2001n)?.items[0]?.entry, 40416);
  assert.equal(client.packetErrors.count, 0, JSON.stringify(client.packetErrors.summary()));
});
