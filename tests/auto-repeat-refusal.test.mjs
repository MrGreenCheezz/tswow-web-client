import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { formatGlobalStringByName } from "../dist/code/world/GlobalStringFormat.js";
import { spellFailureText } from "../dist/code/world/SpellProtocol.js";
import {
  AUTO_REPEAT_CAST_GRACE_MS, REFUSAL_REPEAT_MS, RefusalQuietRules, WANTED_REPEAT_KEPT_RESULTS, WANTED_REPEAT_STOP_RESULTS,
  autoRepeatRefusalAction, autoRepeatWaitsForCast, refusalLimitCategoryText,
} from "../dist/code/world/AutoRepeatRefusal.js";
import { castFailedPacket } from "./fixtures/world-packets.mjs";

/*
 * 05.10-5.05 / 05.10-3.02: Wow.exe 3.3.5a (12340) 0x00808200 — what a refusal does to the auto-repeat
 * (0x00d397d0) and to the error frame (0x005216f0), against the autoRangedCombat controller's wanted spell
 * (0x00d397cc). Notes: .runtime/re-2026-10-02/a2-m8/d2.c (0x00808200), .runtime/re-2026-10-03/stock-small/g1.c
 * (0x00809af0 — the realm's refusal passes 1), .runtime/re-2026-10-01/a9-combat/e2.c (0x00807560, 0x007fe190,
 * 0x006e2be0). The realm: Spell.cpp:3232-3237 (SPELL_IN_PROGRESS before SetCurrentCastSpell),
 * Unit.cpp:3414-3442 (IsNonMeleeSpellCast), Unit.cpp:3264-3270 (Auto Shot's per-update refusals).
 */

const R = {
  BAD_TARGETS: 12, DONT_REPORT: 27, EQUIPPED_ITEM_CLASS: 29, LINE_OF_SIGHT: 47, NEED_AMMO: 52, NOT_READY: 67,
  OUT_OF_RANGE: 97, SPELL_IN_PROGRESS: 105, TOO_MANY_OF_ITEM: 129, UNIT_NOT_INFRONT: 134,
};

// ---- the rules on their own ----------------------------------------------------------------------

test("05.10-5.05: the repeating spell's refusal stops the repeat, but the realm's refusal of the wanted spell only for 0x00808200's list", () => {
  const base = { spellId: 75, repeating: 75, wanted: undefined, fromServer: true, answersRequest: false };
  // A repeat the player started by hand: every refusal but DONT_REPORT stops it, the realm's or the client's.
  assert.equal(autoRepeatRefusalAction({ ...base, result: R.LINE_OF_SIGHT }), "stop");
  assert.equal(autoRepeatRefusalAction({ ...base, result: R.NEED_AMMO }), "stop");
  assert.equal(autoRepeatRefusalAction({ ...base, result: R.LINE_OF_SIGHT, fromServer: false }), "stop");
  assert.equal(autoRepeatRefusalAction({ ...base, result: R.DONT_REPORT }), "keep");
  // Another spell's refusal, or no repeat: nothing.
  assert.equal(autoRepeatRefusalAction({ ...base, spellId: 133, result: R.LINE_OF_SIGHT }), "keep");
  assert.equal(autoRepeatRefusalAction({ ...base, repeating: undefined, result: R.LINE_OF_SIGHT }), "keep");
  // The controller's wanted spell, refused by the realm.
  const wanted = { ...base, wanted: 75 };
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: R.BAD_TARGETS }), "stop");
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: R.UNIT_NOT_INFRONT }), "stop");
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: 11 }), "stop");
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: 23 }), "stop");
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: R.LINE_OF_SIGHT }), "keep", "not in the list");
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: R.NOT_READY }), "keep");
  // The client's own refusal of the wanted spell stops it whatever the result.
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: R.LINE_OF_SIGHT, fromServer: false }), "stop");
  // Deliberate: the listed results this client cannot check locally keep the realm's repeat (no CAST storm).
  for (const result of [28, 29, 30, 31, R.NEED_AMMO, R.OUT_OF_RANGE, 128]) {
    assert.equal(autoRepeatRefusalAction({ ...wanted, result }), "keep", `result ${result}`);
  }
  assert.deepEqual([...WANTED_REPEAT_STOP_RESULTS].sort((a, b) => a - b), [11, 12, 23, 28, 29, 30, 31, 52, 97, 128, 134]);
  assert.ok([...WANTED_REPEAT_KEPT_RESULTS].every((result) => WANTED_REPEAT_STOP_RESULTS.has(result)));
  // Deliberate: SPELL_IN_PROGRESS answering this client's request — the realm never set the repeat up.
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: R.SPELL_IN_PROGRESS, answersRequest: true }), "forget");
  assert.equal(autoRepeatRefusalAction({ ...wanted, result: R.SPELL_IN_PROGRESS }), "keep", "a refusal of a running repeat");
  assert.equal(autoRepeatRefusalAction({ ...base, result: R.SPELL_IN_PROGRESS, answersRequest: true }), "stop");
});

