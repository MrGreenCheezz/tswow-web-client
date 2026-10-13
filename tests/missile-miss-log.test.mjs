// 13.10 (3.01): a missile's misses are told when it lands (Wow.exe 0x0080e1b0 / 0x00700e20,
// world/MissileMissLog.ts), and COMBAT_TEXT_UPDATE("SPELL_CAST", name) for the combat-text unit
// (0x007519e0 / 0x0074d700, browser/framexml/FrameXmlCombatText.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { MissileMissSchedule, missileMissTiming } from "../dist/code/world/MissileMissLog.js";
import { combatTextSpellCast, combatTextUnitGuid } from "../dist/code/browser/framexml/FrameXmlCombatText.js";
import { FrameXmlCombatLogLive } from "../dist/code/browser/framexml/FrameXmlCombatLogLive.js";
import { FRAMEXML_COMBAT_LOG_BINDINGS } from "../dist/code/browser/framexml/FrameXmlCombatLog.js";
import { settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

const ME = 0x10n;
const MOB = 0xf130000000001000n;

test("when a GO's miss is told: no speed now (none with AttributesEx2 0x80), a missile when it lands", () => {
  const at = (x) => ({ x, y: 0, z: 0 });
  assert.equal(missileMissTiming(undefined, at(0), at(30)), "now", "a row not known yet: at once, as before");
  assert.equal(missileMissTiming({ attributes: [] }, at(0), at(30)), "now", "a gateway before v=20 (no speed): at once");
  assert.equal(missileMissTiming({ speed: 0, attributes: [0, 0, 0] }, at(0), at(30)), "now", "0x0080e1b0 writes it");
  assert.equal(missileMissTiming({ speed: 0, attributes: [0, 0, 0x80] }, at(0), at(30)), "never",
    "speed 0 with AttributesEx2 0x80: 0x0080e1b0 skips the list and there is no missile");
  assert.equal(missileMissTiming({ speed: 24, attributes: [] }, at(0), at(30)), 1250, "round(30 / 24 · 1000)");
  assert.equal(missileMissTiming({ speed: 7, attributes: [] }, at(0), { x: 3, y: 4, z: 12 }), 1857, "3-D distance 13, rounded");
  assert.equal(missileMissTiming({ speed: 24, attributes: [0, 0, 0x80] }, at(0), at(30)), 1250, "0x80 matters only without speed");
  assert.equal(missileMissTiming({ speed: 24 }, undefined, at(30)), "now", "no caster position: at once");
  assert.equal(missileMissTiming({ speed: 24 }, at(0), at(0)), "now", "no distance: at once");
});

test("the schedule tells later, never, or now, and a closed session drops what is in flight", () => {
  const timers = [];
  const schedule = new MissileMissSchedule((callback, delay) => { timers.push({ callback, delay, live: true }); return timers.length; },
    (id) => { timers[id - 1].live = false; });
  const told = [];
  schedule.tell("now", () => told.push("a"));
  schedule.tell("never", () => told.push("b"));
  schedule.tell(1250, () => told.push("c"));
  assert.deepEqual(told, ["a"]);
  assert.deepEqual(timers.map((timer) => timer.delay), [1250]);
  assert.equal(schedule.size, 1);
  timers[0].callback();
  assert.deepEqual(told, ["a", "c"]);
  assert.equal(schedule.size, 0);
  schedule.tell(500, () => told.push("d"));
  schedule.clear();
  assert.equal(timers[1].live, false, "cleared");
  assert.equal(schedule.size, 0);
});

test("WorldClient: a missile's miss (UNIT_COMBAT, the word, the log) waits for the missile; an instant's is at once", async () => {
  const { client, connection } = await travelClient([], ME);
  client.state.objects.set(MOB, { guid: MOB, typeId: 3, fields: new Map(), position: { x: 10 + 24, y: 20, z: 30 } });
  const rows = { 133: { speed: 24, attributes: [0, 0, 0] }, 2136: { speed: 0, attributes: [0, 0, 0] }, 9437: { speed: 0, attributes: [0, 0, 0x80] } };
  client.spellMissileRow = (id) => rows[id];
  const seen = [];
  client.events.on("UNIT_COMBAT", (event) => { if (event.source === "miss") seen.push([event.spellId, Date.now()]); });
  client.events.on("FLOATING_TEXT", (event) => { if (event.kind === "miss") seen.push(["text", event.guid]); });
  const started = Date.now();
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: MOB, spellId: 133, misses: [{ guid: ME, reason: 2 }] }));
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: MOB, spellId: 2136, misses: [{ guid: ME, reason: 2 }] }));
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: MOB, spellId: 9437, misses: [{ guid: ME, reason: 2 }] }));
  await settle();
  assert.deepEqual(seen.map(([what]) => what), ["text", 2136], "the instant at once; the missile not yet; 9437 never");
  // The missile covers 24 yards at 24 yards a second: one second.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(seen.map(([what]) => what), ["text", 2136, "text", 133]);
  const landed = seen[3][1] - started;
  assert.ok(landed >= 990 && landed < 1500, `told on arrival: ${landed} ms`);
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: MOB, spellId: 133, misses: [{ guid: ME, reason: 2 }] }));
  await settle();
  client.close?.();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(seen.length, 4, "a closed session tells nothing still in flight");
});

