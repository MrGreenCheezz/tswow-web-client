import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { buildQueryInspectAchievements, parseCriteriaUpdate } from "../dist/code/world/CharacterProgressProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-achievement-live-seam.test.mjs
{
// LiveWorldSeam's achievement wiring (FrameXmlAchievementLive.ts): the model reads WorldClient's
// achievement maps and events, the seam tick coalesces CRITERIA_UPDATE, the comparison sends the
// inspect query, and the chat emitter writes an achievement line's `$a` link and `$g` gender — after
// waiting once for the catalog — before stock ChatFrame formats it.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FrameXmlAchievementCatalog } = await import("../dist/code/browser/framexml/FrameXmlAchievementCatalog.js");
const { FRAMEXML_ACHIEVEMENT_CANNED_CATALOG } = await import("../dist/code/browser/framexml/FrameXmlAchievementCannedData.js");
const { CHAT_MSG_ACHIEVEMENT, CHAT_MSG_GUILD_ACHIEVEMENT } = await import("../dist/code/world/ChatProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) this.#listeners.set(name, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
  listenerCount(name) { return this.#listeners.get(name)?.size ?? 0; }
}

const SELF = 0x10n;
const EARNER = 0x22n;

function fixture() {
  const events = new FakeEvents();
  // A female earner in view: UNIT_FIELD_BYTES_0's third byte is the gender (Fields.ts BYTES_0_GENDER).
  const earner = { guid: EARNER, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 << 16]]) };
  const queries = [];
  const world = {
    state: { selfGuid: SELF, objects: new Map([[EARNER, earner]]) },
    targetGuid: undefined, chatLog: [], channels: new Map(), events,
    casts: new Map(), actionButtons: [], aurasFor: () => [], cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }), names: new Map(), creatureTemplates: new Map(),
    worldStateContext: undefined, mapId: undefined, selfName: "Игрок",
    displayName: (guid) => (guid === EARNER ? "Сильвана" : `0x${guid.toString(16)}`),
    achievements: new Map([[7, (26 << 24) | (8 << 20) | (2 << 14)]]),
    criteria: new Map([[36, 25n]]),
    inspectAchievements: undefined,
    queryInspectAchievements: (guid) => queries.push(guid),
  };
  const fired = [];
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1000,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  let release;
  const catalog = FrameXmlAchievementCatalog.fromJson(JSON.parse(JSON.stringify(FRAMEXML_ACHIEVEMENT_CANNED_CATALOG)));
  seam.achievement.catalogSource = { load: () => new Promise((resolve) => { release = () => resolve(catalog); }) };
  return { seam, world, events, fired, pump, queries, release: () => release?.() };
}

const line = (overrides) => ({
  type: CHAT_MSG_ACHIEVEMENT, language: 0, senderGuid: EARNER, senderName: "", receiverGuid: EARNER, receiverName: "",
  channel: "", text: "%s $gзаслужил:заслужила; достижение $a!", tag: 0, achievementId: 7, ...overrides,
});

test("the live model reads the world's maps and answers its events through the seam", async () => {
  const { seam, world, events, fired, pump, queries, release } = fixture();
  seam.attach(pump);
  try {
    const loading = seam.achievement.loadCatalog();
    release();
    await loading;
    assert.deepEqual(call("GetAchievementInfo", seam, 7).slice(0, 7), [7, "20-й уровень", 10, true, 9, 3, 26]);
    assert.deepEqual(call("HasCompletedAnyAchievement", seam), [true]);
    // An achievement link's player, for its tooltip: this one, or a name from WorldClient's name cache.
    world.names.set(EARNER, "Сильвана");
    assert.equal(seam.achievement.linkPlayer("0000000000000010"), true);
    assert.equal(seam.achievement.linkPlayer("0000000000000022"), "Сильвана");
    fired.length = 0;
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "list" });
    assert.deepEqual(fired.filter(([event]) => event.includes("ACHIEVEMENT")), [["RECEIVED_ACHIEVEMENT_LIST"]]);
    seam.achievement.owned = true;
    fired.length = 0;
    world.criteria.set(36, 26n);
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "criteria", criteriaId: 36, timeElapsed: 0 });
    world.criteria.set(36, 27n);
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "criteria", criteriaId: 36, timeElapsed: 0 });
    assert.equal(fired.some(([event]) => event === "CRITERIA_UPDATE"), false, "not per packet");
    // The seam's own frame tick flushes it.
    seam.tick(101);
    assert.deepEqual(fired.filter(([event]) => event === "CRITERIA_UPDATE"), [["CRITERIA_UPDATE"]]);
    events.emit("ACHIEVEMENT_EARNED", { achievementId: 8, mine: true });
    assert.deepEqual(fired.at(-1), ["ACHIEVEMENT_EARNED", 8]);
    // «Сравнить достижения» on the target: UnitGUID's text back to the guid the query sends.
    world.targetGuid = EARNER;
    call("SetAchievementComparisonUnit", seam, "target");
    assert.deepEqual(queries, [EARNER]);
    world.inspectAchievements = { guid: EARNER, completed: new Map([[6, 0], [7, 0]]), criteria: new Map() };
    events.emit("ACHIEVEMENT_STATE_CHANGED", { kind: "inspect", guid: EARNER });
    assert.deepEqual(fired.at(-1), ["INSPECT_ACHIEVEMENT_READY"]);
    assert.deepEqual(call("GetComparisonAchievementPoints", seam), [20]);
    // The Alliance/Horde filter follows UnitFactionGroup("player"), unknown here: both faction rows are listed.
    assert.equal(call("GetCategoryNumAchievements", seam, 92, true)[0], 18);
  } finally {
    seam.detach();
  }
  assert.equal(events.listenerCount("ACHIEVEMENT_STATE_CHANGED"), 0, "detach drops the model's subscriptions");
  assert.equal(events.listenerCount("ACHIEVEMENT_EARNED"), 0);
});

