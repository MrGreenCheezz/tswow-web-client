// Plan item 3.13c: the quest POI C API and the QuestPOIFrame widget as Wow.exe 3.3.5a 12340 answers them
// (0x5e7370 POI store, 0x5e2950 mask, 0x5e5a50/0x5e63d0 QuestMapUpdateAllQuests, 0x5e3840/0x5e5750 visible
// index, 0x5e0590/0x5e2eb0 icon, 0x5e6650/0x5e58c0 leaderboard, 0xacf180 QuestPOIFrame methods; read 2026-10-02).
import assert from "node:assert/strict";
import test from "node:test";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };

const {
  questPoiCentroid, questPoiBlobCounts, frameXmlQuestPoiMask, frameXmlQuestPoiVisible, frameXmlQuestPoiIconInfo,
  frameXmlQuestPoiShapes, questPoiShapeContains, FrameXmlQuestPoiModel, QUEST_POI_EVENT_BIT,
} = await import("../dist/code/browser/framexml/FrameXmlQuestPoi.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FrameXmlMap } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { setQuestPoiFrameAdapter } = await import("../dist/code/browser/glue/GlueQuestPoiFrame.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

const blob = (fields) => ({ index: 0, objectiveIndex: -1, map: 0, worldMapAreaId: 12, floor: 0, priority: 0, flags: 0, points: [], ...fields });
const square = (x, y, size = 10) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];

test("the centroid is in whole yards, the sum divided by the count as C does", () => {
  assert.deepEqual(questPoiCentroid(blob({ points: [{ x: -9184, y: 100 }, { x: 50, y: -100 }] })), { x: -4567, y: 0 });
  assert.deepEqual(questPoiCentroid(blob({ points: [{ x: -3, y: 3 }, { x: 0, y: 0 }] })), { x: -1, y: 1 }, "truncated toward 0");
  assert.deepEqual(questPoiCentroid(blob({ points: [{ x: 7, y: -2 }] })), { x: 7, y: -2 });
});

test("the objective mask: -1 when met, open slots as bits, 0 when failed", () => {
  const base = { failed: false, serverComplete: false, creatures: [], items: [], sourceItems: [], eventObjective: false };
  assert.equal(frameXmlQuestPoiMask(base), -1, "no objectives at all: met");
  assert.equal(frameXmlQuestPoiMask({ ...base, creatures: [{ slot: 0, done: true }, { slot: 1, done: false }],
    items: [{ slot: 2, done: false }], sourceItems: [{ slot: 1, carried: false }, { slot: 3, carried: true }] }),
  (1 << 1) | (1 << 6) | (1 << 11));
  assert.equal(frameXmlQuestPoiMask({ ...base, creatures: [{ slot: 1, done: false }], serverComplete: true }), -1);
  assert.equal(frameXmlQuestPoiMask({ ...base, eventObjective: true }), 1 << QUEST_POI_EVENT_BIT, "an exploration not done");
  assert.equal(frameXmlQuestPoiMask({ ...base, failed: true }), 0);
  assert.equal(questPoiBlobCounts(blob({ objectiveIndex: -1 }), -1), true);
  assert.equal(questPoiBlobCounts(blob({ objectiveIndex: 1 }), -1), false, "a met quest shows its turn-in blob only");
  assert.equal(questPoiBlobCounts(blob({ objectiveIndex: 1 }), 0b10), true);
  assert.equal(questPoiBlobCounts(blob({ objectiveIndex: 0 }), 0b10), false);
});

/** A map plane: the world square [-1000, 0]² maps onto [0, 1]². */
function poiContext({ quests, blobs, player = { x: -500, y: -500 }, enabled = true }) {
  return {
    enabled: () => enabled,
    quests: () => quests,
    blobs: (id) => blobs[id],
    point: (b, x, y) => (b.map === 0 && x >= -1000 && x <= 0 && y >= -1000 && y <= 0 ? { u: -y / 1000, v: -x / 1000 } : undefined),
    player: () => player,
  };
}

