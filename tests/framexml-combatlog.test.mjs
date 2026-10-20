import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlCombatLogBuffer, FRAMEXML_COMBAT_LOG_BINDINGS, frameXmlCombatLogFlagsMatch } from "../dist/code/browser/framexml/FrameXmlCombatLog.js";
import { FrameXmlCombatLogCastRules, CAST_LOG_REPEAT_MS } from "../dist/code/browser/framexml/FrameXmlCombatLogCasts.js";
import { combatLogLimitCategoryText, SPELL_FAILED_TOO_MANY_OF_ITEM } from "../dist/code/browser/framexml/FrameXmlCombatLogFailed.js";
import { FrameXmlCombatLogLive } from "../dist/code/browser/framexml/FrameXmlCombatLogLive.js";
import { ITEM_LIMIT_CATEGORIES_ROUTE_PATH, ITEM_LIMIT_CATEGORIES_ROUTE_VERSION, itemLimitCategoriesFrom } from "../dist/code/browser/ItemLimitCategoryClient.js";
import { CATALOG_ROUTES } from "../dist/code/gateway/CatalogRoutes.js";
import { parseFixed } from "../dist/code/gateway/DbcFixed.js";
import { ITEM_LIMIT_CATEGORIES_VERSION, ITEM_LIMIT_CATEGORY_LAYOUT, itemLimitCategoryCatalog } from "../dist/code/gateway/ItemLimitCategoryMetadata.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { castFailureWords } from "../dist/code/world/CastFailureWords.js";
import { CL } from "../dist/code/world/CombatEventModel.js";
import { formatGlobalStringByName } from "../dist/code/world/GlobalStringFormat.js";
import { castFailedPacket, settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-combatlog-casts.test.mjs
{
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
}

// ── framexml-combatlog-failed.test.mjs
{
// 3.01 (05.10, 05.10-3.01): SPELL_CAST_FAILED's remaining rules by Wow.exe 3.3.5a's 0x00808200
// (.runtime/re-2026-10-02/a2-m8/d2.c; byte probes .runtime/re-2026-10-05/l301-tails/):
// - TOO_MANY_OF_ITEM (129) with a limit category whose ItemLimitCategory row is known: game error 0x272
//   ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS (quantity, name), written past the repeat rules (case 0x81,
//   0x00808aa5 → 0x005216f0, 0x00808ac3 → 0x00751ad0);
// - the auto-repeat rule compares the autoRangedCombat controller's wanted spell (0x00d397cc), and 0x007fe190's
//   three callers (StopAttack 0x006e1660, the swing 0x006e2610, the controller's shot 0x006e2be0) forget its
//   remembered result;
// - the words are the error frame's (`local_10`); none — no entry (0x00751ad0 wants text);
// - the client's own refusal (0x00809f80 → 0x00808200) is written like a server's.

const ME = 0x10n;
const AUTO_SHOT = 75;
const CONJURE = 759;
const SHOT = { id: AUTO_SHOT, name: "Автоматическая стрельба", attributes: [0x2, 0, 0, 0, 0, 0, 0, 0], effects: [2, 0, 0], castTime: 0 };
const GEM = { id: CONJURE, name: "Сотворение самоцвета маны", attributes: [0, 0, 0, 0, 0, 0, 0, 0], effects: [24, 0, 0], castTime: 3000 };
const MANA_GEM_CATEGORY = 4;
const ROWS = new Map([[MANA_GEM_CATEGORY, { name: "Самоцвет маны", quantity: 1 }]]);

test("rules: a forced refusal (TOO_MANY_OF_ITEM with its row) passes the repeat tests, not 0x00751ad0's own", () => {
  const rules = new FrameXmlCombatLogCastRules();
  assert.equal(rules.failed(CONJURE, 129, 0, undefined, GEM, true), true);
  assert.equal(rules.failed(CONJURE, 129, 500, undefined, GEM, true), true, "within 3 s: still written");
  assert.equal(rules.failed(CONJURE, 129, 900, undefined, GEM), false, "the plain path is quiet — the state was kept");
  assert.equal(rules.failed(AUTO_SHOT, 129, 0, AUTO_SHOT, SHOT, true), true);
  assert.equal(rules.failed(AUTO_SHOT, 129, 10_000, AUTO_SHOT, SHOT, true), true, "the auto-repeat rule too");
  assert.equal(rules.failed(CONJURE, 129, 0, undefined, { ...GEM, attributes: [0x80, 0, 0, 0, 0, 0, 0, 0] }, true), false,
    "ATTR0 0x180 stays out");
});

test("rules: 0x007fe190 forgets the auto-repeat result only", () => {
  const rules = new FrameXmlCombatLogCastRules();
  assert.equal(rules.failed(AUTO_SHOT, 63, 0, AUTO_SHOT, SHOT), true);
  assert.equal(rules.failed(AUTO_SHOT, 63, 10_000, AUTO_SHOT, SHOT), false);
  rules.autoRepeatReset();
  assert.equal(rules.failed(AUTO_SHOT, 63, 20_000, AUTO_SHOT, SHOT), true, "after a reset: written");
  rules.autoRepeatReset();
  assert.equal(rules.failed(AUTO_SHOT, 63, 20_000 + CAST_LOG_REPEAT_MS - 1, AUTO_SHOT, SHOT), false,
    "the 3-second rule is not 0x007fe190's");
});

test("words: the limit-category sentence only for 129 with a category and a row", () => {
  const rows = (id) => ROWS.get(id);
  const text = combatLogLimitCategoryText(SPELL_FAILED_TOO_MANY_OF_ITEM, [MANA_GEM_CATEGORY], rows, formatGlobalStringByName);
  assert.equal(text, formatGlobalStringByName("ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS", [1, "Самоцвет маны"], "%d %s"));
  assert.match(text, /Самоцвет маны/);
  assert.match(text, /1/);
  assert.equal(combatLogLimitCategoryText(129, undefined, rows, formatGlobalStringByName), undefined, "no tail");
  assert.equal(combatLogLimitCategoryText(129, [0], () => ({ name: "x", quantity: 1 }), formatGlobalStringByName), undefined,
    "category 0: not looked up (0x00807f10 wants it above 0)");
  assert.equal(combatLogLimitCategoryText(129, [99], rows, formatGlobalStringByName), undefined, "no row");
  assert.equal(combatLogLimitCategoryText(130, [MANA_GEM_CATEGORY], rows, formatGlobalStringByName), undefined);
  assert.deepEqual(castFailureWords({}, () => undefined), {});
  assert.deepEqual(castFailureWords({ extra: [] }, () => ""), {});
  assert.deepEqual(castFailureWords({ extra: [4] }, () => "x"), { text: "x", extra: [4] });
});

function liveWorld({ wanted, rows = ROWS, failureText = () => "Причина" } = {}) {
  const listeners = new Map();
  const world = {
    state: { selfGuid: ME, objects: new Map([[ME, { guid: ME, typeId: 4, fields: new Map() }]]) },
    group: { groupType: 0, ownSubGroup: 0, ownFlags: 0, members: [] },
    names: new Map([[ME, "Тестовый"]]),
    auras: new Map(),
    autoRepeatSpellId: undefined,
    autoRanged: { wantedSpellId: wanted, failureResets: 0 },
    requestName() {},
    events: { on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); } },
  };
  let clock = 0;
  let prepared = 0;
  const log = new FrameXmlCombatLogLive({
    world: () => world,
    spell: (id) => ({ [AUTO_SHOT]: SHOT, [CONJURE]: GEM })[id],
    name: (guid) => world.names.get(guid),
    reaction: () => -1,
    targetGuid: () => undefined,
    focusGuid: () => undefined,
    failureText,
    limitCategory: (id) => rows.get(id),
    prepareLimitCategories: () => { prepared++; },
    monotonic: () => clock,
    now: () => 1700000000123,
  });
  const fired = [];
  log.attach({ fire: (name, ...args) => { fired.push([name, ...args]); return 1; } });
  // CombatLogGetCurrentEntry's order: …, spellId (9), spellName, school, failedType (12).
  const entries = () => fired.filter(([name]) => name === "COMBAT_LOG_EVENT_UNFILTERED")
    .map(([, , subevent, source, , , , , , spellId, , , words]) => [subevent, source, spellId, words]);
  return {
    emit: (name, value) => listeners.get(name)?.(value), entries, tick: (ms) => { clock += ms; }, world,
    prepared: () => prepared,
  };
}