test("an achievement chat line waits for the catalog once, then reaches stock with its link and gender", async () => {
  const { seam, events, fired, pump, release } = fixture();
  seam.attach(pump);
  try {
    fired.length = 0;
    events.emit("CHAT_MESSAGE", line());
    assert.deepEqual(fired, [], "held: `$a` needs the catalog's name");
    release();
    await seam.achievement.loadCatalog();
    assert.equal(fired.length, 1);
    const [event, text, sender] = fired[0];
    assert.equal(event, "CHAT_MSG_ACHIEVEMENT");
    assert.equal(sender, "Сильвана");
    assert.match(text, /^%s заслужила достижение \|cffffff00\|Hachievement:7:0000000000000022:1:\d+:\d+:\d+:4294967295:4294967295:4294967295:4294967295\|h\[20-й уровень\]\|h\|r!$/,
      "the earner in view is female; the link names her, dated now");
    // Loaded now: a guild line goes straight through, in order with the next one.
    events.emit("CHAT_MESSAGE", line({ type: CHAT_MSG_GUILD_ACHIEVEMENT, achievementId: 8 }));
    assert.equal(fired.length, 2);
    assert.equal(fired[1][0], "CHAT_MSG_GUILD_ACHIEVEMENT");
    assert.match(fired[1][1], /\[30-й уровень\]/);
  } finally {
    seam.detach();
  }
});

test("a line held for the catalog is dropped if the seam was detached meanwhile", async () => {
  const { seam, events, fired, pump, release } = fixture();
  seam.attach(pump);
  events.emit("CHAT_MESSAGE", line());
  seam.detach();
  fired.length = 0;
  release();
  await seam.achievement.loadCatalog();
  assert.deepEqual(fired, [], "no line into a torn-down VM");
});
}

