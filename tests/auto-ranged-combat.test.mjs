import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

/**
 * L15 5.05: the auto-attack leftovers, as Wow.exe 3.3.5a (12340) does them — Ghidra read-only,
 * .runtime/re-2026-10-04/l15-combat/g1.c, g2.c; earlier .runtime/re-2026-10-01/a4-world/d2.c-d4.c,
 * a9-combat/e2.c.
 * * The swing errors (0x00756800): NOT_IN_RANGE (0x145) and BAD_FACING (0x146) only latch an error for
 *   the UI (0x006cee70(1/2)); DEAD_TARGET (0x148) and CANT_ATTACK (0x149) call StopAttack 0x006e1660,
 *   which sends CMSG_ATTACK_STOP (0x007559e0) while a swing runs or is requested; SMSG_CANCEL_COMBAT
 *   (0x14e, 0x006e2210) calls the same.
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
const FRIEND = 11n;

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(SELF).typeId = 4;
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8);
  for (const guid of [A, FRIEND]) {
    client.state.move(guid, { flags: 0, position: { x: 2, y: 0, z: 0, orientation: 0 } });
    client.state.objects.get(guid).typeId = 3;
    client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  }
  client.canAttackUnit = (object) => object.guid !== FRIEND && object.guid !== SELF && client.state.objects.get(object.guid)
    ?.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset) > 0;
  return { client, connection };
}

const attackStart = (attacker, victim) => new PacketWriter().u64(attacker).u64(victim).toUint8Array();
const opcodes = (connection) => connection.sent.map(({ opcode }) => opcode);

test("L15 5.05: DEAD_TARGET and CANT_ATTACK stop the swing on the wire (0x00756800 → 0x006e1660)", async () => {
  for (const opcode of [OPCODES.SMSG_ATTACK_SWING_DEAD_TARGET, OPCODES.SMSG_ATTACK_SWING_CANT_ATTACK,
    OPCODES.SMSG_CANCEL_COMBAT]) {
    for (const answered of [true, false]) {
      const { client, connection } = await loggedIn();
      client.selectTarget(A);
      client.startAttack();
      if (answered) {
        connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
        await settle();
      }
      connection.sent.length = 0;
      connection.push(opcode);
      await settle();
      const label = `${opcode.toString(16)} ${answered ? "after ATTACK_START" : "on the request"}`;
      assert.deepEqual(opcodes(connection).filter((sent) => sent === OPCODES.CMSG_ATTACK_STOP), [OPCODES.CMSG_ATTACK_STOP], label);
      assert.equal(client.attacking, false, label);
      assert.equal(client.attackRequested, false, label);
      assert.equal(client.attackVictim, undefined, label);
      client.close();
    }
  }
});

test("L15 5.05: with no swing running those packets send nothing (0x006e1660 checks +0xa20/+0xa28)", async () => {
  for (const opcode of [OPCODES.SMSG_ATTACK_SWING_DEAD_TARGET, OPCODES.SMSG_ATTACK_SWING_CANT_ATTACK,
    OPCODES.SMSG_CANCEL_COMBAT]) {
    const { client, connection } = await loggedIn();
    client.selectTarget(A);
    connection.sent.length = 0;
    connection.push(opcode);
    await settle();
    // The first packet the session handles also announces the active mover; nothing of the swing's.
    assert.deepEqual(opcodes(connection).filter((sent) => sent !== OPCODES.CMSG_SET_ACTIVE_MOVER), [], opcode.toString(16));
    client.close();
  }
});

test("L15 5.05: NOT_IN_RANGE and BAD_FACING leave the swing running (0x006cee70 only)", async () => {
  for (const opcode of [OPCODES.SMSG_ATTACK_SWING_NOT_IN_RANGE, OPCODES.SMSG_ATTACK_SWING_BAD_FACING]) {
    const { client, connection } = await loggedIn();
    client.selectTarget(A);
    client.startAttack();
    connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
    await settle();
    connection.sent.length = 0;
    connection.push(opcode);
    await settle();
    assert.equal(opcodes(connection).includes(OPCODES.CMSG_ATTACK_STOP), false, opcode.toString(16));
    assert.equal(client.attacking, true, opcode.toString(16));
    client.close();
  }
});

// ---- the autoRangedCombat controller (world/AutoRangedCombat.ts) ---------------------------------
//
// Wow.exe: StartAttack 0x006e4950 registers 0x006e2be0 when the CVar autoRangedCombat (0x00bd091c, "1")
// is on and the book holds the SPELL_ATTR4 0x01000000 spell (0x00be5d84 — Auto Shot); the controller
// swings in melee reach (0x0071b820) and otherwise shoots when facing, still and in range; StopAttack
// 0x006e1660 drops it and cancels the shot it wanted.

const AUTO_SHOT = 75;
const B = 10n;

/** Auto Shot's SpellRange for the test: 5 + the melee reach inside, 35 out. */
const LIMITS = { min: 8, max: 35 };

