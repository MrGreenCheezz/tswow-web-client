// Plan item 3.58 (24.10): the owner's two world-map defects.
// 1. Landmarks: Wow.exe lists AreaPOI rows by GetPOIPosition's flag tests (0x005445f0: zone 0x4, continent 0x8,
//    Azeroth 0x10, 0x400 own area), explored areas and set world states (CGWorldMap::SetMap 0x00546310), and
//    GetMapLandmarkInfo (0x00545a30) answers Icon[state] only for flag 0x80, the gossip POI or a continent —
//    elsewhere 0, the empty POIIcons cell. We answered Icon[0] everywhere: the towns' 7, a red banner.
// 2. Quests: WorldMap_OpenToQuest asks GetQuestWorldMapAreaID (0x005e56c0 → 0x005e2b60), which answered nothing:
//    SetMapByID(nil) did nothing and the map stayed on the player's zone (Stormwind here, not Westfall).
import assert from "node:assert/strict";
import test, { after } from "node:test";

let clientDirectory;
let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
  dbcDirectory = paths.dbcDirectory();
} catch {
  clientDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };
const withClient = { skip: clientDirectory && dbcDirectory ? false : "no 3.3.5a client and DBC dataset on this machine" };

const { FrameXmlMap, FRAMEXML_MAP_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { areaPoiFlagsAllow, areaPoiLandmarkIcon } = await import("../dist/code/browser/framexml/FrameXmlMapLandmarks.js");
const { frameXmlQuestWorldMapArea } = await import("../dist/code/browser/framexml/FrameXmlQuestPoiMapArea.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const data = dbcDirectory ? await (await import("../dist/code/gateway/AreaMetadata.js")).loadAreaData(dbcDirectory) : undefined;
const mapArea = (name) => data.mapAreas.find((area) => area.name === name);
const poi = (id) => data.areaPois.find((row) => row.id === id);

function landmarks(map) {
  const rows = [];
  for (let i = 1; i <= map.getNumMapLandmarks(); i++) {
    const [name, description, icon, x, y, link, battle] = map.getMapLandmarkInfo(i);
    rows.push({ name, description, icon, x, y, link, battle });
  }
  return rows;
}

test("flag tests and icons of 0x005445f0/0x00545a30, row by row", () => {
  const town = { flags: 0x205, icons: [7, 0, 0, 0, 0, 0, 0, 0, 0], worldStateId: 0 };
  assert.equal(areaPoiFlagsAllow("zone", town.flags), true);
  assert.equal(areaPoiFlagsAllow("continent", town.flags), false, "a village is not on the continent: no 0x8");
  assert.equal(areaPoiLandmarkIcon("zone", town, () => undefined), 0, "on a zone map the empty cell, not the banner");
  const sentinelHill = { flags: 0x20d, icons: [5, 0, 0, 0, 0, 0, 0, 0, 0], worldStateId: 0 };
  assert.equal(areaPoiFlagsAllow("continent", sentinelHill.flags), true);
  assert.equal(areaPoiLandmarkIcon("continent", sentinelHill, () => undefined), 5, "the town icon on the continent");
  assert.equal(areaPoiFlagsAllow("world", 0x20d), false, "Azeroth wants 0x10");
  assert.equal(areaPoiFlagsAllow("world", 0x21d), true);
  const tower = { flags: 0x287, icons: [6, 11, 10, 0, 0, 0, 0, 0, 0], worldStateId: 2355 };
  assert.equal(areaPoiLandmarkIcon("zone", tower, () => 2), 11, "0x80: Icon[state − 1] on a zone map too");
  assert.equal(areaPoiLandmarkIcon("zone", tower, () => 12), 6, "a state past 9 reads Icon[0]");
  assert.equal(areaPoiLandmarkIcon("zone", tower, () => 0), 6, "state 0 − 1 wraps past 9: Icon[0]");
});

test("Elwynn and Westfall: town rows are blank hover spots; the continent shows town and city icons", withDataset, () => {
  const elwynn = mapArea("Elwynn");
  let explored = () => true;
  const states = new Map();
  const map = new FrameXmlMap({
    metadata: () => data, location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_460, y: 60 }),
    isExploredArea: (id) => explored(id), worldState: (id) => states.get(id),
  });
  const zone = landmarks(map);
  const goldshire = zone.find((row) => row.name === poi(7).name);
  assert.ok(goldshire, "Goldshire (AreaPOI 7, flags 0x205) is listed on Elwynn");
  assert.equal(goldshire.icon, 0, "Wow.exe answers icon 0 there; Icon[0] = 7 is the red banner we drew");
  assert.equal(goldshire.link, undefined, "WorldMapLink 0 is nil: a click falls through to the map");
  assert.equal(goldshire.battle, true, "flags 0x200: showInBattleMap");
  assert.deepEqual(zone.filter((row) => row.icon !== 0), [], "no zone landmark of Elwynn has a drawn icon");
  explored = (id) => id !== poi(7).areaId;
  assert.equal(landmarks(map).some((row) => row.name === poi(7).name), false, "an unexplored area's row is not listed");
  explored = () => true;

  map.setMapById(mapArea("Westfall").id);
  const westfall = landmarks(map);
  assert.ok(westfall.length > 0);
  assert.deepEqual(westfall.filter((row) => row.icon !== 0), [], "nor of Westfall");
  assert.ok(westfall.some((row) => row.name === poi(15).name), "Sentinel Hill is a hover spot there");

  map.zoomOut();
  assert.deepEqual(map.getMapInfo(), ["Azeroth"], "the Eastern Kingdoms continent map");
  const continent = landmarks(map);
  assert.equal(continent.find((row) => row.name === poi(15).name)?.icon, 5, "Sentinel Hill: the town icon (0x20d)");
  assert.equal(continent.find((row) => row.name === poi(16).name)?.icon, 6, "Stormwind: the city icon (0x21d)");
  assert.equal(continent.some((row) => row.name === poi(7).name), false, "Goldshire (no 0x8) is not on the continent");
  assert.equal(continent.find((row) => row.name === poi(41).name)?.icon, 5, "a FactionID row (Grom'gol, Horde) is not filtered");

  // Eastern Plaguelands' towers: 0x287 rows, one per world state; only the set one is listed, with its icon.
  map.setMapById(mapArea("EasternPlaguelands").id);
  const towers = () => landmarks(map).filter((row) => row.name === poi(1770).name);
  assert.deepEqual(towers(), [], "no world state: none");
  states.set(poi(1773).worldStateId, 1);
  assert.deepEqual(towers().map((row) => [row.description, row.icon]), [[poi(1773).description, poi(1773).icons[0]]]);
});

