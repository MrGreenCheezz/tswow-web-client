import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlCombatLogCastRules, CAST_LOG_REPEAT_MS } from "../dist/code/browser/framexml/FrameXmlCombatLogCasts.js";
import { FrameXmlCombatLogLive } from "../dist/code/browser/framexml/FrameXmlCombatLogLive.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { castFailedPacket, settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

// 3.01 (03.10, 3.01-castlog): the cast entries of the combat log by Wow.exe 3.3.5a's own rules
// (FrameXmlCombatLogCasts.ts header; notes .runtime/re-2026-10-03/stock-small/g1.c, g2.c):
// SPELL_CAST_START from SMSG_SPELL_START without CAST_FLAG_PENDING when the caster's cast time is not 0
// (0x00806700 → 0x00751920, virtual +0x148 = 0x0071ad20 / 0x006d68d0), SPELL_CAST_SUCCESS from the GO
// when it is 0 (0x0080e1b0 → 0x007519e0), SPELL_CAST_FAILED only from SMSG_CAST_FAILED (0x00809af0 →
// 0x00808200 → 0x00751ad0) — never from the interrupt pair (0x00809c70, 0x00806ad0).

const ME = 0x10n;
const MOB = 0xf130000000000abcn;
const OTHER = 0xf130000000000abdn;
const TRAP = 0xf110000000000123n;

const FIREBALL = { id: 133, name: "Огненный шар", attributes: [0, 0, 0, 0, 0, 0, 0, 0], effects: [2, 0, 0], castTime: 3500 };
const INSTANT = { id: 2136, name: "Огненный взрыв", attributes: [0, 0, 0, 0, 0, 0, 0, 0], effects: [2, 0, 0], castTime: 0 };

const start = (overrides = {}) => ({
  casterGuid: MOB, spellId: 133, castId: 1, castFlags: 0x2, castTime: 3500, casterIsUnit: true, self: false, ...overrides,
});
const go = (overrides = {}) => ({ casterGuid: MOB, spellId: 133, castId: 1, castFlags: 0x100, casterIsUnit: true, ...overrides });

test("START: a cast with a cast time is written, an instant and a channel's start are not", () => {
  const rules = new FrameXmlCombatLogCastRules();
  assert.equal(rules.start(start(), FIREBALL), true);
  assert.equal(rules.success(go(), FIREBALL), false, "a timed cast has its START, not a SUCCESS");
  assert.equal(rules.start(start({ spellId: 2136, castTime: 0 }), INSTANT), false, "instant: no START…");
  assert.equal(rules.success(go({ spellId: 2136 }), INSTANT), true, "…its SUCCESS instead");
  const channel = { ...INSTANT, id: 5143, name: "Чародейские стрелы" };
  assert.equal(rules.start(start({ spellId: 5143, castId: 2, castTime: 0 }), channel), false);
  assert.equal(rules.success(go({ spellId: 5143, castId: 2 }), channel), true, "a channel's GO is a SUCCESS");
});

test("START: pending, no unit caster, kept out by 0x0074d3f0; a ranged spell is always timed", () => {
  const rules = new FrameXmlCombatLogCastRules();
  assert.equal(rules.start(start({ castFlags: 0x3 }), FIREBALL), false, "CAST_FLAG_PENDING");
  assert.equal(rules.start(start({ casterGuid: TRAP, casterIsUnit: false }), FIREBALL), false, "a game object casts");
  for (const [label, spell] of [
    ["ATTR0 0x80", { ...FIREBALL, attributes: [0x80, 0, 0, 0, 0, 0, 0, 0] }],
    ["ATTR0 0x100", { ...FIREBALL, attributes: [0x100, 0, 0, 0, 0, 0, 0, 0] }],
    ["ATTR4 0x1", { ...FIREBALL, attributes: [0, 0, 0, 0, 0x1, 0, 0, 0] }],
    ["LEARN_SPELL", { ...FIREBALL, effects: [36, 0, 0] }],
    ["no name (the gateway's placeholder)", { ...FIREBALL, name: "Spell 133" }],
  ]) {
    assert.equal(rules.start(start(), spell), false, label);
  }
  const ranged = { ...INSTANT, attributes: [0x2, 0, 0, 0, 0, 0, 0, 0] };
  assert.equal(rules.start(start({ castTime: 0 }), ranged), true, "ATTR0 0x2: 0x7fffffff for a unit…");
  assert.equal(rules.start(start({ casterGuid: ME, self: true, castTime: 0 }), ranged), true,
    "…+500 for the player, whatever the server's time (Auto Shot's is 0)");
  assert.equal(rules.start(start({ castTime: 2000 }), undefined), true, "a row not fetched yet: the packet's time");
  assert.equal(rules.start(start({ castTime: 0 }), undefined), false);
});

