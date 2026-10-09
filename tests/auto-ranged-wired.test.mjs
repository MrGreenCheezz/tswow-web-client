import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { SETTING_DEFINITIONS, defaultSettings, settingBoolean } from "../dist/code/browser/ui/SettingsModel.js";
import { createFrameXmlSettingsCVar } from "../dist/code/browser/framexml/FrameXmlSettingsCVar.js";
import { FRAMEXML_OPTIONS_UNAVAILABLE } from "../dist/code/browser/framexml/FrameXmlOptions.js";

/*
 * L18 5.05 (04.10): the autoRangedCombat controller (world/AutoRangedCombat.ts) wired to its CVar.
 *
 * Wow.exe 3.3.5a 12340 registers the CVar autoRangedCombat with "1" (0x0051dbd3, pointer 0x00bd091c;
 * .runtime/re-2026-10-04/l15-combat/cvar.mjs) and the stock Combat panel draws it as «Ближний/дальний бой»
 * (InterfaceOptionsPanels.xml, InterfaceOptionsCombatPanelAutoRange; CombatPanelOptions.autoRangedCombat).
 * The browser keeps it as the setting `autoRangedCombat` (on by default), the stock CVar row reads and
 * writes that setting, and EnterWorld hands the world client `() => settingOn("autoRangedCombat")`.
 *
 * StopAttack 0x006e1660 sends CMSG_ATTACKSTOP (0x007559e0) and, for a wanted shot that is repeating,
 * 0x00807560(1): CMSG_CANCEL_AUTO_REPEAT_SPELL (0x26d), a local flag (0x00715ac0(0): +0xa38 &= ~0x200) and
 * an animation reset (0x0072afe0) — no CMSG_SET_SHEATHED anywhere on the way
 * (.runtime/re-2026-10-01/a4-world/d2.c, a9-combat/e2.c; .runtime/re-2026-10-04/l18-wiring/h1.c).
 */

// ---- the setting, the stock CVar row, the stock checkbox, the hook -------------------------------

test("L18 5.05: the setting autoRangedCombat is on by default, in «Игра», as Wow.exe's CVar \"1\"", () => {
  const definition = SETTING_DEFINITIONS.find(({ id }) => id === "autoRangedCombat");
  assert.ok(definition, "the setting exists");
  assert.equal(definition.kind, "boolean");
  assert.equal(definition.group, "Игра");
  assert.equal(definition.fallback, true, "0x0051dbd3 registers it with \"1\"");
  assert.equal(definition.ownWindow, undefined, "drawn by the settings window too");
  assert.equal(settingBoolean(defaultSettings(), "autoRangedCombat"), true);
  assert.equal(settingBoolean({ ...defaultSettings(), autoRangedCombat: false }, "autoRangedCombat"), false);
  // Next to the other stock Combat-panel switch.
  const ids = SETTING_DEFINITIONS.map(({ id }) => id);
  assert.equal(ids.indexOf("autoRangedCombat"), ids.indexOf("stopAutoAttackOnTargetChange") + 1);
});

test("L18 5.05: GetCVar/SetCVar(\"autoRangedCombat\") read and write the setting; the default is \"1\"", () => {
  let values = defaultSettings();
  const writes = [];
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { writes.push([id, value]); values = { ...values, [id]: value }; },
  });
  assert.equal(cvars.get("autoRangedCombat"), "1");
  assert.equal(cvars.getDefault("autoRangedCombat"), "1");
  assert.equal(cvars.range("autoRangedCombat"), undefined, "a switch");
  assert.equal(cvars.set("AUTORANGEDCOMBAT", "0"), true, "CVar names are case-insensitive");
  assert.deepEqual(writes, [["autoRangedCombat", false]]);
  assert.equal(cvars.get("autoRangedCombat"), "0");
  cvars.set("autoRangedCombat", "1");
  assert.equal(values.autoRangedCombat, true);
});

test("L18 5.05: the stock Combat panel's «Ближний/дальний бой» and STOP_AUTO_ATTACK checkboxes are usable", () => {
  // Both CVars have a setting behind them now (stopAutoAttackOnTargetChange since 01.10): greying them
  // with «не поддерживает» was wrong for either.
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.has("InterfaceOptionsCombatPanelAutoRange"), false);
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.has("InterfaceOptionsCombatPanelStopAutoAttack"), false);
  // DEC-review 3.11: AttackOnAssist has the assistAttack setting since DEC-A (04.10) and is usable too
  // (was: «still has no setting: it stays greyed», `true`).
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.has("InterfaceOptionsCombatPanelAttackOnAssist"), false);
});

