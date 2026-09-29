import assert from "node:assert/strict";
import test from "node:test";
import { questTimerDisplay } from "../dist/code/browser/ui/QuestTimer.js";

test("quest countdown uses realm seconds and keeps expiry pending until the realm confirms", () => {
  assert.deepEqual(questTimerDisplay(3_766, undefined), { text: "Сверяем время…", urgent: false });
  assert.deepEqual(questTimerDisplay(3_766, 0), { text: "Осталось 1:02:46", urgent: false });
  assert.deepEqual(questTimerDisplay(3_766, 3_705), { text: "Осталось 1:01", urgent: false });
  assert.deepEqual(questTimerDisplay(3_766, 3_706), { text: "Осталось 1:00", urgent: true });
  assert.deepEqual(questTimerDisplay(3_766, 3_766),
    { text: "Время истекло", urgent: true });
});

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), id: "", children: [], parentElement: undefined,
    hidden: false, textContent: "", className: "", dataset: {}, style: { setProperty() {}, removeProperty() {} },
    get lastElementChild() { return this.children.at(-1) ?? null; },
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
      remove(...names) { node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
    },
    append(...children) {
      for (const child of children) {
        if (!child) continue;
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        node.children.push(child);
      }
    },
    replaceChildren(...children) {
      for (const child of node.children) child.parentElement = undefined;
      node.children = [];
      node.append(...children);
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      if (child.parentElement === node) child.parentElement = undefined;
    },
    remove() { node.parentElement?.removeChild(node); },
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return makeNode("button");
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const className = selector.startsWith(".") ? selector.slice(1) : undefined;
      const matches = (candidate) => className
        ? candidate.className.split(" ").includes(className)
        : candidate.tagName === selector.toUpperCase();
      const result = [];
      const visit = (candidate) => {
        for (const child of candidate.children) {
          if (matches(child)) result.push(child);
          visit(child);
        }
      };
      visit(node);
      return result;
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  };
  return node;
}