// ── framexml-achievement-seam.test.mjs
{
// The stock achievement C API (FrameXmlAchievement.ts) over the canned achievements: the catalog's
// shape, the client's listing rules (earned first, chains folded, this faction, feats once earned,
// statistics answering parent -1), criteria and statistics, the link, the events and their
// coalescing, tracking, the comparison, and the achievement chat line's `$a`/`$g`.

const {
  FrameXmlAchievementModel, FRAMEXML_ACHIEVEMENT_BINDINGS, FRAMEXML_ACHIEVEMENT_EVENTS,
  frameXmlAchievementDate, frameXmlAchievementMoney,
} = await import("../dist/code/browser/framexml/FrameXmlAchievement.js");
const {
  FrameXmlAchievementCatalog, FrameXmlAchievementCatalogClient, FRAMEXML_ACHIEVEMENT_CATALOG_VERSION,
} = await import("../dist/code/browser/framexml/FrameXmlAchievementCatalog.js");
const { createCannedFrameXmlAchievements, cannedAchievementDate } = await import("../dist/code/browser/framexml/FrameXmlAchievementCanned.js");
const { FRAMEXML_ACHIEVEMENT_CANNED_CATALOG } = await import("../dist/code/browser/framexml/FrameXmlAchievementCannedData.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { CHAT_MSG_ACHIEVEMENT, CHAT_MSG_SAY } = await import("../dist/code/world/ChatProtocol.js");

const call = (name, host, ...args) => FRAMEXML_ACHIEVEMENT_BINDINGS[name](host, args);
const GOLD = "|TInterface\\MoneyFrame\\UI-GoldIcon:0:0:2:0|t";
const SILVER = "|TInterface\\MoneyFrame\\UI-SilverIcon:0:0:2:0|t";
const COPPER = "|TInterface\\MoneyFrame\\UI-CopperIcon:0:0:2:0|t";

function recorder() {
  const fired = [];
  return { fired, pump: { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 } };
}

async function canned({ attach = true, load = true } = {}) {
  const achievements = createCannedFrameXmlAchievements();
  const { fired, pump } = recorder();
  if (attach) achievements.model.attach(pump);
  if (load) await achievements.model.loadCatalog();
  return { ...achievements, host: { achievement: achievements.model }, fired };
}

test("every stock achievement name is a seam binding, and the whole list was measured in Wow.exe", () => {
  const names = Object.keys(FRAMEXML_ACHIEVEMENT_BINDINGS);
  assert.equal(names.length, 33);
  for (const name of names) assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
  assert.deepEqual(Object.values(FRAMEXML_ACHIEVEMENT_EVENTS),
    ["RECEIVED_ACHIEVEMENT_LIST", "ACHIEVEMENT_EARNED", "CRITERIA_UPDATE", "TRACKED_ACHIEVEMENT_UPDATE", "INSPECT_ACHIEVEMENT_READY"]);
});

test("the catalog takes the gateway's rows and nothing else", () => {
  const json = JSON.parse(JSON.stringify(FRAMEXML_ACHIEVEMENT_CANNED_CATALOG));
  const catalog = FrameXmlAchievementCatalog.fromJson(json);
  assert.ok(catalog);
  assert.equal(catalog.achievements.size, 38);
  assert.equal(catalog.achievements.get(6).icon, "Interface\\Icons\\Achievement_Level_10");
  assert.equal(catalog.achievements.get(107).icon, "Interface\\Icons\\INV_Misc_QuestionMark", "a missing SpellIcon row");
  assert.equal(catalog.categories.get(135).statistics, true, "Существа, under Победы, under the statistics root");
  assert.equal(catalog.categories.get(1).statistics, false);
  assert.deepEqual(catalog.shownCriteriaOf(6), [], "«Достигните 10-го уровня» is ACHIEVEMENT_CRITERIA_FLAG_HIDDEN");
  assert.equal(catalog.criteriaOf(6).length, 1);
  assert.equal(catalog.isFeatsOfStrength(81), true);
  for (const broken of [
    { ...json, version: FRAMEXML_ACHIEVEMENT_CATALOG_VERSION + 1 },
    { ...json, achievements: [[6, -1]] },
    { ...json, criteria: [[34, 6, 5, 0, "10", "", 2, 0, 0, 0, 1]] },
    { ...json, categories: [[92, -1, 7, 1]] },
    null,
  ]) assert.equal(FrameXmlAchievementCatalog.fromJson(broken), undefined);
  // A crafted icon that would leave Interface\Icons\ is the question mark.
  const crafted = { ...json, achievements: [[1, -1, -1, 0, "x", "", 92, 0, 1, 0, "..\\..\\Something", "", 0, 0]] };
  assert.equal(FrameXmlAchievementCatalog.fromJson(crafted).achievements.get(1).icon, "Interface\\Icons\\INV_Misc_QuestionMark");
});

test("before the catalog every name answers the client's «nothing known»", async () => {
  const { host } = await canned({ load: false });
  assert.deepEqual(call("GetCategoryList", host), [[]]);
  assert.deepEqual(call("GetCategoryInfo", host, 92), []);
  assert.deepEqual(call("GetCategoryNumAchievements", host, 92), [0, 0, 0]);
  assert.deepEqual(call("GetAchievementInfo", host, 6), []);
  assert.deepEqual(call("GetNumCompletedAchievements", host), [0, 0]);
  assert.deepEqual(call("GetTotalAchievementPoints", host), [0]);
  assert.deepEqual(call("HasCompletedAnyAchievement", host), [true], "the packets say so without any catalog");
  assert.deepEqual(call("GetTrackedAchievements", host), []);
  // No model at all: the same answers.
  assert.deepEqual(call("GetAchievementComparisonInfo", {}, 6), [false]);
  assert.deepEqual(call("CanShowAchievementUI", {}), [false]);
  assert.deepEqual(call("GetStatisticsCategoryList", {}), [[]]);
});

test("categories, chains, faction and feats: what a category shows and counts", async () => {
  const { host } = await canned();
  assert.deepEqual(call("GetCategoryInfo", host, 92), ["Общее", -1, 0]);
  assert.deepEqual(call("GetCategoryInfo", host, 130), ["Персонаж", -1, 0], "a top-level statistic answers -1, not the root");
  assert.deepEqual(call("GetCategoryInfo", host, 135), ["Существа", 128, 0]);
  assert.deepEqual(call("GetCategoryInfo", host, 1), ["Статистика", -1, 0]);
  assert.equal(call("GetCategoryList", host)[0].includes(1), false);
  assert.equal(call("GetStatisticsCategoryList", host)[0].includes(1), false);
  const shown = (category) => {
    const [count] = call("GetCategoryNumAchievements", host, category);
    return Array.from({ length: count }, (_unused, index) => call("GetAchievementInfo", host, category, index + 1)[0]);
  };
  assert.deepEqual(shown(92), [7, 1176, 545, 1017, 8, 16, 1177, 2536]);
  assert.deepEqual(call("GetCategoryNumAchievements", host, 92), [8, 4, 4]);
  assert.deepEqual(call("GetCategoryNumAchievements", host, 92, true), [17, 5, 12]);
  assert.deepEqual(shown(81), [411], "Мурчаль is earned; the unearned feat is never listed");
  assert.deepEqual(shown(170), [121, 122], "the cooking chain: journeyman earned, expert next");
  assert.deepEqual(call("GetNumCompletedAchievements", host), [28, 6]);
  assert.deepEqual(call("GetCategoryNumAchievements", host, -1), [28, 6, 22], "the comparison summary's id");
  assert.deepEqual(call("GetTotalAchievementPoints", host), [60]);
  assert.deepEqual(call("GetLatestCompletedAchievements", host), [411, 121, 1176, 1017, 545]);
  assert.deepEqual(call("GetAchievementCategory", host, 776), [14777]);
  assert.deepEqual(call("GetPreviousAchievement", host, 7), [6]);
  assert.deepEqual(call("GetPreviousAchievement", host, 6), []);
  assert.deepEqual(call("GetPreviousAchievement", host, 2536), [], "its predecessor is not in the table");
  assert.deepEqual(call("GetNextAchievement", host, 7), [8, false]);
  assert.deepEqual(call("GetNextAchievement", host, 6), [7, true]);
  assert.deepEqual(call("GetNextAchievement", host, 13), []);
});

test("an achievement's info: the packed date read back, flags, icon, reward", async () => {
  const { host } = await canned();
  assert.deepEqual(call("GetAchievementInfo", host, 7),
    [7, "20-й уровень", 10, true, 9, 3, 26, "Достигните 20-го уровня.", 4, "Interface\\Icons\\Achievement_Level_20", ""]);
  assert.deepEqual(call("GetAchievementInfo", host, 8).slice(3, 7), [false, undefined, undefined, undefined],
    "an unearned one has no date: stock tests `if ( month )`");
  assert.deepEqual(call("GetAchievementInfo", host, 60).slice(3, 4), [false], "a statistic never completes");
  assert.equal(call("GetAchievementInfo", host, 2536)[10], "Награда: синий верховой дракондор");
  assert.deepEqual(call("GetAchievementNumRewards", host, 2536), [1]);
  assert.deepEqual(call("GetAchievementReward", host, 2536, 1), ["Награда: синий верховой дракондор"]);
  assert.deepEqual(call("GetAchievementNumRewards", host, 7), [0]);
  assert.deepEqual(call("GetAchievementInfoFromCriteria", host, 111).slice(0, 2), [60, "Всего смертей"]);
  assert.deepEqual(frameXmlAchievementDate(cannedAchievementDate(2026, 12, 31, 23, 59)), [12, 31, 26]);
  assert.equal(frameXmlAchievementDate((31 << 24) | (1 << 20)), undefined, "an unset year");
  assert.equal(frameXmlAchievementDate(undefined), undefined);
});

test("criteria: hidden ones left out, completion by the core's rule, quantity strings", async () => {
  const { host, world } = await canned();
  assert.deepEqual(call("GetAchievementNumCriteria", host, 6), [0]);
  assert.deepEqual(call("GetAchievementNumCriteria", host, 776), [12]);
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 776, 1),
    ["Долина Североземья", 43, true, 1, 1, undefined, 0, 125, "1", 1146]);
  assert.equal(call("GetAchievementCriteriaInfo", host, 776, 5)[2], false, "Лесная опушка is not explored: `completed == false`");
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 16, 1).slice(2, 5).concat(call("GetAchievementCriteriaInfo", host, 16, 1)[8]),
    [false, 150, 400, "150/400"]);
  assert.equal(call("GetAchievementCriteriaInfo", host, 1177, 1)[8], `150${GOLD} / 1000${GOLD}`);
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 3631).slice(0, 4), ["Всего заданий", 9, false, 37],
    "by criteria id (the statistics summary's form); a statistic's criterion never completes");
  assert.equal(call("GetAchievementCriteriaInfo", host, 730, 3)[2], false, "the cooking grandmaster is not earned");
  // A quantity type completes at its quantity.
  world.progress(230, 50n);
  assert.equal(call("GetAchievementCriteriaInfo", host, 503, 1)[2], true, "50 of 50 quests");
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 7, 1), [], "a hidden criterion has no index");
});