test("START: the caster's own row decides for others, the server's time for the player (spell modifiers)", () => {
  const rules = new FrameXmlCombatLogCastRules();
  // Another unit hasted to 0 by the server is still timed in the client's eyes (DBC + cast speed).
  assert.equal(rules.start(start({ castTime: 0 }), FIREBALL), true);
  // The player's Presence of Mind: 0x006d68d0 applies the modifier, the START is quiet, the GO writes —
  // also right after another cast of the player's (its record is the one rewritten).
  assert.equal(rules.start(start({ casterGuid: ME, self: true, castId: 0, spellId: 2136, castTime: 0 }), INSTANT), false);
  assert.equal(rules.success(go({ casterGuid: ME, castId: 0, spellId: 2136 }), INSTANT), true);
  assert.equal(rules.start(start({ casterGuid: ME, self: true, castTime: 0 }), FIREBALL), false);
  assert.equal(rules.success(go({ casterGuid: ME }), FIREBALL), true);
  // A START decides one GO (03.10 review: its record is reused, not dropped): another GO of the same cast
  // id with no START of its own reads the row, as 0x006d68d0 would with the modifier spent.
  assert.equal(rules.success(go({ casterGuid: ME }), FIREBALL), false);
});

test("SUCCESS: pending only with ATTR7 0x80000000; never for an OPEN_LOCK spell or a non-unit caster", () => {
  const rules = new FrameXmlCombatLogCastRules();
  assert.equal(rules.success(go({ spellId: 2136, castFlags: 0x101 }), INSTANT), false, "triggered");
  assert.equal(rules.success(go({ spellId: 2136, castFlags: 0x101 }),
    { ...INSTANT, attributes: [0, 0, 0, 0, 0, 0, 0, 0x80000000] }), true, "AttributesEx7 0x80000000");
  assert.equal(rules.success(go({ spellId: 2136, castFlags: 0x101 }), undefined), false, "unknown row, pending");
  assert.equal(rules.success(go({ spellId: 3365 }), { ...INSTANT, id: 3365, name: "Открывание", effects: [33, 0, 0] }), false);
  assert.equal(rules.success(go({ spellId: 2136, casterIsUnit: false }), INSTANT), false);
  assert.equal(rules.success(go({ spellId: 2136 }), { ...INSTANT, attributes: [0x100, 0, 0, 0, 0, 0, 0, 0] }), false);
  assert.equal(rules.success(go({ spellId: 9999 }), undefined), true, "unknown row without a START: instant");
});

