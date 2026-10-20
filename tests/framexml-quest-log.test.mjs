import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-quest-log-groups.test.mjs
{
// Plan item 3.13a/b: the displayed quest log (zone headers, collapsing, tags) and the quest-log
// extras, as the original client builds and answers them (FrameXmlQuestLog.ts, Wow.exe addresses
// there).
const {
  FrameXmlQuestLogModel, FRAMEXML_QUEST_LOG_BINDINGS, QUEST_LOG_MISSING_HEADER, frameXmlQuestLogCompare,
} = await import("../dist/code/browser/framexml/FrameXmlQuestLog.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { QUEST_LOG_NAMES_VERSION, questLogNameCatalog } = await import("../dist/code/gateway/QuestLogNameMetadata.js");
const { QUEST_LOG_NAMES_ROUTE_VERSION, questLogNameTableFrom } = await import("../dist/code/browser/QuestLogNameClient.js");

const AREAS = new Map([[12, "Элвиннский лес"], [40, "Западный Край"]]);
const SORTS = new Map([[284, "Особые"]]);
const INFOS = new Map([[1, "Группа"], [81, "Подземелье"]]);

function quest(questId, sortId, level, title, extra = {}) {
  return { questId, sortId, level, title, type: 0, flags: 0, suggestedPlayers: 0, startItem: 0, objectives: [], ...extra };
}

/** Slots in field order: 0 Elwynn L10, 1 Westfall L12, 2 «Особые» L5, 3 Elwynn L8, 4 Westfall L12 «А…». */
function fixture(overrides = {}) {
  const templates = new Map([
    [101, quest(101, 12, 10, "Волки")],
    [102, quest(102, 40, 12, "Бандиты", { type: 1, flags: 0x1000 })],
    [103, quest(103, -284, 5, "Праздник")],
    [104, quest(104, 12, 8, "Кабаны")],
    [105, quest(105, 40, 12, "Арбузы", { type: 81 })],
  ]);
  const rows = [101, 102, 103, 104, 105].map((questId, slot) => ({ slot, questId, state: 0, counters: [0, 0, 0, 0], timer: 0 }));
  const fired = [];
  let listener;
  const context = {
    rows: () => rows,
    template: (id) => templates.get(id),
    requested: [],
    requestTemplate(id) { this.requested.push(id); },
    playerLevel: () => 10,
    greenRange: () => 5,
    areaName: (id) => AREAS.get(id),
    names: {
      sortName: (id) => SORTS.get(id), infoName: (type) => INFOS.get(type),
      subscribe: (callback) => { listener = callback; return () => { listener = undefined; }; },
    },
    ...overrides,
  };
  const model = new FrameXmlQuestLogModel(context);
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  return { model, rows, templates, fired, context, names: () => listener };
}

const shape = (model) => model.list().rows.map((row) => row.header
  ? `[${row.title}${row.collapsed ? " +" : ""}]` : `${row.entry.questId}${row.hidden ? "*" : ""}`);

test("headers are the quests' ZoneOrSort, named by AreaTable or QuestSort and ordered by name; quests by level then title", () => {
  const { model } = fixture();
  assert.deepEqual(shape(model), [
    "[Западный Край]", "105", "102", "[Особые]", "103", "[Элвиннский лес]", "104", "101",
  ]);
  assert.deepEqual(model.counts(), [8, 5]);
  assert.ok(frameXmlQuestLogCompare("Арбузы", "Бандиты") < 0);
  assert.ok(frameXmlQuestLogCompare("абв", "Абв") > 0 && frameXmlQuestLogCompare("Абв", "абв") < 0, "case folded, case breaks the tie");
});

test("GetQuestLogTitle: header rows, questTag from QuestInfo, isDaily from flag 0x1000, level -1 is the player's", () => {
  const { model, templates } = fixture();
  const complete = () => undefined;
  assert.deepEqual(model.title(1, complete), ["Западный Край", 0, undefined, 0, true, false, undefined, false, 0, false]);
  assert.deepEqual(model.title(2, complete), ["Арбузы", 12, "Подземелье", 0, false, false, undefined, false, 105, false]);
  assert.deepEqual(model.title(3, complete), ["Бандиты", 12, "Группа", 0, false, false, undefined, true, 102, false]);
  assert.deepEqual(model.title(99, complete), ["", 0, undefined, 0, false, false, undefined, false, 0, false]);
  templates.set(103, quest(103, 0, 0xffff_ffff, "Масштаб"));
  assert.deepEqual(model.title(1, complete)[0], QUEST_LOG_MISSING_HEADER, "key 0 comes first, with the client's literal");
  assert.equal(model.title(2, complete)[1], 10, "a record level of -1 reads as the player's");
});

test("collapsing moves a header's quests to the tail, the first count drops, QUEST_LOG_UPDATE fires", () => {
  const { model, fired } = fixture();
  model.setCollapsed(1, true);
  assert.deepEqual(shape(model), [
    "[Западный Край +]", "[Особые]", "103", "[Элвиннский лес]", "104", "101", "105*", "102*",
  ]);
  assert.deepEqual(model.counts(), [6, 5]);
  assert.deepEqual(fired, [["QUEST_LOG_UPDATE"]]);
  assert.equal(model.title(1, () => undefined)[5], true, "isCollapsed");
  // The hidden tail is still indexable, as in the client.
  assert.equal(model.entryAt(7).questId, 105);
  model.setCollapsed(1, false);
  assert.deepEqual(model.counts(), [8, 5]);
  // 0 (or any row that is not a header) collapses / expands every header.
  model.setCollapsed(0, true);
  assert.deepEqual(model.counts(), [3, 5]);
  assert.deepEqual(shape(model).slice(0, 3), ["[Западный Край +]", "[Особые +]", "[Элвиннский лес +]"]);
  model.setCollapsed(5, false);
  assert.deepEqual(model.counts(), [8, 5]);
  model.setCollapsed("x", true);
  assert.deepEqual(model.counts(), [8, 5], "not a number: nothing");
  assert.equal(fired.length, 4);
});

test("GetQuestSortIndex is the header-list position, GetQuestLink the client's link and colours", () => {
  const { model, templates, context } = fixture();
  assert.equal(model.sortIndex(2), 1);
  assert.equal(model.sortIndex(8), 3);
  assert.equal(model.sortIndex(6), 3);
  assert.equal(model.sortIndex(99), 0);
  assert.equal(model.link(1), undefined, "a header has no link");
  assert.equal(model.link(8), "|cffffff00|Hquest:101:10|h[Волки]|h|r");
  const levelOf = (level) => { templates.set(101, quest(101, 12, level, "Волки")); return model.link(model.indexOfQuest(101)); };
  assert.match(levelOf(15), /^\|cffff2020\|Hquest:101:15\|/);
  assert.match(levelOf(13), /^\|cffff8040/);
  assert.match(levelOf(12), /^\|cffffff00/, "two above: still yellow");
  assert.match(levelOf(8), /^\|cffffff00/);
  assert.match(levelOf(7), /^\|cff40c040/);
  assert.match(levelOf(5), /^\|cff40c040/, "exactly the green range below: still green");
  assert.match(levelOf(4), /^\|cff808080/);
  assert.equal(levelOf(0xffff_ffff), "|cffffff00|Hquest:101:-1|h[Волки]|h|r", "the link keeps the record's -1");
  context.playerLevel = () => undefined;
  assert.match(levelOf(80), /^\|cffffff00/, "no player: yellow");
});

test("uncached quests are left out and asked for; the name table's arrival redraws", () => {
  const { model, templates, context, fired, names } = fixture();
  templates.delete(104);
  assert.deepEqual(model.counts(), [7, 4]);
  assert.ok(context.requested.includes(104));
  assert.equal(typeof names(), "function");
  names()();
  assert.deepEqual(fired, [["QUEST_LOG_UPDATE"]]);
  model.detach();
  assert.equal(names(), undefined, "detach unsubscribes");
});

test("the special item: SourceItemId, or with flag 0x20000 the RequiredSourceItemIds, when carried and usable", () => {
  const asked = [];
  const used = [];
  const carried = new Map([[5001, { bag: 255, slot: 23, link: "|Hitem:5001|h[Жезл]|h", texture: "Interface\\Icons\\Wand", charges: 3 }]]);
  const { model, templates } = fixture({
    findItem: (entries) => { asked.push([...entries]); return entries.map((entry) => carried.get(entry)).find(Boolean); },
    itemCooldown: () => [100, 30, 1],
    useItem: (item) => used.push(item.slot),
  });
  const index = () => model.indexOfQuest(101);
  assert.equal(model.specialItemInfo(index()), undefined, "no source item, no flag: not asked");
  assert.deepEqual(asked, []);
  templates.set(101, quest(101, 12, 10, "Волки", { startItem: 5001 }));
  assert.deepEqual(model.specialItemInfo(index()), ["|Hitem:5001|h[Жезл]|h", "Interface\\Icons\\Wand", 3]);
  assert.deepEqual(model.specialItemCooldown(index()), [100, 30, 1]);
  model.useSpecialItem(index());
  assert.deepEqual(used, [23]);
  templates.set(101, quest(101, 12, 10, "Волки", { flags: 0x20000, objectives: [{ itemDrop: 0 }, { itemDrop: 5002 }, { itemDrop: 5001 }] }));
  asked.length = 0;
  assert.deepEqual(model.specialItemInfo(index())?.[0], "|Hitem:5001|h[Жезл]|h");
  assert.deepEqual(asked, [[5002, 5001]]);
  assert.equal(model.specialItemInfo(1), undefined, "a header has none");
  assert.deepEqual(FRAMEXML_QUEST_LOG_BINDINGS.GetQuestLogSpecialItemInfo({ questLog: model }, [1]), []);
});

test("daily and completed quests; the canned seam answers the neutral values", () => {
  const words = new Array(25).fill(0);
  words[0] = 11; words[7] = 12; words[24] = 13;
  let asked = 0;
  const { model } = fixture({
    dailyQuests: () => words, completedQuests: () => new Set([7, 9]), requestCompletedQuests: () => { asked++; },
  });
  const host = { questLog: model };
  assert.deepEqual(FRAMEXML_QUEST_LOG_BINDINGS.GetDailyQuestsCompleted(host, []), [3]);
  assert.deepEqual(FRAMEXML_QUEST_LOG_BINDINGS.GetMaxDailyQuests(host, []), [25]);
  assert.deepEqual(FRAMEXML_QUEST_LOG_BINDINGS.GetQuestsCompleted(host, []), [7, 9]);
  FRAMEXML_QUEST_LOG_BINDINGS.QueryQuestsCompleted(host, []);
  assert.equal(asked, 1);
  assert.deepEqual(FRAMEXML_QUEST_LOG_BINDINGS.GetDailyQuestsCompleted({}, []), [0]);
  assert.deepEqual(FRAMEXML_QUEST_LOG_BINDINGS.GetQuestLink({}, [1]), [undefined]);
  assert.deepEqual(FRAMEXML_QUEST_LOG_BINDINGS.GetQuestSortIndex({}, [1]), [0]);
  for (const name of Object.keys(FRAMEXML_QUEST_LOG_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_QUEST_LOG_BINDINGS[name], `${name} is a seam binding`);
  }
});

test("the name route: catalog shape and the browser's validation agree", () => {
  assert.equal(QUEST_LOG_NAMES_ROUTE_VERSION, QUEST_LOG_NAMES_VERSION);
  const rows = (entries) => ({
    records: entries.length,
    int: (row) => entries[row][0],
    string: (row, field) => field === 1 + 8 ? entries[row][1] : "",
  });
  const catalog = questLogNameCatalog(rows([[284, "Особые"]]), rows([[81, "Подземелье"]]), "ruRU");
  assert.deepEqual(catalog, { version: 1, sorts: [[284, "Особые"]], infos: [[81, "Подземелье"]] });
  const table = questLogNameTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.equal(table.sorts.get(284), "Особые");
  assert.equal(table.infos.get(81), "Подземелье");
  assert.equal(questLogNameTableFrom({ ...catalog, version: 2 }), undefined);
  assert.equal(questLogNameTableFrom({ ...catalog, sorts: [[1]] }), undefined);
});

test("review: a QuestSort key arrives as the wire's u32 (QuestPackets.cpp writes uint32(QuestSortID)) and is still negative", () => {
  const { model, templates } = fixture();
  templates.set(103, quest(103, 0x1_0000_0000 - 284, 5, "Праздник"));
  assert.deepEqual(shape(model), [
    "[Западный Край]", "105", "102", "[Особые]", "103", "[Элвиннский лес]", "104", "101",
  ]);
});

test("review: the special item reads all four RequiredSourceItemIds (cache 0x1c74), not only the objectives with a creature", () => {
  const asked = [];
  const { model, templates } = fixture({ findItem: (entries) => { asked.push([...entries]); return undefined; } });
  templates.set(101, quest(101, 12, 10, "Волки", { flags: 0x20000, objectives: [], sourceItems: [0, 5002, 0, 5001] }));
  model.specialItemInfo(model.indexOfQuest(101));
  assert.deepEqual(asked, [[5002, 5001]]);
});

test("review: the list is built once per change, not once per C API call", () => {
  const { model, templates, rows, context } = fixture();
  const first = model.list();
  assert.equal(model.list(), first, "nothing changed: the same list");
  rows[0] = { ...rows[0], counters: [1, 0, 0, 0] };
  const second = model.list();
  assert.notEqual(second, first, "a counter changed");
  assert.equal(second.rows.find((row) => !row.header && row.entry.questId === 101).entry.counters[0], 1);
  model.setCollapsed(1, true);
  assert.notEqual(model.list(), second, "collapsing rebuilds");
  const third = model.list();
  templates.set(104, quest(104, 12, 8, "Кабаны"));
  assert.notEqual(model.list(), third, "a new cache record rebuilds");
  const fourth = model.list();
  context.playerLevel = () => 11;
  assert.notEqual(model.list(), fourth, "the player's level rebuilds");
});

test("review: the name compare folds as 0x0076e7a0/0x0076eab0 do — to upper case, accents and ё stripped", () => {
  assert.ok(frameXmlQuestLogCompare("Ёж", "Дом") > 0, "Ё sorts as Е, after Д");
  assert.ok(frameXmlQuestLogCompare("ёж", "жук") < 0, "ё folds to Ё, and so to Е, before Ж");
  assert.ok(frameXmlQuestLogCompare("ёж", "еж") > 0 && frameXmlQuestLogCompare("еж", "ёж") < 0, "ё after е only as a tie");
  assert.ok(frameXmlQuestLogCompare("_a", "b") > 0, "folded to upper case: '_' (0x5f) is after 'B'");
  assert.ok(frameXmlQuestLogCompare("Éa", "Fa") < 0, "É sorts as E");
  assert.equal(frameXmlQuestLogCompare("Волки", "Волки"), 0);
});

test("review: a header that leaves the log forgets its collapse (0x005e6940 carries bits only for the previous headers)", () => {
  const { model, rows } = fixture();
  model.setCollapsed(1, true); // [Западный Край]: 102, 105
  const saved = rows.splice(0, rows.length, ...rows.filter((row) => row.questId !== 102 && row.questId !== 105));
  assert.deepEqual(shape(model).slice(0, 1), ["[Особые]"]);
  rows.splice(0, rows.length, ...saved);
  assert.deepEqual(shape(model).slice(0, 3), ["[Западный Край]", "105", "102"], "back as a new header: expanded");
});

test("review: GetQuestTimers/GetQuestIndexForTimer walk every row, the collapsed tail included (0x005e6240, 0x005e4fb0)", async () => {
  const { FRAMEXML_MECHANICS_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlMechanics.js");
  const { model } = fixture();
  model.setCollapsed(1, true); // [Западный Край +] [Особые] 103 [Элвиннский лес] 104 101 | 105* 102*
  const host = {
    questLogEntryCount: () => model.counts(),
    questLogTimeLeft: (index) => model.entryAt(index)?.questId === 102 ? 42 : undefined,
  };
  assert.deepEqual(FRAMEXML_MECHANICS_BINDINGS.GetQuestTimers(host, []), [42]);
  assert.deepEqual(FRAMEXML_MECHANICS_BINDINGS.GetQuestIndexForTimer(host, [1]), [8]);
});

test("follow-up: SMSG_QUERY_QUESTS_COMPLETED_RESPONSE raises QUEST_QUERY_COMPLETE after the list is replaced (0x005b5190)", async () => {
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const { OPCODES } = await import("../dist/code/generated/opcodes.js");
  const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
  const { createLiveFrameXmlQuestLog } = await import("../dist/code/browser/framexml/FrameXmlQuestLogLive.js");
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array() },
      { opcode: OPCODES.SMSG_QUERY_QUESTS_COMPLETED_RESPONSE, payload: new PacketWriter().u32(2).u32(7).u32(9).toUint8Array() },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const model = createLiveFrameXmlQuestLog({
    world: () => client, rows: () => [], template: () => undefined, playerLevel: () => 10, areaName: () => undefined,
    itemLink: () => undefined, itemTexture: () => undefined, itemCooldown: () => [0, 0, 1],
  });
  const fired = [];
  let seen;
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); seen ??= model.completedQuests(); return 1; } });
  await client.loginCharacter(1n);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(fired, [["QUEST_QUERY_COMPLETE"]], "once, no arguments");
  assert.deepEqual(seen, [7, 9], "GetQuestsCompleted already answers the new list when the event fires");
  model.detach();
  client.events.emit("QUESTS_COMPLETED", {});
  assert.equal(fired.length, 1, "detach unsubscribes");
});

