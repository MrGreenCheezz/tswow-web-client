import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { OwnCastMark, ownSheathCasting } from "../dist/code/world/OwnCastMark.js";
import { cycleEndIsSheathStart } from "../dist/code/browser/SheathCycleStart.js";
import { setPetSpellAttributesSource } from "../dist/code/world/PetCastSpell.js";
import { OwnAnimationSheath } from "../dist/code/browser/game/OwnAnimationSheath.js";
import {
  castFailedPacket, fakeWorldConnection, initialSpellsPacket, loginVerifyWorldPacket, settle, spellGoPacket,
} from "./fixtures/world-packets.mjs";

/*
 * 5.05 (15.11, sheath6): the window between the own request and SMSG_SPELL_GO, measured on the stand's Wow.exe
 * (F:/WowOracle/runs/sheath6-*.json and .bones). Spell rows read through the gateway's /dbc/spells on 15.11:
 * 469 Commanding Shout, instant, Attributes 0x10; 6673 Battle Shout, instant, Attributes 0x50010 (0x40000 =
 * SPELL_ATTR0_DONT_AFFECT_SHEATH_STATE).
 */
const COMMANDING_SHOUT = 469;
const BATTLE_SHOUT = 6673;
const ATTRIBUTES = new Map([[COMMANDING_SHOUT, [0x10, 0, 0, 0, 0, 0, 0, 0]], [BATTLE_SHOUT, [0x50010, 0, 0, 0, 0, 0, 0, 0]]]);

test("5.05 (15.11): the mark is the request's until the end of that very cast (0x00805330, 0x007fecc0)", () => {
  const mark = new OwnCastMark();
  mark.send(COMMANDING_SHOUT, 4);
  assert.equal(mark.spellId, COMMANDING_SHOUT);
  mark.send(BATTLE_SHOUT, 5);
  assert.equal(mark.spellId, COMMANDING_SHOUT, "a second request inside the window keeps the first mark");
  mark.end(COMMANDING_SHOUT, 3);
  assert.equal(mark.spellId, COMMANDING_SHOUT, "another count's end leaves it");
  mark.end(BATTLE_SHOUT, 4);
  assert.equal(mark.spellId, COMMANDING_SHOUT, "another spell's end leaves it");
  mark.end(COMMANDING_SHOUT, 4 + 256);
  assert.equal(mark.spellId, undefined, "the count is the wire's byte");
  mark.send(BATTLE_SHOUT, 6, true);
  assert.equal(mark.spellId, undefined, "a cast bar of the player's already holds +0xa60");
});

test("5.05 (15.11): the cast judged is the cast bar, else the unanswered request; a channel is neither", () => {
  const attributes = (id) => ATTRIBUTES.get(id)?.[0];
  assert.deepEqual(ownSheathCasting(undefined, COMMANDING_SHOUT, attributes), { attributes0: 0x10 });
  assert.deepEqual(ownSheathCasting({ spellId: BATTLE_SHOUT, channel: false }, COMMANDING_SHOUT, attributes), { attributes0: 0x50010 });
  assert.deepEqual(ownSheathCasting({ spellId: BATTLE_SHOUT, channel: true }, COMMANDING_SHOUT, attributes), { attributes0: 0x10 });
  assert.equal(ownSheathCasting({ spellId: BATTLE_SHOUT, channel: true }, undefined, attributes), undefined);
  assert.deepEqual(ownSheathCasting(undefined, 99999, attributes), { attributes0: undefined }, "a row not known");
});

test("5.05 (15.11): a looping clip without variations coming round is a start (HumanMale Run, 667 ms)", () => {
  assert.equal(cycleEndIsSheathStart(true, true, true, false, false), true);
  assert.equal(cycleEndIsSheathStart(false, true, true, false, false), false, "not round");
  assert.equal(cycleEndIsSheathStart(true, true, true, false, true), false, "variations: the draw-again start counts it");
  assert.equal(cycleEndIsSheathStart(true, true, false, false, false), false, "played backwards");
  assert.equal(cycleEndIsSheathStart(true, true, true, true, false), false, "under an upper-body pose");
  assert.equal(cycleEndIsSheathStart(true, false, true, false, false), false, "a one-shot");
});

// ---- the wiring: castSpell → the mark → the renderer's start → CMSG_SET_SHEATHED ----

const SELF = 0x1234n;

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  await world.loginCharacter(SELF);
  await settle();
  connection.push(OPCODES.SMSG_INITIAL_SPELLS, initialSpellsPacket({ spells: [COMMANDING_SHOUT, BATTLE_SHOUT] }));
  await settle();
  const sheath = new OwnAnimationSheath();
  const own = { guid: SELF, animation: 0, starts: 0 };
  sheath.afterDraw(world, own);
  world.setSheathed(1); // the sword drawn, as on the stand before each case
  connection.sent.length = 0;
  const sheaths = () => connection.sentOf(OPCODES.CMSG_SET_SHEATHED).map(({ payload }) => payload[0]);
  const casts = () => connection.sentOf(OPCODES.CMSG_CAST_SPELL).map(({ payload }) => payload[0]);
  const start = (animation) => { own.starts++; own.animation = animation; sheath.afterDraw(world, own); };
  return { world, connection, sheaths, casts, start };
}

test("5.05 (15.11): Commanding Shout unanswered — stopping (Stand starts) puts the sword away with one SET_SHEATHED 0; the GO draws nothing back",
  async () => {
    setPetSpellAttributesSource((spellId) => ATTRIBUTES.get(spellId));
    const { world, connection, sheaths, casts, start } = await client();
    try {
      world.castSpell(COMMANDING_SHOUT);
      assert.equal(casts().length, 1, "the request went out");
      start(0); // the stop's Stand (sheath6-stop-150/600/2000: the packet in the stop's frame)
      assert.deepEqual(sheaths(), [0]);
      start(5); // Run again
      assert.deepEqual(sheaths(), [0], "nothing more: the setter holds 0");
      connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId: casts()[0], spellId: COMMANDING_SHOUT }));
      await settle();
      start(0);
      assert.deepEqual(sheaths(), [0], "after the GO no start draws it again (every sheath6 case stayed on the back)");
    } finally {
      setPetSpellAttributesSource(undefined);
      world.close();
    }
  });

test("5.05 (15.11): no start inside the window, a DONT_AFFECT_SHEATH_STATE shout, or a start after the answer keep the sword",
  async () => {
    setPetSpellAttributesSource((spellId) => ATTRIBUTES.get(spellId));
    const { world, connection, sheaths, casts, start } = await client();
    try {
      world.castSpell(BATTLE_SHOUT);
      start(0); // sheath6-battle-stop-2000: the stop inside the window, nothing sent
      assert.deepEqual(sheaths(), []);
      connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId: casts()[0], spellId: BATTLE_SHOUT }));
      await settle();
      world.castSpell(COMMANDING_SHOUT);
      connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId: casts()[1], spellId: COMMANDING_SHOUT }));
      await settle();
      start(0); // sheath6-stand-600, -run-150: the window passed without a start
      assert.deepEqual(sheaths(), [], "the GO ended the mark before the start");
      world.castSpell(COMMANDING_SHOUT);
      connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: casts()[2], spellId: COMMANDING_SHOUT, result: 0x28 }));
      await settle();
      start(0);
      assert.deepEqual(sheaths(), [], "the realm's refusal ends the mark too (0x00808200 → 0x007fecc0)");
      assert.equal(casts().length, 3, "all three requests went out");
    } finally {
      setPetSpellAttributesSource(undefined);
      world.close();
    }
  });
