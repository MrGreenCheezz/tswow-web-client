import assert from "node:assert/strict";
import test from "node:test";

function makeNode(tag) {
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(),
    id: "",
    children: [],
    parentElement: undefined,
    hidden: false,
    textContent: "",
    className: "",
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add(...names) { for (const name of names) classes.add(name); node.className = [...classes].join(" "); },
      remove(...names) { for (const name of names) classes.delete(name); node.className = [...classes].join(" "); },
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
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      // Dom.ts validates the unrelated login scaffold during module import; this focused fixture
      // has no login form, so retain the old synthetic submit control for that one selector.
      if (selector === 'button[type="submit"]') return makeNode("button");
      const matches = (candidate) => selector.startsWith(".")
        ? candidate.className.split(" ").includes(selector.slice(1))
        : candidate.tagName === selector.toUpperCase();
      const visit = (candidate) => {
        for (const child of candidate.children) {
          if (matches(child)) return child;
          const nested = visit(child);
          if (nested) return nested;
        }
        return undefined;
      };
      return visit(node) ?? null;
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
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem() { return null; }, setItem() {} },
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");

function worldWithQuest(questId = 1) {
  const fields = new Map([[UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, questId]]);
  const state = { selfGuid: 1n, objects: new Map([[1n, { fields }]]) };
  return { state, questTemplates: new Map(), names: { declined() { return undefined; } } };
}

function findDescendant(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function trackerBody(tracker) {
  return findDescendant(tracker, (node) => node.className === "quest-tracker-body");
}

test("stock quest publication captures, hides and identity-restores the native tracker", async () => {
  const questLog = await import("../dist/code/browser/ui/QuestLog.js?native-tracker");
  const world = worldWithQuest(1);
  game.world = world;
  const rail = document.getElementById("right-rail");
  rail.replaceChildren();
  usePanelHost({ viewport: document.getElementById("world-viewport"), attach() {} });

  questLog.showQuestTracker();
  const tracker = rail.children[0];
  assert.ok(tracker, "native tracker exists before stock publication");
  assert.equal(tracker.hidden, false);
  assert.equal(trackerBody(tracker)?.children[0]?.children[0]?.textContent, "Задание 1");
  questLog.toggleQuestLog();

  const state = questLog.beginQuestLogNativeReplacement();
  assert.equal(state.panelExists, true);
  assert.ok(state.panel);
  assert.equal(state.panelVisible, true);
  assert.equal(state.tracker, tracker);
  assert.equal(state.trackerExists, true);
  assert.equal(state.trackerVisible, true);
  assert.equal(tracker.hidden, true);
  const childCount = tracker.children.length;

  // A queued native refresh cannot redraw or reveal the surface borrowed by WatchFrame.
  questLog.showQuestTracker();
  assert.equal(tracker.hidden, true);
  assert.equal(tracker.children.length, childCount);

  // Teardown redraws current data before restoring a visible panel/tracker.
  world.state.objects.get(1n).fields.set(UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, 2);
  questLog.restoreQuestLogNativeReplacement(state);
  assert.ok(findDescendant(state.panel?.body, (node) => node.textContent === "Задание 2"),
    "the restored native panel redraws the current quest");

  // A stale cleanup must not end a newer publication.
  const newer = questLog.beginQuestLogNativeReplacement();
  questLog.restoreQuestLogNativeReplacement(state);
  assert.equal(newer.tracker, tracker);
  assert.equal(tracker.hidden, true);

  // Teardown redraws current data before restoring a visible tracker.
  questLog.restoreQuestLogNativeReplacement(newer);
  assert.equal(tracker.hidden, false);
  assert.equal(trackerBody(tracker)?.children[0]?.children[0]?.textContent, "Задание 2");

  // An empty current log stays hidden; restoration must not override the fresh render's visibility.
  world.state.objects.get(1n).fields.set(UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, 0);
  questLog.showQuestTracker();
  assert.equal(tracker.hidden, true);
  const emptyState = questLog.beginQuestLogNativeReplacement();
  assert.equal(emptyState.trackerVisible, false);
  questLog.restoreQuestLogNativeReplacement(emptyState);
  assert.equal(tracker.hidden, true);
  assert.equal(trackerBody(tracker)?.children.length, 0);

  // Logout while stock owns a previously visible tracker must veto restoration of stale content.
  world.state.objects.get(1n).fields.set(UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, 3);
  questLog.showQuestTracker();
  assert.equal(tracker.hidden, false);
  const teardownState = questLog.beginQuestLogNativeReplacement();
  questLog.clearQuestLog();
  questLog.restoreQuestLogNativeReplacement(teardownState);
  assert.equal(tracker.hidden, true);
  assert.equal(teardownState.panel?.visible, false);
  game.world = undefined;
});

test("tracker absent at stock publication is never created by blocked native refresh", async () => {
  const questLog = await import("../dist/code/browser/ui/QuestLog.js?native-tracker-empty");
  game.world = worldWithQuest(3);
  const rail = document.getElementById("right-rail");
  rail.replaceChildren();

  const state = questLog.beginQuestLogNativeReplacement();
  assert.equal(state.trackerExists, false);
  questLog.showQuestTracker();
  assert.equal(rail.children.length, 0, "native refresh cannot create a tracker under stock ownership");
  questLog.restoreQuestLogNativeReplacement(state);
  assert.equal(rail.children.length, 0, "teardown does not invent a tracker absent at publication");

  questLog.clearQuestLog();
  game.world = undefined;
});