test("the live seam indexes the displayed log: headers, selection by quest, watches, Expand/Collapse", () => {
  const selfGuid = 0x101n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  const daily = UPDATE_FIELDS.PLAYER_FIELD_DAILY_QUESTS_1.offset;
  const fields = new Map([[base, 101], [base + stride, 102], [base + 2 * stride, 104], [daily, 777], [daily + 3, 555],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 9]]);
  const object = { guid: selfGuid, typeId: 4, fields };
  const templates = new Map([
    [101, { ...quest(101, 12, 10, "Волки"), objectives: [], itemObjectives: [], rewardItems: [], rewardChoiceItems: [], details: "D101", objectivesText: "O101" }],
    [102, { ...quest(102, 40, 12, "Бандиты"), objectives: [], itemObjectives: [], rewardItems: [], rewardChoiceItems: [], details: "D102", objectivesText: "O102" }],
    [104, { ...quest(104, 12, 8, "Кабаны"), objectives: [], itemObjectives: [], rewardItems: [], rewardChoiceItems: [], details: "D104", objectivesText: "O104" }],
  ]);
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, object]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(),
    creatureTemplates: new Map(), gameObjectTemplates: new Map(), questTemplates: templates, questPoi: new Map(),
    completedQuests: new Set([3, 4]), cooldownRemaining: () => 0, currentServerTime: () => 100, queryQuest() {},
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    mapSource: { metadata: () => ({ areas: [...AREAS].map(([id, name]) => ({ id, name })), maps: [] }) },
    questLogNames: { sortName: (id) => SORTS.get(id), infoName: (type) => INFOS.get(type) },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  // [Западный Край] 102 [Элвиннский лес] 104 101
  assert.deepEqual(call("GetNumQuestLogEntries"), [5, 3]);
  assert.deepEqual(call("GetQuestLogTitle", 1).slice(0, 6), ["Западный Край", 0, undefined, 0, true, false]);
  assert.deepEqual(call("GetQuestLogTitle", 4)[8], 104);
  call("SelectQuestLogEntry", 5);
  assert.deepEqual(call("GetQuestLogSelection"), [5]);
  assert.deepEqual(call("GetQuestLogQuestText"), ["D101", "O101"]);
  assert.deepEqual(call("GetQuestIndexForWatch", 1), [5], "the first watched slot (101) at its displayed line");
  fired.length = 0;
  call("CollapseQuestHeader", 1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]]);
  // [Западный Край +] [Элвиннский лес] 104 101 | 102
  assert.deepEqual(call("GetNumQuestLogEntries"), [4, 3]);
  assert.deepEqual(call("GetQuestLogSelection"), [4], "the selection follows its quest");
  assert.deepEqual(call("GetQuestLogQuestText"), ["D101", "O101"]);
  assert.deepEqual(call("GetQuestLogTitle", 5)[8], 102, "the collapsed quest sits in the tail");
  assert.deepEqual(call("GetQuestSortIndex", 5), [1]);
  call("ExpandQuestHeader", 0);
  assert.deepEqual(call("GetNumQuestLogEntries"), [5, 3]);
  assert.deepEqual(call("GetQuestLink", 2), ["|cffff8040|Hquest:102:12|h[Бандиты]|h|r"]);
  assert.deepEqual(call("GetDailyQuestsCompleted"), [2]);
  assert.deepEqual(call("GetQuestsCompleted"), [3, 4]);
  seam.detach();
});
}