test("05.10-5.05: the shot waits for a cast bar, not for a channel, and not for a bar long over", () => {
  const bar = { channel: false, startedAt: 1000, duration: 1500 };
  assert.equal(autoRepeatWaitsForCast(undefined, 1000), false);
  assert.equal(autoRepeatWaitsForCast(bar, 1000), true);
  assert.equal(autoRepeatWaitsForCast(bar, 2500 + AUTO_REPEAT_CAST_GRACE_MS - 1), true, "the GO is on its way");
  assert.equal(autoRepeatWaitsForCast(bar, 2500 + AUTO_REPEAT_CAST_GRACE_MS), false, "a GO that never matched");
  assert.equal(autoRepeatWaitsForCast({ ...bar, channel: true }, 1000), false);
});

test("05.10-3.02: local_14 — the wanted spell's remembered result, 0x007fe190's resets, the 3-second rule, GO", () => {
  const rules = new RefusalQuietRules();
  // Another spell: quiet only within 3 s of the same spell and result.
  assert.equal(rules.quiet(133, R.NOT_READY, 1000, undefined, 0), false);
  assert.equal(rules.quiet(133, R.NOT_READY, 1000 + REFUSAL_REPEAT_MS - 1, undefined, 0), true);
  assert.equal(rules.quiet(133, R.NOT_READY, 1000 + 2 * REFUSAL_REPEAT_MS - 2, undefined, 0), true, "each repeat re-arms the 3 s");
  assert.equal(rules.quiet(133, R.NOT_READY, 1000 + 3 * REFUSAL_REPEAT_MS, undefined, 0), false);
  assert.equal(rules.quiet(133, R.LINE_OF_SIGHT, 20_000, undefined, 0), false, "another result");
  // A GO without CAST_FLAG_PENDING forgets the last refusal.
  rules.spellGo();
  assert.equal(rules.quiet(133, R.LINE_OF_SIGHT, 20_001, undefined, 0), false);
  // The wanted spell: the same result again is quiet however long after, until 0x007fe190.
  assert.equal(rules.quiet(75, R.LINE_OF_SIGHT, 30_000, 75, 0), false);
  rules.spellGo();
  assert.equal(rules.quiet(75, R.LINE_OF_SIGHT, 90_000, 75, 0), true, "a GO does not forget the wanted spell's result");
  assert.equal(rules.quiet(75, R.UNIT_NOT_INFRONT, 90_001, 75, 0), false, "another result is said");
  assert.equal(rules.quiet(75, R.LINE_OF_SIGHT, 99_000, 75, 0), false, "and is the remembered one now");
  assert.equal(rules.quiet(75, R.LINE_OF_SIGHT, 109_000, 75, 1), false, "0x007fe190 ran (the counter moved)");
  assert.equal(rules.quiet(75, R.LINE_OF_SIGHT, 119_000, 75, 1), true);
  // Not wanted (the controller off): only the 3-second rule.
  assert.equal(rules.quiet(75, R.LINE_OF_SIGHT, 200_000, undefined, 1), false);
});

test("05.10-3.02: TOO_MANY_OF_ITEM with a known limit category says ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS", () => {
  const rows = new Map([[2, { name: "Камень здоровья", quantity: 1 }]]);
  const category = (id) => rows.get(id);
  assert.equal(refusalLimitCategoryText(R.TOO_MANY_OF_ITEM, [2], category),
    formatGlobalStringByName("ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS", [1, "Камень здоровья"], "%d %s"));
  assert.equal(refusalLimitCategoryText(R.TOO_MANY_OF_ITEM, [3], category), undefined, "no row: the plain words");
  assert.equal(refusalLimitCategoryText(R.TOO_MANY_OF_ITEM, [], category), undefined, "no category in the tail");
  assert.equal(refusalLimitCategoryText(R.TOO_MANY_OF_ITEM, [2], undefined), undefined, "no rows at all");
  assert.equal(refusalLimitCategoryText(R.NEED_AMMO, [2], category), undefined);
});

// ---- through WorldClient ---------------------------------------------------------------------------

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
const AUTO_SHOT = 75;
const SCARE_BEAST = 1513;
const LIMITS = { min: 8, max: 35 };