const refusal = (spellId, result, more = {}) => ({ casterGuid: ME, spellId, castCount: 1, result, refusal: true, ...more });

test("live: TOO_MANY_OF_ITEM names its limit category and is written however often; without a row, the plain words", () => {
  const { emit, entries, tick, prepared } = liveWorld();
  assert.equal(prepared(), 1, "the rows are asked for at attach");
  const sentence = combatLogLimitCategoryText(129, [MANA_GEM_CATEGORY], (id) => ROWS.get(id), formatGlobalStringByName);
  emit("SPELL_CAST_RESULT", refusal(CONJURE, 129, { text: "Слишком много", extra: [MANA_GEM_CATEGORY] }));
  tick(500);
  emit("SPELL_CAST_RESULT", refusal(CONJURE, 129, { text: "Слишком много", extra: [MANA_GEM_CATEGORY] }));
  tick(500);
  // A category the client has no row for: 0x0065c290 finds none, the plain path with its repeat rule.
  emit("SPELL_CAST_RESULT", refusal(CONJURE, 129, { text: "Слишком много", extra: [77] }));
  tick(4000);
  emit("SPELL_CAST_RESULT", refusal(CONJURE, 129, { text: "Слишком много", extra: [77] }));
  assert.deepEqual(entries(), [
    ["SPELL_CAST_FAILED", "0x0000000000000010", CONJURE, sentence],
    ["SPELL_CAST_FAILED", "0x0000000000000010", CONJURE, sentence],
    ["SPELL_CAST_FAILED", "0x0000000000000010", CONJURE, "Слишком много"],
  ]);
});

