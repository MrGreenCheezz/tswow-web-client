// Plan item 1.12: sharing a quest — GetQuestLogPushable, QuestLogPushQuest and the sharer's lines for
// MSG_QUEST_PUSH_RESULT (FrameXmlQuestShare.ts), as Wow.exe 0x5df520, 0x5e4ed0 and 0x6e2e90 do.
import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlQuestShareModel, FRAMEXML_QUEST_SHARE_BINDINGS, FRAMEXML_QUEST_PUSH_MESSAGES, QUEST_FLAG_SHARABLE } =
  await import("../dist/code/browser/framexml/FrameXmlQuestShare.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const STRINGS = {
  ERR_QUEST_PUSH_ACCEPTED_S: "%s принимает ваше задание.",
  ERR_QUEST_PUSH_DECLINED_S: "%s отказывается от вашего задания",
  ERR_QUEST_PUSH_LOG_FULL_S: "Список заданий |3-1(%s) переполнен.",
  ERR_QUEST_PUSH_NOT_IN_PARTY_S: "Вы не в группе.",
};

function fixture() {
  const state = {
    selected: 1,
    log: [101, 102],
    flags: new Map([[101, QUEST_FLAG_SHARABLE], [102, 0]]),
    player: true,
    party: 1,
    raid: 0,
    names: new Map([[5n, "Ария"]]),
  };
  const shared = [];
  const fired = [];
  const model = new FrameXmlQuestShareModel({
    questIdAt: (index) => (index === 0 ? state.log[state.selected - 1] : state.log[index - 1]),
    questFlags: (id) => state.flags.get(id),
    hasPlayer: () => state.player,
    partyMemberCount: () => state.party,
    raidMemberCount: () => state.raid,
    share: (id) => shared.push(id),
    cachedName: (guid) => state.names.get(guid),
    globalString: (name) => STRINGS[name],
  });
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (name, ...args) => [...FRAMEXML_QUEST_SHARE_BINDINGS[name]({ questShare: model }, args)];
  return { state, shared, fired, model, call };
}

test("the push messages are the client's twelve, in QUEST_PARTY_MSG order", () => {
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES.length, 12);
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[0], "ERR_QUEST_PUSH_SUCCESS_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[2], "ERR_QUEST_PUSH_ACCEPTED_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[3], "ERR_QUEST_PUSH_DECLINED_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[10], "ERR_QUEST_PUSH_NOT_IN_PARTY_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[11], "ERR_QUEST_PUSH_DIFFERENT_SERVER_DAILY_S");
});

test("GetQuestLogPushable answers 1 for a cached sharable quest and no value otherwise", () => {
  const { state, call } = fixture();
  assert.deepEqual(call("GetQuestLogPushable"), [1], "no argument: the selected quest");
  assert.deepEqual(call("GetQuestLogPushable", 0), [1]);
  assert.deepEqual(call("GetQuestLogPushable", 1), [1]);
  assert.deepEqual(call("GetQuestLogPushable", 2), [], "flags 0: nothing, not false");
  assert.deepEqual(call("GetQuestLogPushable", 3), [], "past the log");
  assert.deepEqual(call("GetQuestLogPushable", "2"), []);
  state.selected = 2;
  assert.deepEqual(call("GetQuestLogPushable"), [], "the selection moved to the unsharable quest");
  assert.deepEqual(call("GetQuestLogPushable", 1.4), [1], "the index is rounded");
  state.flags.delete(101);
  assert.deepEqual(call("GetQuestLogPushable", 1), [], "a quest not in the cache answers nothing");
  state.flags.set(101, 0x10 | 0x2);
  assert.deepEqual(call("GetQuestLogPushable", 1), [], "only bit 0x8 makes a quest sharable");
});

