import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { ANIMATION_WEAPON_FLAGS } from "../dist/code/generated/animations.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { animationSheathState } from "../dist/code/world/AnimationSheathRule.js";
import { setPetSpellAttributesSource } from "../dist/code/world/PetCastSpell.js";
import { OwnAnimationSheath } from "../dist/code/browser/game/OwnAnimationSheath.js";
import { fakeWorldConnection, loginVerifyWorldPacket, settle } from "./fixtures/world-packets.mjs";

/*
 * 5.05 (11.11): Wow.exe 0x00738180, the sheath the animation a model starts asks for (world/AnimationSheathRule.ts),
 * read whole in .runtime/re-2026-11-11/combat/l6.lst; behaviors 0x0071d590 / 0x0071d2e0 in d6.c.
 */

const base = { animation: 0, keep: false, held: 0, casting: undefined, attacking: false, activePlayer: true, published: 0 };
const row = (weaponFlags, behavior = 0) => ({ weaponFlags, behavior });

test("5.05 (11.11): branch 1 — Weaponflags 0x4 sheathes unless the play flags keep it", () => {
  assert.equal(animationSheathState({ ...base, animation: 50, row: row(0x4), held: 1 }), 0, "Loot");
  assert.equal(animationSheathState({ ...base, animation: 50, row: row(0x4), held: 1, keep: true }), undefined);
  assert.equal(animationSheathState({ ...base, animation: 91, row: row(0x4), held: 2 }), 0, "Mount, even with the bow out");
  assert.equal(animationSheathState({ ...base, animation: 91, row: undefined, held: 1 }), undefined, "no row: no flags");
});

test("5.05 (11.11): branch 2 — the bow held: loads and ranged behaviors keep it, 0x10 sheathes (no keep test), 0x20 draws melee", () => {
  const held = { ...base, held: 2 };
  for (const animation of [105, 106, 112]) {
    assert.equal(animationSheathState({ ...held, animation, row: row(0x10) }), undefined, `load ${animation}`);
  }
  assert.equal(animationSheathState({ ...held, animation: 46, row: row(0x10, 0x2e) }), undefined, "AttackBow, a ranged behavior");
  assert.equal(animationSheathState({ ...held, animation: 69, row: row(0x10), keep: true }), 0, "an emote, keep or not");
  assert.equal(animationSheathState({ ...held, animation: 26, row: row(0x20) }), 1, "Ready1H");
  assert.equal(animationSheathState({ ...held, animation: 0, row: row(0) }), undefined, "the player keeps the bow");
  assert.equal(animationSheathState({ ...held, animation: 0, row: row(0), activePlayer: false }), 2, "another unit: ranged again");
  assert.equal(animationSheathState({ ...held, animation: 0, row: undefined, attacking: true }), undefined, "the swing is not read here");
});

test("5.05 (11.11): branch 3 — a cast in progress sheathes unless DONT_AFFECT_SHEATH_STATE, and ends the judgement", () => {
  const casting = (attributes0) => ({ ...base, held: 1, casting: { attributes0 }, animation: 26, row: row(0x20), attacking: true });
  assert.equal(animationSheathState(casting(0x10000)), 0);
  assert.equal(animationSheathState(casting(0x50000)), undefined, "ATTR0 0x40000");
  assert.equal(animationSheathState(casting(undefined)), undefined, "no row for the spell: 0x004cfd20 finds none");
});

test("5.05 (11.11): branches 4-7 — the swing draws melee; 0x10 when idle sheathes; another unit follows the server", () => {
  assert.equal(animationSheathState({ ...base, attacking: true, animation: 17, row: row(0x20, 0x10) }), 1, "a combat behavior");
  assert.equal(animationSheathState({ ...base, attacking: true, animation: 60, row: row(0x10) }), 0, "an emote while swinging");
  assert.equal(animationSheathState({ ...base, attacking: true, animation: 60, row: row(0x10), keep: true }), 1, "kept: the swing");
  assert.equal(animationSheathState({ ...base, held: 1, animation: 69, row: row(0x10) }), 0, "EmoteDance");
  assert.equal(animationSheathState({ ...base, animation: 133, row: row(0x20) }), 1, "FishingCast draws the pole");
  assert.equal(animationSheathState({ ...base, held: 1, animation: 0, row: row(0) }), undefined, "Stand: nothing");
  assert.equal(animationSheathState({ ...base, held: 1, animation: 0, row: row(0), activePlayer: false, published: 0 }), 0,
    "another unit: the server's byte");
});

