// Plan item 2.05 (mechanism M3): the explicit-target tail of CMSG_CAST_SPELL / CMSG_USE_ITEM, read
// back in SpellCastTargets::Read order (Spell.cpp:144-195): mask, object guid, item guid, source,
// destination, string.
import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import {
  buildCastSpellTargeted, buildUseItemTargeted, spellTargetMask, TRADE_SLOT_NONTRADED, writeSpellTargets,
} from "../dist/code/world/SpellTargets.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

test("an item target writes mask 0x10 and the packed item guid", () => {
  const writer = new PacketWriter();
  assert.equal(writeSpellTargets(writer, { item: 0x4000_0000_0000_0123n }), true);
  assert.equal(hex(writer.toUint8Array()), "10000000" + "83" + "2301" + "40");
});

test("the trade slot writes mask 0x1000 and the slot number 6 as the item «guid»", () => {
  assert.equal(TRADE_SLOT_NONTRADED, 6);
  const writer = new PacketWriter();
  assert.equal(writeSpellTargets(writer, { tradeSlot: 6 }), true);
  assert.equal(hex(writer.toUint8Array()), "00100000" + "01" + "06");
  for (const slot of [0, 5, 7]) {
    assert.equal(spellTargetMask({ tradeSlot: slot }), undefined, `trade slot ${slot} is refused by the core`);
  }
  assert.equal(spellTargetMask({ tradeSlot: 6, item: 5n }), undefined, "one item target at a time");
});

test("game object, unit and destination targets keep the core's field order", () => {
  const go = new PacketWriter();
  writeSpellTargets(go, { gameObject: 0xF110_0000_0000_0042n });
  assert.equal(hex(go.toUint8Array()), "00080000" + "c1" + "42" + "10f1");
  const unit = new PacketWriter();
  writeSpellTargets(unit, { unit: 0x55n });
  assert.equal(hex(unit.toUint8Array()), "02000000" + "01" + "55");
  assert.equal(spellTargetMask({ unit: 1n, gameObject: 2n }), undefined, "one object target at a time");
  const both = new PacketWriter();
  writeSpellTargets(both, { item: 0x77n, destination: { x: 1, y: 2, z: 3 } });
  const reader = new PacketReader(both.toUint8Array());
  assert.equal(reader.u32(), 0x50);
  assert.equal(reader.packedGuid(), 0x77n, "the item guid comes before the destination");
  assert.equal(reader.packedGuid(), 0n, "world coordinates: transport guid zero");
  assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [1, 2, 3]);
  reader.assertFinished();
  assert.equal(spellTargetMask({ destination: { x: Number.NaN, y: 0, z: 0 } }), undefined);
  assert.equal(spellTargetMask({}), 0);
});

test("CMSG_USE_ITEM with an item target is the HandleUseItemOpcode header plus the tail", () => {
  const payload = buildUseItemTargeted(255, 23, 7, 2823, 0x4000_0000_0000_0009n, { item: 0x4000_0000_0000_0010n });
  const reader = new PacketReader(payload);
  assert.deepEqual([reader.u8(), reader.u8(), reader.u8(), reader.u32()], [255, 23, 7, 2823]);
  assert.equal(reader.u64(), 0x4000_0000_0000_0009n);
  assert.equal(reader.u32(), 0, "glyph index");
  assert.equal(reader.u8(), 0, "cast flags");
  assert.equal(reader.u32(), 0x10);
  assert.equal(reader.packedGuid(), 0x4000_0000_0000_0010n);
  reader.assertFinished();
  assert.equal(buildUseItemTargeted(255, 23, 7, 2823, 9n, { tradeSlot: 2 }), undefined);
});

test("CMSG_CAST_SPELL on the trade slot is castCount, spell, flags, 0x1000, packed 6", () => {
  assert.equal(hex(buildCastSpellTargeted(13262, 3, { tradeSlot: 6 })), "03" + "ce330000" + "00" + "00100000" + "0106");
});

function connection() {
  const packets = []; let wake;
  return {
    sent: [],
    push(opcode, payload) { if (wake) { const resume = wake; wake = undefined; resume({ opcode, payload }); }
      else packets.push({ opcode, payload }); },
    read() { return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
  };
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise(setImmediate); }

/** A player whose backpack slot 23 holds a poison and whose main hand (slot 15) holds a blade. */
function carry(world, self, items) {
  const fields = new Map();
  for (const [slotField, guid] of items) {
    fields.set(slotField, Number(guid & 0xffff_ffffn));
    fields.set(slotField + 1, Number(guid >> 32n));
    world.state.objects.set(guid, { guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 1]]) });
  }
  world.state.objects.set(self, { guid: self, typeId: 4, fields });
  world.state.selfGuid = self;
}

test("WorldClient.useItemOnItem sends one targeted use, only for items the inventory holds", async () => {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  try {
    await world.loginCharacter(1n); await settle(); transport.sent.length = 0;
    const packSlot = UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset;
    const invSlot = UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset;
    const poison = 0x4000_0000_0000_0101n;
    const blade = 0x4000_0000_0000_0202n;
    carry(world, 1n, [[packSlot, poison], [invSlot + 15 * 2, blade]]);
    assert.equal(world.useItemOnItem(255, 23, poison, 2823, blade), true);
    const uses = transport.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_USE_ITEM);
    assert.equal(uses.length, 1);
    const reader = new PacketReader(uses[0].payload);
    assert.deepEqual([reader.u8(), reader.u8()], [255, 23]);
    reader.u8(); reader.u32();
    assert.equal(reader.u64(), poison);
    reader.u32(); reader.u8();
    assert.equal(reader.u32(), 0x10);
    assert.equal(reader.packedGuid(), blade);
    reader.assertFinished();
    assert.equal(world.useItemOnItem(255, 24, poison, 2823, blade), false, "the source moved: nothing is sent");
    assert.equal(world.useItemOnItem(255, 23, poison, 2823, 0x4000_0000_0000_0999n), false, "a target not carried");
    assert.equal(transport.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_USE_ITEM).length, 1);
  } finally { world.close(); }
});

test("WorldClient.castSpellOnTradeSlot needs an open trade and a known spell", async () => {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  try {
    await world.loginCharacter(1n); await settle(); transport.sent.length = 0;
    world.state.selfGuid = 1n;
    world.knownSpells = [{ id: 13262 }];
    assert.equal(world.castSpellOnTradeSlot(13262), false, "no trade: nothing");
    world.tradeOpen = true;
    assert.equal(world.castSpellOnTradeSlot(999), false, "an unknown spell: nothing");
    assert.equal(world.castSpellOnTradeSlot(13262), true);
    const casts = transport.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL);
    assert.equal(casts.length, 1);
    assert.equal(hex(casts[0].payload).slice(2), "ce330000" + "00" + "00100000" + "0106");
  } finally { world.close(); }
});