test("statistics: counter, sum, money, the busiest shared criterion, an average with no age", async () => {
  const { host } = await canned();
  assert.deepEqual(call("GetStatistic", host, 60), ["42"]);
  assert.deepEqual(call("GetStatistic", host, 107), ["430"]);
  assert.deepEqual(call("GetStatistic", host, 98), ["40"]);
  assert.deepEqual(call("GetStatistic", host, 95), [], "ACHIEVEMENT_FLAG_AVERAGE: the window's --");
  assert.deepEqual(call("GetStatistic", host, 328), [`133${GOLD} 33${SILVER} 32${COPPER}`]);
  assert.deepEqual(call("GetStatistic", host, 1125), ["Бинты Осквернителя из магической ткани"]);
  assert.deepEqual(call("GetStatistic", host, 344), ["15"], "the bandage count it shares");
  assert.equal(frameXmlAchievementMoney(0), `0${COPPER}`);
  assert.equal(frameXmlAchievementMoney(10_000), `1${GOLD}`);
  assert.equal(frameXmlAchievementMoney(10_101), `1${GOLD} 1${SILVER} 1${COPPER}`);
});

test("GetAchievementLink: earned with its date and every bit, unearned with the bits so far", async () => {
  const { host } = await canned();
  assert.deepEqual(call("GetAchievementLink", host, 7),
    ["|cffffff00|Hachievement:7:0000000000000001:1:9:3:26:4294967295:4294967295:4294967295:4294967295|h[20-й уровень]|h|r"]);
  assert.deepEqual(call("GetAchievementLink", host, 776),
    ["|cffffff00|Hachievement:776:0000000000000001:0:0:0:-1:11:0:0:0|h[Элвиннский лес]|h|r"],
    "Долина Североземья, Златоземье and Штормград are criteria 1, 2 and 4: bits 0b1011");
  assert.deepEqual(call("GetAchievementLink", host, 999999), []);
});

test("the events: the list, an earned one queued for the load, one CRITERIA_UPDATE per frame", async () => {
  const { model, world, fired } = await canned();
  const loads = [];
  const availability = [];
  model.onLoadRequest = () => loads.push("load");
  model.onAvailabilityChanged = () => availability.push("changed");
  world.earn(8);
  assert.deepEqual(fired, [], "nothing reaches Lua before the window is loaded");
  assert.deepEqual(loads, ["load"], "the toast asks for the load (AlertFrame_OnEvent's AchievementFrame_LoadUI)");
  world.earn(9, false);
  assert.deepEqual(loads, ["load"], "another player's achievement is not ours to toast");
  world.progress(35, 20n);
  world.progress(36, 26n);
  model.tick();
  assert.deepEqual(fired, [], "CRITERIA_UPDATE waits for the loaded window too");
  model.owned = true;
  assert.deepEqual(fired, [["ACHIEVEMENT_EARNED", 8], ["CRITERIA_UPDATE"]], "the edge delivers what waited, in order");
  fired.length = 0;
  world.progress(36, 27n);
  world.progress(111, 43n);
  world.progress(4948, 121n);
  assert.deepEqual(fired, []);
  model.tick();
  model.tick();
  assert.deepEqual(fired, [["CRITERIA_UPDATE"]], "three criteria, one event");
  assert.ok(availability.length >= 1, "an earned achievement can enable the micro button");
});

