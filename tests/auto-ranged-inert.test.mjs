import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { defaultSettings, settingBoolean } from "../dist/code/browser/ui/SettingsModel.js"; // L18 5.05

/*
 * L15-review (04.10, 5.05): the autoRangedCombat controller (world/AutoRangedCombat.ts) must leave the wire
 * exactly as before it wherever it does not run: no tick registered, no wanted shot, and the packets of the
 * swing, the hand-cast Auto Shot, Tab with the shot running and the attack button in the order the
 * pre-5.05-controller paths sent them (`#startAutoRepeat` now stops only the swing — the same packets
 * while the mode never runs).
 *
 * L18 5.05: the controller is wired now — EnterWorld hands the world client `settingOn("autoRangedCombat")`,
 * and the setting is on by default because Wow.exe registers the CVar with "1" (0x0051dbd3, pointer
 * 0x00bd091c; .runtime/re-2026-10-04/l15-combat/cvar.mjs). So the hook here is the settings model's, as
 * EnterWorld installs it: a hunter is inert with «Ближний/дальний бой» unchecked, and a wand user is inert
 * with the default — the wand's Shoot (5019) has no SPELL_ATTR4 0x01000000, so the book hands the
 * controller no spell (0x00542030 → 0x00be5d84 stays 0; MountSpells.ts) and 0x006d71e0 answers 0.
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
const A = 9n;
const B = 10n;
const AUTO_SHOT = 75;
const SHOOT = 5019;

/** L18 5.05: «Ближний/дальний бой» unchecked in the settings (the CVar "0"). */
const UNCHECKED = { ...defaultSettings(), autoRangedCombat: false };

async function hunter({ spells = [AUTO_SHOT], controllerSpells = [AUTO_SHOT], settings = UNCHECKED } = {}) { // L18 5.05: settings
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(SELF).typeId = 4;
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8);
  for (const [guid, x] of [[A, 20], [B, 25]]) {
    client.state.move(guid, { flags: 0, position: { x, y: 0, z: 0, orientation: 0 } });
    client.state.objects.get(guid).typeId = 3;
    client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  }
  client.canAttackUnit = (object) => object.guid === A || object.guid === B;
  client.knownSpells = spells.map((id, slot) => ({ id, slot }));
  client.setAutoRepeatSpellIds(spells);
  client.setAutoRangedCombatSpellIds(controllerSpells); // the book's SPELL_ATTR4 0x01000000 spell, as MountSpells hands it
  client.autoRangedLimits = () => ({ min: 8, max: 35 });
  // L18 5.05: the CVar hook EnterWorld installs, over this fixture's settings.
  client.autoRangedCombat = () => settingBoolean(settings, "autoRangedCombat");
  const timer = { started: 0 };
  client.autoRanged.schedule = { start: () => { timer.started++; return timer; }, stop: () => {} };
  await settle();
  connection.sent.length = 0;
  return { client, connection, timer };
}

const COMBAT = new Set([
  OPCODES.CMSG_ATTACK_SWING, OPCODES.CMSG_ATTACK_STOP, OPCODES.CMSG_SET_SHEATHED, OPCODES.CMSG_CAST_SPELL,
  OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL, OPCODES.CMSG_SET_SELECTION, OPCODES.CMSG_CANCEL_MOUNT_AURA,
]);
const combat = (connection) => connection.sent.filter(({ opcode }) => COMBAT.has(opcode)).map(({ opcode, payload }) =>
  (opcode === OPCODES.CMSG_SET_SHEATHED ? `SHEATH ${payload[0]}` : Object.keys(OPCODES).find((name) => OPCODES[name] === opcode)));

function assertInert(client, timer, label) {
  assert.equal(client.autoRanged.active, false, label);
  assert.equal(client.autoRanged.wantedSpellId, undefined, label);
  assert.equal(timer.started, 0, label);
}