test("L18 5.05: EnterWorld hands the world client the setting as the CVar hook", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(source, /world\.autoRangedCombat = \(\) => settingOn\("autoRangedCombat"\);/);
});

// ---- the controller under the wired default, end to end through WorldClient ---------------------

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
/** Auto Shot's range for the fixture: the dead zone inside 8 yards, 35 out. */
const LIMITS = { min: 8, max: 35 };

/** A hunter whose CVar hook is the settings model's, exactly as EnterWorld installs it. */
async function hunter(settings = defaultSettings()) {
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
  const refused = new Set();
  client.canAttackUnit = (object) => !refused.has(object.guid) && (object.guid === A || object.guid === B)
    && client.state.objects.get(object.guid)?.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset) > 0;
  client.knownSpells = [{ id: AUTO_SHOT, slot: 0 }];
  client.setAutoRepeatSpellIds([AUTO_SHOT]);
  client.setAutoRangedCombatSpellIds([AUTO_SHOT]);
  client.autoRangedLimits = () => LIMITS;
  client.autoRangedCombat = () => settingBoolean(settings, "autoRangedCombat");
  const timer = { started: 0, stopped: 0 };
  client.autoRanged.schedule = { start: () => { timer.started++; return timer; }, stop: () => { timer.stopped++; } };
  await settle();
  connection.sent.length = 0;
  return { client, connection, timer, refused };
}

const COMBAT = new Set([
  OPCODES.CMSG_ATTACK_SWING, OPCODES.CMSG_ATTACK_STOP, OPCODES.CMSG_SET_SHEATHED, OPCODES.CMSG_CAST_SPELL,
  OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL, OPCODES.CMSG_SET_SELECTION, OPCODES.CMSG_CANCEL_MOUNT_AURA,
]);
const combat = (connection) => connection.sent.filter(({ opcode }) => COMBAT.has(opcode)).map(({ opcode, payload }) =>
  (opcode === OPCODES.CMSG_SET_SHEATHED ? `SHEATH ${payload[0]}` : Object.keys(OPCODES).find((name) => OPCODES[name] === opcode)));
const place = (client, guid, x) => { client.state.objects.get(guid).position = { x, y: 0, z: 0, orientation: 0 }; };
const castTargets = (connection) => connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL)
  .map(({ payload }) => new DataView(payload.buffer, payload.byteOffset).getUint32(1, true));
const attackStart = (attacker, victim) => new PacketWriter().u64(attacker).u64(victim).toUint8Array();

test("L18 5.05: the wired default — at range the attack shoots, in reach it swings, out again it shoots", async () => {
  const { client, connection, timer } = await hunter();
  client.selectTarget(A);
  connection.sent.length = 0;
  client.startAttack(); // the right click on an enemy, the attack button, /startattack
  assert.deepEqual(combat(connection), ["SHEATH 2", "CMSG_CAST_SPELL"], "no swing from StartAttack: the first tick shoots");
  assert.equal(client.autoRanged.active, true);
  assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT);
  assert.equal(timer.started, 1);
  // The target walks into melee reach: the swing (0x006e2610) cancels the repeat.
  connection.sent.length = 0;
  place(client, A, 3);
  client.autoRanged.tick();
  assert.deepEqual(combat(connection).filter((name) => !name.startsWith("SHEATH")), ["CMSG_CANCEL_AUTO_REPEAT_SPELL", "CMSG_ATTACK_SWING"]);
  assert.equal(client.autoRepeatSpellId, undefined);
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  // And out past the dead zone: the swing stops (0x006d5f70, no sheath), the shot goes.
  connection.sent.length = 0;
  place(client, A, 15);
  client.autoRanged.tick();
  assert.deepEqual(combat(connection), ["CMSG_ATTACK_STOP", "SHEATH 2", "CMSG_CAST_SPELL"]);
  assert.equal(client.autoRanged.active, true);
  client.close();
});