test("tracking belongs to the loaded window; a tracked criterion raises TRACKED_ACHIEVEMENT_UPDATE", async () => {
  const { model, host, world, fired } = await canned();
  call("AddTrackedAchievement", host, 503);
  assert.deepEqual(call("GetTrackedAchievements", host), [], "nothing is tracked before AchievementFrame exists");
  model.owned = true;
  fired.length = 0;
  call("AddTrackedAchievement", host, 503);
  call("AddTrackedAchievement", host, 503);
  assert.deepEqual(call("GetTrackedAchievements", host), [503]);
  assert.deepEqual(call("IsTrackedAchievement", host, 503), [true]);
  assert.deepEqual(fired, [["TRACKED_ACHIEVEMENT_UPDATE"]], "stock refreshes its own watch list from this event");
  fired.length = 0;
  world.progress(230, 40n);
  assert.deepEqual(fired, [["TRACKED_ACHIEVEMENT_UPDATE", 503, 230]]);
  for (let id = 1; id <= 12; id += 1) call("AddTrackedAchievement", host, [6, 7, 8, 9, 10, 11, 12, 13, 16, 545, 1017, 1176][id - 1]);
  assert.equal(call("GetNumTrackedAchievements", host)[0], 10, "WATCHFRAME_MAXACHIEVEMENTS");
  call("RemoveTrackedAchievement", host, 503);
  assert.deepEqual(call("IsTrackedAchievement", host, 503), [false]);
  model.detach();
  assert.deepEqual(call("GetTrackedAchievements", host), [], "a new VM starts with no AchievementFrame and no watch list");
});

test("an earned tracked achievement leaves the watch list before its ACHIEVEMENT_EARNED", async () => {
  const { model, host, world, fired } = await canned();
  model.owned = true;
  call("AddTrackedAchievement", host, 503);
  call("AddTrackedAchievement", host, 16);
  fired.length = 0;
  // The core's order: the last SMSG_CRITERIA_UPDATE, then SMSG_ACHIEVEMENT_EARNED.
  world.progress(230, 50n);
  world.earn(503);
  assert.deepEqual(fired, [["TRACKED_ACHIEVEMENT_UPDATE", 503, 230], ["TRACKED_ACHIEVEMENT_UPDATE"], ["ACHIEVEMENT_EARNED", 503]],
    "the watch list's own refresh, then the window's redraw reads it untracked");
  assert.deepEqual(call("GetTrackedAchievements", host), [16]);
  fired.length = 0;
  world.earn(8);
  assert.deepEqual(fired, [["ACHIEVEMENT_EARNED", 8]], "an untracked one changes nothing on the watch list");
});

/** A model over one synthetic catalog and a counter map the test writes. */
async function synthetic(rows, { completed = new Map(), criteria = new Map(), self = 1n, names = new Map() } = {}) {
  const catalog = FrameXmlAchievementCatalog.fromJson({ version: FRAMEXML_ACHIEVEMENT_CATALOG_VERSION, ...rows });
  assert.ok(catalog);
  const listeners = [];
  const model = new FrameXmlAchievementModel({
    completed: () => completed, criteria: () => criteria, faction: () => 1, selfGuid: () => self, inspect: () => undefined,
    queryInspect: () => {}, gender: () => undefined, name: (guid) => names.get(guid),
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
  });
  model.catalogSource = { load: async () => catalog };
  const { fired, pump } = recorder();
  model.attach(pump);
  await model.loadCatalog();
  return { model, host: { achievement: model }, fired, emit: (change) => listeners[0](change), completed, criteria };
}

