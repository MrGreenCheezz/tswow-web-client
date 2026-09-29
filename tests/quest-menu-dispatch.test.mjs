import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { buildQuestAction, buildQuestQuery } from "../dist/code/world/NpcProtocol.js";

// The selected TrinityCore's Player::PrepareQuestMenu sends icon 4 for both an
// incomplete and a completed involved quest, and icon 2 for a new quest.
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "",
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...children) { node.children.push(...children); },
      prepend(...children) { node.children.unshift(...children); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...children) { node.children = [...children]; },
      remove() {}, focus() {}, blur() {},
      addEventListener(type, listener) {
        const handlers = listeners.get(type) ?? [];
        handlers.push(listener);
        listeners.set(type, handlers);
      },
      click() { for (const listener of listeners.get("click") ?? []) listener({ type: "click" }); },
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (value) => ({ textContent: value }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) { node = make("div"); node.id = id; byId.set(id, node); }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { questMenuButton } = await import("../dist/code/browser/ui/Npc.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

test("selected core quest menu icon 4 opens completion while icon 2 opens details", () => {
  const sent = [];
  const world = new WorldClient({ send: (opcode, payload) => sent.push({ opcode, payload }) });
  const guid = 0x1234n;
  const turnIn = questMenuButton(world, guid, { id: 100, icon: 4, level: 10, title: "Сдать" });
  const newQuest = questMenuButton(world, guid, { id: 101, icon: 2, level: 11, title: "Принять" });

  assert.match(turnIn.textContent, /^\?/);
  assert.match(newQuest.textContent, /^!/);
  turnIn.click();
  newQuest.click();
  assert.deepEqual(sent, [
    { opcode: OPCODES.CMSG_QUESTGIVER_COMPLETE_QUEST, payload: buildQuestAction(guid, 100) },
    { opcode: OPCODES.CMSG_QUESTGIVER_QUERY_QUEST, payload: buildQuestQuery(guid, 101) },
  ]);
});
