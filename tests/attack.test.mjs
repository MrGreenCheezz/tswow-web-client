import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  HITINFO_BLOCK, HITINFO_CRITICAL, HITINFO_FULL_ABSORB, HITINFO_MISS, HITINFO_PARTIAL_RESIST,
  SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED,
  VICTIMSTATE_DODGE, VICTIMSTATE_HIT,
  buildSetSheathed, facingTarget, parseAttackerStateUpdate, parseEnvironmentalDamage,
  parseExperienceGain, withinMeleeRange,
} from "../dist/code/world/CombatProtocol.js";

/**
 * Builds SMSG_ATTACKERSTATEUPDATE exactly as Unit::SendAttackStateUpdate does: the sub-damage
 * triples in one loop, then absorb in a second loop and resist in a third, each present or absent
 * as a whole block.
 */
function attackerStateUpdate({ hitInfo = 0, attacker = 7n, victim = 9n, damages = [], victimState = VICTIMSTATE_HIT, blocked = 0 }) {
  const total = damages.reduce((sum, entry) => sum + entry.damage, 0);
  const writer = new PacketWriter()
    .u32(hitInfo)
    .packedGuid(attacker)
    .packedGuid(victim)
    .u32(total)
    .u32(0)
    .u8(damages.length);
  for (const entry of damages) writer.u32(entry.schoolMask).f32(entry.damage).u32(entry.damage);
  if ((hitInfo & (HITINFO_FULL_ABSORB | 0x40)) !== 0) for (const entry of damages) writer.u32(entry.absorbed ?? 0);
  if ((hitInfo & (0x80 | HITINFO_PARTIAL_RESIST)) !== 0) for (const entry of damages) writer.u32(entry.resisted ?? 0);
  writer.u8(victimState).u32(0).u32(0);
  if ((hitInfo & HITINFO_BLOCK) !== 0) writer.u32(blocked);
  return writer.toUint8Array();
}

test("a plain swing carries its attacker, victim and damage", () => {
  const swing = parseAttackerStateUpdate(attackerStateUpdate({
    attacker: 0x1234n, victim: 0xabcdn, damages: [{ schoolMask: 1, damage: 132 }],
  }));
  assert.equal(swing.attacker, 0x1234n);
  assert.equal(swing.victim, 0xabcdn);
  assert.equal(swing.damage, 132);
  assert.equal(swing.victimState, VICTIMSTATE_HIT);
  assert.deepEqual(swing.damages, [{ schoolMask: 1, damage: 132, absorbed: 0, resisted: 0 }]);
});

test("a two-school swing reads both, and the loops are not interleaved", () => {
  // The absorb and resist arrays are separate loops over the same count, not fields of a struct.
  // Reading them as one interleaved record works by accident on a single school and falls apart
  // here, which is the whole reason this shape is pinned.
  const swing = parseAttackerStateUpdate(attackerStateUpdate({
    hitInfo: HITINFO_FULL_ABSORB | HITINFO_PARTIAL_RESIST,
    damages: [
      { schoolMask: 0x01, damage: 100, absorbed: 10, resisted: 1 },
      { schoolMask: 0x04, damage: 40, absorbed: 4, resisted: 2 },
    ],
  }));
  assert.equal(swing.damage, 140, "the headline number is both schools together");
  assert.deepEqual(swing.damages, [
    { schoolMask: 0x01, damage: 100, absorbed: 10, resisted: 1 },
    { schoolMask: 0x04, damage: 40, absorbed: 4, resisted: 2 },
  ]);
});

test("a blocked crit reads its block amount, which only exists when the flag is set", () => {
  const swing = parseAttackerStateUpdate(attackerStateUpdate({
    hitInfo: HITINFO_BLOCK | HITINFO_CRITICAL,
    damages: [{ schoolMask: 1, damage: 200 }],
    blocked: 55,
  }));
  assert.equal(swing.blocked, 55);
  assert.ok((swing.hitInfo & HITINFO_CRITICAL) !== 0);

  // Without the flag the field is simply not there, and reading it anyway would run off the end.
  const plain = parseAttackerStateUpdate(attackerStateUpdate({ damages: [{ schoolMask: 1, damage: 200 }] }));
  assert.equal(plain.blocked, 0);
});

test("a miss and a dodge are told apart", () => {
  const miss = parseAttackerStateUpdate(attackerStateUpdate({
    hitInfo: HITINFO_MISS, damages: [{ schoolMask: 1, damage: 0 }], victimState: 0,
  }));
  assert.equal(miss.damage, 0);
  assert.ok((miss.hitInfo & HITINFO_MISS) !== 0);

  const dodge = parseAttackerStateUpdate(attackerStateUpdate({
    damages: [{ schoolMask: 1, damage: 0 }], victimState: VICTIMSTATE_DODGE,
  }));
  assert.equal(dodge.victimState, VICTIMSTATE_DODGE);
  assert.equal(dodge.hitInfo & HITINFO_MISS, 0, "a dodge is not a miss");
});