test("live: the words are the event's, else failureText; none — no entry", () => {
  const { emit, entries, tick } = liveWorld({ failureText: () => undefined });
  emit("SPELL_CAST_RESULT", refusal(CONJURE, 40));
  tick(5000);
  emit("SPELL_CAST_RESULT", refusal(CONJURE, 40, { text: "" }));
  tick(5000);
  emit("SPELL_CAST_RESULT", refusal(CONJURE, 41, { text: "Прервано" }));
  assert.deepEqual(entries(), [["SPELL_CAST_FAILED", "0x0000000000000010", CONJURE, "Прервано"]]);
  const other = liveWorld();
  other.emit("SPELL_CAST_RESULT", refusal(CONJURE, 40));
  assert.deepEqual(other.entries(), [["SPELL_CAST_FAILED", "0x0000000000000010", CONJURE, "Причина"]]);
});

test("live: the auto-repeat rule follows the wanted spell and 0x007fe190's resets", () => {
  const { emit, entries, tick, world } = liveWorld({ wanted: AUTO_SHOT });
  emit("SPELL_CAST_RESULT", refusal(AUTO_SHOT, 63, { text: "Нет цели" }));
  tick(10_000);
  emit("SPELL_CAST_RESULT", refusal(AUTO_SHOT, 63, { text: "Нет цели" }));
  assert.equal(entries().length, 1, "the wanted spell's result again: quiet");
  world.autoRanged.failureResets = 2;
  tick(10_000);
  emit("SPELL_CAST_RESULT", refusal(AUTO_SHOT, 63, { text: "Нет цели" }));
  assert.equal(entries().length, 2, "after 0x007fe190: written");
  // Repeating without the controller (autoRangedCombat off): 0x00d397cc is 0, no auto-repeat rule at all.
  const plain = liveWorld({ wanted: undefined });
  plain.world.autoRepeatSpellId = AUTO_SHOT;
  plain.emit("SPELL_CAST_RESULT", refusal(AUTO_SHOT, 63, { text: "Нет цели" }));
  plain.tick(10_000);
  plain.emit("SPELL_CAST_RESULT", refusal(AUTO_SHOT, 63, { text: "Нет цели" }));
  assert.equal(plain.entries().length, 2);
});

