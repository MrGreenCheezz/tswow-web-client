// Plan item 3.13 (04.10, L6): QuestPOIUpdateIcons' icon search and spread as Wow.exe 3.3.5a 12340 does it
// (0x5e5740 → 0x5e2eb0, read from the disassembly 2026-10-04; constants 0xad1014 = 12, 0xa1c8a0 = 1/1024,
// 0x9f1958 = 0.05, 0xad1264 = 20, 0xa1c89c = 0.7500188, 0xa1c894 = 1.3333, POIShiftComplete = "0.6").
import assert from "node:assert/strict";
import test from "node:test";

const {
  questPoiIconBlob, questPoiSpreadIcons, questPoiPushRound, questPoiShiftComplete, QUEST_POI_SPREAD_ROUNDS,
} = await import("../dist/code/browser/framexml/FrameXmlQuestPoiLayout.js");
const { FrameXmlQuestPoiModel, frameXmlQuestPoiLayout } = await import("../dist/code/browser/framexml/FrameXmlQuestPoi.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

/** R = 24 × width / 1024: a width of 2048 yards gives R = 48 and a 2.4-yard push per round. */
const WIDTH_R48 = 2048;
const seat = (x, y, fields = {}) => ({ x, y, movable: true, met: false, ...fields });

test("the icon blob: lowest priority from 10 down, then the nearest; above 10 never", () => {
  const centre = (blob) => blob.c;
  const all = () => true;
  const blobs = [
    { objectiveIndex: 0, priority: 11, c: { x: 0, y: 0 } },
    { objectiveIndex: 1, priority: 10, c: { x: 50, y: 0 } },
    { objectiveIndex: 2, priority: 10, c: { x: 20, y: 0 } },
  ];
  assert.equal(questPoiIconBlob(blobs, all, centre, { x: 0, y: 0 }).objectiveIndex, 2, "priority 11 is out even at the player");
  assert.equal(questPoiIconBlob(blobs.slice(0, 1), all, centre, { x: 0, y: 0 }), undefined, "a lone priority 11 has no icon");
  const signed = [{ objectiveIndex: 3, priority: 0, c: { x: 0, y: 0 } }, { objectiveIndex: 4, priority: 0xffff_ffff, c: { x: 99, y: 0 } }];
  assert.equal(questPoiIconBlob(signed, all, centre, { x: 0, y: 0 }).objectiveIndex, 4, "the word compares signed: 0xffffffff is -1");
  assert.equal(questPoiIconBlob(blobs, (blob) => blob.objectiveIndex !== 2, centre, { x: 0, y: 0 }).objectiveIndex, 1);
});

test("one push round: R along the line, the same-spot turn (0,2), (1,-2), (-2,1), single points stay", () => {
  const pushX = new Int32Array(4);
  const pushY = new Int32Array(4);
  const turn = { next: 0 };
  // A and B on one spot, C and D on another far away.
  const seats = [seat(0, 0), seat(0, 0), seat(1000, 1000), seat(1000, 1000)];
  questPoiPushRound(seats, 48, 48 * 48, pushX, pushY, turn);
  assert.deepEqual([...pushX], [0, 0, 21, 0], "C takes (1,-2)·48/√5 = (21, -42) truncated; the later of a pair stays");
  assert.deepEqual([...pushY], [48, 0, -42, 0], "A takes (0,2)·24");
  assert.equal(turn.next, 2);
  // Two apart along x: each takes ±R; a single-point icon does not move but still pushes.
  const pair = [seat(0, 0), seat(16, 0, { movable: false })];
  questPoiPushRound(pair, 48, 48 * 48, pushX, pushY, turn);
  assert.deepEqual([...pushX].slice(0, 2), [-48, 0]);
  const far = [seat(0, 0), seat(48, 0)];
  questPoiPushRound(far, 48, 48 * 48, pushX, pushY, turn);
  assert.deepEqual([...pushX].slice(0, 2), [0, 0], "R apart is not closer than R");
});

test("the spread: 2.4-yard capped steps until R apart; y squeezed by 0.75 and stretched by 1.3333", () => {
  assert.equal(QUEST_POI_SPREAD_ROUNDS, 20);
  const alongX = [seat(0, 0), seat(10, 0)];
  questPoiSpreadIcons(alongX, WIDTH_R48, 0.6);
  assert.deepEqual(alongX.map(({ x, y }) => [x, y]), [[-20, 0], [30, 0]], "10 rounds of ±2 until 50 apart");
  const alongY = [seat(0, 0), seat(0, 10)];
  questPoiSpreadIcons(alongY, WIDTH_R48, 0.6);
  // 10 → 7 squeezed; 11 rounds of ±2 → -22 and 29; stretched: trunc(-22·1.3333) = -29, trunc(29·1.3333) = 38.
  assert.deepEqual(alongY.map(({ x, y }) => [x, y]), [[0, -29], [0, 38]]);
  const sameSpot = [seat(5, 5), seat(5, 5)];
  questPoiSpreadIcons(sameSpot, WIDTH_R48, 0.6);
  // y 5 → 3; the first round moves only the first (+2), then 12 rounds of ±2.
  assert.deepEqual(sameSpot.map(({ x, y }) => [x, y]), [[5, 38], [5, -27]]);
  const fixed = [seat(0, 0, { movable: false }), seat(10, 0)];
  questPoiSpreadIcons(fixed, WIDTH_R48, 0.6);
  assert.deepEqual(fixed.map(({ x }) => x), [0, 48], "a single-point icon holds, the other walks off alone");
  const noMap = [seat(0, 0), seat(10, 0)];
  questPoiSpreadIcons(noMap, undefined, 0.6);
  assert.deepEqual(noMap.map(({ x, y }) => [x, y]), [[0, 0], [10, 0]], "a dungeon floor: nothing moves");
});

test("met quests are left out of the spread and shifted off an earlier met neighbour", () => {
  const met = (x, y) => seat(x, y, { met: true });
  const seats = [met(0, 0), met(3, 4), met(100, 100), met(100, 105), seat(500, 500)];
  questPoiSpreadIcons(seats, WIDTH_R48, 0.6);
  assert.deepEqual(seats.map(({ x, y }) => [x, y]),
    [[0, 0], [33, 55], [100, 100], [49, 135], [500, 499]],
    "(50, 86)·0.6 → (30, 51), then (-86, 50)·0.6 → (-51, 30); 25 < 60 squared yards; a met quest's y is not squeezed, "
    + "an open one's is (500 → 375 → 499, lossy as in the client)");
  const off = [met(0, 0), met(3, 4)];
  questPoiSpreadIcons(off, WIDTH_R48, 0);
  assert.deepEqual(off.map(({ x, y }) => [x, y]), [[0, 0], [3, 4]], "POIShiftComplete 0: no shift");
  assert.equal(questPoiShiftComplete(undefined), 0.6);
  assert.equal(questPoiShiftComplete("0.25"), 0.25);
  assert.equal(questPoiShiftComplete("x"), 0);
});

const blob = (fields) => ({ index: 0, objectiveIndex: -1, map: 0, worldMapAreaId: 12, floor: 0, priority: 0, flags: 0, points: [], ...fields });
const square = (x, y, size = 10) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];