// ── framexml-quest-log-headers-canned.test.mjs
{
// Plan item 3.13 (04.10, L6): the canned seam's quest log with the client's zone headers once its quests name
// a zone (FrameXmlQuestLog.ts over CannedQuest.zone), and SelectQuestLogEntry on a header row, which Wow.exe
// 3.3.5a 12340 ignores (0x5dffa0: a header leaves the selected quest id; only a row past the list clears it;
// read 2026-10-04) — in the canned and the live seam.

const { CannedWorldSeam, CANNED_QUEST_ZONE_NAMES } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];

test("canned quests with zones: the client's headers, counts, watch indices and collapse", () => {
  assert.equal(CANNED_QUEST_ZONE_NAMES[12], "Элвиннский лес");
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, [
    { questId: 101, zone: 12, level: 60, title: "Волки" },
    { questId: 102, zone: 40, level: 62, title: "Бандиты", daily: true },
    { questId: 104, zone: 12, level: 58, title: "Кабаны", watched: false },
  ]);
  const fired = [];
  seam.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 0 });
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [5, 3]);
  const titles = () => [1, 2, 3, 4, 5].map((index) => {
    const [title, , , , header] = call(seam, "GetQuestLogTitle", index);
    return header ? `#${title}` : title;
  });
  assert.deepEqual(titles(), ["#Западный Край", "Бандиты", "#Элвиннский лес", "Кабаны", "Волки"]);
  assert.deepEqual(call(seam, "GetQuestLogTitle", 2).slice(7, 9), [true, 102], "isDaily, questId");
  assert.deepEqual(call(seam, "GetNumQuestWatches"), [2]);
  assert.deepEqual(call(seam, "GetQuestIndexForWatch", 1), [2], "a displayed row");
  assert.deepEqual(call(seam, "GetQuestIndexForWatch", 2), [5]);
  call(seam, "SelectQuestLogEntry", 4);
  call(seam, "SelectQuestLogEntry", 3);
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [4], "a header leaves the selection");
  call(seam, "CollapseQuestHeader", 1);
  assert.ok(fired.includes("QUEST_LOG_UPDATE"));
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [4, 3]);
  assert.deepEqual(titles(), ["#Западный Край", "#Элвиннский лес", "Кабаны", "Волки", "Бандиты"], "the collapsed tail");
  // 3.13: the selection is the quest (Кабаны, 104), as the live seam and Wow.exe keep it: its row moved up.
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [3], "the selected quest's new row");
  assert.equal(call(seam, "GetQuestLogTitle", call(seam, "GetQuestLogSelection")[0])[8], 104);
  call(seam, "ExpandQuestHeader", 0);
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [5, 3]);
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [4], "and back with the expand");
  call(seam, "SelectQuestLogEntry", 9);
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [0], "a row past the list clears it");
  seam.detach();
});

