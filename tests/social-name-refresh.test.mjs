import assert from "node:assert/strict";
import test from "node:test";
import { SOCIAL_FLAG_FRIEND } from "../dist/code/world/ContactProtocol.js";

function node(tag) {
  const element = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, attributes: new Map(),
    className: "", textContent: "", hidden: false, value: "", listeners: new Map(),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    querySelector() { return node("button"); },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
  return element;
}

function descendant(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const match = descendant(child, predicate);
    if (match) return match;
  }
  return undefined;
}

const byId = new Map();
globalThis.document = {
  createElement: node,
  createTextNode: (value) => ({ textContent: value }),
  body: node("body"),
  documentElement: node("html"),
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, node("div"));
    return byId.get(id);
  },
  querySelectorAll: () => [],
};
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const { openSocialPanel, refreshSocialNames, resetSocialPanel } = await import("../dist/code/browser/ui/SocialPanel.js");

test("a late name answer updates an open friend row without erasing the typed name", () => {
  const viewport = node("div");
  usePanelHost({ viewport, attach() {} });
  let resolved = false;
  game.world = {
    requestContacts() {},
    contacts: { flags: SOCIAL_FLAG_FRIEND, contacts: [{
      guid: 7n, flags: SOCIAL_FLAG_FRIEND, note: "", status: 1, areaId: 0, level: 80, classId: 8,
    }] },
    displayName: () => resolved ? "Джайна" : "0x7",
  };
  try {
    openSocialPanel("friends");
    const label = descendant(viewport, (element) => element.tagName === "STRONG" && element.textContent === "0x7");
    const input = descendant(viewport, (element) => element.tagName === "INPUT");
    assert.ok(label);
    assert.ok(input);
    input.value = "Новый друг";

    resolved = true;
    refreshSocialNames();

    assert.equal(label.textContent, "Джайна");
    assert.equal(input.value, "Новый друг");
    assert.strictEqual(descendant(viewport, (element) => element.tagName === "INPUT"), input,
      "the edit field is not replaced while the name query resolves");
  } finally {
    resetSocialPanel();
    game.world = undefined;
  }
});