test("ClickLandmark opens a WorldMapLink's dungeon floor", withDataset, () => {
  // No AreaPOI row of this 3.3.5a dataset carries a WorldMapLink; the call itself is still the client's.
  assert.equal(data.areaPois.filter((row) => row.worldMapLink !== 0).length, 0);
  const floor = data.dungeonMaps.find((row) => row.mapId === 571 && row.floorIndex === 2);
  assert.ok(floor, "Dalaran's second floor");
  const map = new FrameXmlMap({ metadata: () => data, location: () => ({ mapId: 0, areaId: 12, x: -9_000, y: -400 }) });
  FRAMEXML_MAP_BINDINGS.ClickLandmark({ map }, [floor.id]);
  assert.equal(map.getCurrentMapDungeonLevel(), 2, "at that floor");
  const shown = data.mapAreas.find((row) => row.id === map.getCurrentMapAreaId() - 1);
  assert.equal(shown?.mapId, floor.mapId, "the floor's own map");
  FRAMEXML_MAP_BINDINGS.ClickLandmark({ map }, [999_999]);
  assert.equal(map.getCurrentMapAreaId() - 1, shown.id, "an unknown floor does nothing");
});

const blob = (fields) => ({ index: 0, objectiveIndex: -1, map: 0, worldMapAreaId: 12, floor: 0, priority: 0, flags: 0, points: [], ...fields });

