import assert from "node:assert/strict";
import test from "node:test";

const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("quest green range follows the Wrath player-level bands rather than a fixed threshold", () => {
  const seam = new CannedWorldSeam();
  let playerLevel;
  seam.unitLevel = (unit) => unit === "player" ? playerLevel : undefined;
  for (const [level, range] of [
    [undefined, 0], [0, 0], [1, 4], [9, 4], [10, 5], [19, 5],
    [20, 6], [29, 6], [30, 7], [39, 7], [40, 8], [44, 8],
    [45, 9], [49, 9], [50, 10], [54, 10], [55, 11], [59, 11], [60, 12], [80, 12],
  ]) {
    playerLevel = level;
    assert.deepEqual(call("GetQuestGreenRange", seam), [range], `player level ${level}`);
  }
});

test("canned QuestLog returns stock tuples, selection and deduplicated objective edges", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
    now: () => 1,
  });
  assert.deepEqual(call("GetNumQuestLogEntries", seam), [1, 1]);
  assert.deepEqual(call("QuestMapUpdateAllQuests", seam), [1]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 1), [9001]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 2), []);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "Проверка журнала заданий", 60, undefined, 0, false, false, undefined, false, 9001, false,
  ]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), []);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [0]);

  call("SelectQuestLogEntry", seam, 1);
  assert.deepEqual(call("GetQuestLogSelection", seam), [1]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), ["Описание задания.", "Проверить цели."]);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [1]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Проверить цель: 2/5", "monster", false]);
  assert.deepEqual(call("GetQuestLogRequiredMoney", seam), [125]);
  assert.deepEqual(call("GetQuestLogTimeLeft", seam), [90]);
  assert.deepEqual(call("GetQuestLogCompletionText", seam), ["Цель выполнена."]);
  assert.deepEqual(call("GetQuestLogGroupNum", seam), [0]);
  assert.deepEqual(call("IsCurrentQuestFailed", seam), [false]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [1]);
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), [1]);
  assert.deepEqual(call("IsQuestWatched", seam, 1), [true]);

  fired.length = 0;
  call("RemoveQuestWatch", seam, 1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 1]]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [0]);
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), []);
  assert.deepEqual(call("IsQuestWatched", seam, 1), [false]);
  fired.length = 0;
  call("RemoveQuestWatch", seam, 1);
  assert.deepEqual(fired, [], "removing an already-unwatched quest is quiet");
  call("AddQuestWatch", seam, 1, 300);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 1]]);
  fired.length = 0;
  call("AddQuestWatch", seam, 1);
  assert.deepEqual(fired, [], "adding an already-watched quest is quiet");

  assert.equal(seam.setQuestObjective(9001, 1, 5), 2);
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.questWatchUpdate, 1],
    [FRAMEXML_SEAM_EVENTS.questLogUpdate],
  ]);
  fired.length = 0;
  assert.equal(seam.setQuestObjective(9001, 1, 5), 0);
  assert.deepEqual(fired, []);
  seam.detach();
});

test("canned unresolved template stays nil until selected row is resolved", () => {
  const seam = new CannedWorldSeam([], undefined, [], [], [{ questId: 77 }]);
  call("SelectQuestLogEntry", seam, 1);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "", 0, undefined, 0, false, false, undefined, false, 77, false,
  ]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), []);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [0]);
  assert.deepEqual(call("GetQuestLogCompletionText", seam), []);
  seam.setQuestTemplate(77, {
    title: "Resolved", level: 12, description: "Detail", objectivesText: "Objectives",
    completedText: "Done", objectives: [{ text: "One", need: 1, have: 0 }],
  });
  assert.deepEqual(call("GetQuestLogQuestText", seam), ["Detail", "Objectives"]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["One: 0/1", "monster", false]);
});