// ---- the wiring: the renderer's count → OwnAnimationSheath → WorldClient → CMSG_SET_SHEATHED ----

const SELF = 0x1234n;
const VICTIM = 0x5678n;

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  await world.loginCharacter(SELF);
  await settle();
  world.state.move(VICTIM, { flags: 0, position: { x: 12, y: 20, z: 30, orientation: 0 } });
  world.state.objects.get(VICTIM).typeId = 3;
  world.state.setField(VICTIM, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  world.selectTarget(VICTIM);
  connection.sent.length = 0;
  const sheaths = () => connection.sentOf(OPCODES.CMSG_SET_SHEATHED).map(({ payload }) => payload[0]);
  return { world, connection, sheaths };
}

const dataSkip = { skip: ANIMATION_WEAPON_FLAGS[50] === 4 ? false : "no generated AnimationData.Weaponflags in this checkout" };

test("5.05 (11.11): after a fight the next Loot or Mount start puts the weapon away; Stand does not; a count that did not move judges nothing", dataSkip, async () => {
  const { world, sheaths } = await client();
  const sheath = new OwnAnimationSheath();
  const own = { guid: SELF, animation: 0, starts: 3 };
  sheath.afterDraw(world, own); // the first draw: the count as it stands
  world.startAttack();
  world.stopAttack();
  assert.deepEqual(sheaths(), [1]);
  own.starts = 4; own.animation = 0; // Stand
  sheath.afterDraw(world, own);
  assert.deepEqual(sheaths(), [1], "Stand: Weaponflags 0");
  own.starts = 5; own.animation = 50; // Loot
  sheath.afterDraw(world, own);
  assert.deepEqual(sheaths(), [1, 0], "Loot (Weaponflags 0x4) puts the blade away");
  sheath.afterDraw(world, own);
  assert.deepEqual(sheaths(), [1, 0], "the same count: nothing");
  world.startAttack();
  own.starts = 6; own.animation = 91; // Mount
  sheath.afterDraw(world, own);
  assert.deepEqual(sheaths(), [1, 0, 1, 0], "Mount puts it away, the swing's request notwithstanding (branch 1)");
  world.close();
});

test("5.05 (11.11): swinging, a Ready1H start keeps the blade; casting Fireball puts it away, a DONT_AFFECT_SHEATH_STATE cast does not", dataSkip, async () => {
  const { world, sheaths } = await client();
  const sheath = new OwnAnimationSheath();
  const own = { guid: SELF, animation: 0, starts: 0 };
  sheath.afterDraw(world, own);
  world.startAttack();
  own.starts = 1; own.animation = 26; // Ready1H
  sheath.afterDraw(world, own);
  assert.deepEqual(sheaths(), [1]);
  world.stopAttack();
  const attributes = new Map([[133, [0x10000, 0, 0, 0, 0, 0, 0, 0]], [6673, [0x50000, 0, 0, 0, 0, 0, 0, 0]]]);
  setPetSpellAttributesSource((spellId) => attributes.get(spellId));
  try {
    world.casts.set(SELF, { spellId: 6673, castTime: 1000, channel: false, startedAt: 0 });
    own.starts = 2; own.animation = 0;
    sheath.afterDraw(world, own);
    assert.deepEqual(sheaths(), [1], "a DONT_AFFECT_SHEATH_STATE cast keeps the blade");
    world.casts.set(SELF, { spellId: 133, castTime: 3000, channel: false, startedAt: 0 });
    own.starts = 3;
    sheath.afterDraw(world, own);
    assert.deepEqual(sheaths(), [1, 0], "Fireball's cast bar puts it away");
  } finally {
    setPetSpellAttributesSource(undefined);
    world.casts.delete(SELF);
  }
  sheath.afterDraw(world, { guid: 0x9999n, animation: 50, starts: 9 });
  assert.deepEqual(sheaths(), [1, 0], "another guid's row is not the player's");
  world.close();
});