test("a progress-bar achievement answers one bar over its hidden criteria, by the core's completion rule", async () => {
  // As the dataset has them: Loremaster (SUMM|BAR, flags 0x88) and «10 гербовых накидок» (REQ_COUNT|BAR,
  // 0xa0, MinimumCriteria 10) over another achievement's hidden criteria, and the default (last criterion).
  const { host, criteria, completed } = await synthetic({
    categories: [[96, -1, "Задания", 2], [81, -1, "Великие подвиги", 9]],
    achievements: [
      [1676, -1, -1, 0, "Хранитель мудрости", "Выполните 700 заданий.", 96, 10, 1, 0x88, "", "", 0, 0],
      [621, -1, -1, 0, "Накидки", "", 81, 0, 1, 0, "", "", 0, 0],
      [1020, -1, -1, 0, "10 гербовых накидок", "", 81, 10, 2, 0xa0, "", "", 10, 621],
      [4000, -1, -1, 0, "По умолчанию", "", 96, 10, 3, 0x80, "", "", 0, 0],
      [4001, -1, -1, 0, "Без полосы", "", 96, 10, 4, 0, "", "", 0, 0],
    ],
    criteria: [
      [1, 1676, 11, 1, 700, "Дун Морог", 3, 0, 0, 0, 1], [2, 1676, 11, 12, 700, "Элвиннский лес", 3, 0, 0, 0, 2],
      ...Array.from({ length: 12 }, (_, index) => [100 + index, 621, 57, 5000 + index, 1, `Накидка ${index}`, 2, 0, 0, 0, index]),
      [200, 4000, 70, 0, 30, "Первый", 2, 0, 0, 0, 1], [201, 4000, 70, 0, 50, "Последний", 2, 0, 0, 0, 2],
      [300, 4001, 70, 0, 5, "Скрытый", 2, 0, 0, 0, 1],
    ],
  });
  criteria.set(1, 250n);
  criteria.set(2, 180n);
  assert.deepEqual(call("GetAchievementNumCriteria", host, 1676), [1]);
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 1676, 1),
    ["Выполните 700 заданий.", 11, false, 430, 700, undefined, 1, 0, "430/700", 0], "the counters' sum as a progress bar");
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 1676, 2), [], "one bar, no second criterion");
  criteria.set(2, 600n);
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 1676, 1).slice(2, 5), [true, 700, 700], "capped at the maximum");
  for (let index = 0; index < 4; index += 1) criteria.set(100 + index, 1n);
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 1020, 1).slice(2, 5).concat(call("GetAchievementCriteriaInfo", host, 1020, 1)[8]),
    [false, 4, 10, "4/10"], "four of the shared achievement's criteria done, of MinimumCriteria");
  criteria.set(200, 29n);
  criteria.set(201, 12n);
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 4000, 1).slice(3, 5), [12, 50], "by default the last criterion");
  completed.set(4000, 0);
  assert.deepEqual(call("GetAchievementCriteriaInfo", host, 4000, 1).slice(2, 5), [true, 50, 50], "an earned one reads full");
  assert.deepEqual(call("GetAchievementNumCriteria", host, 4001), [0], "without the flag, hidden criteria stay unlisted");
});

test("a criterion counted for a tracked achievement that borrows it raises that achievement's update", async () => {
  const { model, host, fired, emit } = await synthetic({
    categories: [[81, -1, "Великие подвиги", 9]],
    achievements: [
      [621, -1, -1, 0, "Накидки", "", 81, 0, 1, 0, "", "", 0, 0],
      [1020, -1, -1, 0, "10 гербовых накидок", "", 81, 10, 2, 0xa0, "", "", 10, 621],
    ],
    criteria: [[100, 621, 57, 5000, 1, "Накидка", 2, 0, 0, 0, 1]],
  });
  model.owned = true;
  call("AddTrackedAchievement", host, 1020);
  fired.length = 0;
  emit({ kind: "criteria", criteriaId: 100, timeElapsed: 0 });
  assert.deepEqual(fired, [["TRACKED_ACHIEVEMENT_UPDATE", 1020, 100]]);
});

test("an achievement link names its player: this one, one from the name cache, or nobody", async () => {
  const { model } = await synthetic({ categories: [], achievements: [], criteria: [] },
    { self: 0x1n, names: new Map([[0x11n, "Альфа"]]) });
  assert.equal(model.linkPlayer("0000000000000001"), true);
  assert.equal(model.linkPlayer("0000000000000011"), "Альфа");
  assert.equal(model.linkPlayer("0000000000000099"), undefined, "not in the name cache");
  assert.equal(model.linkPlayer("0000000000000000"), undefined);
  assert.equal(model.linkPlayer("x1"), undefined, "only the link's 16 hex digits");
});

test("a refused load drops the ACHIEVEMENT_EARNED events that waited for it", async () => {
  const { model, world, fired } = await canned();
  model.onLoadRequest = () => {};
  world.earn(8);
  model.discardQueuedEarned();
  world.earn(9);
  model.owned = true;
  assert.deepEqual(fired.filter(([event]) => event === "ACHIEVEMENT_EARNED"), [["ACHIEVEMENT_EARNED", 9]]);
});

test("a timed criterion carries its clock: elapsed seconds and the table's limit", () => {
  const catalog = FrameXmlAchievementCatalog.fromJson({
    version: FRAMEXML_ACHIEVEMENT_CATALOG_VERSION, categories: [[95, -1, "PvP", 4]],
    achievements: [[201, -1, -1, 0, "Быстрая победа", "", 95, 10, 1, 0, "", "", 0, 0]],
    criteria: [[159, 201, 1, 0, 1, "Победить за 6 минут", 2, 1, 0, 360, 1]],
  });
  const listeners = [];
  const model = new FrameXmlAchievementModel({
    completed: () => new Map(), criteria: () => new Map(), faction: () => 1, selfGuid: () => 1n, inspect: () => undefined,
    queryInspect: () => {}, gender: () => undefined,
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
  });
  model.catalogSource = { load: async () => catalog };
  const { fired, pump } = recorder();
  model.attach(pump);
  return model.loadCatalog().then(() => {
    model.owned = true;
    call("AddTrackedAchievement", { achievement: model }, 201);
    fired.length = 0;
    listeners[0]({ kind: "criteria", criteriaId: 159, timeElapsed: 42 });
    assert.deepEqual(fired, [["TRACKED_ACHIEVEMENT_UPDATE", 201, 159, 42, 360]], "WatchFrame's timed-criterion arguments");
  });
});