test("live: the client's own refusal is the active player's SPELL_CAST_FAILED", () => {
  const { emit, entries } = liveWorld();
  emit("SPELL_CAST_REFUSED_LOCAL", { spellId: CONJURE, result: 105, text: "Уже идёт" });
  emit("SPELL_CAST_REFUSED_LOCAL", { spellId: CONJURE, result: 187 });
  assert.deepEqual(entries(), [["SPELL_CAST_FAILED", "0x0000000000000010", CONJURE, "Уже идёт"]]);
});

test("WorldClient: CAST_FAILED carries its words and tail; StopAttack and the swing count 0x007fe190", async () => {
  const { client, connection } = await travelClient([], ME);
  const seen = [];
  client.events.on("SPELL_CAST_RESULT", (event) => seen.push(event));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 2, spellId: CONJURE, result: 129, tail: [MANA_GEM_CATEGORY] }));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 3, spellId: CONJURE, result: 27 }));
  await settle();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].extra, [MANA_GEM_CATEGORY]);
  assert.equal(typeof seen[0].text, "string");
  assert.ok(seen[0].text.length > 0);
  assert.equal("text" in seen[1] || "extra" in seen[1], false, "DONT_REPORT: no words, no tail");
  const before = client.autoRanged.failureResets;
  client.stopAttack();
  assert.equal(client.autoRanged.failureResets, before + 1, "StopAttack 0x006e1660");
  const MOB = 0xf130000000000abcn;
  client.state.move(MOB, { flags: 0, position: { x: 11, y: 20, z: 30, orientation: 0 } });
  client.state.objects.get(MOB).typeId = 3;
  client.state.setField(MOB, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.targetGuid = MOB;
  client.startAttack();
  assert.equal(connection.sent.some(({ opcode }) => opcode === OPCODES.CMSG_ATTACK_SWING), true);
  assert.equal(client.autoRanged.failureResets, before + 2, "the swing 0x006e2610");
  client.close?.();
});

test("WorldClient: the autoRangedCombat controller's shot counts 0x007fe190 (0x006e2df3)", async () => {
  const { client, connection } = await travelClient([], ME);
  client.state.objects.get(ME).typeId = 4;
  client.state.setField(ME, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  const MOB = 0xf130000000000abdn;
  client.state.move(MOB, { flags: 0, position: { x: 30, y: 20, z: 30, orientation: 0 } });
  client.state.objects.get(MOB).typeId = 3;
  client.state.setField(MOB, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.knownSpells = [{ id: AUTO_SHOT, slot: 0 }];
  client.setAutoRepeatSpellIds([AUTO_SHOT]);
  client.setAutoRangedCombatSpellIds([AUTO_SHOT]);
  client.autoRangedCombat = () => true;
  client.autoRangedLimits = () => ({ min: 8, max: 35 });
  client.autoRanged.schedule = { start: () => ({}), stop: () => {} };
  await settle();
  client.selectTarget(MOB);
  const before = client.autoRanged.failureResets;
  client.startAttack();
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL).length, 1, "the shot");
  assert.equal(client.autoRanged.wantedSpellId, AUTO_SHOT);
  assert.equal(client.autoRanged.failureResets, before + 1);
  client.close?.();
});