test("canned quests without zones keep the plain canned order", () => {
  const seam = new CannedWorldSeam();
  assert.equal(seam.questLog, undefined);
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [1, 1]);
  assert.equal(call(seam, "GetQuestLogTitle", 1)[4], false);
  seam.setQuestTemplate(9001, { zone: 12 });
  assert.ok(seam.questLog, "a zone given later brings the headers");
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [2, 1]);
});

test("the live seam: SelectQuestLogEntry on a header keeps the selected quest", () => {
  const selfGuid = 0x10n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  const fields = new Map([[base, 100], [base + stride, 101]]);
  const template = (questId, title, sortId) => ({ questId, title, sortId, level: 10, type: 0, flags: 0, objectives: [], itemObjectives: [] });
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    questTemplates: new Map([[100, template(100, "А", 0)], [101, template(101, "Б", 12)]]),
    events: { on: () => () => {} }, queryQuest() {},
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  // Header «Missing header!» (key 0) first, then key 12.
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [4, 2]);
  call(seam, "SelectQuestLogEntry", 2);
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [2]);
  call(seam, "SelectQuestLogEntry", 1);
  call(seam, "SelectQuestLogEntry", 3);
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [2], "headers leave it");
  call(seam, "SelectQuestLogEntry", 9);
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [0], "a row past the list clears it");
});
}