test("live QuestLog reads update fields and cached templates without per-frame scans", () => {
  const selfGuid = 0x101n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const fields = new Map([
    [base, 77], [base + 1, 0], [base + 2, 2], [base + 3, 0], [base + 4, 150],
  ]);
  const object = { guid: selfGuid, typeId: 4, fields };
  let objectReads = 0;
  const objects = { get(guid) {
    objectReads++;
    return guid === selfGuid ? object : undefined;
  } };
  const storeListeners = new Map();
  const worldListeners = new Map();
  const store = {
    field: () => () => {},
    any: () => () => {},
    events: { on: (name, listener) => {
      storeListeners.set(name, listener);
      return () => storeListeners.delete(name);
    } },
  };
  const world = {
    mapId: 1,
    state: { selfGuid, objects },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(),
    creatureTemplates: new Map(),
    gameObjectTemplates: new Map([[456, { name: "Сундук Братства" }]]),
    questTemplates: new Map(), questPoi: new Map([
      // 3.13c: a blob counts for an objective still open (Wow.exe 0x5e2950): slot 1, the chest.
      [77, [{ map: 1, worldMapAreaId: 10, objectiveIndex: 1, points: [] }]],
      [88, [{ map: 1, worldMapAreaId: 11, objectiveIndex: 1, points: [] }]],
    ]), cooldownRemaining: () => 0,
    currentServerTime: () => 100,
    queryQuestCalls: [],
    queryQuest(questId) { this.queryQuestCalls.push(questId); },
    events: { on: (name, listener) => {
      worldListeners.set(name, listener);
      return () => worldListeners.delete(name);
    } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    creatureInfo: (entry) => entry === 123 ? { name: "Лесной волк" } : undefined,
    itemInfo: (itemId) => itemId === 999
      ? { name: "Кусок мяса вепря", texture: "Interface\\Icons\\INV_Misc_Food_16" }
      : undefined,
    worldMapAreaId: () => 10,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
    now: () => 1,
  });
  fired.length = 0;
  // A quest whose record is not cached is not listed yet, as in the client (Wow.exe 0x005e6940),
  // and building the list asks for it.
  assert.deepEqual(call("GetNumQuestLogEntries", seam), [0, 0]);
  // 3.13c: without the quest's record there is no objective mask, so no POI (Wow.exe 0x5e2950).
  assert.deepEqual(call("QuestMapUpdateAllQuests", seam), [0]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 1), []);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "", 0, undefined, 0, false, false, undefined, false, 0, false,
  ]);
  call("SelectQuestLogEntry", seam, 1);
  assert.deepEqual([...new Set(world.queryQuestCalls)], [77]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), []);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [0]);

  world.questTemplates.set(77, {
    questId: 77, level: 10, minLevel: 1, sortId: 0, type: 0, suggestedPlayers: 2,
    nextQuest: 0, rewardMoney: 0, rewardBonusMoney: 0, rewardSpell: 0, rewardHonor: 0,
    startItem: 0, flags: 0, rewardTitleId: 0, requiredPlayerKills: 0, rewardTalents: 0,
    rewardItems: [], rewardChoiceItems: [], poi: { map: 0, x: 0, y: 0, priority: 0 },
    title: "Resolved", objectivesText: "Objectives", details: "Detail", areaDescription: "",
    completedText: "Done", objectives: [
      { entry: 123, count: 3, gameObject: false, itemDrop: 0, text: "" },
      { entry: 456, count: 1, gameObject: true, itemDrop: 0, text: "" },
    ],
    itemObjectives: [{ itemId: 999, count: 1 }],
  });
  objectReads = 0;
  worldListeners.get("QUEST_LOG_CHANGED")?.({});
  assert.ok(objectReads <= 20, "one quest-log reconciliation takes one bounded inventory snapshot");
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]]);
  fired.length = 0;
  worldListeners.get("QUEST_LOG_CHANGED")?.({});
  assert.deepEqual(fired, [], "same template edge is deduplicated");
  // Now listed: line 1 is its ZoneOrSort 0 header, the quest is line 2.
  assert.deepEqual(call("GetNumQuestLogEntries", seam), [2, 1]);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "Missing header! (quest designers)", 0, undefined, 0, true, false, undefined, false, 0, false,
  ]);
  call("SelectQuestLogEntry", seam, 2);
  assert.deepEqual(call("GetQuestLogQuestText", seam), ["Detail", "Objectives"]);
  assert.equal(world.creatureTemplates.size, 0,
    "stock names an objective directly from context metadata without a world template");
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 2/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Сундук Братства: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Кусок мяса вепря", "item", false]);
  assert.deepEqual(call("GetQuestLogTimeLeft", seam), [50]);
  assert.deepEqual(call("GetQuestLogGroupNum", seam), [2]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [1], "live defaults current rows to watched");
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), [2]);
  assert.deepEqual(call("IsQuestWatched", seam, 2), [true]);
  fired.length = 0;
  call("RemoveQuestWatch", seam, 2);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]]);
  fired.length = 0;
  call("RemoveQuestWatch", seam, 2);
  assert.deepEqual(fired, [], "live duplicate removal is quiet");
  call("AddQuestWatch", seam, 2, 300);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]]);
  fired.length = 0;

  worldListeners.get("QUEST_PROGRESS")?.({ questId: 77, entry: 123, count: 2, required: 3 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]]);
  worldListeners.get("QUEST_PROGRESS")?.({ questId: 77, entry: 123, count: 2, required: 3 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]], "same progress is quiet");

  fields.set(base + 2, 3);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2],
    [FRAMEXML_SEAM_EVENTS.unitQuestLogChanged, "player"],
  ]);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2],
    [FRAMEXML_SEAM_EVENTS.unitQuestLogChanged, "player"],
  ], "same field shape is quiet");
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 3/3", "monster", true]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [1]);
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), [2]);
  assert.deepEqual(call("IsQuestWatched", seam, 2), [true]);

  // Explicit removals are retained by quest id when a row leaves and later returns; new ids
  // retain the native-compatible default watched state.
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  call("RemoveQuestWatch", seam, 2);
  fields.set(base, 0);
  fields.set(base + stride, 77);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(call("IsQuestWatched", seam, 2), [false]);
  world.questTemplates.set(88, { ...world.questTemplates.get(77), questId: 88, title: "Other" });
  fields.set(base + stride, 88);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(call("IsQuestWatched", seam, 2), [true]);

  fields.set(base, 77);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(call("QuestMapUpdateAllQuests", seam), [1],
    "current map area excludes a remote WorldMapArea on the same map");
  // The second value is the quest's displayed log row: header, «Other» (88), «Resolved» (77).
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 1), [77, 3]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 2), []);

  fired.length = 0;
  objectReads = 0;
  seam.tick(1.01);
  const readsAfterBoundary = objectReads;
  seam.tick(1.02);
  assert.equal(objectReads, readsAfterBoundary, "sub-60ms render does not rescan quest state");
  seam.tick(1.08);
  assert.deepEqual(fired.filter(([event]) => [
    FRAMEXML_SEAM_EVENTS.questLogUpdate,
    FRAMEXML_SEAM_EVENTS.unitQuestLogChanged,
    FRAMEXML_SEAM_EVENTS.questWatchUpdate,
  ].includes(event)), [], "quest events come only from authoritative edges");
  seam.detach();
});