test("marked quests: met ones first, then the watched, then the rest; never more than 25", () => {
  const quests = [
    { questId: 1, logIndex: 2, complete: false, watched: false, mask: 0b1 },
    { questId: 2, logIndex: 3, complete: false, watched: true, mask: 0b1 },
    { questId: 3, logIndex: 4, complete: true, watched: false, mask: -1 },
    { questId: 4, logIndex: 5, complete: false, watched: true, mask: 0b1 },
  ];
  const blobs = {
    1: [blob({ objectiveIndex: 0, points: square(-600, -600) })],
    2: [blob({ objectiveIndex: 0, points: square(-600, -600) })],
    3: [blob({ objectiveIndex: -1, points: square(-200, -200) })],
    4: [blob({ objectiveIndex: 0, map: 1, points: square(-600, -600) })],
  };
  assert.deepEqual(frameXmlQuestPoiVisible(poiContext({ quests, blobs })).map((quest) => quest.questId), [3, 2, 1],
    "quest 4's blob is on another map");
  assert.deepEqual(frameXmlQuestPoiVisible(poiContext({ quests, blobs, enabled: false })), [], "questPOI off");
  const many = Array.from({ length: 30 }, (_, index) => ({ questId: 100 + index, logIndex: index + 1, complete: false, watched: true, mask: 1 }));
  const manyBlobs = Object.fromEntries(many.map((quest) => [quest.questId, [blob({ objectiveIndex: 0, points: square(-600, -600) })]]));
  assert.equal(frameXmlQuestPoiVisible(poiContext({ quests: many, blobs: manyBlobs })).length, 25);
});

test("the icon: the counting blob with the lowest priority, then the one nearest the player", () => {
  const quests = [{ questId: 7, logIndex: 2, complete: false, watched: true, mask: 0b11 }];
  const blobs = { 7: [
    blob({ objectiveIndex: 0, priority: 1, points: square(-510, -510) }),
    blob({ objectiveIndex: 1, priority: 0, points: square(-910, -910) }),
    blob({ objectiveIndex: 1, priority: 0, points: square(-110, -110) }),
    blob({ objectiveIndex: 2, priority: 0, points: square(-505, -505) }),
  ] };
  const info = frameXmlQuestPoiIconInfo(poiContext({ quests, blobs, player: { x: -100, y: -100 } }), 7);
  assert.deepEqual(info, [false, 0.105, 0.105, 1], "priority 0 beats the nearer priority 1; the nearer of the two wins");
  const far = frameXmlQuestPoiIconInfo(poiContext({ quests, blobs, player: { x: -900, y: -900 } }), 7);
  assert.deepEqual(far, [false, 0.905, 0.905, 1]);
  const middle = frameXmlQuestPoiIconInfo(poiContext({ quests, blobs, player: { x: -500, y: -500 } }), 7);
  assert.deepEqual(middle, [false, 0.105, 0.105, 1], "the nearest blob is priority 1: a priority 0 one wins");
  assert.equal(frameXmlQuestPoiIconInfo(poiContext({ quests, blobs }), 8), undefined);
  const met = [{ questId: 7, logIndex: 2, complete: true, watched: true, mask: -1 }];
  assert.equal(frameXmlQuestPoiIconInfo(poiContext({ quests: met, blobs }), 7), undefined, "no turn-in blob");
});

test("shapes: three points or more, every point on the map; every blob while the quest is met", () => {
  const quests = [{ questId: 7, logIndex: 2, complete: false, watched: true, mask: 0b10 }];
  const blobs = { 7: [
    blob({ objectiveIndex: 1, points: square(-600, -600) }),
    blob({ objectiveIndex: 1, points: [{ x: -600, y: -600 }, { x: -500, y: -600 }] }),
    blob({ objectiveIndex: 1, points: [{ x: -600, y: -600 }, { x: -500, y: -600 }, { x: -500, y: 200 }] }),
    blob({ objectiveIndex: 0, points: square(-300, -300) }),
  ] };
  const drawn = frameXmlQuestPoiShapes(poiContext({ quests, blobs }), 7);
  assert.equal(drawn.mask, 0b10);
  assert.equal(drawn.shapes.length, 1);
  assert.ok(questPoiShapeContains(drawn.shapes[0], 0.595, 0.595));
  assert.equal(questPoiShapeContains(drawn.shapes[0], 0.2, 0.2), false);
  const met = frameXmlQuestPoiShapes(poiContext({ quests: [{ ...quests[0], mask: -1, complete: true }], blobs }), 7);
  assert.equal(met.shapes.length, 2, "both on-map blobs of three points or more");
});