test("the comparison asks by guid and answers only for that player, once the answer is in", async () => {
  const { model, host, world, fired } = await canned();
  model.owned = true;
  const seamHost = { achievement: model, unitGuid: (unit) => (unit === "party1" ? "0x0000000000000011" : undefined) };
  call("SetAchievementComparisonUnit", seamHost, "PARTY1");
  assert.deepEqual(world.inspectQueries, [0x11n]);
  assert.deepEqual(call("GetComparisonAchievementPoints", host), [0], "neutral until SMSG_RESPOND_INSPECT_ACHIEVEMENTS");
  assert.deepEqual(call("GetAchievementComparisonInfo", host, 7), [false, undefined, undefined, undefined]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fired.at(-1), ["INSPECT_ACHIEVEMENT_READY"]);
  assert.deepEqual(call("GetComparisonAchievementPoints", host), [60]);
  assert.deepEqual(call("GetAchievementComparisonInfo", host, 7), [true, 7, 9, 26]);
  assert.deepEqual(call("GetComparisonCategoryNumAchievements", host, 92), [5],
    "of the eight rows General shows this player: levels 20 and 30, both gold steps and the barber");
  assert.deepEqual(call("GetComparisonCategoryNumAchievements", host, -1), [6]);
  assert.deepEqual(call("GetNumComparisonCompletedAchievements", host), [28, 6]);
  assert.deepEqual(call("GetComparisonStatistic", host, 60), ["7"]);
  assert.deepEqual(call("GetLatestCompletedComparisonAchievements", host), [1177, 545, 1176, 8, 7]);
  call("SetAchievementComparisonUnit", seamHost, "target");
  assert.deepEqual(world.inspectQueries, [0x11n], "no guid, no query");
  assert.deepEqual(call("GetComparisonAchievementPoints", host), [0], "the answer about party1 is not the target's");
  call("ClearAchievementComparisonUnit", host);
  assert.deepEqual(call("GetComparisonStatistic", host, 60), []);
});

test("an achievement chat line gets its link and the earner's gender; it waits once for the catalog", async () => {
  const { model } = await canned({ load: false });
  const line = (overrides) => ({
    type: CHAT_MSG_ACHIEVEMENT, language: 0, senderGuid: 1n, senderName: "", receiverGuid: 1n, receiverName: "",
    channel: "", text: "%s $gзаслужил:заслужила; достижение $a!", tag: 0, achievementId: 7, ...overrides,
  });
  const say = line({ type: CHAT_MSG_SAY, text: "$a стоит как есть", achievementId: 0 });
  assert.equal(model.chatLine(say, () => assert.fail("a say line never waits")), say);
  const emitted = [];
  assert.equal(model.chatLine(line(), (message) => emitted.push(message)), undefined, "held: nothing names $a yet");
  await model.loadCatalog();
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].text, /^%s заслужил достижение \|cffffff00\|Hachievement:7:0000000000000001:1:\d+:\d+:\d+:4294967295:4294967295:4294967295:4294967295\|h\[20-й уровень\]\|h\|r!$/);
  // Loaded: at once; a female earner's form. The canned world knows only the player's gender (male).
  const now = model.chatLine(line({ senderGuid: 0x11n }), () => assert.fail("loaded, no wait"));
  assert.match(now.text, /^%s заслужил достижение /, "an earner out of view reads as male, the table's first form");
  const female = new FrameXmlAchievementModel({
    completed: () => new Map(), criteria: () => new Map(), faction: () => 1, selfGuid: () => 1n, inspect: () => undefined,
    queryInspect: () => {}, gender: () => 1, subscribe: () => () => {},
  });
  female.catalogSource = model.catalogSource;
  await female.loadCatalog();
  assert.match(female.chatLine(line(), () => {}).text, /^%s заслужила достижение /);
  // No catalog source at all (a mount without a gateway): the id stands for the name.
  const bare = new FrameXmlAchievementModel({
    completed: () => new Map(), criteria: () => new Map(), faction: () => 1, selfGuid: () => 1n, inspect: () => undefined,
    queryInspect: () => {}, gender: () => undefined, subscribe: () => () => {},
  });
  assert.match(bare.chatLine(line(), () => {}).text, /\|h\[7\]\|h\|r!$/);
});

test("the gateway client: one fetch per page, a failure remembered and retried by the next caller", async () => {
  const bodies = [];
  let status = 404;
  const fetcher = async (url) => {
    bodies.push(url);
    return { ok: status === 200, status, json: async () => JSON.parse(JSON.stringify(FRAMEXML_ACHIEVEMENT_CANNED_CATALOG)) };
  };
  const client = new FrameXmlAchievementCatalogClient("http://127.0.0.1:8090", fetcher);
  assert.equal(await client.load(), undefined);
  assert.equal(client.failure, "achievement catalog gateway returned 404");
  assert.deepEqual(bodies, ["http://127.0.0.1:8090/dbc/achievements?v=1"]);
  status = 200;
  const [first, second] = await Promise.all([client.load(), client.load()]);
  assert.ok(first);
  assert.equal(first, second, "one request for both callers");
  assert.equal(await client.load(), first);
  assert.equal(bodies.length, 2);
  assert.equal(client.failure, undefined);
  const malformed = new FrameXmlAchievementCatalogClient("http://127.0.0.1:8090", async () => ({ ok: true, status: 200, json: async () => ({ version: 1 }) }));
  assert.equal(await malformed.load(), undefined);
  assert.equal(malformed.failure, "malformed achievement catalog");
});
}