/** The world square [-1000, 0]² on [0, 1]², as in framexml-quest-poi. */
function poiContext({ quests, blobs, width }) {
  return {
    enabled: () => true,
    quests: () => quests,
    blobs: (id) => blobs[id],
    point: (b, x, y) => (b.map === 0 && x >= -1000 && x <= 0 && y >= -1000 && y <= 0 ? { u: -y / 1000, v: -x / 1000 } : undefined),
    player: () => ({ x: -500, y: -500 }),
    mapWidthYards: () => width,
    leaderBoardLine: () => undefined,
  };
}

test("QuestPOIUpdateIcons places the icons QuestPOIGetIconInfo reads; overlapping ones are pushed apart", () => {
  const quests = [
    { questId: 1, logIndex: 2, complete: false, watched: true, mask: 0b1 },
    { questId: 2, logIndex: 3, complete: false, watched: true, mask: 0b1 },
  ];
  const blobs = {
    1: [blob({ objectiveIndex: 0, points: square(-600, -600) })],
    2: [blob({ objectiveIndex: 0, points: square(-600, -600) })],
  };
  const layout = frameXmlQuestPoiLayout(poiContext({ quests, blobs, width: WIDTH_R48 }));
  // Both at (-595, -595): y squeezed to -446, the first pushed (0, 2) alone, then 12 rounds of ±2.
  assert.deepEqual([layout.get(1).x, layout.get(1).y, layout.get(2).x, layout.get(2).y], [-595, -559, -595, -626]);
  const model = new FrameXmlQuestPoiModel(poiContext({ quests, blobs, width: WIDTH_R48 }));
  const host = { questPoi: model };
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](host, args)];
  assert.deepEqual(call("QuestPOIUpdateIcons"), []);
  assert.deepEqual(call("QuestPOIGetIconInfo", 1), [false, 0.559, 0.595, 0]);
  assert.deepEqual(call("QuestPOIGetIconInfo", 2), [false, 0.626, 0.595, 0]);
  const flat = new FrameXmlQuestPoiModel(poiContext({ quests, blobs, width: undefined }));
  assert.deepEqual(flat.iconInfo(1), [false, 0.595, 0.595, 0], "no area map: the centroid as it is");
  assert.deepEqual(flat.iconInfo(2), [false, 0.595, 0.595, 0]);
});