test("route: ItemLimitCategory rows travel as [id, name, quantity, flags]; the two versions agree", () => {
  assert.equal(ITEM_LIMIT_CATEGORIES_ROUTE_VERSION, ITEM_LIMIT_CATEGORIES_VERSION);
  assert.equal(ITEM_LIMIT_CATEGORIES_ROUTE_PATH, "/dbc/item-limit-categories?v=1");
  const route = CATALOG_ROUTES.find((candidate) => candidate.pathname === "/dbc/item-limit-categories");
  assert.equal(route?.version, ITEM_LIMIT_CATEGORIES_VERSION);
  // A synthetic ItemLimitCategory.dbc: two rows, the ruRU name in its locale slot.
  const { fieldCount, recordSize } = ITEM_LIMIT_CATEGORY_LAYOUT;
  const strings = Buffer.from("\0Самоцвет маны\0Healthstone\0", "utf8");
  const gem = 1;
  const stone = 1 + Buffer.byteLength("Самоцвет маны\0", "utf8");
  const data = Buffer.alloc(20 + 2 * recordSize + strings.length);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(2, 4);
  data.writeUInt32LE(fieldCount, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(strings.length, 16);
  const row = (index, id, slot, offset, quantity, flags) => {
    const base = 20 + index * recordSize;
    data.writeUInt32LE(id, base);
    data.writeUInt32LE(offset, base + (1 + slot) * 4);
    data.writeUInt32LE(quantity, base + 18 * 4);
    data.writeUInt32LE(flags, base + 19 * 4);
  };
  row(0, 4, 8, gem, 1, 0);
  row(1, 2, 0, stone, 3, 1);
  strings.copy(data, 20 + 2 * recordSize);
  const catalog = itemLimitCategoryCatalog(parseFixed("ItemLimitCategory", data, ITEM_LIMIT_CATEGORY_LAYOUT), "ruRU");
  assert.deepEqual(catalog, { version: 1, categories: [[4, "Самоцвет маны", 1, 0], [2, "Healthstone", 3, 1]] });
  const rows = itemLimitCategoriesFrom(JSON.parse(JSON.stringify(catalog)));
  assert.deepEqual(rows?.get(4), { name: "Самоцвет маны", quantity: 1, flags: 0 });
  assert.equal(itemLimitCategoriesFrom({ ...catalog, version: 2 }), undefined, "another version");
  assert.equal(itemLimitCategoriesFrom({ version: 1, categories: [[4, "x", 1]] }), undefined, "a short row");
  assert.equal(itemLimitCategoriesFrom({ version: 1, categories: [[4, "x", 1, 0, 9]] }), undefined, "a long row");
});
}

// ── framexml-combatlog-seam.test.mjs
{
// 3.01 slices B and E: the buffer's cursor and filters (Wow.exe 0x0074fa70, 0x0074fae0, 0x0074fc20,
// 0x0074ff70, 0x0074e1a0, 0x0074d600), the flags (0x0074dcb0) and the firing order (0x0074f910).

const ME = 0x10n;
const PARTY = 0x21n;
const MOB = 0xf130000000000abcn;
const PET = 0xf140000000000defn;

function filled(buffer, event, source, dest, sourceFlags, destFlags, time) {
  const entry = buffer.next();
  Object.assign(entry, { event, source, dest, sourceFlags, destFlags, time, spellId: 0 });
  buffer.push(entry);
  return entry;
}

function three() {
  const buffer = new FrameXmlCombatLogBuffer({ spell: () => undefined });
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 10);
  filled(buffer, CL.SPELL_DAMAGE, MOB, ME, 0xa48, 0x511, 11);
  filled(buffer, CL.SPELL_HEAL, ME, ME, 0x511, 0x511, 12);
  return buffer;
}

const event = (buffer) => buffer.args(buffer.current())[1];

test("the cursor: index 0 is the newest, -1 steps back to older, 1..n count from the oldest", () => {
  const buffer = three();
  assert.equal(buffer.numEntries(false), 3);
  assert.equal(buffer.setCurrent(0, false), true);
  assert.equal(event(buffer), "SPELL_HEAL");
  assert.equal(buffer.advance(-1, false), true);
  assert.equal(event(buffer), "SPELL_DAMAGE");
  assert.equal(buffer.advance(-1, false), true);
  assert.equal(event(buffer), "SWING_DAMAGE");
  assert.equal(buffer.advance(-1, false), false, "past the oldest: no current entry");
  assert.equal(buffer.current(), undefined);
  assert.equal(buffer.setCurrent(1, false), true);
  assert.equal(event(buffer), "SWING_DAMAGE");
  assert.equal(buffer.advance(2, false), true);
  assert.equal(event(buffer), "SPELL_HEAL");
  assert.equal(buffer.setCurrent(-2, false), true);
  assert.equal(event(buffer), "SWING_DAMAGE");
  assert.equal(buffer.setCurrent(4, false), false);
});