const ATTR6_COMBAT_TEXT = 0x40;
const spell = (extra = {}) => ({ id: 1, name: "Огненный шар", attributes: [0, 0, 0, 0, 0, 0, ATTR6_COMBAT_TEXT, 0], effects: [2, 0, 0], ...extra });

test("COMBAT_TEXT_UPDATE(\"SPELL_CAST\"): the combat-text unit's casts of AttributesEx6 0x40 spells (0x007519e0 / 0x0074d700)", () => {
  const go = (extra = {}) => ({ casterGuid: ME, casterUnit: ME, castFlags: 0, casterIsUnit: true, ...extra });
  assert.equal(combatTextSpellCast(go(), spell(), ME), "Огненный шар");
  assert.equal(combatTextSpellCast(go(), spell(), 0n), undefined, "before CombatTextSetActiveUnit: nothing");
  assert.equal(combatTextSpellCast(go(), spell({ attributes: [0, 0, 0, 0, 0, 0, 0, 0] }), ME), undefined, "no Ex6 0x40");
  assert.equal(combatTextSpellCast(go({ casterUnit: MOB }), spell(), ME), undefined, "another caster");
  assert.equal(combatTextSpellCast(go(), undefined, ME), undefined, "no row");
  assert.equal(combatTextSpellCast(go({ casterIsUnit: false }), spell(), ME), undefined, "0x007519e0 wants a unit in view");
  assert.equal(combatTextSpellCast(go(), spell({ attributes: [0x100, 0, 0, 0, 0, 0, ATTR6_COMBAT_TEXT, 0] }), ME), undefined,
    "kept out of the log (0x0074d3f0)");
  assert.equal(combatTextSpellCast(go(), spell({ effects: [33, 0, 0] }), ME), undefined, "a lock opener (0x0074d3d0)");
  // CAST_FLAG_PENDING: 0x0074d700 compares the packet's first caster GUID and tests nothing else.
  assert.equal(combatTextSpellCast(go({ castFlags: 1, casterIsUnit: false }), spell({ effects: [33, 0, 0] }), ME), "Огненный шар");
  assert.equal(combatTextSpellCast(go({ castFlags: 1, casterGuid: 0x4000000000000001n }), spell(), ME), undefined, "an item cast's first GUID");
  // …unless AttributesEx7 0x80000000 sends a pending GO through 0x007519e0 after all.
  assert.equal(combatTextSpellCast(go({ castFlags: 1, casterIsUnit: false }),
    spell({ attributes: [0, 0, 0, 0, 0, 0, ATTR6_COMBAT_TEXT, 0x80000000] }), ME), undefined);
  assert.equal(combatTextUnitGuid("0x0000000000000010"), 0x10n);
  assert.equal(combatTextUnitGuid(undefined), 0n);
  assert.equal(combatTextUnitGuid("player"), 0n);
});

test("live: CombatTextSetActiveUnit then a GO fires COMBAT_TEXT_UPDATE(\"SPELL_CAST\", name) after SPELL_CAST_SUCCESS", async () => {
  const { client, connection } = await travelClient([], ME);
  client.state.objects.set(ME, { ...client.state.objects.get(ME), typeId: 4 });
  const fired = [];
  const log = new FrameXmlCombatLogLive({
    world: () => client,
    spell: (id) => (id === 133 ? spell({ id: 133, castTime: 0 }) : undefined),
    name: () => undefined,
    reaction: () => -1,
    targetGuid: () => undefined,
    focusGuid: () => undefined,
    monotonic: () => 0,
    now: () => 1700000000123,
  });
  log.attach({ fire: (name, ...args) => { fired.push([name, ...(name === "COMBAT_TEXT_UPDATE" ? args : [args[1]])]); return 1; } });
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: ME, spellId: 133 }));
  await settle();
  assert.ok(!fired.some(([name]) => name === "COMBAT_TEXT_UPDATE"), "no combat-text unit yet");
  const seam = { combatLog: log, unitGuid: (unit) => (unit === "player" ? "0x0000000000000010" : undefined) };
  FRAMEXML_COMBAT_LOG_BINDINGS.CombatTextSetActiveUnit(seam, ["Player"]);
  fired.length = 0;
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: ME, spellId: 133 }));
  await settle();
  assert.deepEqual(fired.filter(([name]) => name !== "COMBAT_LOG_EVENT"), [
    ["COMBAT_LOG_EVENT_UNFILTERED", "SPELL_CAST_SUCCESS"],
    ["COMBAT_TEXT_UPDATE", "SPELL_CAST", "Огненный шар"],
  ]);
  FRAMEXML_COMBAT_LOG_BINDINGS.CombatTextSetActiveUnit(seam, ["nobody"]);
  fired.length = 0;
  connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: ME, spellId: 133 }));
  await settle();
  assert.ok(!fired.some(([name]) => name === "COMBAT_TEXT_UPDATE"), "a token naming nobody clears it");
  log.detach();
  client.close?.();
  assert.ok(new PacketWriter());
});