async function hunter({ cvar = true } = {}) {
  const { client, connection } = await loggedIn();
  client.state.move(B, { flags: 0, position: { x: 2, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(B).typeId = 3;
  client.state.setField(B, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.knownSpells = [{ id: AUTO_SHOT, slot: 0 }];
  client.setAutoRepeatSpellIds([AUTO_SHOT]);
  client.setAutoRangedCombatSpellIds([AUTO_SHOT]);
  client.autoRangedCombat = () => cvar;
  client.autoRangedLimits = () => LIMITS;
  const timer = { started: 0, stopped: 0 };
  client.autoRanged.schedule = { start: () => { timer.started++; return timer; }, stop: () => { timer.stopped++; } };
  await settle();
  connection.sent.length = 0;
  return { client, connection, timer };
}

const place = (client, guid, x, y = 0) => { client.state.objects.get(guid).position = { x, y, z: 0, orientation: 0 }; };
const casts = (connection) => connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL)
  .map(({ payload }) => {
    const view = new DataView(payload.buffer, payload.byteOffset);
    return { spellId: view.getUint32(1, true), target: payload.slice(10) };
  });
const unitTarget = (guid) => new PacketWriter().packedGuid(guid).toUint8Array();
const swings = (connection) => connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_ATTACK_SWING).length;
const count = (connection, opcode) => connection.sent.filter((sent) => sent.opcode === opcode).length;

test("L15 5.05: with autoRangedCombat off the attack is the swing it was", async () => {
  const { client, connection, timer } = await hunter({ cvar: false });
  place(client, A, 20);
  client.selectTarget(A);
  client.startAttack();
  assert.equal(swings(connection), 1);
  assert.deepEqual(casts(connection), []);
  assert.equal(client.autoRanged.active, false);
  assert.equal(timer.started, 0);
  client.close();
});

test("L15 5.05: an attack at range shoots, one in melee reach swings (0x006e4950 → 0x006e2be0)", async () => {
  {
    const { client, connection, timer } = await hunter();
    place(client, A, 20);
    client.selectTarget(A);
    client.startAttack();
    assert.equal(swings(connection), 0, "no swing from StartAttack itself");
    assert.deepEqual(casts(connection), [{ spellId: AUTO_SHOT, target: unitTarget(A) }], "the first tick shoots");
    assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
    assert.equal(client.autoRanged.active, true);
    assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT);
    assert.equal(timer.started, 1, "registered once");
    client.startAttack();
    assert.equal(timer.started, 1, "a second StartAttack keeps the one registration");
    client.close();
    assert.equal(timer.stopped, 1, "the session's end unregisters it");
  }
  {
    const { client, connection } = await hunter();
    place(client, A, 2);
    client.selectTarget(A);
    client.startAttack();
    assert.equal(swings(connection), 1, "within max(5, reaches + 4/3): the swing");
    assert.deepEqual(casts(connection), []);
    assert.equal(client.autoRanged.active, true, "the mode stays to follow the distance");
    client.close();
  }
});

test("L15 5.05: the controller follows the distance — melee in reach, the shot out of it", async () => {
  const { client, connection } = await hunter();
  place(client, A, 20);
  client.selectTarget(A);
  client.startAttack();
  connection.sent.length = 0;
  place(client, A, 3);
  client.autoRanged.tick();
  assert.equal(count(connection, OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), 1, "0x006e2610 cancels the repeat");
  assert.equal(swings(connection), 1);
  assert.equal(client.autoRepeatSpellId, undefined);
  assert.equal(client.autoRanged.wantedSpellId, undefined, "0x006e2610 clears the wanted spell");
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  connection.sent.length = 0;
  client.autoRanged.tick();
  assert.deepEqual(connection.sent, [], "a running swing in reach: nothing to do");
  // Into the dead zone (≤ min) the swing goes on.
  place(client, A, 7);
  client.autoRanged.tick();
  assert.deepEqual(connection.sent, [], "inside the minimum range a swing is kept");
  // Out past it: the swing stops (the mode stays) and the shot goes.
  place(client, A, 15);
  client.autoRanged.tick();
  assert.equal(count(connection, OPCODES.CMSG_ATTACK_STOP), 1, "0x006d5f70");
  assert.deepEqual(casts(connection), [{ spellId: AUTO_SHOT, target: unitTarget(A) }]);
  assert.equal(client.autoRanged.active, true);
  // While the repeat runs the controller leaves it alone.
  connection.sent.length = 0;
  client.autoRanged.tick();
  assert.deepEqual(connection.sent, []);
  client.close();
});

test("L15 5.05: out of reach the swing stops even when no shot can go (0x006d5f70 comes first)", async () => {
  const { client, connection } = await hunter();
  place(client, A, 2);
  client.selectTarget(A);
  client.startAttack();
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  connection.sent.length = 0;
  place(client, A, -15); // behind the player: no shot
  client.autoRanged.tick();
  assert.equal(count(connection, OPCODES.CMSG_ATTACK_STOP), 1);
  assert.deepEqual(casts(connection), []);
  assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT);
  assert.equal(client.autoRanged.active, true);
  client.close();
});

