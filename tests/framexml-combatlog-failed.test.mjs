import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlCombatLogCastRules, CAST_LOG_REPEAT_MS } from "../dist/code/browser/framexml/FrameXmlCombatLogCasts.js";
import { FrameXmlCombatLogLive } from "../dist/code/browser/framexml/FrameXmlCombatLogLive.js";
import {
  combatLogLimitCategoryText, SPELL_FAILED_TOO_MANY_OF_ITEM,
} from "../dist/code/browser/framexml/FrameXmlCombatLogFailed.js";
import { formatGlobalStringByName } from "../dist/code/world/GlobalStringFormat.js";
import { castFailureWords } from "../dist/code/world/CastFailureWords.js";
import {
  ITEM_LIMIT_CATEGORIES_ROUTE_PATH, ITEM_LIMIT_CATEGORIES_ROUTE_VERSION, itemLimitCategoriesFrom,
} from "../dist/code/browser/ItemLimitCategoryClient.js";
import {
  ITEM_LIMIT_CATEGORIES_VERSION, ITEM_LIMIT_CATEGORY_LAYOUT, itemLimitCategoryCatalog,
} from "../dist/code/gateway/ItemLimitCategoryMetadata.js";
import { parseFixed } from "../dist/code/gateway/DbcFixed.js";
import { CATALOG_ROUTES } from "../dist/code/gateway/CatalogRoutes.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { castFailedPacket, settle, travelClient } from "./fixtures/world-packets.mjs";

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