test("GetQuestWorldMapAreaID: current area first, then the nearest on this map, then any; else the header zone", () => {
  let player = { x: 0, y: 0 };
  let current = { id: 30, mapId: 0, floor: 0 };
  const mapOf = { 30: 0, 39: 0, 40: 0, 41: 1 };
  let quests = [{ questId: 5, mask: 0b11 }];
  let blobs = {};
  const context = {
    quests: () => quests, blobs: (id) => blobs[id], player: () => player, currentMapArea: () => current,
    mapAreaMapId: (id) => mapOf[id], headerMapArea: (id) => (id === 5 ? 30 : 0),
  };
  const ask = (id) => [...frameXmlQuestWorldMapArea(context, id)];
  assert.deepEqual(ask(5), [30, 0], "no POI response yet: the header's zone");
  blobs = { 5: [] };
  assert.deepEqual(ask(5), [30, 0], "an empty response: the header's zone too");
  blobs = { 5: [
    blob({ objectiveIndex: 0, worldMapAreaId: 41, points: [{ x: 0, y: 0 }] }),
    blob({ objectiveIndex: 1, worldMapAreaId: 39, points: [{ x: 900, y: 0 }] }),
    blob({ objectiveIndex: 0, worldMapAreaId: 40, points: [{ x: 100, y: 0 }] }),
  ] };
  assert.deepEqual(ask(5), [40, 0], "same map as the player's zone: the nearest centroid beats another continent");
  player = { x: 1000, y: 0 };
  assert.deepEqual(ask(5), [39, 0]);
  quests = [{ questId: 5, mask: 0b1 }];
  assert.deepEqual(ask(5), [40, 0], "objective 1 is done: its blob does not count");
  blobs[5].push(blob({ objectiveIndex: 0, worldMapAreaId: 30, points: [{ x: 5000, y: 0 }] }));
  assert.deepEqual(ask(5), [30, 0], "a blob on the player's own zone answers at once");
  quests = [{ questId: 5, mask: -1 }];
  assert.deepEqual(ask(5), [30, 0], "met: only turn-in blobs count, none here — the header");
  blobs[5].push(blob({ objectiveIndex: -1, worldMapAreaId: 41, floor: 2, points: [{ x: 0, y: 0 }] }));
  assert.deepEqual(ask(5), [41, 2], "the turn-in blob on another continent, with its floor");
  current = undefined;
  assert.deepEqual(ask(5), [30, 0], "no current WorldMapArea: the header");
  player = undefined;
  assert.deepEqual(ask(5), [0, 0], "no player: 0, 0");
  assert.throws(() => FRAMEXML_SEAM_BINDINGS.GetQuestWorldMapAreaID({}, ["x"]), /Usage: GetQuestWorldMapAreaID/);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetQuestWorldMapAreaID({}, [5])], [0, 0], "no POI model: 0, 0");
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetQuestWorldMapAreaID({ questPoi: { worldMapArea: () => [39, 0] } }, ["5"])],
    [39, 0]);
});

// ---- The stock UI: the tracker's POI button and the quest log's «Карта» button open the quest's zone. ----

const chain = clientDirectory ? await (await import("../tools/mpq.mjs")).clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

function questTemplate(questId, title, fields = {}) {
  return {
    questId, level: 10, minLevel: 1, sortId: 12, type: 0, suggestedPlayers: 0, nextQuest: 0, rewardMoney: 0,
    requiredMoney: 0, rewardBonusMoney: 0, rewardDisplaySpell: 0, rewardSpellCast: 0, rewardSpell: 0, rewardHonor: 0,
    startItem: 0, flags: 0, sourceItems: [0, 0, 0, 0], rewardTitleId: 0, requiredPlayerKills: 0, rewardTalents: 0,
    rewardItems: [], rewardChoiceItems: [], poi: { map: 0, x: 0, y: 0, priority: 0 }, title, objectivesText: "Цель",
    details: "", areaDescription: "", completedText: "Вернитесь", objectives: [], itemObjectives: [], ...fields,
  };
}