test("FAILED: DONT_REPORT and CUSTOM_ERROR are quiet, a repeat within 3 s too, the clock restarts on it", () => {
  const rules = new FrameXmlCombatLogCastRules();
  assert.equal(rules.failed(133, 27, 0, undefined, FIREBALL), false, "SPELL_FAILED_DONT_REPORT");
  assert.equal(rules.failed(133, 172, 10, undefined, FIREBALL), false, "SPELL_FAILED_CUSTOM_ERROR");
  assert.equal(rules.failed(133, 40, 100, undefined, FIREBALL), true);
  assert.equal(rules.failed(133, 40, 100 + 2000, undefined, FIREBALL), false, "same spell and result within 3 s");
  assert.equal(rules.failed(133, 40, 100 + 4500, undefined, FIREBALL), false, "2.5 s after the repeat: still quiet");
  assert.equal(rules.failed(133, 40, 100 + 4500 + CAST_LOG_REPEAT_MS, undefined, FIREBALL), true, "3 s of quiet");
  assert.equal(rules.failed(133, 12, 100 + 4500 + CAST_LOG_REPEAT_MS, undefined, FIREBALL), true, "another result");
  assert.equal(rules.failed(2136, 40, 0, undefined, { ...INSTANT, attributes: [0x100, 0, 0, 0, 0, 0, 0, 0] }), false,
    "0x00751ad0: ATTR0 0x180");
  // The auto-repeat spell (0x007fe140 keeps it): its result repeated is quiet however late it comes.
  const shot = { ...INSTANT, id: 75, name: "Автоматическая стрельба", attributes: [0x2, 0, 0, 0, 0, 0, 0, 0] };
  assert.equal(rules.failed(75, 63, 0, 75, shot), true);
  assert.equal(rules.failed(75, 63, 60_000, 75, shot), false);
  assert.equal(rules.failed(75, 64, 70_000, 75, shot), true);
});

test("FAILED: a GO without CAST_FLAG_PENDING, anyone's, restarts the repeat rule (0x0080e1b0 clears 0x00d397c4)", () => {
  // 03.10 review: 0x0080e1b0 zeroes the remembered spell (0x00d397c4) for every GO without
  // CAST_FLAG_PENDING, right before 0x007fecc0's 187 — whoever cast it; only 0x00808200 sets it again.
  const rules = new FrameXmlCombatLogCastRules();
  assert.equal(rules.failed(133, 40, 0, undefined, FIREBALL), true);
  rules.success(go({ casterGuid: OTHER, spellId: 2136, castFlags: 0x101 }), INSTANT);
  assert.equal(rules.failed(133, 40, 1000, undefined, FIREBALL), false, "a triggered GO leaves it");
  rules.success(go({ casterGuid: TRAP, spellId: 2136, casterIsUnit: false }), INSTANT);
  assert.equal(rules.failed(133, 40, 2000, undefined, FIREBALL), true, "any other GO clears it: written again");
  assert.equal(rules.failed(133, 40, 2500, undefined, FIREBALL), false, "and remembered again");
});

function liveWorld() {
  const listeners = new Map();
  const object = (guid, typeId) => ({ guid, typeId, fields: new Map() });
  const world = {
    state: { selfGuid: ME, objects: new Map([[ME, object(ME, 4)], [MOB, object(MOB, 3)], [OTHER, object(OTHER, 3)], [TRAP, object(TRAP, 5)]]) },
    group: { groupType: 0, ownSubGroup: 0, ownFlags: 0, members: [] },
    names: new Map([[ME, "Тестовый"]]),
    auras: new Map(),
    autoRepeatSpellId: undefined,
    requestName() {},
    events: {
      on(name, listener) {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      },
    },
  };
  let clock = 0;
  const log = new FrameXmlCombatLogLive({
    world: () => world,
    spell: (id) => ({ 133: FIREBALL, 2136: INSTANT })[id],
    name: (guid) => (guid === MOB ? "Кобольд" : world.names.get(guid)),
    reaction: () => -1,
    targetGuid: () => undefined,
    focusGuid: () => undefined,
    failureText: () => "Прервано",
    monotonic: () => clock,
    now: () => 1700000000123,
  });
  const fired = [];
  log.attach({ fire: (name, ...args) => { fired.push([name, ...args]); return 1; } });
  const entries = () => fired.filter(([name]) => name === "COMBAT_LOG_EVENT_UNFILTERED")
    .map(([, , subevent, source, , , dest, , , spellId]) => [subevent, source, dest, spellId]);
  return { emit: (name, value) => listeners.get(name)?.(value), entries, fired, tick: (ms) => { clock += ms; }, world };
}

