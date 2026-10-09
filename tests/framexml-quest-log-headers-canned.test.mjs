// Plan item 3.13 (04.10, L6): the canned seam's quest log with the client's zone headers once its quests name
// a zone (FrameXmlQuestLog.ts over CannedQuest.zone), and SelectQuestLogEntry on a header row, which Wow.exe
// 3.3.5a 12340 ignores (0x5dffa0: a header leaves the selected quest id; only a row past the list clears it;
// read 2026-10-04) — in the canned and the live seam.
import assert from "node:assert/strict";
import test from "node:test";

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
  call(seam, "ExpandQuestHeader", 0);
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [5, 3]);
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