test("the strict «met» of the spread: a met quest with nothing to do is spread like an open one", () => {
  const quests = [
    { questId: 1, logIndex: 2, complete: true, watched: true, mask: -1, spreadMet: false },
    { questId: 2, logIndex: 3, complete: true, watched: true, mask: -1, spreadMet: false },
  ];
  const blobs = {
    1: [blob({ points: square(-600, -600) })],
    2: [blob({ points: square(-600, -580) })],
  };
  const layout = frameXmlQuestPoiLayout(poiContext({ quests, blobs, width: WIDTH_R48 }));
  assert.notEqual(layout.get(1).y, -595, "pushed off its centroid");
  const metQuests = quests.map((quest) => ({ ...quest, spreadMet: true }));
  const still = frameXmlQuestPoiLayout(poiContext({ quests: metQuests, blobs, width: WIDTH_R48 }));
  assert.deepEqual([still.get(1).x, still.get(1).y, still.get(2).x, still.get(2).y], [-595, -595, -595, -575],
    "400 squared yards apart: no POIShiftComplete shift (below 60 only), and met quests are not spread");
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no 3.3.5a DBC dataset on this machine" };

function questTemplate(questId, title, fields = {}) {
  return {
    questId, level: 10, minLevel: 1, sortId: 0, type: 0, suggestedPlayers: 0, nextQuest: 0, rewardMoney: 0,
    requiredMoney: 0, rewardBonusMoney: 0, rewardDisplaySpell: 0, rewardSpellCast: 0, rewardSpell: 0, rewardHonor: 0,
    startItem: 0, flags: 0, sourceItems: [0, 0, 0, 0], rewardTitleId: 0, requiredPlayerKills: 0, rewardTalents: 0,
    rewardItems: [], rewardChoiceItems: [], poi: { map: 0, x: 0, y: 0, priority: 0 }, title, objectivesText: "",
    details: "", areaDescription: "", completedText: "", objectives: [], itemObjectives: [], ...fields,
  };
}

test("the live seam spreads by the displayed WorldMapArea's width; a met quest with nothing to do is spread", withDataset, async () => {
  const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FrameXmlMap } = await import("../dist/code/browser/framexml/FrameXmlMap.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const data = await loadAreaData(dbcDirectory);
  const elwynn = data.mapAreas.find((area) => area.name === "Elwynn");
  const mapSource = { metadata: () => data, location: () => ({ mapId: 0, areaId: elwynn.areaId, x: -9_000, y: -400 }),
    corpseLocation: () => null, deathReleaseLocation: () => null };
  const map = new FrameXmlMap(mapSource);
  assert.equal(map.questPoiMapWidth(), Math.abs(elwynn.left - elwynn.right));
  const selfGuid = 0x10n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  // Slots: 100 and 101 open (wolves 0/5), 102 complete with nothing to do, 103 complete with a kill objective.
  const fields = new Map([
    [base, 100], [base + stride, 101], [base + 2 * stride, 102], [base + 2 * stride + 1, 1],
    [base + 3 * stride, 103], [base + 3 * stride + 1, 1], [base + 3 * stride + 2, 5],
  ]);
  const self = { guid: selfGuid, typeId: 4, fields, position: { x: -9_000, y: -400, z: 0, orientation: 0 } };
  const wolves = { objectives: [{ entry: 123, count: 5, gameObject: false, itemDrop: 0, text: "", slot: 0 }] };
  const spot = (objectiveIndex) => [blob({ objectiveIndex, worldMapAreaId: elwynn.id, points: square(-9_000, -400, 20) })];
  const world = {
    mapId: 0, state: { selfGuid, objects: new Map([[selfGuid, self]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(), creatureTemplates: new Map(),
    gameObjectTemplates: new Map(),
    questTemplates: new Map([
      [100, questTemplate(100, "А", wolves)], [101, questTemplate(101, "Б", wolves)],
      [102, questTemplate(102, "В")], [103, questTemplate(103, "Г", wolves)],
    ]),
    questPoi: new Map([[100, spot(0)], [101, spot(0)], [102, spot(-1)], [103, spot(-1)]]),
    cooldownRemaining: () => 0, currentServerTime: () => 100, queryQuest() {},
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    creatureInfo: () => ({ name: "Волк" }), mapSource,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  assert.deepEqual(call("QuestMapUpdateAllQuests"), [4]);
  call("QuestPOIUpdateIcons");
  const after = [100, 101, 102, 103].map((id) => JSON.stringify(call("QuestPOIGetIconInfo", id).slice(1, 3)));
  // Every icon starts on the blob's centroid (-8990, -390); only the strictly met quest 103 stays there.
  const centre = map.questPoiPoint(spot(-1)[0], -8_990, -390);
  assert.equal(after[3], JSON.stringify([centre.u, centre.v]), "a met quest with a counted objective is not spread");
  assert.equal(new Set(after).size, 4, "100, 101 and the met-but-empty 102 are pushed off the spot and apart");
  assert.deepEqual(call("QuestPOIGetIconInfo", 102).slice(0, 1), [true]);
});