test("L15 5.05: melee reach is 0x0071b820's — max(5, both combat reaches + 4/3), strictly inside", async () => {
  const reach = (value) => new Uint32Array(new Float32Array([value]).buffer)[0];
  for (const [variant, x, combatReach, melee] of [
    ["at 5 yards exactly", 5, 0, false], ["just inside 5", 4.99, 0, true],
    ["big reaches: 3 + 3 + 4/3", 7.2, 3, true], ["past them", 7.4, 3, false],
  ]) {
    const { client, connection } = await hunter();
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset, reach(combatReach));
    client.state.setField(A, UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset, reach(combatReach));
    place(client, A, x);
    client.selectTarget(A);
    client.startAttack();
    assert.equal(swings(connection), melee ? 1 : 0, variant);
    client.close();
  }
});

test("L15 5.05: the CVar off mid-fight drops the wanted shot; a dead unit in reach is left in silence", async () => {
  {
    const { client } = await hunter();
    place(client, A, 20);
    client.selectTarget(A);
    client.startAttack();
    client.autoRangedCombat = () => false;
    client.autoRanged.tick();
    assert.equal(client.autoRanged.wantedSpellId, undefined, "0x006e2be0: 0x007fe140(0)");
    assert.equal(client.autoRanged.active, true, "the mode itself stays");
    client.close();
  }
  {
    const { client, connection } = await hunter();
    place(client, A, 20);
    client.selectTarget(A);
    client.startAttack();
    client.stopAttack = () => assert.fail("not this way");
    const said = [];
    client.onCombatStatus = (message, _attacking, error) => { if (error) said.push(message); };
    client.state.setField(A, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    place(client, A, 2);
    connection.sent.length = 0;
    client.autoRanged.tick();
    assert.equal(swings(connection), 0, "0x006e2610 refuses it without a word");
    assert.deepEqual(said, []);
    client.close();
  }
});

test("L15 5.05: no shot facing away, walking or turning, or out of range — but strafing shoots", async () => {
  for (const [variant, setup, shoots] of [
    ["behind", (client) => place(client, A, -20), false],
    ["forward", (client) => { client.state.objects.get(SELF).movementFlags = 0x1; }, false],
    ["backward", (client) => { client.state.objects.get(SELF).movementFlags = 0x2; }, false],
    ["turning", (client) => { client.state.objects.get(SELF).movementFlags = 0x10; }, false],
    ["strafing", (client) => { client.state.objects.get(SELF).movementFlags = 0x4; }, true],
    ["out of range", (client) => place(client, A, 40), false],
  ]) {
    const { client, connection } = await hunter();
    place(client, A, 20);
    setup(client);
    client.selectTarget(A);
    client.startAttack();
    assert.equal(casts(connection).length, shoots ? 1 : 0, variant);
    assert.equal(swings(connection), 0, variant);
    assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT, `${variant}: wanted all the same (START_AUTOREPEAT_SPELL)`);
    client.close();
  }
});

test("L15 5.05: StopAttack ends the mode and cancels the shot it wanted, not one shot by hand", async () => {
  {
    const { client, connection, timer } = await hunter();
    place(client, A, 20);
    client.selectTarget(A);
    client.startAttack();
    connection.sent.length = 0;
    client.stopAttack();
    assert.equal(client.autoRanged.active, false);
    assert.equal(client.autoRanged.wantedSpellId, undefined);
    assert.equal(count(connection, OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), 1, "0x00807560(1): it was the wanted shot");
    assert.equal(client.autoRepeatSpellId, undefined);
    assert.equal(timer.stopped, 1);
    client.close();
  }
  {
    // Shot by hand with the CVar on: the mode is entered (0x0080cce0 → 0x0072c2b0), nothing is wanted.
    const { client, connection } = await hunter();
    place(client, A, 20);
    client.selectTarget(A);
    client.castSpell(AUTO_SHOT);
    assert.equal(casts(connection).length, 1, "one cast, not a second from the controller");
    assert.equal(client.autoRanged.active, true);
    assert.equal(client.autoRanged.wantedSpellId, undefined);
    connection.sent.length = 0;
    client.stopAttack();
    assert.equal(count(connection, OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), 0, "a hand-cast repeat runs on");
    assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
    assert.equal(client.autoRanged.active, false);
    client.close();
  }
});