async function hunter({ controller = true } = {}) {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(SELF).typeId = 4;
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.state.move(A, { flags: 0, position: { x: 20, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(A).typeId = 3;
  client.state.setField(A, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.canAttackUnit = (object) => object.guid === A;
  client.knownSpells = [{ id: AUTO_SHOT, slot: 0 }, { id: SCARE_BEAST, slot: 1 }, { id: 133, slot: 2 }];
  client.setAutoRepeatSpellIds([AUTO_SHOT]);
  if (controller) client.setAutoRangedCombatSpellIds([AUTO_SHOT]);
  client.autoRangedLimits = () => LIMITS;
  client.autoRangedCombat = () => controller;
  client.autoRanged.schedule = { start: () => 1, stop: () => {} };
  const errors = [];
  client.onSpellStatus = (message, error) => { if (error) errors.push(message); };
  await settle();
  connection.sent.length = 0;
  return { client, connection, errors };
}

const named = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);
const shots = (connection) => named(connection, OPCODES.CMSG_CAST_SPELL)
  .map(({ payload }) => ({ castCount: payload[0], spellId: new DataView(payload.buffer, payload.byteOffset).getUint32(1, true) }));
const spellStart = (castCount, spellId, castTime) =>
  new PacketWriter().packedGuid(SELF).packedGuid(SELF).u8(castCount).u32(spellId).u32(0).u32(castTime).toUint8Array();
const spellGo = (castCount, spellId, castFlags = 0x100) =>
  new PacketWriter().packedGuid(SELF).packedGuid(SELF).u8(castCount).u32(spellId).u32(castFlags).u32(0).u8(0).u8(0).toUint8Array();

test("05.10-5.05: the controller holds its shot while the player's cast bar runs and shoots once it ends", async () => {
  const { client, connection } = await hunter();
  client.selectTarget(A);
  client.startAttack();
  assert.deepEqual(shots(connection).map(({ spellId }) => spellId), [AUTO_SHOT]);
  // A stun, a Tab: the realm cancels the repeat; then Scare Beast's 1.5 s bar.
  connection.push(OPCODES.SMSG_CANCEL_AUTO_REPEAT, Uint8Array.of(0x03, 0x34, 0x12));
  connection.push(OPCODES.SMSG_SPELL_START, spellStart(9, SCARE_BEAST, 1500));
  await settle();
  assert.equal(client.autoRepeatSpellId, undefined);
  connection.sent.length = 0;
  const resets = client.autoRanged.failureResets;
  client.autoRanged.tick();
  client.autoRanged.tick();
  assert.deepEqual(shots(connection), [], "no CMSG_CAST_SPELL for the realm to refuse with SPELL_IN_PROGRESS");
  assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT, "the shot stays wanted: the button stays lit");
  assert.equal(client.autoRanged.failureResets, resets, "a held shot is no 0x007fe190 (0x0080da40 returned false)");
  connection.push(OPCODES.SMSG_SPELL_GO, spellGo(9, SCARE_BEAST));
  await settle();
  client.autoRanged.tick();
  assert.deepEqual(shots(connection).map(({ spellId }) => spellId), [AUTO_SHOT]);
  assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
  assert.equal(client.autoRanged.failureResets, resets + 1, "the shot that goes out is 0x006e2df3's 0x007fe190");
  client.close();
});

test("05.10-5.05: a shot the realm refuses with SPELL_IN_PROGRESS is not left «running» — the controller shoots again after the cast", async () => {
  const { client, connection, errors } = await hunter();
  client.selectTarget(A);
  client.startAttack();
  const [shot] = shots(connection);
  // The race: the realm took Scare Beast first; its START is on the wire before the refusal.
  connection.push(OPCODES.SMSG_SPELL_START, spellStart(shot.castCount + 1, SCARE_BEAST, 1500));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: shot.castCount, spellId: AUTO_SHOT, result: R.SPELL_IN_PROGRESS }));
  await settle();
  assert.equal(client.autoRepeatSpellId, undefined, "the realm holds no repeat (Spell.cpp:3232-3237)");
  assert.equal(named(connection, OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL).length, 0, "nothing to cancel");
  assert.equal(errors.length, 1);
  connection.sent.length = 0;
  client.autoRanged.tick();
  assert.deepEqual(shots(connection), [], "the bar runs");
  connection.push(OPCODES.SMSG_SPELL_GO, spellGo(shot.castCount + 1, SCARE_BEAST));
  await settle();
  client.autoRanged.tick();
  assert.deepEqual(shots(connection).map(({ spellId }) => spellId), [AUTO_SHOT], "no longer stuck");
  client.close();
});