test("stock WorldMap_OpenToQuest: the tracker and the quest log open the quest's zone with its marker and blob", withClient, async () => {
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { setQuestPoiFrameAdapter } = await import("../dist/code/browser/glue/GlueQuestPoiFrame.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const { WorldState } = await import("../dist/code/world/WorldState.js");
  const { WorldStore } = await import("../dist/code/world/WorldStore.js");

  const westfall = mapArea("Westfall");
  const elwynn = mapArea("Elwynn");
  const stormwind = mapArea("Stormwind");
  const PLAYER = 0x10n;
  const offset = (name) => UPDATE_FIELDS[name].offset;
  const base = offset("PLAYER_QUEST_LOG_1_1");
  const stride = offset("PLAYER_QUEST_LOG_2_1") - base;
  const world = new WorldClient({ send() {}, close() {} });
  const state = new WorldState();
  world.state = state;
  state.objects.set(PLAYER, {
    guid: PLAYER, typeId: 4, position: { x: -8_833, y: 628, z: 94, orientation: 0 }, movementFlags: 0, updateFlags: 0,
    fields: new Map([
      [offset("UNIT_FIELD_BYTES_0"), 1 | (2 << 8)], [offset("UNIT_FIELD_LEVEL"), 18],
      [offset("UNIT_FIELD_HEALTH"), 400], [offset("UNIT_FIELD_MAXHEALTH"), 400],
      // Slot 0: quest 109, complete (its turn-in is in Westfall). Slot 1: quest 62, the mine still to explore.
      [base, 109], [base + 1, 1], [base + stride, 62], [base + stride + 1, 0],
    ]),
  });
  state.selfGuid = PLAYER;
  world.mapId = 0;
  world.selfName = "Флик";
  world.currentGameTime = () => ({ minuteOfDay: 600, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } });
  world.calendarPending = 0;
  world.questTemplates.set(109, questTemplate(109, "Доложить Гриану Стоутмэнтлу"));
  world.questTemplates.set(62, questTemplate(62, "Рудник Подземных Глубин", { objectives: [
    { entry: 123, count: 5, gameObject: false, itemDrop: 0, text: "", slot: 0 },
  ] }));
  // The live realm's quest_poi rows of both quests (SELECT on 24.10): 109 — one turn-in point at Sentinel Hill;
  // 62 — a polygon for its objective 0 (here: five kills, none yet) and the turn-in point.
  world.questPoi.set(109, [blob({ objectiveIndex: -1, worldMapAreaId: westfall.id, flags: 1, points: [{ x: -10_509, y: 1_045 }] })]);
  world.questPoi.set(62, [
    blob({ objectiveIndex: 0, worldMapAreaId: elwynn.id, flags: 1,
      points: [{ x: -9_800, y: -500 }, { x: -9_800, y: -300 }, { x: -9_600, y: -300 }, { x: -9_600, y: -500 }] }),
    blob({ index: 1, objectiveIndex: -1, worldMapAreaId: elwynn.id, flags: 1, points: [{ x: -9_464, y: 74 }] }),
  ]);
  const store = new WorldStore(state);
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store,
    spell: (id) => ({ id, name: "Проверка", rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    mapSource: {
      metadata: () => data,
      location: () => ({ mapId: 0, areaId: stormwind.areaId, x: -8_833, y: 628, orientation: 0 }),
      corpseLocation: () => null, deathReleaseLocation: () => null, isExploredArea: () => true,
    },
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const paints = [];
  const releaseAdapter = setQuestPoiFrameAdapter({
    shapes: (id, style) => seam.questPoi.shapes(id, style), logIndex: (id) => seam.questPoi.logIndex(id),
    paint: (frame, quests) => paints.push([frame.name, [...quests]]),
  });
  const decoder = new TextDecoder();
  const boot = new FrameXmlBoot({
    provider: { async read(path) {
      const bytes = await chain.read(path.replaceAll("/", "\\"));
      return bytes ? decoder.decode(bytes) : undefined;
    } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1280, height: 768 }),
  });
  const lua = (code, results = 0) => {
    const fn = boot.vm.compileFunction(code, "@worldmap-quest", []);
    assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
    try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
  };
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`);
  try {
    await boot.load();
    boot.bridge.Show(boot.bridge.getFrame("UIParent"));
    seam.tick(5);
    const baseline = failures().length;
    const view = () => {
      seam.map.tick();
      seam.tick(1);
      return lua(`return WorldMapFrame:IsShown() and 1 or 0, GetMapInfo(), WORLDMAP_SETTINGS.selectedQuestId,
        WorldMapFrame.blockWorldMapUpdate and 1 or 0, WorldMapQuestFrame1 and WorldMapQuestFrame1.questId,
        WorldMapQuestFrame1 and WorldMapQuestFrame1.poiIcon and WorldMapQuestFrame1.poiIcon:IsShown() and 1 or 0`, 6);
    };

    // The tracker's numbered button (WatchFrameQuestPOI_OnClick → WorldMap_OpenToQuest).
    lua("WatchFrameQuestPOI_OnClick({ questId = 109 })");
    assert.deepEqual(failures().slice(baseline), [], "no Lua error on the way");
    let [shown, name, selected, blocked, first, icon] = view();
    assert.equal(shown, 1);
    assert.equal(name, "Westfall", "the map opens on the quest's zone, not the player's Stormwind");
    assert.equal(blocked, 0, "WorldMapFrame.blockWorldMapUpdate is cleared again");
    assert.equal(selected, 109, "the quest is selected");
    assert.equal(first, 109);
    assert.equal(icon, 0, "a met quest's own button gives way to the swap button while selected (QuestPOI.lua)");
    assert.deepEqual(lua(`local swap = QUEST_POI_SWAP_BUTTONS["WorldMapPOIFrame"]
      local _, anchor = swap:GetPoint(1)
      return swap and swap:IsShown() and 1 or 0, anchor == WorldMapQuestFrame1.poiIcon and 1 or 0,
        select(2, QuestPOIGetIconInfo(109)) and 1 or 0`, 3),
    [1, 1, 1], "the turn-in marker (the «?» swap button) stands on Sentinel Hill");

    // The quest log's «Карта» button with quest 62 selected (its row is 3: header, 109, 62 — both under Elwynn).
    lua("HideUIPanel(WorldMapFrame)");
    const row = seam.questLog.indexOfQuest(62);
    lua(`QuestLogFrame.selectedIndex = ${row}`);
    paints.length = 0;
    boot.bridge.fireScript(boot.bridge.getFrame("QuestLogFrameShowMapButton"), "OnClick", "LeftButton");
    assert.deepEqual(failures().slice(baseline), []);
    [shown, name, selected, blocked, first, icon] = view();
    assert.deepEqual([shown, name, selected, blocked, first, icon], [1, "Elwynn", 62, 0, 62, 1],
      "Elwynn, quest 62 selected, its numbered marker shown");
    assert.equal(seam.questPoi.shapes(62).shapes.length, 1, "one shaded area: the objective's blob");
    // GetQuestWorldMapAreaID first sets the map to the player's zone, as 0x005e2b60 does.
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetQuestWorldMapAreaID(seam, [109])], [westfall.id, 0]);
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetQuestWorldMapAreaID(seam, [62])], [elwynn.id, 0]);
    assert.ok(paints.some(([frame, quests]) => frame === "WorldMapBlobFrame" && quests.includes(62)),
      "the objective's area is painted for the selected quest");
  } finally {
    releaseAdapter();
    boot.close();
  }
});