test("QuestLogPushQuest shares a sharable quest only with a party or raid", () => {
  const { state, shared, call } = fixture();
  assert.deepEqual(call("QuestLogPushQuest"), []);
  assert.deepEqual(shared, [101]);
  call("QuestLogPushQuest", 2);
  assert.deepEqual(shared, [101], "unsharable: nothing sent");
  state.party = 0;
  call("QuestLogPushQuest", 1);
  assert.deepEqual(shared, [101], "alone: nothing sent");
  state.raid = 3;
  call("QuestLogPushQuest", 1);
  assert.deepEqual(shared, [101, 101], "a raid is a group too");
  state.player = false;
  call("QuestLogPushQuest", 1);
  assert.equal(shared.length, 2, "no player object: nothing");
});

test("MSG_QUEST_PUSH_RESULT prints the code's line with the cached name, markup kept", () => {
  const { state, fired, model } = fixture();
  model.result(5n, 2);
  model.result(5n, 3);
  model.result(5n, 5);
  model.result(5n, 10);
  assert.deepEqual(fired.map(([event, text]) => [event, text]), [
    ["CHAT_MSG_SYSTEM", "Ария принимает ваше задание."],
    ["CHAT_MSG_SYSTEM", "Ария отказывается от вашего задания"],
    ["CHAT_MSG_SYSTEM", "Список заданий |3-1(Ария) переполнен."],
    ["CHAT_MSG_SYSTEM", "Вы не в группе."],
  ]);
  fired.length = 0;
  model.result(6n, 2);
  assert.deepEqual(fired, [], "no cached name: no line");
  model.result(5n, 12);
  model.result(5n, 1);
  assert.deepEqual(fired, [], "an unknown code, or a string this build lacks: no line");
  state.names.set(6n, "Бран");
  model.result(6n, 3);
  assert.equal(fired.length, 1);
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

function template(questId, flags) {
  return { questId, flags, title: `Q${questId}`, objectives: [], itemObjectives: [], creatureObjectives: [],
    rewardItems: [], rewardChoiceItems: [] };
}

function questSlot(slot) {
  return UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset + slot * 5;
}

test("the live seam reads its log, templates and group, and prints the result line", () => {
  const selfGuid = 0x10n;
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 8) | (1 << 24)],
    [questSlot(0), 101],
    [questSlot(1), 102],
  ]);
  const events = new FakeEvents();
  const shared = [];
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, fields }]]) },
    events,
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    questTemplates: new Map([[101, template(101, QUEST_FLAG_SHARABLE)], [102, template(102, 0)]]),
    group: { groupType: 0, leaderGuid: selfGuid, members: [{ guid: 5n, name: "Ария", online: true }] },
    names: new Map([[5n, "Ария"]]),
    shareQuest: (id) => shared.push(id),
    queryQuest: () => {},
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 });
  const api = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];

  // Line 1 is the zone header both quests sit under (FrameXmlQuestLog.ts); a header names no quest.
  assert.deepEqual(api("GetQuestLogPushable", 1), []);
  assert.deepEqual(api("GetQuestLogPushable", 2), [1]);
  assert.deepEqual(api("GetQuestLogPushable", 3), []);
  api("SelectQuestLogEntry", 2);
  assert.deepEqual(api("GetQuestLogPushable"), [1]);
  assert.ok(seam.partyMemberCount() > 0, "the fixture's group has a member");
  api("QuestLogPushQuest");
  assert.deepEqual(shared, [101]);

  fired.length = 0;
  events.emit("QUEST_PUSH_RESULT", { guid: 5n, result: 3 });
  const lines = fired.filter(([event]) => event === "CHAT_MSG_SYSTEM");
  assert.equal(lines.length, 1);
  assert.match(lines[0][1], /Ария/);
  seam.detach();
  events.emit("QUEST_PUSH_RESULT", { guid: 5n, result: 3 });
  assert.equal(fired.filter(([event]) => event === "CHAT_MSG_SYSTEM").length, 1, "detached: silent");
});

test("the canned seam's quest can be shared with its party", () => {
  const seam = new CannedWorldSeam();
  const api = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  assert.deepEqual(api("GetQuestLogPushable", 1), [1]);
  assert.deepEqual(api("GetQuestLogPushable", 9), []);
  api("QuestLogPushQuest", 1);
  assert.deepEqual(seam.sharedQuests, [9001]);
});