const startEvent = (overrides = {}) => ({
  casterGuid: MOB, casterUnit: MOB, castId: 1, spellId: 133, castFlags: 0x2, castTime: 3500,
  schoolImmunityMask: 0, mechanicImmunityMask: 0, ...overrides,
});
const goEvent = (overrides = {}) => ({
  casterGuid: MOB, casterUnit: MOB, castId: 1, spellId: 133, castFlags: 0x100, castTime: 0, hits: [], misses: [], ...overrides,
});

test("live: SPELL_START writes the START of a timed cast; the GO of an instant writes SUCCESS at its target", () => {
  const { emit, entries } = liveWorld();
  // The cast bar's bus event alone no longer writes: the log hears the packet (SPELL_START).
  emit("SPELL_CAST_START", { casterGuid: MOB, spellId: 133, castTime: 3500, channel: false });
  assert.deepEqual(entries(), []);
  emit("SPELL_START", startEvent());
  emit("SPELL_GO", goEvent({ hits: [ME] }));
  emit("SPELL_START", startEvent({ castId: 2, spellId: 2136, castTime: 0 }));
  emit("SPELL_GO", goEvent({ castId: 2, spellId: 2136, hits: [OTHER, ME], targets: { targetFlags: 0x2, unitTarget: ME } }));
  // An area instant with no object in its target block: the destination is empty, not the first hit.
  emit("SPELL_GO", goEvent({ castId: 3, spellId: 2136, hits: [OTHER], targets: { targetFlags: 0x40 } }));
  // A triggered GO is not logged; neither is a game object's cast.
  emit("SPELL_GO", goEvent({ castId: 4, spellId: 2136, castFlags: 0x101 }));
  emit("SPELL_START", startEvent({ casterGuid: TRAP, casterUnit: TRAP, castId: 5 }));
  assert.deepEqual(entries(), [
    ["SPELL_CAST_START", "0xF130000000000ABC", "0x0000000000000000", 133],
    ["SPELL_CAST_SUCCESS", "0xF130000000000ABC", "0x0000000000000010", 2136],
    ["SPELL_CAST_SUCCESS", "0xF130000000000ABC", "0x0000000000000000", 2136],
  ]);
});

test("live: SPELL_CAST_FAILED only for the player's SMSG_CAST_FAILED, once for an interrupt", () => {
  const { emit, entries, tick } = liveWorld();
  // Spell::cancel in PREPARING (Spell.cpp:3384-3387): CAST_FAILED, then the SPELL_FAILURE/FAILED_OTHER pair.
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 7, result: 40, refusal: true });
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 7, result: 40 });
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 7, result: 40 });
  // A channel interrupted (SPELL_STATE_CASTING) sends only the pair: nothing is written.
  tick(5000);
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 8, result: 40 });
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 8, result: 40 });
  // GO's own «success» is not a failure.
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 9, result: 187 });
  assert.deepEqual(entries(), [["SPELL_CAST_FAILED", "0x0000000000000010", "0x0000000000000000", 133]]);
  // The same refusal again at once is quiet (0x00808200's 3-second rule), later it is written again.
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 10, result: 40, refusal: true });
  assert.equal(entries().length, 2, "5 s after the first: written");
  tick(1000);
  emit("SPELL_CAST_RESULT", { casterGuid: ME, spellId: 133, castCount: 11, result: 40, refusal: true });
  assert.equal(entries().length, 2, "1 s after: quiet");
});

/** `SMSG_SPELL_START`: header, target flags, then the flagged words (SpellPackets.cpp:112-160). */
function spellStartPacket({ caster, castId, spellId, castTime, flags = 0x2 }) {
  return new PacketWriter().packedGuid(caster).packedGuid(caster).u8(castId).u32(spellId).u32(flags).u32(castTime)
    .u32(0).toUint8Array();
}