test("L15-review: DEAD_TARGET, CANT_ATTACK and CANCEL_COMBAT send CMSG_ATTACK_STOP alone — no sheath", async () => {
  // Wow.exe 0x00756800 (0x148/0x149) and 0x006e2210 (SMSG_CANCEL_COMBAT) call StopAttack 0x006e1660, whose
  // only packet is 0x007559e0's CMSG_ATTACKSTOP (0x142) — no CMSG_SET_SHEATHED (.runtime/re-2026-10-01/
  // a4-world/d2.c, a9-combat/e3.c). The core sends CANCEL_COMBAT after its own AttackStop (Feign Death in a
  // dungeon, Unit::CombatStop): the weapon stays where it was, as before 5.05.
  for (const opcode of [OPCODES.SMSG_ATTACK_SWING_DEAD_TARGET, OPCODES.SMSG_ATTACK_SWING_CANT_ATTACK,
    OPCODES.SMSG_CANCEL_COMBAT]) {
    const { client, connection, timer } = await hunter();
    client.selectTarget(A);
    client.startAttack();
    connection.sent.length = 0;
    connection.push(opcode);
    await settle();
    assert.deepEqual(combat(connection), ["CMSG_ATTACK_STOP"], opcode.toString(16));
    assert.equal(client.attackRequested, false);
    assertInert(client, timer, opcode.toString(16));
    client.close();
  }
});

test("L18 5.05: the setting is on by default — Wow.exe's \"1\" — and the hunter's attack then runs the controller", async () => {
  assert.equal(settingBoolean(defaultSettings(), "autoRangedCombat"), true);
  const { client, timer } = await hunter({ settings: defaultSettings() });
  client.selectTarget(A);
  client.startAttack();
  assert.equal(client.autoRanged.active, true, "not inert: the mode runs");
  assert.equal(timer.started, 1);
  client.close();
});

for (const [who, options] of [["a hunter (Auto Shot), the setting unchecked", {}], ["a wand user (Shoot, no SPELL_ATTR4 bit), the default setting",
  { spells: [SHOOT], controllerSpells: [], settings: defaultSettings() }]]) { // L18 5.05: the wand user under the wired default
  const spell = options.spells?.[0] ?? AUTO_SHOT;
  test(`L15-review: ${who} — the right click's swing, then the shot by hand`, async () => {
    const { client, connection, timer } = await hunter(options);
    client.selectTarget(A);
    client.startAttack();
    assert.deepEqual(combat(connection), ["CMSG_SET_SELECTION", "SHEATH 1", "CMSG_ATTACK_SWING"]);
    connection.sent.length = 0;
    client.castSpell(spell);
    assert.deepEqual(combat(connection), ["CMSG_ATTACK_STOP", "SHEATH 0", "SHEATH 2", "CMSG_CAST_SPELL"],
      "the swing stops (as stopAttack did), the shot goes out");
    assert.equal(client.autoRepeatSpellId, spell);
    assertInert(client, timer, who);
    client.close();
  });

  test(`L15-review: ${who} — Tab with the shot running re-aims it, the attack button swaps it for the swing`, async () => {
    const { client, connection, timer } = await hunter(options);
    client.selectTarget(A);
    client.castSpell(spell);
    connection.sent.length = 0;
    client.selectTarget(B);
    assert.deepEqual(combat(connection), ["CMSG_SET_SELECTION", "SHEATH 2", "CMSG_CAST_SPELL"]);
    connection.sent.length = 0;
    client.castSpell(6603);
    assert.deepEqual(combat(connection), ["CMSG_CANCEL_AUTO_REPEAT_SPELL", "SHEATH 0", "SHEATH 1", "CMSG_ATTACK_SWING"]);
    connection.sent.length = 0;
    client.castSpell(6603);
    assert.deepEqual(combat(connection), ["CMSG_ATTACK_STOP", "SHEATH 0"], "the button again: the swing stops");
    assertInert(client, timer, who);
    client.close();
  });
}
