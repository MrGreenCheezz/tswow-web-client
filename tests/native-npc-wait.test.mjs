import assert from "node:assert/strict";
import test from "node:test";

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = true;
    this.value = "";
    this.className = "";
    this.textContent = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => { names.forEach((name) => classes.add(name)); },
      remove: (...names) => { names.forEach((name) => classes.delete(name)); },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const add = force === undefined ? !classes.has(name) : force;
        if (add) classes.add(name); else classes.delete(name);
        return add;
      },
    };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  prepend(...children) { this.append(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() {}
  addEventListener(name, handler) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]); }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === 'button[type="submit"]' ? new FakeNode("button") : null; }
  querySelectorAll() { return []; }
  contains(target) { return this === target || this.children.some((child) => child.contains?.(target)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = null; }
}
class FakeInput extends FakeNode { constructor() { super("input"); } }
class FakeButton extends FakeNode { constructor() { super("button"); } }
globalThis.HTMLInputElement = FakeInput;
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLButtonElement = FakeButton;
globalThis.HTMLElement = FakeNode;
const elements = new Map();
globalThis.document = {
  activeElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  createElement(tag) { return tag === "input" ? new FakeInput() : tag === "button" ? new FakeButton() : new FakeNode(tag); },
  createElementNS(_namespace, tag) { return this.createElement(tag); },
  createTextNode(text) { return { textContent: text }; },
  getElementById(id) {
    if (!elements.has(id)) {
      const element = id === "chat-input" ? new FakeInput() : new FakeNode();
      element.id = id;
      elements.set(id, element);
    }
    return elements.get(id);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const windowListeners = new Map();
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener(name, handler) { windowListeners.set(name, [...(windowListeners.get(name) ?? []), handler]); },
  removeEventListener() {},
  fire(name, event) { for (const handler of windowListeners.get(name) ?? []) handler(event); },
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const npc = await import("../dist/code/browser/ui/Npc.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const wait = await import("../dist/code/browser/ui/NpcWait.js");
usePanelHost({ viewport: document.body, attach() {} });

// 4.15: a click the server answers with silence — an NPC too far, dead or of the wrong side
// (Player::GetNPCIfCanInteractWith returns null and the handler returns), an object out of reach —
// is no longer met with silence by the client either.

const notices = () => {
  const viewport = document.getElementById("world-viewport");
  // The strip is redrawn whole on every notice; the fake DOM never reports it connected, so each
  // draw appends a fresh one and the last is current.
  return (viewport.children.at(-1)?.children ?? []).map((line) => line.textContent);
};

function npcWorld({ npcAt = { x: 30, y: 0, z: 0 } } = {}) {
  const creature = { typeId: 3, guid: 77n, position: npcAt, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 295], [UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, 0x01],
  ]) };
  const self = { typeId: 4, guid: 1n, position: { x: 0, y: 0, z: 0 }, fields: new Map() };
  return {
    state: { selfGuid: 1n, objects: new Map([[1n, self], [77n, creature]]) },
    names: { declined: () => undefined, get: () => undefined },
    gameObjectTemplates: new Map(),
    openGossip() {}, closeNpcServices() {}, closeGossip() {}, closeBank() {},
  };
}

test("an NPC that never answers: the waiting card closes after the wait and says the NPC is too far", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  game.world = npcWorld();
  try {
    npc.interactWithGuid(77n);
    assert.equal(dom.gossipWindow.hidden, false, "the waiting card is up");
    t.mock.timers.tick(wait.PENDING_NPC_TIMEOUT_MS - 1);
    assert.equal(dom.gossipWindow.hidden, false, "still waiting");
    t.mock.timers.tick(1);
    assert.equal(dom.gossipWindow.hidden, true, "given up");
    assert.equal(notices().at(-1), wait.tooFarText());
  } finally {
    game.world = undefined;
    dom.gossipWindow.hidden = true;
  }
});

test("near an NPC that never answers: «NPC не отвечает»; an answer in time is left alone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const world = npcWorld({ npcAt: { x: 6, y: 0, z: 0 } });
  game.world = world;
  try {
    npc.interactWithGuid(77n);
    t.mock.timers.tick(wait.PENDING_NPC_TIMEOUT_MS);
    assert.equal(notices().at(-1), "NPC не отвечает", "5 yards plus two reaches of 1.5: 6 yards is in reach");
    const before = notices().length;
    npc.interactWithGuid(77n);
    dom.gossipText.textContent = "Здравствуй, путник.";
    t.mock.timers.tick(wait.PENDING_NPC_TIMEOUT_MS);
    assert.equal(dom.gossipWindow.hidden, false, "a real answer is not closed");
    assert.equal(notices().length, before);
  } finally {
    game.world = undefined;
    dom.gossipWindow.hidden = true;
  }
});

test("the reach rule: 3D distance against five yards plus both combat reaches", () => {
  assert.equal(wait.beyondInteraction({ x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, 1.5, 1.5), false);
  assert.equal(wait.beyondInteraction({ x: 0, y: 0, z: 0 }, { x: 8.01, y: 0, z: 0 }, 1.5, 1.5), true);
  assert.equal(wait.beyondInteraction({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 9 }, 1.5, 1.5), true, "height counts");
});

test("an interactive object out of reach says so instead of eating the click", () => {
  const chest = { typeId: 5, guid: 90n, position: { x: 30, y: 0, z: 0 }, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 500], [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 19 << 8],
    [UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset, 0],
  ]) };
  const used = [];
  const world = {
    ...npcWorld(),
    gameObjectTemplates: new Map([[500, { entry: 500, type: 19, iconName: "", name: "Почтовый ящик", data: [] }]]),
    gameObjectTemplate(entry) { return this.gameObjectTemplates.get(entry); },
    knownSpells: [],
    openMailbox(guid) { used.push(guid); },
    useGameObject(guid) { used.push(guid); },
  };
  world.state.objects.set(90n, chest);
  game.world = world;
  try {
    const before = notices().length;
    npc.interactWithGuid(90n);
    assert.deepEqual(used, [], "nothing is used from thirty yards");
    assert.equal(notices().length, before + 1);
    assert.equal(notices().at(-1), wait.tooFarText());
    chest.position = { x: 2, y: 0, z: 0 };
    npc.interactWithGuid(90n);
    assert.deepEqual(used, [90n], "in reach the mailbox opens");
  } finally {
    game.world = undefined;
  }
});