test("L15 5.05: a hand-cast shot in the mode meets a target that walks into reach with the swing", async () => {
  const { client, connection } = await hunter();
  place(client, A, 20);
  client.selectTarget(A);
  client.castSpell(AUTO_SHOT);
  connection.sent.length = 0;
  place(client, A, 2);
  client.autoRanged.tick();
  assert.equal(count(connection, OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), 1);
  assert.equal(swings(connection), 1);
  client.close();
});

test("L15 5.05: the attack toggle and an unattackable unit end the mode", async () => {
  {
    const { client, connection } = await hunter();
    place(client, A, 20);
    client.selectTarget(A);
    client.castSpell(6603);
    assert.equal(client.autoRanged.active, true, "6603 starts the mode");
    connection.sent.length = 0;
    client.castSpell(6603);
    assert.equal(client.autoRanged.active, false, "0x0072c2b0: bit 2 set — the toggle stops it");
    assert.equal(swings(connection), 0);
    client.close();
  }
  {
    const { client, connection, timer } = await hunter();
    place(client, FRIEND, 20);
    client.selectTarget(FRIEND);
    client.startAttack();
    assert.deepEqual(connection.sent.filter(({ opcode }) => opcode !== OPCODES.CMSG_SET_SELECTION), [], "CanAttack refuses: nothing");
    assert.equal(client.autoRanged.active, false);
    assert.equal(timer.started, 0);
    client.close();
  }
  {
    // The target dies while the mode runs: the repeat ends with it, and the next tick stops the mode.
    const { client } = await hunter();
    place(client, A, 20);
    client.selectTarget(A);
    client.startAttack();
    client.state.setField(A, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    client.autoRepeatSpellId = undefined;
    client.autoRanged.tick();
    assert.equal(client.autoRanged.active, false);
    client.close();
  }
});

test("L15 5.05: the selection leaving the world ends the mode (0x5241b0 → 0x6e1660)", async () => {
  const { client, connection, timer } = await hunter();
  place(client, A, 20);
  client.selectTarget(A);
  client.startAttack();
  client.state.objects.delete(A);
  connection.push(OPCODES.SMSG_AI_REACTION, new PacketWriter().u64(0x9abcn).u32(0).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, undefined);
  assert.equal(client.autoRanged.active, false);
  assert.equal(timer.stopped, 1);
  // A new selection afterwards is not attacked: the mode is over.
  place(client, B, 20);
  connection.sent.length = 0;
  client.selectTarget(B);
  assert.deepEqual(casts(connection), []);
  client.close();
});

test("L15 5.05: a target change carries the mode, and the wanted shot is aimed anew", async () => {
  const { client, connection } = await hunter();
  place(client, A, 20);
  place(client, B, 25);
  client.selectTarget(A);
  client.startAttack();
  connection.sent.length = 0;
  client.selectTarget(B);
  assert.equal(count(connection, OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), 1, "0x005241b0 → 0x006e1660 cancels the wanted shot");
  assert.deepEqual(casts(connection), [{ spellId: AUTO_SHOT, target: unitTarget(B) }], "0x006e4950 again: the shot at B");
  assert.equal(client.autoRanged.active, true);
  // With stopAutoAttackOnTargetChange the mode ends instead.
  client.stopAutoAttackOnTargetChange = () => true;
  connection.sent.length = 0;
  client.selectTarget(A);
  assert.equal(client.autoRanged.active, false);
  assert.deepEqual(casts(connection), []);
  client.close();
});

test("L15 5.05: mounted, the shot's range is the dismount's (0x006e4950)", async () => {
  for (const [variant, x, dismounts] of [["in range", 20, 1], ["too far", 50, 0]]) {
    const { client, connection } = await hunter();
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 14_000);
    place(client, A, x);
    const said = [];
    client.onCombatStatus = (message, _attacking, error) => { if (error) said.push(message); };
    client.selectTarget(A);
    connection.sent.length = 0;
    client.startAttack();
    assert.equal(count(connection, OPCODES.CMSG_CANCEL_MOUNT_AURA), dismounts, variant);
    assert.equal(said.length, dismounts === 1 ? 0 : 1, variant);
    client.close();
  }
});