// ── framexml-quest-log-selection.test.mjs
{
// Plan item 3.13, review of L6 (04.10): the quest log selection with zone headers, as the stock QuestLogFrame,
// WatchFrame and the abandon/share buttons drive it on the live seam. Wow.exe 3.3.5a 12340, read 2026-10-04 from the
// bytes (descriptions only):
// - SelectQuestLogEntry (Lua 0x5e02f0) passes index − 1 to 0x5dffa0: an index outside the rows clears the selection,
//   a header row leaves it as it was, a quest row stores that quest's id in 0x00c23ad8.
// - GetQuestLogSelection (0x5df0a0 → 0x5debd0) answers 1 + the row of that quest id among all rows, the collapsed tail
//   included, 0 when it is not in the log; SetAbandonQuest (0x5df0d0) copies 0x00c23ad8 to 0x00c23adc and
//   GetAbandonQuestName (0x5df0e0) names the quest id kept there — the abandon target is a quest, not a row.

const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const AREAS = new Map([[12, "Элвиннский лес"], [40, "Западный Край"]]);
const SHARABLE = 0x8;

function quest(questId, sortId, level, title) {
  return {
    questId, sortId, level, title, type: 0, flags: SHARABLE, suggestedPlayers: 0, startItem: 0, objectives: [],
    itemObjectives: [], rewardItems: [], rewardChoiceItems: [], details: `D${questId}`, objectivesText: `O${questId}`,
  };
}

/** Slots 0 «Волки» (Elwynn), 1 «Бандиты» (Westfall), 2 «Кабаны» (Elwynn); a party of one other player. */
function fixture() {
  const selfGuid = 0x101n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  const fields = new Map([[base, 101], [base + stride, 102], [base + 2 * stride, 104], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 9]]);
  const calls = [];
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(),
    creatureTemplates: new Map(), gameObjectTemplates: new Map(), questPoi: new Map(),
    questTemplates: new Map([[101, quest(101, 12, 10, "Волки")], [102, quest(102, 40, 12, "Бандиты")], [104, quest(104, 12, 8, "Кабаны")]]),
    completedQuests: new Set(), cooldownRemaining: () => 0, currentServerTime: () => 100, queryQuest() {},
    events: { on: () => () => {} },
    group: { groupType: 0, ownSubGroup: 0, members: [{ guid: 0x202n, name: "Друг", subGroup: 0, online: true }] },
    names: { get: () => undefined },
    abandonQuest: (slot) => calls.push(["abandon", slot]),
    shareQuest: (questId) => calls.push(["share", questId]),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    mapSource: { metadata: () => ({ areas: [...AREAS].map(([id, name]) => ({ id, name })), maps: [] }) },
    questLogNames: { sortName: () => undefined, infoName: () => undefined },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach({ fire: () => 1, now: () => 1 });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  /** QuestLog_SetSelection's C calls (QuestLogFrame.lua:611-633): select, remember for abandon, toggle a header. */
  const setSelection = (index) => {
    call("SelectQuestLogEntry", index);
    call("SetAbandonQuest");
    const title = call("GetQuestLogTitle", index);
    if (title[4]) call(title[5] ? "ExpandQuestHeader" : "CollapseQuestHeader", index);
  };
  /** QuestLogFrameAbandonButton's OnClick and the popup's OnAccept: the quest the popup names, then abandon it. */
  const abandon = () => {
    call("SetAbandonQuest");
    const name = call("GetAbandonQuestName")[0];
    call("AbandonQuest");
    return name;
  };
  const selectedQuest = () => call("GetQuestLogTitle", call("GetQuestLogSelection")[0])[8];
  return { world, fields, base, seam, call, setSelection, abandon, selectedQuest, calls };
}