// ── framexml-achievement-worldclient.test.mjs
{
// The achievement packets the stock achievement model hears (ACHIEVEMENT_STATE_CHANGED beside
// ACHIEVEMENT_EARNED), in TrinityCore's own layouts (AchievementMgr::SendCriteriaUpdate,
// ::BuildAllDataPacket, ::SendRespondInspectAchievements), and CMSG_QUERY_INSPECT_ACHIEVEMENTS
// (WorldSession::HandleQueryInspectAchievements reads one packed guid).

const SELF = 0x1234n;
const OTHER = 0x5678n;
/** WowTime::GetPackedTime for 2026-09-20 18:30, a Sunday. */
const PACKED = (26 << 24) | (8 << 20) | (19 << 14) | (0 << 11) | (18 << 6) | 30;

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
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

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  return { client, connection };
}

/** AchievementMgr::SendCriteriaUpdate: id, packed counter, packed player, flags, date, elapsed, 0. */
function criteriaUpdate(id, counter, elapsed = 0, flags = 0) {
  return new PacketWriter().u32(id).packedGuid(counter).packedGuid(SELF).u32(flags).u32(PACKED).u32(elapsed).u32(0).toUint8Array();
}

/** BuildAllDataPacket: completed ids with dates, -1, then criteria rows, -1. */
function allData(writer, completed, criteria) {
  for (const [id, date] of completed) writer.u32(id).u32(date);
  writer.i32(-1);
  for (const [id, counter] of criteria) writer.u32(id).packedGuid(counter).packedGuid(SELF).u32(0).u32(PACKED).u32(0).u32(0);
  writer.i32(-1);
  return writer.toUint8Array();
}

test("SMSG_CRITERIA_UPDATE reads TrinityCore's four trailing words: flags, date, elapsed, zero", () => {
  const update = parseCriteriaUpdate(criteriaUpdate(159, 1n, 42, 1));
  assert.deepEqual(update, { criteriaId: 159, counter: 1n, playerGuid: SELF, flags: 1, date: PACKED, timeElapsed: 42 });
});

test("CMSG_QUERY_INSPECT_ACHIEVEMENTS is one packed guid", () => {
  const reader = new PacketReader(buildQueryInspectAchievements(OTHER));
  assert.equal(reader.packedGuid(), OTHER);
  reader.assertFinished();
});

test("every achievement packet raises its world event, and the inspect answer is kept apart", async () => {
  const { client, connection } = await loggedIn();
  const changes = [];
  const earned = [];
  client.events.on("ACHIEVEMENT_STATE_CHANGED", (change) => changes.push(change));
  client.events.on("ACHIEVEMENT_EARNED", (event) => earned.push(event));
  // The player's own create block (UPDATEFLAG_SELF) names it; the fake login stops short of it.
  client.state.selfGuid = SELF;
  try {
    connection.push(OPCODES.SMSG_ALL_ACHIEVEMENT_DATA, allData(new PacketWriter(), [[6, PACKED], [7, PACKED]], [[34, 10n], [35, 20n]]));
    connection.push(OPCODES.SMSG_CRITERIA_UPDATE, criteriaUpdate(36, 25n, 7));
    connection.push(OPCODES.SMSG_ACHIEVEMENT_EARNED, new PacketWriter().packedGuid(SELF).u32(8).u32(PACKED).u32(0).toUint8Array());
    connection.push(OPCODES.SMSG_ACHIEVEMENT_EARNED, new PacketWriter().packedGuid(OTHER).u32(9).u32(PACKED).u32(0).toUint8Array());
    connection.push(OPCODES.SMSG_CRITERIA_DELETED, new PacketWriter().u32(34).toUint8Array());
    connection.push(OPCODES.SMSG_ACHIEVEMENT_DELETED, new PacketWriter().u32(6).toUint8Array());
    connection.push(OPCODES.SMSG_RESPOND_INSPECT_ACHIEVEMENTS,
      allData(new PacketWriter().packedGuid(OTHER), [[6, PACKED], [1176, PACKED]], [[111, 7n]]));
    await settle();
    assert.deepEqual(changes, [
      { kind: "list" },
      { kind: "criteria", criteriaId: 36, timeElapsed: 7 },
      { kind: "deleted" },
      { kind: "deleted" },
      { kind: "inspect", guid: OTHER },
    ]);
    assert.deepEqual(earned, [{ achievementId: 8, mine: true }, { achievementId: 9, mine: false }]);
    assert.deepEqual([...client.achievements], [[7, PACKED], [8, PACKED]], "the list, the earned one, less the deleted one");
    assert.deepEqual([...client.criteria], [[35, 20n], [36, 25n]]);
    assert.equal(client.inspectAchievements.guid, OTHER);
    assert.deepEqual([...client.inspectAchievements.completed], [[6, PACKED], [1176, PACKED]]);
    assert.deepEqual([...client.inspectAchievements.criteria], [[111, 7n]]);
    assert.equal(client.achievements.has(1176), false, "another player's list is not this character's");
    client.queryInspectAchievements(OTHER);
    client.queryInspectAchievements(0n);
    const queries = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_QUERY_INSPECT_ACHIEVEMENTS);
    assert.equal(queries.length, 1, "no query for guid 0");
    assert.deepEqual([...queries[0].payload], [...buildQueryInspectAchievements(OTHER)]);
  } finally {
    client.close?.();
  }
});
}
