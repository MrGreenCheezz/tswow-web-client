import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { castFailedPacket, initialSpellsPacket, settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

// 3.02 sources on a real WorldClient: SPELL_CAST_SENT from the request (Wow.exe 0x0080ac90),
// SPELL_CAST_RESULT before the STOP its packet causes (0x007fecc0's callers: GO 0x0080e1b0 unless
// CAST_FLAG_PENDING, CAST_FAILED 0x00809af0 → 0x00808200, SPELL_FAILURE 0x00809c70, SPELL_FAILED_OTHER 0x00806ad0 —
// registration 0x008100e0; 3.01-go-order corrected the addresses),
// and SMSG_SPELL_START's CAST_FLAG_IMMUNITY words on the cast.

const SELF = 0x10n;
const MOB = 0xf130000000000abcn;

/** `SMSG_SPELL_START` — SpellPackets.cpp:112-160: header, `u32` target flags, then the flagged words. */
function spellStartPacket({ caster, castId, spellId, castTime, flags = 0x2, power, immunity }) {
  const writer = new PacketWriter().packedGuid(caster).packedGuid(caster).u8(castId).u32(spellId).u32(flags).u32(castTime);
  writer.u32(0);
  if (power !== undefined) writer.u32(power);
  if (immunity) writer.u32(immunity.school).u32(immunity.mechanic);
  return writer.toUint8Array();
}

/** `SMSG_SPELL_FAILURE` / `_FAILED_OTHER` — Spell::SendInterrupted (Spell.cpp:4822-4837). */
function spellFailurePacket({ caster, castCount, spellId, result }) {
  return new PacketWriter().packedGuid(caster).u8(castCount).u32(spellId).u8(result).toUint8Array();
}

/** A GO whose flags carry CAST_FLAG_PENDING (a triggered spell, Spell.cpp:4485). */
function pendingGoPacket({ caster, castId, spellId }) {
  return new PacketWriter().packedGuid(caster).packedGuid(caster).u8(castId).u32(spellId).u32(0x101).u32(0)
    .u8(0).u8(0).u32(0).toUint8Array();
}

function record(client, names) {
  const seen = [];
  for (const name of names) client.events.on(name, (event) => seen.push([name, event]));
  return seen;
}

test("a cast request raises SPELL_CAST_SENT with its count and named unit", async () => {
  const { client, connection } = await travelClient([
    { opcode: OPCODES.SMSG_INITIAL_SPELLS, payload: initialSpellsPacket({ spells: [133] }) },
  ], SELF);
  const seen = record(client, ["SPELL_CAST_SENT"]);
  client.castSpellOnUnit(133, MOB);
  assert.equal(connection.sentOf(OPCODES.CMSG_CAST_SPELL).length, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1].spellId, 133);
  assert.equal(seen[0][1].targetGuid, MOB);
  assert.equal(typeof seen[0][1].castCount, "number");
  client.castSpell(133);
  assert.equal(seen.length, 2);
  assert.equal(seen[1][1].targetGuid, undefined, "an ordinary cast names no unit");
  assert.equal(seen[1][1].castCount, (seen[0][1].castCount + 1) & 0xff);
  client.close?.();
});

test("GO: the success result comes before STOP; a pending (triggered) GO has none", async () => {
  const { client, connection } = await travelClient([], SELF);
  const seen = record(client, ["SPELL_CAST_START", "SPELL_CAST_RESULT", "SPELL_CAST_STOP"]);
  connection.push(OPCODES.SMSG_SPELL_START, spellStartPacket({ caster: MOB, castId: 0, spellId: 133, castTime: 2500 }));
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: MOB, castId: 0, spellId: 133 }));
  await settle();
  assert.deepEqual(seen.map(([name]) => name), ["SPELL_CAST_START", "SPELL_CAST_RESULT", "SPELL_CAST_STOP"]);
  assert.deepEqual(seen[1][1], { casterGuid: MOB, spellId: 133, castCount: 0, result: 187 });
  seen.length = 0;
  connection.push(OPCODES.SMSG_SPELL_GO, pendingGoPacket({ caster: MOB, castId: 0, spellId: 12654 }));
  await settle();
  assert.deepEqual(seen, [], "CAST_FLAG_PENDING: no SUCCEEDED in the original");
  client.close?.();
});

test("refusals: CAST_FAILED is the player's; the interrupt pair gives two results", async () => {
  const { client, connection } = await travelClient([], SELF);
  const seen = record(client, ["SPELL_CAST_RESULT", "SPELL_CAST_STOP"]);
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 5, spellId: 133, result: 27 }));
  await settle();
  // 3.01-castlog: CAST_FAILED's result is marked — it alone is logged as SPELL_CAST_FAILED (0x00809af0 → 0x00808200).
  assert.deepEqual(seen, [["SPELL_CAST_RESULT", { casterGuid: SELF, spellId: 133, castCount: 5, result: 27, refusal: true }]]);
  seen.length = 0;
  connection.push(OPCODES.SMSG_SPELL_START, spellStartPacket({ caster: MOB, castId: 3, spellId: 133, castTime: 2500 }));
  connection.push(OPCODES.SMSG_SPELL_FAILURE, spellFailurePacket({ caster: MOB, castCount: 3, spellId: 133, result: 40 }));
  connection.push(OPCODES.SMSG_SPELL_FAILED_OTHER, spellFailurePacket({ caster: MOB, castCount: 3, spellId: 133, result: 40 }));
  await settle();
  assert.deepEqual(seen.map(([name, event]) => [name, event.result ?? event.reason]), [
    ["SPELL_CAST_RESULT", 40], ["SPELL_CAST_STOP", "interrupted"],
    ["SPELL_CAST_RESULT", 40], ["SPELL_CAST_STOP", "interrupted"],
  ]);
  client.close?.();
});

test("SPELL_START keeps CAST_FLAG_IMMUNITY's two words on the cast, past the power word", async () => {
  const { client, connection } = await travelClient([], SELF);
  let atStart;
  client.events.on("SPELL_CAST_START", ({ casterGuid }) => { atStart = { ...client.casts.get(casterGuid) }; });
  connection.push(OPCODES.SMSG_SPELL_START, spellStartPacket({
    caster: MOB, castId: 1, spellId: 133, castTime: 3000, flags: 0x2 | 0x800 | 0x04000000, power: 100,
    immunity: { school: 0x7e, mechanic: 1 << 26 },
  }));
  await settle();
  assert.equal(atStart.schoolImmunityMask, 0x7e, "set before the START listeners run");
  assert.equal(atStart.mechanicImmunityMask, 1 << 26);
  connection.push(OPCODES.SMSG_SPELL_START, spellStartPacket({ caster: MOB, castId: 2, spellId: 133, castTime: 3000 }));
  await settle();
  assert.equal(client.casts.get(MOB).schoolImmunityMask, undefined);
  client.close?.();
});