function record(client, names) {
  const seen = [];
  for (const name of names) client.events.on(name, (event) => seen.push([name, event]));
  return seen;
}

test("WorldClient: every SMSG_SPELL_START is SPELL_START after the cast bar's SPELL_CAST_START; CAST_FAILED is a refusal", async () => {
  const { client, connection } = await travelClient([], ME);
  const seen = record(client, ["SPELL_CAST_START", "SPELL_START", "SPELL_CAST_RESULT"]);
  connection.push(OPCODES.SMSG_SPELL_START, spellStartPacket({ caster: MOB, castId: 1, spellId: 133, castTime: 2500 }));
  connection.push(OPCODES.SMSG_SPELL_START, spellStartPacket({ caster: MOB, castId: 2, spellId: 2136, castTime: 0, flags: 0x3 }));
  await settle();
  assert.deepEqual(seen.map(([name, event]) => [name, event.spellId, event.castFlags]), [
    ["SPELL_CAST_START", 133, undefined],
    ["SPELL_START", 133, 0x2],
    ["SPELL_START", 2136, 0x3],
  ]);
  seen.length = 0;
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 5, spellId: 133, result: 40 }));
  connection.push(OPCODES.SMSG_SPELL_FAILURE,
    new PacketWriter().packedGuid(ME).u8(5).u32(133).u8(40).toUint8Array());
  await settle();
  assert.deepEqual(seen.map(([, event]) => event.refusal), [true, undefined]);
  client.close?.();
});

test("WorldClient GO order: UNIT_SPELLCAST_SUCCEEDED, then SPELL_CAST_SUCCESS, then SPELL_MISSED (3.01-go-order)", async () => {
  // 0x0080e1b0: 0x007fecc0 with 187 (UNIT_SPELLCAST_SUCCEEDED) for a GO without CAST_FLAG_PENDING, then the
  // missile, then 0x007519e0 (SPELL_CAST_SUCCESS), then 0x00751b80 for each miss (SPELL_MISSED).
  const { client, connection } = await travelClient([], ME);
  client.state.objects.set(MOB, { guid: MOB, typeId: 3, fields: new Map() });
  const seen = record(client, ["SPELL_CAST_RESULT", "SPELL_GO", "UNIT_COMBAT"]);
  const fired = [];
  client.events.on("SPELL_CAST_RESULT", ({ result }) => { if (result === 187) fired.push(["UNIT_SPELLCAST_SUCCEEDED"]); });
  const log = new FrameXmlCombatLogLive({
    world: () => client,
    spell: (id) => ({ 133: FIREBALL, 2136: INSTANT })[id],
    name: () => undefined,
    reaction: () => -1,
    targetGuid: () => undefined,
    focusGuid: () => undefined,
    monotonic: () => 0,
    now: () => 1700000000123,
  });
  log.attach({ fire: (name, ...args) => { if (name === "COMBAT_LOG_EVENT_UNFILTERED") fired.push([name, args[1]]); return 1; } });
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: MOB, castId: 0, spellId: 2136, misses: [{ guid: ME, reason: 2 }] }));
  await settle();
  assert.deepEqual(seen.map(([name, event]) => [name, event.result ?? event.source]), [
    ["SPELL_CAST_RESULT", 187], ["SPELL_GO", undefined], ["UNIT_COMBAT", "miss"],
  ]);
  assert.deepEqual(fired, [
    ["UNIT_SPELLCAST_SUCCEEDED"],
    ["COMBAT_LOG_EVENT_UNFILTERED", "SPELL_CAST_SUCCESS"],
    ["COMBAT_LOG_EVENT_UNFILTERED", "SPELL_MISSED"],
  ]);
  log.detach();
  client.close?.();
});
