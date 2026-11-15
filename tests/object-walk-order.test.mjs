import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { WorldState } from "../dist/code/world/WorldState.js";

// 5.25 (15.11): the order in which Wow.exe walks its objects (0x004D4B30, from the head of the object manager's
// visible list at +0xA4/+0xAC), and that `state.objects` keeps the same one — the spirit-guide pick
// (FrameXmlAreaSpiritHealer.ts, 0x00524010 → 0x00523F80) and the minimap's object lists walk it.
// Wow.exe (.runtime/re-2026-11-15/quest5/b.lst, c.c): a create block links an object that is in neither list to the
// tail of a pending list (0x004D6B72–0x004D6BA7, 0x006DED60 = link to tail); when the packet is done the pending
// objects move, head first, to the tail of the visible list (0x004D7190–0x004D7204). A create block for an object still
// visible links nothing; going out of range or being destroyed unlinks it (0x004D6FFC–0x004D7014). So: oldest first,
// a packet's new objects in block order, and an object that came back into view behind everything already there.

function createBlock(writer, guid) {
  return writer
    .u8(2) // UPDATETYPE_CREATE_OBJECT
    .packedGuid(guid)
    .u8(3)
    .u16(0x0020) // UPDATEFLAG_LIVING
    .u32(0).u16(0).u32(0)
    .f32(0).f32(0).f32(0).f32(0)
    .u32(0);
}

function creates(...guids) {
  const writer = new PacketWriter().u32(guids.length);
  for (const guid of guids) {
    createBlock(writer, guid);
    for (let speed = 0; speed < 9; speed++) writer.f32(speed + 1);
    writer.u8(0);
  }
  return writer.toUint8Array();
}

const outOfRange = (guid) => new PacketWriter().u32(1).u8(4).u32(1).packedGuid(guid).toUint8Array();

test("objects are walked oldest first; a packet's in block order; one back in view goes behind the rest", () => {
  const state = new WorldState();
  state.applyUpdate(creates(10n, 20n));
  state.applyUpdate(creates(30n));
  assert.deepEqual([...state.objects.keys()], [10n, 20n, 30n]);
  state.applyUpdate(creates(10n));
  assert.deepEqual([...state.objects.keys()], [10n, 20n, 30n], "a create for an object still in view keeps its place");
  state.applyUpdate(outOfRange(10n));
  state.applyUpdate(creates(10n));
  assert.deepEqual([...state.objects.keys()], [20n, 30n, 10n], "out of range and back: the tail");
});