test("L18 5.05: unchecked in the settings, the attack is the plain swing", async () => {
  const { client, connection, timer } = await hunter({ ...defaultSettings(), autoRangedCombat: false });
  client.selectTarget(A);
  connection.sent.length = 0;
  client.startAttack();
  assert.deepEqual(combat(connection), ["SHEATH 1", "CMSG_ATTACK_SWING"]);
  assert.equal(client.autoRanged.active, false);
  assert.equal(timer.started, 0);
  client.close();
});

test("L18 5.05: running holds the shot (movement flags 0x33), standing still lets it go", async () => {
  const { client, connection } = await hunter();
  client.state.objects.get(SELF).movementFlags = 0x1; // running forward
  client.selectTarget(A);
  client.startAttack();
  assert.deepEqual(castTargets(connection), [], "no shot on the run");
  assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT, "the shot is wanted all the same");
  client.state.objects.get(SELF).movementFlags = 0;
  client.autoRanged.tick();
  assert.deepEqual(castTargets(connection), [AUTO_SHOT], "stopped: the shot");
  client.close();
});

test("L18 5.05: the controller's StopAttack sends CMSG_ATTACK_STOP alone — no CMSG_SET_SHEATHED (0x006e1660)", async () => {
  {
    // A swing out of reach at a unit CanAttack now refuses: 0x006e2be0 → 0x006e1660.
    const { client, connection, timer, refused } = await hunter();
    place(client, A, 3);
    client.selectTarget(A);
    client.startAttack();
    connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
    await settle();
    connection.sent.length = 0;
    place(client, A, 15);
    refused.add(A);
    client.autoRanged.tick();
    assert.deepEqual(combat(connection), ["CMSG_ATTACK_STOP"]);
    assert.equal(client.autoRanged.active, false);
    assert.equal(timer.stopped, 1);
    client.close();
  }
  {
    // The target dies out of reach while the swing still runs.
    const { client, connection } = await hunter();
    place(client, A, 3);
    client.selectTarget(A);
    client.startAttack();
    connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
    await settle();
    place(client, A, 15);
    client.state.setField(A, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    connection.sent.length = 0;
    client.autoRanged.tick();
    assert.deepEqual(combat(connection), ["CMSG_ATTACK_STOP"]);
    assert.equal(client.autoRanged.active, false);
    client.close();
  }
  {
    // StopAttack with the wanted shot repeating: 0x00807560(1) cancels it — CMSG_CANCEL_AUTO_REPEAT_SPELL alone.
    const { client, connection, refused } = await hunter();
    client.selectTarget(A);
    client.startAttack();
    assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
    connection.sent.length = 0;
    refused.add(A);
    client.autoRanged.begin(client.state.objects.get(A)); // 0x006e4950 at a unit CanAttack refuses
    assert.deepEqual(combat(connection), ["CMSG_CANCEL_AUTO_REPEAT_SPELL"]);
    assert.equal(client.autoRanged.active, false);
    assert.equal(client.autoRepeatSpellId, undefined);
    client.close();
  }
});

test("L18 5.05: Tab while the mode shoots cancels the wanted shot and aims it at the new unit — no sheath in between", async () => {
  const { client, connection } = await hunter();
  client.selectTarget(A);
  client.startAttack();
  connection.sent.length = 0;
  client.selectTarget(B);
  assert.deepEqual(combat(connection), ["CMSG_CANCEL_AUTO_REPEAT_SPELL", "CMSG_SET_SELECTION", "SHEATH 2", "CMSG_CAST_SPELL"]);
  assert.equal(client.autoRanged.active, true);
  assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT);
  client.close();
});

test("L18 5.05: a hand-cast Auto Shot enters the mode; the target walking into reach meets the swing", async () => {
  const { client, connection } = await hunter();
  client.selectTarget(A);
  connection.sent.length = 0;
  client.castSpell(AUTO_SHOT);
  assert.deepEqual(castTargets(connection), [AUTO_SHOT], "one cast, not a second from the controller");
  assert.equal(client.autoRanged.active, true);
  assert.equal(client.autoRanged.wantedSpellId, undefined, "nothing is wanted: the hand-cast shot repeats");
  connection.sent.length = 0;
  place(client, A, 2);
  client.autoRanged.tick();
  assert.deepEqual(combat(connection).filter((name) => !name.startsWith("SHEATH")), ["CMSG_CANCEL_AUTO_REPEAT_SPELL", "CMSG_ATTACK_SWING"]);
  client.close();
});