test("a swing that claims an impossible number of schools is rejected", () => {
  const writer = new PacketWriter().u32(0).packedGuid(1n).packedGuid(2n).u32(5).u32(0).u8(7);
  assert.throws(() => parseAttackerStateUpdate(writer.toUint8Array()), /damage schools/);
});

test("sheathing sends one of the three states the server accepts", () => {
  assert.deepEqual([...buildSetSheathed(SHEATH_MELEE)], [1, 0, 0, 0]);
  assert.deepEqual([...buildSetSheathed(SHEATH_RANGED)], [2, 0, 0, 0]);
  assert.deepEqual([...buildSetSheathed(SHEATH_UNARMED)], [0, 0, 0, 0]);
  // Anything else is dropped by the server without a word, so it never goes out.
  assert.deepEqual([...buildSetSheathed(9)], [0, 0, 0, 0]);
});

test("experience is variable length, and the type byte says which shape it is", () => {
  const kill = new PacketWriter().u64(0x55n).u32(340).u8(0).u32(300).f32(1).u8(0).toUint8Array();
  assert.deepEqual(parseExperienceGain(kill), { victim: 0x55n, total: 340, base: 300, restedBonus: false });

  const quest = new PacketWriter().u64(0n).u32(1200).u8(1).u8(1).toUint8Array();
  assert.deepEqual(parseExperienceGain(quest), { victim: 0n, total: 1200, base: 1200, restedBonus: true });
});

test("environmental damage reads in the writer's order, not the header's", () => {
  const packet = new PacketWriter().u64(3n).u8(1).u32(90).u32(5).u32(10).toUint8Array();
  assert.deepEqual(parseEnvironmentalDamage(packet), {
    victim: 3n, type: 1, damage: 90, resisted: 5, absorbed: 10,
  });
});

test("melee reach and the swing arc are computed rather than waited for", () => {
  // Both reaches plus 4/3, floored at five yards. Two small creatures still reach five.
  assert.equal(withinMeleeRange(0.5, 0.5, 4.9), true);
  assert.equal(withinMeleeRange(0.5, 0.5, 5.1), false);
  // A tauren and a tauren reach further than the floor.
  assert.equal(withinMeleeRange(3, 3, 7), true);
  assert.equal(withinMeleeRange(3, 3, 7.5), false);

  // 120 degrees total, so 60 either side of straight ahead.
  assert.equal(facingTarget(0, 1, 0), true);
  assert.equal(facingTarget(0, 1, 1.7), true, "just inside 60 degrees");
  assert.equal(facingTarget(0, 1, 1.8), false, "just outside");
  assert.equal(facingTarget(Math.PI, -1, 0), true, "facing behind, target behind");
  assert.equal(facingTarget(Math.PI, 1, 0), false, "facing behind, target ahead");
});

/**
 * A world connection a test can push packets into after the login handshake has finished.
 *
 * The read loop is already parked on `read()` by then, so a queue that is only drained on demand
 * would never wake it — the pending promise has to be the thing the push resolves.
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

/** Lets the world loop finish with whatever was pushed. `#dispatch` is async several layers deep. */
async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

test("Н1б a melee swing reaches onSwing and nothing else, so no blow is heard twice", async () => {
  // The one thing that could double the noise of a melee blow. `EnterWorld` plays a creature's
  // exertion and its injury on every `COMBAT_LOG` line, and Н1б now plays both from `onSwing` — so
  // the question is whether a swing produces a `COMBAT_LOG` line as well. It does not, and this is
  // what says so: `COMBAT_LOG` is emitted by six spell packets in five branches
  // (`SMSG_SPELLNONMELEEDAMAGELOG`, `SMSG_SPELLHEALLOG`, `SMSG_SPELLINSTAKILLLOG`, the dispel pair
  // and `SMSG_DISPEL_FAILED`) and by none of the melee ones, and the core sends
  // `SMSG_ATTACKERSTATEUPDATE` only for `BASE_ATTACK` and `OFF_ATTACK` (`Unit.cpp:2143-2163`), a
  // weapon-damage spell going out as the first of those six instead. `FLOATING_TEXT` is the same
  // story: a swing's damage number is put over the head by `logSwing` calling `showFloatingText`
  // directly, not by an event anything else listens to.
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();

  const heard = [];
  client.events.on("COMBAT_LOG", () => heard.push("COMBAT_LOG"));
  client.events.on("FLOATING_TEXT", () => heard.push("FLOATING_TEXT"));
  const swings = [];
  client.onSwing = (swing) => swings.push(swing);

  connection.push(OPCODES.SMSG_ATTACKERSTATEUPDATE, attackerStateUpdate({
    attacker: 0x1234n, victim: 9n, damages: [{ schoolMask: 1, damage: 47 }],
  }));
  await settle();

  assert.equal(swings.length, 1, "the swing itself arrives");
  assert.equal(swings[0].damage, 47);
  assert.deepEqual(heard, [], "and nothing else does, so the sound of it is played once");
  client.close();
});

