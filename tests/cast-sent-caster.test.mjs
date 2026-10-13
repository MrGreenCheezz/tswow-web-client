import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { packPetAction, REACT_DEFENSIVE, COMMAND_FOLLOW } from "../dist/code/world/PetProtocol.js";

// Plan item 3.02 (13.10): who hears UNIT_SPELLCAST_SENT. Wow.exe's request builder 0x0080ac90 raises it (0x81b530
// with 0x143, "player", name, rank, the target's name) only when 0x004cee50 holds for the caster — the caster's guid
// is the active player's (0x004d3790) — whatever packet it built: CMSG_CAST_SPELL (0x12e), CMSG_USE_ITEM (0xab, the
// item branch joining at 0x0080b349), or CMSG_PET_CAST_SPELL (0x1f0) for a player spell whose AttributesEx6 has
// 0x40000. A cast of the pet, the vehicle or a possessed unit through the same builder (caster ≠ player: 0x1f0) raises
// none, and the pet bar's CMSG_PET_ACTION (0x005d4210) never reaches the builder
// (.runtime/re-2026-10-02/a2-m8/d1.c; .runtime/re-2026-10-11/glue-1110/a302-1.txt: 0x004cee50). The plan's open «SENT
// for a pet's cast» is therefore Wow.exe's own silence; this pins it beside the player's and the item's SENT.

const SELF = 0x1234n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const PET = 0xf140_0000_0000_0099n;
const ENEMY = 0xf130_0000_0000_0077n;
const STRIKE = 78;
const BITE = 17253;

async function client() {
  const login = new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array();
  const waiters = [];
  const connection = {
    packets: [{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login }],
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (this.packets.length) return Promise.resolve(this.packets.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {},
  };
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  for (const guid of [SELF, VEHICLE, PET, ENEMY]) {
    world.state.move(guid, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
    if (guid !== SELF) world.state.objects.get(guid).typeId = 3;
  }
  await world.loginCharacter(SELF);
  await new Promise((resolve) => setImmediate(resolve));
  world.targetGuid = ENEMY;
  world.knownSpells = [{ id: STRIKE, slot: 0 }];
  const sent = [];
  world.events.on("SPELL_CAST_SENT", (event) => sent.push(event.spellId));
  return { world, connection, sent };
}

function bar(guid, spells) {
  const packed = spells.map((spellId, slot) => packPetAction(spellId, 0xc1)).concat(Array(10 - spells.length).fill(0));
  return {
    guid, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
    flags: 0, spells: [], cooldowns: [],
    bar: packed.map((word, slot) => ({ slot, packed: word, action: word & 0xffffff, type: word >>> 24 })),
  };
}

const opcodes = (connection) => connection.sent.map(({ opcode }) => opcode)
  .filter((opcode) => opcode === OPCODES.CMSG_CAST_SPELL || opcode === OPCODES.CMSG_PET_CAST_SPELL || opcode === OPCODES.CMSG_PET_ACTION);

test("the player's own request raises SENT; the pet bar's CMSG_PET_ACTION does not (it never reaches 0x0080ac90)", async () => {
  const { world, connection, sent } = await client();
  try {
    world.castSpell(STRIKE);
    assert.deepEqual(sent, [STRIKE], "CMSG_CAST_SPELL: the caster is the player");
    world.petSpells = bar(PET, [BITE]);
    world.usePetSlot(0);
    world.castPetSpell(BITE, 0xc1, ENEMY);
    assert.deepEqual(opcodes(connection), [OPCODES.CMSG_CAST_SPELL, OPCODES.CMSG_PET_ACTION, OPCODES.CMSG_PET_ACTION]);
    assert.deepEqual(sent, [STRIKE], "a pet's spell: no UNIT_SPELLCAST_SENT");
  } finally { world.close(); }
});

test("a controlled unit's cast (CMSG_PET_CAST_SPELL from 0x0080ac90, caster ≠ player) raises no SENT", async () => {
  const { world, connection, sent } = await client();
  try {
    world.petSpells = bar(VEHICLE, [STRIKE]);
    world.controlledGuid = VEHICLE;
    world.usePetSlot(0);
    assert.deepEqual(opcodes(connection), [OPCODES.CMSG_PET_CAST_SPELL], "the vehicle casts it");
    assert.deepEqual(sent, [], "0x004cee50: the vehicle is not the active player");
  } finally { world.close(); }
});