test("filters: events by name, masks per group, GUIDs, any filter passes; ignoreFilter counts all", () => {
  const buffer = three();
  buffer.addFilter("SPELL_DAMAGE,SPELL_HEAL", undefined, undefined);
  assert.equal(buffer.numEntries(false), 2);
  assert.equal(buffer.numEntries(true), 3);
  buffer.resetFilter();
  // COMBATLOG_FILTER_MINE as source.
  buffer.addFilter(undefined, 0x4511, undefined);
  assert.equal(buffer.numEntries(false), 2);
  buffer.addFilter(undefined, undefined, "0x0000000000000010");
  assert.equal(buffer.numEntries(false), 3, "the second filter (a GUID) takes the mob's spell at me");
  buffer.resetFilter();
  buffer.addFilter("", 0x4511, undefined);
  assert.equal(buffer.numEntries(false), 0, "an empty list names no event");
  assert.throws(() => buffer.addFilter(undefined, 0x11, undefined), /incomplete filter for srcMask/);
  assert.throws(() => buffer.addFilter(undefined, undefined, 0x500), /incomplete filter for dstMask/);
  buffer.resetFilter();
  buffer.addFilter(undefined, 0x10000, undefined);
  assert.equal(buffer.numEntries(false), 0, "a special bit alone is complete, and nothing here is the target");
  assert.equal(buffer.setCurrent(0, false), false);
  assert.equal(buffer.setCurrent(0, true), true, "ignoreFilter walks everything");
});

test("CombatLog_Object_IsA and the mask test: every group, or any special bit", () => {
  assert.equal(frameXmlCombatLogFlagsMatch(0x511, 0x4511), true);
  assert.equal(frameXmlCombatLogFlagsMatch(0xa48, 0x4511), false);
  assert.equal(frameXmlCombatLogFlagsMatch(0x10a48, 0x10000), true);
  const call = (name, ...args) => FRAMEXML_COMBAT_LOG_BINDINGS[name]({}, args);
  assert.deepEqual(call("CombatLog_Object_IsA", 0x511, 0x4511), [1]);
  assert.deepEqual(call("CombatLog_Object_IsA", 0xa48, 0x4511), []);
  assert.deepEqual(call("CombatLog_Object_IsA", -2147483648, -65536), [1], "NONE against the special mask, signed");
  assert.deepEqual(call("CombatLogGetNumEntries"), [0], "no log: empty");
  assert.deepEqual(call("CombatLogGetRetentionTime"), [300]);
});

test("retention by time, then the count cap; the cursor never points at a dropped entry", () => {
  const buffer = new FrameXmlCombatLogBuffer({ spell: () => undefined }, 4);
  buffer.retention = 30;
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 0);
  buffer.setCurrent(1, true);
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 10);
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 40);
  assert.equal(buffer.size, 2, "the entry from t=0 is older than 30 s at t=40");
  assert.equal(buffer.current(), undefined);
  for (let time = 41; time < 50; time++) filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, time);
  assert.equal(buffer.size, 4);
  buffer.setCurrent(1, true);
  assert.equal(buffer.current().time, 46);
  buffer.clear();
  assert.equal(buffer.numEntries(true), 0);
});

function object(guid, typeId, fields = {}) {
  const map = new Map();
  for (const [name, value] of Object.entries(fields)) {
    const offset = UPDATE_FIELDS[name].offset;
    map.set(offset, Number(BigInt(value) & 0xffffffffn));
    if (UPDATE_FIELDS[name].type === "LONG") map.set(offset + 1, Number(BigInt(value) >> 32n));
  }
  return { guid, typeId, fields: map };
}

function liveWorld() {
  const listeners = new Map();
  const objects = new Map([
    [ME, object(ME, 4, { UNIT_FIELD_HEALTH: 100 })],
    [PARTY, object(PARTY, 4)],
    [MOB, object(MOB, 3, { UNIT_FIELD_HEALTH: 50 })],
    [PET, object(PET, 3, { UNIT_FIELD_SUMMONEDBY: ME, UNIT_FIELD_CREATEDBY: ME })],
  ]);
  const world = {
    state: { selfGuid: ME, objects },
    group: { groupType: 0, ownSubGroup: 0, ownFlags: 0, members: [{ guid: PARTY, subGroup: 0, flags: 2 }] },
    raidTargets: new Map([[7, MOB]]),
    names: new Map([[ME, "Тестовый"], [PARTY, "Друг"]]),
    auras: new Map(),
    requested: [],
    requestName(guid) { this.requested.push(guid); },
    events: {
      on(name, listener) {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      },
    },
  };
  return { world, emit: (name, value) => listeners.get(name)?.(value) };
}