test("the model marks on QuestMapUpdateAllQuests and the bindings answer id and log row", () => {
  const quests = [
    { questId: 1, logIndex: 2, complete: false, watched: true, mask: 0b1 },
    { questId: 3, logIndex: 4, complete: true, watched: false, mask: -1 },
  ];
  const blobs = {
    1: [blob({ objectiveIndex: 0, points: square(-600, -600) })],
    3: [blob({ objectiveIndex: -1, points: square(-200, -200) })],
  };
  const lines = [];
  const model = new FrameXmlQuestPoiModel({ ...poiContext({ quests, blobs }),
    leaderBoardLine: (logIndex, poi) => { lines.push([logIndex, poi]); return poi === 0 ? ["Волк: 1/5", "monster", false] : undefined; } });
  const host = { questPoi: model };
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](host, args)];
  assert.deepEqual(call("QuestMapUpdateAllQuests"), [2]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", 1), [3, 4]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", 2), [1, 2]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", 3), []);
  assert.deepEqual(call("QuestPOIGetIconInfo", 1), [false, 0.595, 0.595, 0]);
  assert.deepEqual(call("QuestPOIGetIconInfo", 3), [true, 0.195, 0.195, -1]);
  assert.deepEqual(call("QuestPOIUpdateIcons"), []);
  assert.deepEqual(call("GetQuestPOILeaderBoard", 0, 2), ["Волк: 1/5", "monster", undefined]);
  assert.deepEqual(call("GetQuestPOILeaderBoard", 4, 2), [undefined, undefined, undefined]);
  assert.deepEqual(call("GetQuestPOILeaderBoard", 16, 2), [undefined, undefined, undefined], "beyond 15: no line");
  assert.deepEqual(lines, [[2, 0], [2, 4]]);
});

test("a blob counts on the displayed map by the client's map, floor and flag rules", withDataset, async () => {
  const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
  const data = await loadAreaData(dbcDirectory);
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  const map = new FrameXmlMap({
    metadata: () => data, location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_000, y: -400 }),
    corpseLocation: () => null, deathReleaseLocation: () => null,
  });
  assert.equal(map.hasAreaData, true);
  const here = map.questPoiPoint({ map: 0, worldMapAreaId: elwynn.id, floor: 0 }, -9_000, -400);
  assert.ok(here && here.u > 0 && here.u < 1 && here.v > 0 && here.v < 1);
  assert.deepEqual(map.questPoiPoint({ map: 0, worldMapAreaId: 9999, floor: 0, flags: 0 }, -9_000, -400), here,
    "without flag 4 another WorldMapArea's blob still counts by its position");
  assert.equal(map.questPoiPoint({ map: 0, worldMapAreaId: 9999, floor: 0, flags: 4 }, -9_000, -400), undefined,
    "flag 4: only on its own WorldMapArea");
  assert.equal(map.questPoiPoint({ map: 1, worldMapAreaId: elwynn.id, floor: 0 }, -9_000, -400), undefined, "another map");
  assert.equal(map.questPoiPoint({ map: 0, worldMapAreaId: elwynn.id, floor: 0 }, 2_000, 2_000), undefined, "off the zone");
  map.zoomOut();
  const continent = map.questPoiPoint({ map: 0, worldMapAreaId: elwynn.id, floor: 0 }, -9_000, -400);
  assert.ok(continent && continent.u > 0 && continent.u < 1, "the continent map places it too");
  assert.equal(new FrameXmlMap({ metadata: () => undefined, location: () => undefined }).hasAreaData, false);
});

function questTemplate(questId, title, fields = {}) {
  return {
    questId, level: 10, minLevel: 1, sortId: 0, type: 0, suggestedPlayers: 0, nextQuest: 0, rewardMoney: 0,
    requiredMoney: 0, rewardBonusMoney: 0, rewardDisplaySpell: 0, rewardSpellCast: 0, rewardSpell: 0, rewardHonor: 0,
    startItem: 0, flags: 0, sourceItems: [0, 0, 0, 0], rewardTitleId: 0, requiredPlayerKills: 0, rewardTalents: 0,
    rewardItems: [], rewardChoiceItems: [], poi: { map: 0, x: 0, y: 0, priority: 0 }, title, objectivesText: "",
    details: "", areaDescription: "", completedText: "", objectives: [], itemObjectives: [], ...fields,
  };
}