test("05.10-5.05: the realm's BAD_TARGETS stops the wanted repeat (CMSG_CANCEL_AUTO_REPEAT_SPELL, no sheath); LINE_OF_SIGHT and NEED_AMMO keep it", async () => {
  {
    const { client, connection } = await hunter();
    client.selectTarget(A);
    client.startAttack();
    connection.sent.length = 0;
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: AUTO_SHOT, result: R.BAD_TARGETS }));
    await settle();
    assert.equal(client.autoRepeatSpellId, undefined);
    assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL]);
    assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT, "0x00807560 leaves the wanted spell");
    client.close();
  }
  for (const result of [R.LINE_OF_SIGHT, R.NEED_AMMO]) {
    const { client, connection } = await hunter();
    client.selectTarget(A);
    client.startAttack();
    connection.sent.length = 0;
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: AUTO_SHOT, result }));
    await settle();
    assert.equal(client.autoRepeatSpellId, AUTO_SHOT, `result ${result}`);
    assert.deepEqual(connection.sent, []);
    client.close();
  }
});

test("05.10-5.05: a hand-started Auto Shot stops on the realm's refusal; DONT_REPORT leaves it", async () => {
  const { client, connection, errors } = await hunter({ controller: false });
  client.selectTarget(A);
  client.castSpell(AUTO_SHOT);
  assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: AUTO_SHOT, result: R.DONT_REPORT }));
  await settle();
  assert.equal(client.autoRepeatSpellId, AUTO_SHOT);
  connection.sent.length = 0;
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: AUTO_SHOT, result: R.NEED_AMMO }));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: AUTO_SHOT, result: R.NEED_AMMO }));
  await settle();
  assert.equal(client.autoRepeatSpellId, undefined);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL], "once, no sheath");
  assert.deepEqual(errors, [spellFailureText(R.NEED_AMMO)], "the second within 3 s is quiet");
  client.close();
});

test("05.10-3.02: the error frame keys the repeat rule on the wanted spell — a GO does not reset it, 0x007fe190 does", async () => {
  const { client, connection, errors } = await hunter();
  client.selectTarget(A);
  client.startAttack();
  const los = castFailedPacket({ castCount: 1, spellId: AUTO_SHOT, result: R.LINE_OF_SIGHT });
  connection.push(OPCODES.SMSG_CAST_FAILED, los);
  // The repeat's own shots are triggered (CAST_FLAG_PENDING) — and even a plain GO leaves 0x00d397c8.
  connection.push(OPCODES.SMSG_SPELL_GO, spellGo(0, AUTO_SHOT, 0x1));
  connection.push(OPCODES.SMSG_SPELL_GO, spellGo(0, 133));
  await settle();
  // The plain GO forgot the 3-second memory: only the wanted spell's memory keeps this one quiet.
  connection.push(OPCODES.SMSG_CAST_FAILED, los);
  await settle();
  assert.deepEqual(errors, [spellFailureText(R.LINE_OF_SIGHT)]);
  // StopAttack is a 0x007fe190: the same refusal after it is said again.
  client.stopAttack();
  client.startAttack();
  connection.push(OPCODES.SMSG_SPELL_GO, spellGo(0, 133));
  connection.push(OPCODES.SMSG_CAST_FAILED, los);
  await settle();
  assert.equal(errors.length, 2);
  client.close();
});

test("05.10-3.02: TOO_MANY_OF_ITEM — the limit category's sentence, never quiet; without the rows the plain words, quiet within 3 s", async () => {
  const { client, connection, errors } = await hunter({ controller: false });
  const healthstone = castFailedPacket({ castCount: 2, spellId: 133, result: R.TOO_MANY_OF_ITEM, tail: [2] });
  connection.push(OPCODES.SMSG_CAST_FAILED, healthstone);
  connection.push(OPCODES.SMSG_CAST_FAILED, healthstone);
  await settle();
  const plain = spellFailureText({ castCount: 2, spellId: 133, result: R.TOO_MANY_OF_ITEM, extra: [2] });
  assert.deepEqual(errors, [plain], "no rows (the gateway before its restart): Wow.exe's «no row» path");
  errors.length = 0;
  client.castFailureLimitCategory = (id) => (id === 2 ? { name: "Камень здоровья", quantity: 1 } : undefined);
  connection.push(OPCODES.SMSG_CAST_FAILED, healthstone);
  connection.push(OPCODES.SMSG_CAST_FAILED, healthstone);
  await settle();
  const sentence = formatGlobalStringByName("ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS", [1, "Камень здоровья"], "%d %s");
  assert.deepEqual(errors, [sentence, sentence], "case 0x81 jumps past local_14");
  client.close();
});