function liveLog({ target, listeners = { filtered: 1, unfiltered: 1 } } = {}) {
  const { world, emit } = liveWorld();
  let clock = 0;
  const log = new FrameXmlCombatLogLive({
    world: () => world,
    spell: (id) => (id === 133 ? { name: "Огненный шар", schoolMask: 4, attributes: [0, 0, 0, 0, 0, 0, 0, 0] } : undefined),
    name: (guid) => (guid === MOB ? "Кобольд" : guid === PET ? "Волк" : world.names.get(guid)),
    reaction: (unit) => (unit.guid === MOB ? -1 : 1),
    targetGuid: () => target,
    focusGuid: () => undefined,
    monotonic: () => clock,
    now: () => 1700000000123,
  });
  const fired = [];
  log.attach({ fire: (name, ...args) => {
    fired.push([name, ...args]);
    return name === "COMBAT_LOG_EVENT" ? listeners.filtered : listeners.unfiltered;
  } });
  return { log, world, emit, fired, tick: (ms) => { clock += ms; } };
}

test("0x0074dcb0 flags: mine, my pet, a hostile grouped-icon target, a party member with MAINTANK, none", () => {
  const { log } = liveLog({ target: MOB });
  assert.equal(log.flags(ME), 0x511);
  assert.equal(log.flags(PET), 0x1111, "a summoned unit of mine: PET, control player, mine, friendly");
  assert.equal(log.flags(MOB), (0xa48 | 0x10000 | (0x100000 << 7)) >>> 0, "hostile NPC outsider, target, raid icon 8 while grouped");
  assert.equal(log.flags(PARTY), 0x40512, "party, friendly, player, main tank");
  assert.equal(log.flags(0n), 0x80000000);
});

test("firing: COMBAT_LOG_EVENT when the filter passes, then _UNFILTERED; the epoch timestamp; unknown names queried", () => {
  const { emit, fired, log, world } = liveLog();
  emit("UNIT_COMBAT", { source: "spellDamage", log: {
    casterGuid: ME, targetGuid: MOB, spellId: 133, damage: 10, overkill: 0, schoolMask: 4, absorbed: 0, resisted: 0,
    blocked: 0, periodic: false, critical: false, hitInfo: 0,
  } });
  assert.deepEqual(fired.map((entry) => entry[0]), ["COMBAT_LOG_EVENT", "COMBAT_LOG_EVENT_UNFILTERED"]);
  assert.deepEqual(fired[0].slice(1, 10), [1700000000.123, "SPELL_DAMAGE", "0x0000000000000010", "Тестовый", 0x511,
    "0xF130000000000ABC", "Кобольд", (0xa48 | (0x100000 << 7)) >>> 0, 133]);
  fired.length = 0;
  log.buffer.addFilter("SWING_DAMAGE", undefined, undefined);
  emit("PARTY_KILL", { killerGuid: PARTY, victimGuid: 0xf130000000000999n });
  assert.deepEqual(fired.map((entry) => entry[0]), ["COMBAT_LOG_EVENT_UNFILTERED"], "the filter stops only the filtered event");
  assert.deepEqual(fired[0].slice(2, 9), ["PARTY_KILL", "0x0000000000000021", "Друг", 0x40512, "0xF130000000000999", undefined, 0xa28]);
  assert.deepEqual(world.requested, [], "a player whose name is known is not queried");
  assert.equal(log.buffer.numEntries(true), 2);
});

test("lazy: an event nobody took is not built again for a second; the entries are still kept", () => {
  const { emit, fired, log, tick } = liveLog({ listeners: { filtered: 0, unfiltered: 0 } });
  const swing = { hitInfo: 2, attacker: ME, victim: MOB, damage: 5, overkill: 0, victimState: 1, blocked: 0,
    damages: [{ schoolMask: 1, damage: 5, absorbed: 0, resisted: 0 }] };
  emit("UNIT_COMBAT", { source: "melee", swing });
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.equal(fired.length, 2, "one probe per event name, then quiet");
  tick(1000);
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.equal(fired.length, 4, "probed again after a second");
  assert.equal(log.buffer.numEntries(true), 3);
});