const nodes = new Map();
globalThis.document = {
  createElement: makeNode,
  createElementNS: (_namespace, tag) => makeNode(tag),
  getElementById(id) {
    if (!nodes.has(id)) {
      const node = makeNode("div");
      node.id = id;
      nodes.set(id, node);
    }
    return nodes.get(id);
  },
  querySelectorAll() { return []; },
};
globalThis.window = {
  devicePixelRatio: 1, addEventListener() {}, removeEventListener() {},
  localStorage: { getItem() { return null; }, setItem() {} },
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { QUEST_STATE_COMPLETE, QUEST_STATE_FAIL } = await import("../dist/code/world/QuestProtocol.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const questLog = await import("../dist/code/browser/ui/QuestLog.js");

test("timed quest updates journal and tracker without rebuilding them every second", () => {
  const actualSetInterval = globalThis.setInterval;
  const actualClearInterval = globalThis.clearInterval;
  const intervals = new Map();
  let nextInterval = 0;
  globalThis.setInterval = (callback, period) => {
    assert.equal(period, 1_000);
    intervals.set(++nextInterval, callback);
    return nextInterval;
  };
  globalThis.clearInterval = (id) => { intervals.delete(id); };

  try {
    usePanelHost({ viewport: document.getElementById("world-viewport"), attach() {} });
    const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
    const fields = new Map([[base, 42], [base + 4, 1_065]]);
    let serverNow;
    let requests = 0;
    const world = {
      state: { selfGuid: 1n, objects: new Map([[1n, { fields }]]) },
      questTemplates: new Map(),
      names: { declined() { return undefined; } },
      currentQueryTime: () => serverNow,
      currentServerTime: () => undefined,
      requestServerTime() { requests++; },
    };
    game.world = world;

    questLog.showQuestTracker();
    questLog.toggleQuestLog();
    const tracker = document.getElementById("right-rail").children[0];
    const panel = document.getElementById("world-viewport").querySelector(".quest-log");
    const trackerTime = tracker.querySelector(".quest-track-timer");
    const journalTime = panel.querySelector(".quest-timer-row");
    assert.equal(requests, 1, "one server time query serves both surfaces");
    assert.equal(intervals.size, 1, "one ticker serves both surfaces");
    assert.equal(trackerTime.textContent, "Сверяем время…");
    assert.equal(journalTime.lastElementChild.textContent, "Сверяем время…");

    serverNow = 1_000;
    [...intervals.values()][0]();
    assert.equal(tracker.querySelector(".quest-track-timer"), trackerTime,
      "a tick updates the same tracker node rather than replacing it");
    assert.equal(panel.querySelector(".quest-timer-row"), journalTime,
      "a tick preserves the journal and its search focus");
    assert.equal(trackerTime.textContent, "Осталось 1:05");
    assert.equal(journalTime.lastElementChild.textContent, "Осталось 1:05");

    // A delayed quest description redraws both surfaces; ticks must target the new timer rows.
    world.questTemplates.set(42, {
      title: "Волки у ворот", level: 10, details: "Защитить лагерь", objectivesText: "",
      areaDescription: "", completedText: "", objectives: [], itemObjectives: [],
      rewardMoney: 0, requiredMoney: 0, rewardBonusMoney: 0, rewardHonor: 0,
      rewardTalents: 0, rewardItems: [], rewardChoiceItems: [], rewardDisplaySpell: 0,
    });
    questLog.showQuestLog();
    questLog.showQuestTracker();
    const refreshedJournalTime = panel.querySelector(".quest-timer-row");
    const refreshedTrackerTime = tracker.querySelector(".quest-track-timer");
    assert.notEqual(refreshedJournalTime, journalTime);
    assert.notEqual(refreshedTrackerTime, trackerTime);
    assert.equal(tracker.querySelector(".quest-track")?.children[0]?.textContent, "Волки у ворот");
    assert.equal(refreshedJournalTime.lastElementChild.textContent, "Осталось 1:05");
    assert.equal(requests, 1, "redraws do not repeat the clock query");
    serverNow = 1_006;
    [...intervals.values()][0]();
    assert.equal(refreshedJournalTime.lastElementChild.textContent, "Осталось 0:59");
    assert.equal(refreshedJournalTime.dataset.urgent, "true");
    assert.equal(refreshedTrackerTime.dataset.urgent, "true");

    fields.set(base + 1, QUEST_STATE_COMPLETE);
    questLog.showQuestLog();
    questLog.showQuestTracker();
    const completedTrackerTime = tracker.querySelector(".quest-track-timer");
    assert.ok(panel.querySelector(".quest-timer-row"), "a complete quest can still need turn-in before its deadline");
    assert.ok(completedTrackerTime);
    assert.equal(intervals.size, 1);

    serverNow = 1_065;
    [...intervals.values()][0]();
    assert.equal(completedTrackerTime.textContent, "Время истекло");
    assert.equal(panel.querySelector(".quest-log-details")?.querySelector(".ui-line")?.lastElementChild?.textContent,
      "Выполнено — доступна награда", "elapsed time does not locally fail the quest");

    fields.set(base + 1, QUEST_STATE_FAIL);
    questLog.showQuestLog();
    questLog.showQuestTracker();
    assert.equal(panel.querySelector(".quest-timer-row"), null);
    assert.equal(tracker.querySelector(".quest-track-timer"), null);
    assert.equal(intervals.size, 0, "server-confirmed failure stops the ticker");

    // Stock FrameXML can borrow the tracker during logout. Restoring its DOM owner after clear
    // must not bring a timed quest's interval back from the dead.
    fields.set(base + 1, 0);
    serverNow = 1_000;
    questLog.showQuestTracker();
    assert.equal(intervals.size, 1);
    const borrowed = questLog.beginQuestLogNativeReplacement();
    assert.equal(intervals.size, 0);
    questLog.clearQuestLog();
    questLog.restoreQuestLogNativeReplacement(borrowed);
    assert.equal(intervals.size, 0, "native teardown leaves the clock stopped");
    game.world = undefined;
  } finally {
    questLog.clearQuestLog();
    game.world = undefined;
    globalThis.setInterval = actualSetInterval;
    globalThis.clearInterval = actualClearInterval;
  }
});