test("the live seam: masks from the log counters, the displayed log row, the leaderboard line of a POI", withDataset, async () => {
  const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
  const data = await loadAreaData(dbcDirectory);
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  const selfGuid = 0x10n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  const fields = new Map([
    // Slot 0: quest 100, wolves 5/5, the chest 0/1. Slot 1: quest 101, complete (state 1).
    [base, 100], [base + 1, 0], [base + 2, 5],
    [base + stride, 101], [base + stride + 1, 1],
  ]);
  const self = { guid: selfGuid, typeId: 4, fields, position: { x: -9_000, y: -400, z: 0, orientation: 0 } };
  const world = {
    mapId: 0, state: { selfGuid, objects: new Map([[selfGuid, self]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(), creatureTemplates: new Map(),
    gameObjectTemplates: new Map([[456, { name: "Сундук" }]]),
    questTemplates: new Map([
      [100, questTemplate(100, "А", { objectives: [
        { entry: 123, count: 5, gameObject: false, itemDrop: 0, text: "", slot: 0 },
        { entry: 456, count: 1, gameObject: true, itemDrop: 0, text: "", slot: 1 },
      ] })],
      [101, questTemplate(101, "Б")],
    ]),
    questPoi: new Map([
      [100, [
        blob({ objectiveIndex: 0, worldMapAreaId: elwynn.id, points: square(-9_000, -400, 20) }),
        blob({ objectiveIndex: 1, worldMapAreaId: elwynn.id, points: square(-9_100, -500, 20) }),
      ]],
      [101, [blob({ objectiveIndex: -1, worldMapAreaId: elwynn.id, points: square(-9_050, -450, 20) })]],
    ]),
    cooldownRemaining: () => 0, currentServerTime: () => 100, queryQuest() {},
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    creatureInfo: (entry) => (entry === 123 ? { name: "Волк" } : undefined),
    mapSource: { metadata: () => data, location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_000, y: -400 }),
      corpseLocation: () => null, deathReleaseLocation: () => null },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  assert.deepEqual(call("GetNumQuestLogEntries"), [3, 2], "one header, two quests");
  assert.deepEqual(call("QuestMapUpdateAllQuests"), [2]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", 1), [101, 3], "the complete quest first, with its displayed row");
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", 2), [100, 2]);
  const icon = call("QuestPOIGetIconInfo", 100);
  assert.equal(icon[0], false);
  assert.equal(icon[3], 1, "only the chest's blob counts: the wolves are done");
  assert.deepEqual(call("QuestPOIGetIconInfo", 101).slice(0, 1), [true]);
  assert.deepEqual(call("GetQuestPOILeaderBoard", 1, 2), ["Сундук: 0/1", "object", undefined]);
  assert.deepEqual(call("GetQuestPOILeaderBoard", 0, 2), ["Волк: 5/5", "monster", 1]);
  assert.deepEqual(call("GetQuestPOILeaderBoard", 2, 2), [undefined, undefined, undefined]);
  assert.deepEqual(call("GetQuestPOILeaderBoard", 0, 1), [undefined, undefined, undefined], "a header row");
  assert.equal(seam.questPoi.shapes(100).shapes.length, 1);
});

async function bootBlobFrame() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Blob.xml",
      "interface/framexml/blob.xml": `<Ui>
        <Frame name="UIParent"><Size x="1024" y="768"/></Frame>
        <QuestPOIFrame name="Blob" parent="UIParent"><Size x="1002" y="668"/></QuestPOIFrame>
      </Ui>`,
    }),
    subset: ["Blob.xml"],
    exercise: false,
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@quest-poi-frame", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  return { boot, run };
}

