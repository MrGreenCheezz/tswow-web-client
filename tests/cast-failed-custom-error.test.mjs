import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { globalString } from "../dist/code/generated/globalStrings.js";
import { castFailedPacket, settle, travelClient } from "./fixtures/world-packets.mjs";

// Plan item 3.02 (13.10): SPELL_FAILED_CUSTOM_ERROR (172) in the error frame, as Wow.exe 0x00808200 says it
// (.runtime/re-2026-10-04/l15-combat/g2.c; .runtime/re-2026-10-11/glue-1110/a302-2.txt, a302-3.txt, a302-4.txt):
// case 0xac calls 0x007fef10, which formats "SPELL_FAILED_CUSTOM_ERROR_%d" with the packet's custom error, looks it
// up through 0x00819d40 (plural and gender suffixes, else "") and raises it at once through 0x005216f0(0x30) —
// ERR_SPELL_FAILED_S, "%s", a UI_ERROR_MESSAGE — then sets `local_14`, so the general line (0x005216f0 with the
// result's own string, and 0x00751ad0) never follows. The 3 s rule and the wanted-spell rule that fill `local_14`
// before it therefore never silence it, and a custom error with no string of its own says nothing at all.

const SELF = 0x10n;
const SPELL = 33395;

async function client() {
  const { client: world, connection } = await travelClient([], SELF);
  const said = [];
  world.onSpellStatus = (text, error) => said.push([text, error]);
  return { world, connection, said };
}

test("a custom error is said every time, a repeat within 3 s too; an ordinary repeat is quiet", async () => {
  const { world, connection, said } = await client();
  try {
    const custom = globalString("SPELL_FAILED_CUSTOM_ERROR_28");
    assert.ok(custom, "the dataset's SPELL_FAILED_CUSTOM_ERROR_28");
    for (let press = 0; press < 3; press++) {
      connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: press, spellId: SPELL, result: 172, tail: [28] }));
    }
    await settle();
    assert.deepEqual(said, [[custom, true], [custom, true], [custom, true]], "ERR_SPELL_FAILED_S, never quiet");
    said.length = 0;
    // The control: the same spell and an ordinary result twice within 3 s — the second is quiet (local_14).
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 4, spellId: SPELL, result: 97 }));
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 5, spellId: SPELL, result: 97 }));
    await settle();
    assert.equal(said.length, 1, JSON.stringify(said));
  } finally { world.close?.(); }
});

test("a custom error without a string of its own — an unknown number, or one GlobalStrings keeps only under _NONE — says nothing", async () => {
  const { world, connection, said } = await client();
  try {
    assert.equal(globalString("SPELL_FAILED_CUSTOM_ERROR_14"), undefined);
    assert.ok(globalString("SPELL_FAILED_CUSTOM_ERROR_14_NONE"), "the string 0x00819d40 never asks for");
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: SPELL, result: 172, tail: [14] }));
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 2, spellId: SPELL + 1, result: 172, tail: [4000] }));
    await settle();
    assert.deepEqual(said, [], "no SPELL_FAILED_UNKNOWN, no number");
  } finally { world.close?.(); }
});