test("collapsing the selected quest's own zone keeps it selected: abandon and share act on it", () => {
  const { call, setSelection, abandon, selectedQuest, calls } = fixture();
  // [Западный Край] 102 [Элвиннский лес] 104 101
  setSelection(5);
  assert.equal(selectedQuest(), 101);
  setSelection(3);
  // [Западный Край] 102 [Элвиннский лес +] | 104 101
  assert.deepEqual(call("GetNumQuestLogEntries"), [3, 3]);
  assert.deepEqual(call("GetQuestLogSelection"), [5], "still «Волки», now in the collapsed tail (0x5debd0)");
  assert.deepEqual(call("GetQuestLogQuestText"), ["D101", "O101"], "the details pane still shows it");
  assert.equal(call("GetQuestLogTitle", 3)[5], true, "the header stays collapsed: QuestLog_Update finds a selection");
  call("QuestLogPushQuest");
  assert.equal(abandon(), "Волки");
  assert.deepEqual(calls, [["share", 101], ["abandon", 0]]);
});

test("collapsing a zone above the selection moves its row, not the selection", () => {
  const { call, setSelection, abandon, selectedQuest, calls } = fixture();
  setSelection(4);
  assert.equal(selectedQuest(), 104);
  setSelection(1);
  // [Западный Край +] [Элвиннский лес] 104 101 | 102
  assert.deepEqual(call("GetQuestLogSelection"), [3]);
  assert.equal(selectedQuest(), 104);
  assert.equal(abandon(), "Кабаны");
  assert.deepEqual(calls, [["abandon", 2]]);
  // Expanding again puts every row back; the selection follows «Кабаны».
  setSelection(1);
  assert.deepEqual(call("GetQuestLogSelection"), [4]);
});