test("QuestPOIFrame: four slots, the hit test answers the quest's log row and its objective", async () => {
  const shapes = {
    7: { mask: 0b10, shapes: [{ objectiveIndex: 1, points: [{ u: 0.1, v: 0.1 }, { u: 0.3, v: 0.1 }, { u: 0.3, v: 0.3 }, { u: 0.1, v: 0.3 }] }] },
    8: { mask: -1, shapes: [{ objectiveIndex: -1, points: [{ u: 0.5, v: 0.5 }, { u: 0.7, v: 0.5 }, { u: 0.7, v: 0.7 }] }] },
  };
  const paints = [];
  const release = setQuestPoiFrameAdapter({
    shapes: (id) => shapes[id], logIndex: (id) => (id === 7 ? 5 : 0),
    paint: (frame, quests, style) => paints.push([frame.name, [...quests], style.fillAlpha, style.borderScalar]),
  });
  const { boot, run } = await bootBlobFrame();
  try {
    run(`Blob:SetFillTexture("Interface\\\\WorldMap\\\\UI-QuestBlob-Inside") Blob:SetFillAlpha(128) Blob:SetBorderScalar(1.0)`);
    paints.length = 0;
    run(`Blob:DrawQuestBlob(7, true) Blob:DrawQuestBlob(7, true) Blob:DrawQuestBlob(8, 1)`);
    assert.deepEqual(paints, [["Blob", [7], 128, 1], ["Blob", [7, 8], 128, 1]], "a drawn quest is not added twice");
    assert.deepEqual(run(`return Blob:UpdateMouseOverTooltip(0.2, 0.2)`, 2), [5, 1]);
    assert.deepEqual(run(`return Blob:GetNumTooltips()`, 1), [1]);
    assert.deepEqual(run(`return Blob:GetTooltipIndex(1), Blob:GetTooltipIndex(2), Blob:GetTooltipIndex(5)`, 3), [1, 0, 0]);
    assert.deepEqual(run(`return Blob:UpdateMouseOverTooltip(0.6, 0.6)`, 2), [undefined, undefined], "a met quest has no tooltip");
    assert.deepEqual(run(`return Blob:GetNumTooltips()`, 1), [0]);
    assert.deepEqual(run(`return Blob:UpdateMouseOverTooltip(1.5, 0.2)`, 2), [undefined, undefined]);
    run(`Blob:DrawQuestBlob(9, true) Blob:DrawQuestBlob(10, true) Blob:DrawQuestBlob(11, true)`);
    assert.deepEqual(paints.at(-1)[1], [7, 8, 9, 10], "four slots");
    run(`Blob:DrawQuestBlob(7, false)`);
    assert.deepEqual(paints.at(-1)[1], [8, 9, 10]);
    assert.deepEqual(run(`return Blob:UpdateMouseOverTooltip(0.2, 0.2)`, 2), [undefined, undefined], "quest 7 is off");
    assert.deepEqual(boot.errors, []);
  } finally {
    release();
    boot.close();
  }
});

test("the painter: nothing before both textures, then fill and border per blob in the frame's canvas", async () => {
  const { installFrameXmlQuestPoiFrame } = await import("../dist/code/browser/framexml/FrameXmlQuestBlobPainter.js");
  const calls = [];
  const context2d = new Proxy({}, {
    get: (_target, name) => (name === "createPattern" ? () => undefined
      : typeof name === "string" && /^[a-z]/.test(name) ? (...args) => { calls.push([name, ...args]); } : undefined),
    set: (_target, name, value) => { calls.push([`=${String(name)}`, value]); return true; },
  });
  const created = [];
  const document = {
    defaultView: { devicePixelRatio: 2 },
    createElement: (tag) => {
      const node = { tag, className: "", style: {}, width: 0, height: 0, classList: { contains: (name) => node.className === name },
        getContext: () => context2d, addEventListener() {}, complete: false, naturalWidth: 0, set src(url) { created.push(url); } };
      return node;
    },
  };
  const element = { ownerDocument: document, offsetWidth: 100, offsetHeight: 50, children: [], prepend(child) { this.children.unshift(child); child.remove = () => { this.children.splice(this.children.indexOf(child), 1); }; } };
  const frame = { name: "WorldMapBlobFrame" };
  const shapes = { 7: { mask: 0b10, shapes: [{ objectiveIndex: 1, points: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }] }] } };
  const seam = { questPoi: { shapes: (id) => shapes[id], logIndex: () => 0 } };
  const release = installFrameXmlQuestPoiFrame(seam, { elementFor: () => element }, (path) => `tex:${path}`);
  try {
    const { boot, run } = await bootBlobFrame();
    try {
      run(`Blob:DrawQuestBlob(7, true)`);
      assert.equal(element.children.length, 1, "the canvas is put into the frame's box");
      assert.equal(element.children[0].width, 200, "sized to the box at the device ratio");
      assert.equal(calls.some(([name]) => name === "fill"), false, "no textures yet: nothing painted");
      run(`Blob:SetFillTexture("A") Blob:SetBorderTexture("B") Blob:SetFillAlpha(128) Blob:SetBorderAlpha(192)`);
      assert.deepEqual(created, ["tex:A", "tex:B"]);
      assert.ok(calls.some(([name]) => name === "fill") && calls.some(([name]) => name === "stroke"));
      assert.ok(calls.some(([name, a]) => name === "=globalAlpha" && a === 128 / 255));
      assert.ok(calls.some(([name, a]) => name === "=lineWidth" && Math.abs(a - 1 * 0.01 * 768 * 2 * 2) < 1e-9),
        "the band is BorderScalar × 0.01 of the screen, doubled for the clipped stroke");
      assert.ok(calls.some(([name, x, y]) => name === "moveTo" && x === 0 && y === 0));
      assert.deepEqual(boot.errors, []);
    } finally { boot.close(); }
  } finally {
    release();
  }
  assert.equal(element.children.length, 0, "the canvas goes with the painter");
});
