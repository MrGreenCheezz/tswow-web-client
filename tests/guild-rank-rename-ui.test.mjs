import assert from "node:assert/strict";
import test from "node:test";

function node(tag, id = "") {
  return {
    tagName: tag.toUpperCase(), id, children: [], dataset: {}, style: {}, hidden: false,
    textContent: "", className: "", value: "", listeners: new Map(), attributes: new Map(),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    insertBefore(child, reference) {
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    querySelector() { return node("button"); },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
}

function descendant(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = descendant(child, predicate);
    if (found) return found;
  }
  return undefined;
}

const byId = new Map();
globalThis.document = {
  createElement: node,
  createTextNode: (value) => ({ textContent: value }),
  body: node("body"), documentElement: node("html"),
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, node("div", id));
    return byId.get(id);
  },
  querySelectorAll: () => [],
};
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = {
  innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {},
  prompt() { return "Офицер почты"; },
};

const { game } = await import("../dist/code/browser/game/Context.js");
const { openGuildWindow, resetGuildWindow } = await import("../dist/code/browser/ui/Guild.js");
byId.get("guild-window").append(byId.get("guild-roster"));

test("renaming a guild rank resends its six existing bank tab rights", () => {
  const sent = [];
  const tabs = Array.from({ length: 6 }, (_, index) => ({ rights: index + 1, slots: (index + 1) * 10 }));
  game.world = {
    guildRoster: { welcomeText: "", infoText: "", members: [], ranks: [{
      flags: 0x51, withdrawGoldLimit: 5000, tabs,
    }] },
    guildQuery: { name: "Гильдия", rankNames: ["Офицер"] },
    requestGuildRoster() {}, requestGuildInfo() {},
    setGuildRank(...args) { sent.push(args); },
  };
  try {
    openGuildWindow();
    const guildWindow = byId.get("guild-window");
    const ranksTab = descendant(guildWindow, (element) => element.tagName === "BUTTON" && element.textContent === "Ранги");
    assert.ok(ranksTab);
    ranksTab.listeners.get("click")();
    const rename = descendant(guildWindow, (element) => element.tagName === "BUTTON" && element.textContent === "Переименовать");
    assert.ok(rename);
    rename.listeners.get("click")();

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].slice(0, 4), [0, 0x51, "Офицер почты", 5000]);
    assert.deepEqual(sent[0][4], tabs,
      "CMSG_GUILD_RANK rewrites every bank permission, even for a name-only edit");
  } finally {
    resetGuildWindow();
    game.world = undefined;
  }
});