test("a listener that registers mid-second hears the next entry when the pump can say who listens", () => {
  // 02.10 review: an add-on that registers COMBAT_LOG_EVENT_UNFILTERED on PLAYER_REGEN_DISABLED (or is
  // loaded by LoadAddOn) lost up to a second of the pull to the probe. Wow.exe fires to whoever is
  // registered at the moment of the entry (0x0074f910).
  const { world, emit } = liveWorld();
  const log = new FrameXmlCombatLogLive({
    world: () => world, spell: () => undefined, name: () => undefined, reaction: () => undefined,
    targetGuid: () => undefined, focusGuid: () => undefined, monotonic: () => 0, now: () => 1700000000123,
  });
  const registered = new Set();
  const fired = [];
  let built = 0;
  log.attach({
    listening: (name) => registered.has(name),
    fire: (name, ...args) => { built += 1; if (!registered.has(name)) return 0; fired.push([name, ...args]); return 1; },
  });
  const swing = { hitInfo: 2, attacker: ME, victim: MOB, damage: 5, overkill: 0, victimState: 1, blocked: 0,
    damages: [{ schoolMask: 1, damage: 5, absorbed: 0, resisted: 0 }] };
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.equal(built, 0, "nobody registered: no argument list is built");
  registered.add("COMBAT_LOG_EVENT_UNFILTERED");
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.deepEqual(fired.map((entry) => entry[0]), ["COMBAT_LOG_EVENT_UNFILTERED"], "the same millisecond");
  assert.equal(log.buffer.numEntries(true), 2);
});

test("0x0074d210: a creature whose template has CREATURE_TYPE_FLAG_MASK_UID is named without its counter", () => {
  // Before firing (0x0074f910) Wow.exe clears the low 24 bits of a creature or vehicle GUID whose
  // cached template type flags carry 0x4000 (SharedDefines.h CREATURE_TYPE_FLAG_MASK_UID).
  const { world, emit, fired } = liveLog();
  const MASKED = 0xf130001234000abcn; // entry 0x1234, counter 0xabc
  const PLAIN = 0xf130001235000abdn;
  world.creatureTemplates = new Map([[0x1234, { entry: 0x1234, flags: 0x4000 }], [0x1235, { entry: 0x1235, flags: 0 }]]);
  emit("PARTY_KILL", { killerGuid: ME, victimGuid: MASKED });
  emit("PARTY_KILL", { killerGuid: ME, victimGuid: PLAIN });
  // Only creature (0xF130) and vehicle (0xF150) GUIDs: a pet with the same bits keeps its counter.
  emit("PARTY_KILL", { killerGuid: ME, victimGuid: 0xf140001234000abcn });
  const kills = fired.filter((entry) => entry[0] === "COMBAT_LOG_EVENT_UNFILTERED").map((entry) => entry[6]);
  assert.deepEqual(kills, ["0xF130001234000000", "0xF130001235000ABD", "0xF140001234000ABC"]);
});

test("UNIT_DIED once per death; the first full aura list is quiet; a dispel names the removed aura's type", () => {
  const { log, world, fired } = liveLog();
  world.state.objects.get(MOB).fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  log.health(MOB);
  log.health(MOB);
  assert.deepEqual(fired.filter((entry) => entry[0] === "COMBAT_LOG_EVENT").map((entry) => entry[2]), ["UNIT_DIED"]);
  fired.length = 0;
  const aura = { slot: 0, spellId: 133, flags: 0x80, casterLevel: 1, applications: 0, casterGuid: ME };
  log.auraChanged({ guid: MOB, replaceAll: true, previous: new Map(), added: [aura], removed: [], updated: [] });
  assert.deepEqual(fired, []);
  log.auraChanged({ guid: MOB, replaceAll: false, previous: new Map([[0, aura]]), added: [], removed: [aura], updated: [] });
  log.combatFact({ source: "dispel", stolen: false, log: { casterGuid: PARTY, targetGuid: MOB, spellId: 527, dispelled: [{ spellId: 133, cleansed: false }] } });
  const events = fired.filter((entry) => entry[0] === "COMBAT_LOG_EVENT");
  assert.deepEqual(events.map((entry) => [entry[2], entry.at(-1)]), [["SPELL_AURA_REMOVED", "DEBUFF"], ["SPELL_DISPEL", "DEBUFF"]]);
});
}
