// Plan item 3.13, review of L6 (04.10): the quest log selection with zone headers, as the stock QuestLogFrame,
// WatchFrame and the abandon/share buttons drive it on the live seam. Wow.exe 3.3.5a 12340, read 2026-10-04 from the
// bytes (descriptions only):
// - SelectQuestLogEntry (Lua 0x5e02f0) passes index − 1 to 0x5dffa0: an index outside the rows clears the selection,
//   a header row leaves it as it was, a quest row stores that quest's id in 0x00c23ad8.
// - GetQuestLogSelection (0x5df0a0 → 0x5debd0) answers 1 + the row of that quest id among all rows, the collapsed tail
//   included, 0 when it is not in the log; SetAbandonQuest (0x5df0d0) copies 0x00c23ad8 to 0x00c23adc and
//   GetAbandonQuestName (0x5df0e0) names the quest id kept there — the abandon target is a quest, not a row.
import assert from "node:assert/strict";
import test from "node:test";

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