test("stock QuestLog prefetches cold objective metadata when a cached quest enters the player log", () => {
  const selfGuid = 0x202n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const fields = new Map([[base, 0], [base + 1, 0], [base + 2, 0], [base + 3, 0]]);
  const object = { guid: selfGuid, typeId: 4, fields };
  const storeListeners = new Map();
  const worldListeners = new Map();
  const store = {
    field: () => () => {},
    any: () => () => {},
    events: { on: (name, listener) => {
      storeListeners.set(name, listener);
      return () => storeListeners.delete(name);
    } },
  };
  const questTemplate = {
    questId: 77, level: 10, minLevel: 1, sortId: 0, type: 0, suggestedPlayers: 0,
    nextQuest: 0, rewardMoney: 0, rewardBonusMoney: 0, rewardSpell: 0, rewardHonor: 0,
    startItem: 0, flags: 0, rewardTitleId: 0, requiredPlayerKills: 0, rewardTalents: 0,
    rewardItems: [], rewardChoiceItems: [], poi: { map: 0, x: 0, y: 0, priority: 0 },
    title: "Cold cache", objectivesText: "Objectives", details: "Detail", areaDescription: "",
    completedText: "Done", objectives: [
      { entry: 123, count: 3, gameObject: false, itemDrop: 0, text: "" },
      { entry: 456, count: 1, gameObject: true, itemDrop: 0, text: "" },
    ],
    itemObjectives: [{ itemId: 999, count: 1 }],
  };
  const creatureQueries = [];
  const gameObjectQueries = [];
  const world = {
    mapId: 1,
    state: { selfGuid, objects: new Map([[selfGuid, object]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(),
    creatureTemplates: new Map(), gameObjectTemplates: new Map(),
    questTemplates: new Map([[77, questTemplate]]), questPoi: new Map(),
    cooldownRemaining: () => 0, currentServerTime: () => 100,
    creatureTemplate(entry) {
      creatureQueries.push(entry);
      return this.creatureTemplates.get(entry);
    },
    gameObjectTemplate(entry, guid) {
      gameObjectQueries.push([entry, guid]);
      return this.gameObjectTemplates.get(entry);
    },
    events: { on: (name, listener) => {
      worldListeners.set(name, listener);
      return () => worldListeners.delete(name);
    } },
  };
  const itemMetadata = new Map();
  const prefetchCalls = [];
  let finishPrefetch;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    itemInfo: (itemId) => itemMetadata.get(itemId),
    prefetchQuestMetadata: (itemIds, spellIds, onChanged) => {
      prefetchCalls.push([[...itemIds], [...spellIds]]);
      finishPrefetch = onChanged;
    },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
    now: () => 1,
  });
  assert.deepEqual(prefetchCalls, [], "an empty log starts no target metadata work");

  fields.set(base, 77);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(creatureQueries, [123]);
  assert.deepEqual(gameObjectQueries, [[456, 0n]]);
  assert.deepEqual(prefetchCalls, [[[999], []]]);
  assert.equal(typeof finishPrefetch, "function");
  // Line 1 is the quest's ZoneOrSort 0 header (FrameXmlQuestLog.ts), the quest is line 2.
  call("SelectQuestLogEntry", seam, 2);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Существо #123: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Объект #456: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Предмет #999", "item", false]);

  world.creatureTemplates.set(123, { name: "Лесной волк" });
  world.gameObjectTemplates.set(456, { name: "Сундук Братства" });
  itemMetadata.set(999, {
    name: "Кусок мяса вепря", texture: "Interface\\Icons\\INV_Misc_Food_16",
  });
  fired.length = 0;
  finishPrefetch();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Сундук Братства: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Кусок мяса вепря", "item", false]);

  itemMetadata.clear();
  world.creatureTemplates.clear();
  world.gameObjectTemplates.clear();
  fired.length = 0;
  worldListeners.get("QUERY_CACHE_CHANGED")?.({ kind: "cleared", id: 0 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]],
    "cache invalidation immediately republishes the explicit id fallback");
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Существо #123: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Объект #456: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Предмет #999", "item", false]);
  assert.deepEqual(creatureQueries, [123, 123]);
  assert.deepEqual(gameObjectQueries, [[456, 0n], [456, 0n]]);
  assert.deepEqual(prefetchCalls, [[[999], []], [[999], []]], "cleared resets the prefetch gate once");

  world.creatureTemplates.set(123, { name: "Лесной волк" });
  world.gameObjectTemplates.set(456, { name: "Сундук Братства" });
  itemMetadata.set(999, {
    name: "Кусок мяса вепря", texture: "Interface\\Icons\\INV_Misc_Food_16",
  });
  fired.length = 0;
  finishPrefetch();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Сундук Братства: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Кусок мяса вепря", "item", false]);
  seam.detach();
});