test("0x5dffa0's three cases: a header keeps, a row past the list or 0 clears, a quest row selects", () => {
  const { call, selectedQuest } = fixture();
  call("SelectQuestLogEntry", 1);
  assert.deepEqual(call("GetQuestLogSelection"), [0], "a header with nothing selected selects nothing");
  call("SelectQuestLogEntry", 2);
  assert.equal(selectedQuest(), 102);
  call("SelectQuestLogEntry", 3);
  assert.equal(selectedQuest(), 102, "a header leaves the selection");
  call("SelectQuestLogEntry", 99);
  assert.deepEqual(call("GetQuestLogSelection"), [0], "past the list: cleared");
  call("SelectQuestLogEntry", 2);
  call("SelectQuestLogEntry", 0);
  assert.deepEqual(call("GetQuestLogSelection"), [0]);
});

test("WatchFrame_AbandonQuest: the watched quest is the one abandoned, the selection comes back", () => {
  const { call, setSelection, selectedQuest, calls } = fixture();
  setSelection(5);
  setSelection(3);
  // WatchFrame.lua:992-1007 with «Волки» selected in a collapsed zone; watch 2 is slot 1, «Бандиты».
  const lastQuest = call("GetQuestLogSelection")[0];
  call("SelectQuestLogEntry", call("GetQuestIndexForWatch", 2)[0]);
  call("SetAbandonQuest");
  const name = call("GetAbandonQuestName")[0];
  call("SelectQuestLogEntry", lastQuest);
  assert.equal(name, "Бандиты");
  assert.equal(selectedQuest(), 101);
  call("AbandonQuest");
  assert.deepEqual(calls, [["abandon", 1]]);
});

test("a selected quest that left the log selects nothing and abandons nothing", () => {
  const { fields, base, call, setSelection, abandon, calls } = fixture();
  setSelection(5);
  fields.set(base, 0);
  assert.deepEqual(call("GetQuestLogSelection"), [0]);
  setSelection(1);
  assert.equal(abandon(), undefined);
  call("QuestLogPushQuest");
  assert.deepEqual(calls, []);
});
}