test("spell combat-log events preserve damage versus healing semantics", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();

  const lines = [];
  client.events.on("COMBAT_LOG", (line) => lines.push(line));
  connection.push(OPCODES.SMSG_SPELLHEALLOG, new PacketWriter()
    .packedGuid(0x1234n).packedGuid(0x1234n).u32(2050).u32(60).u32(0).u32(0).u8(0).u8(0)
    .toUint8Array());
  connection.push(OPCODES.SMSG_SPELLNONMELEEDAMAGELOG, new PacketWriter()
    .packedGuid(9n).packedGuid(0x1234n)
    .u32(133).u32(47).u32(0).u8(4).u32(0).u32(0).u8(0).u8(0).u32(0).u32(0)
    .toUint8Array());
  await settle();

  assert.deepEqual(lines.map((line) => line.kind), ["heal", "damage"]);
  client.close();
});

test("an active Auto Shot reports one failure edge instead of repeating the same cast error", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  assert.equal(typeof client.setAutoRepeatSpellIds, "function");

  client.knownSpells = [{ id: 75, slot: 0 }];
  client.state.selfGuid = 0x1234n;
  client.state.move(0x1234n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.move(9n, { flags: 0, position: { x: 20, y: 0, z: 0, orientation: 0 } });
  client.state.setField(9n, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.selectTarget(9n);
  client.setAutoRepeatSpellIds([75]);
  const failures = [];
  client.onSpellStatus = (message, error) => { if (error) failures.push(message); };
  client.castSpell(75);
  assert.equal(client.autoRepeatSpellId, 75);

  const failure = new PacketWriter().u8(1).u32(75).u8(42).toUint8Array();
  connection.push(OPCODES.SMSG_CAST_FAILED, failure);
  connection.push(OPCODES.SMSG_CAST_FAILED, failure);
  connection.push(OPCODES.SMSG_CAST_FAILED, failure);
  await settle();

  assert.equal(client.autoRepeatSpellId, 75, "ordinary ranged failures leave Auto Shot active");
  assert.equal(failures.length, 1);
  client.close();
});

test("a target health death edge cancels Auto Shot on the server and clears local repeat state", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();

  client.knownSpells = [{ id: 75, slot: 0 }];
  client.state.selfGuid = 0x1234n;
  client.state.move(0x1234n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.move(9n, { flags: 0, position: { x: 20, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(9n).typeId = 3;
  client.state.setField(9n, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.selectTarget(9n);
  client.setAutoRepeatSpellIds([75]);
  client.castSpell(75);
  connection.sent.length = 0;

  connection.push(OPCODES.SMSG_HEALTH_UPDATE,
    new PacketWriter().packedGuid(9n).u32(0).toUint8Array());
  await settle();

  assert.equal(client.autoRepeatSpellId, undefined);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode).filter((opcode) =>
    opcode === OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL || opcode === OPCODES.CMSG_SET_SHEATHED), [
    OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL,
    OPCODES.CMSG_SET_SHEATHED,
  ]);
  client.close();
});

test("a disappearing melee target sends ATTACK_STOP before clearing local combat state", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();

  client.state.selfGuid = 0x1234n;
  client.state.move(0x1234n, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.move(9n, { flags: 0, position: { x: 2, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(9n).typeId = 3;
  client.state.setField(9n, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.selectTarget(9n);
  client.startAttack();
  connection.sent.length = 0;

  connection.push(OPCODES.SMSG_UPDATE_OBJECT,
    new PacketWriter().u32(1).u8(4).u32(1).packedGuid(9n).toUint8Array());
  await settle();

  assert.deepEqual(connection.sent.map(({ opcode }) => opcode).filter((opcode) =>
    opcode === OPCODES.CMSG_ATTACK_STOP || opcode === OPCODES.CMSG_SET_SHEATHED), [
    OPCODES.CMSG_ATTACK_STOP,
    OPCODES.CMSG_SET_SHEATHED,
  ]);
  assert.equal(client.attacking, false);
  assert.equal(client.targetGuid, undefined);
  client.close();
});
