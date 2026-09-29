import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMBAT_LOG_CATEGORIES,
  combatLogCategory,
  combatLogVisible,
} from "../dist/code/browser/ui/CombatLogModel.js";

// Q6: the combat tab filters what it shows and keeps what it knows.

test("every written kind lands in exactly one bucket, the future in «other»", () => {
  assert.deepEqual(COMBAT_LOG_CATEGORIES.map(({ id }) => id), ["dealt", "taken", "crit", "avoided", "other"]);
  assert.equal(combatLogCategory({ kind: "dealt" }), "dealt");
  assert.equal(combatLogCategory({ kind: "taken" }), "taken");
  assert.equal(combatLogCategory({ kind: "crit" }), "crit");
  assert.equal(combatLogCategory({ kind: "avoided" }), "avoided");
  assert.equal(combatLogCategory({ kind: "reward" }), "other");
  assert.equal(combatLogCategory({ kind: "muted" }), "other");
  assert.equal(combatLogCategory({ kind: "something-new" }), "other",
    "an unknown kind stays readable until its filter exists");
});

test("hiding is per bucket and never touches the others", () => {
  const hidden = new Set(["taken", "other"]);
  assert.equal(combatLogVisible({ kind: "dealt" }, hidden), true);
  assert.equal(combatLogVisible({ kind: "crit" }, hidden), true);
  assert.equal(combatLogVisible({ kind: "taken" }, hidden), false);
  assert.equal(combatLogVisible({ kind: "muted" }, hidden), false);
  assert.equal(combatLogVisible({ kind: "taken" }, new Set()), true, "empty set shows everything");
});

function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], hidden: false, disabled: false,
    value: "", textContent: "", type: "", checked: false,
    dataset: {}, id: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} },
    parentNode: undefined, listeners: new Map(),
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: {
      _set: new Set(),
      add(...names) { for (const name of names) node.classList._set.add(name); node.className = [...node.classList._set].join(" "); },
      remove(...names) { for (const name of names) node.classList._set.delete(name); node.className = [...node.classList._set].join(" "); },
      toggle() { return false; },
      contains: (name) => node.classList._set.has(name),
    },
    append(...kids) { for (const kid of kids) { kid.parentNode = node; node.children.push(kid); } },
    prepend(...kids) { for (const kid of [...kids].reverse()) { kid.parentNode = node; node.children.unshift(kid); } },
    replaceChildren(...kids) { node.children = [...kids]; for (const kid of kids) kid.parentNode = node; },
    remove() {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((kid) => kid !== node);
      node.parentNode = undefined;
    },
    insertBefore(kid, before) {
      kid.parentNode = node;
      const at = before ? node.children.indexOf(before) : -1;
      if (at < 0) node.children.push(kid);
      else node.children.splice(at, 0, kid);
    },
    addEventListener(type, run) {
      const list = node.listeners.get(type) ?? [];
      list.push(run);
      node.listeners.set(type, list);
    },
    removeEventListener() {},
    setAttribute(name, value) { node[name] = value; },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute() {},
    focus() {}, blur() {},
    querySelector() { return makeNode("button"); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

const chatWindow = makeNode("section");
const chatTabs = makeNode("div");
const chatLog = makeNode("div");
const chatForm = makeNode("form");
const chatInput = makeNode("input");
chatWindow.append(chatTabs, chatLog, chatForm);
const byId = new Map([
  ["chat-window", chatWindow], ["chat-tabs", chatTabs], ["chat-log", chatLog],
  ["chat-form", chatForm], ["chat-input", chatInput],
  ["login-form", makeNode("form")], ["gateway", makeNode("input")],
  ["username", makeNode("input")], ["password", makeNode("input")], ["token", makeNode("input")],
  ["status", makeNode("p")], ["realms", makeNode("div")],
]);
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  createElementNS: (_ns, tag) => makeNode(tag),
  body: makeNode("body"),
  documentElement: makeNode("html"),
  createTextNode: (text) => ({ textContent: text }),
  getElementById: (id) => {
    if (!byId.has(id)) {
      const node = makeNode("div");
      node.id = id;
      byId.set(id, node);
    }
    return byId.get(id);
  },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLButtonElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.HTMLTextAreaElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const dock = await import("../dist/code/browser/ui/ChatDock.js");
// The store directly, not `setSetting`: that runs the whole `applySettings` chain (action bar
// included) and this stub owns no action bar. The filter reads the same store either way.
const { settingsStore } = await import("../dist/code/browser/ui/Settings.js");
const hide = (id, off) => settingsStore.set({ ...settingsStore.value, [id]: !off });
const showAll = () => settingsStore.set({
  ...settingsStore.value,
  combatDealt: true, combatTaken: true, combatCrit: true, combatAvoided: true, combatOther: true,
});

const line = (kind, text) => ({ at: 1, text, kind, casterGuid: 1n, targetGuid: 2n, spellId: 0 });
const paneTexts = () => chatLog.children.map((child) => child.textContent);

test("the combat pane hides a switched-off bucket and keeps the rest", () => {
  dock.resetChatDock();
  showAll();
  try {
    dock.selectChatTab("combat");
    dock.recordCombatEntry(line("dealt", "вы: 47"));
    dock.recordCombatEntry(line("taken", "вам: 12"));
    dock.recordCombatEntry(line("crit", "крит 99"));
    dock.recordCombatEntry(line("muted", "чужой бой"));
    assert.deepEqual(paneTexts(), ["вы: 47", "вам: 12", "крит 99", "чужой бой"]);

    hide("combatTaken", true);
    dock.redrawChatLog();
    assert.deepEqual(paneTexts(), ["вы: 47", "крит 99", "чужой бой"]);

    // A line arriving while its bucket is off never reaches the pane…
    dock.recordCombatEntry(line("taken", "вам: 13"));
    assert.deepEqual(paneTexts(), ["вы: 47", "крит 99", "чужой бой"]);

    // …but history kept it: switching the bucket back on shows everything again.
    hide("combatTaken", false);
    dock.redrawChatLog();
    assert.deepEqual(paneTexts(), ["вы: 47", "вам: 12", "крит 99", "чужой бой", "вам: 13"]);
  } finally {
    showAll();
    dock.resetChatDock();
    game.world = undefined;
  }
});

test("the filter row lives beside the pane, only on the combat tab", async () => {
  dock.resetChatDock();
  try {
    dock.selectChatTab("combat");
    const bar = chatWindow.children.find((child) => child.className === "combat-filters");
    assert.ok(bar, "the combat tab owns a filter row");
    assert.equal(bar.children.length, 5, "one switch per bucket");
    dock.selectChatTab("general");
    assert.equal(
      chatWindow.children.filter((child) => child.className === "combat-filters").length, 0,
      "other tabs read plain chat and show no switches",
    );
  } finally {
    dock.resetChatDock();
  }

  // The switches write through the settings account path, not a local flag.
  const source = await readFile(new URL("../src/browser/ui/ChatDock.ts", import.meta.url), "utf8");
  assert.match(source, /setSetting\(COMBAT_SETTING\[id\], input\.checked\)/,
    "a checkbox flip is a settings write plus a redraw");
});
