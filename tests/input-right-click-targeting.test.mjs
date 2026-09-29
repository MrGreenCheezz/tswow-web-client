import assert from "node:assert/strict";
import test from "node:test";

// A right click on the 3D world cancels pending spell targeting, as the 3.3.5 client does: the
// stock TradeSkillFrame's enchant cursor (DoTradeSkill waiting for its item) and the native
// ground-target reticle. The click that cancelled selects and opens nothing; with nothing armed a
// right click still selects and interacts, and a right drag is still the camera's. The fake DOM of
// input-controls-residuals.test.mjs: Controls is the real module.

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
  setPointerCapture() {}
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
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const tradeSkill = await import("../dist/code/browser/framexml/FrameXmlTradeSkillController.js");
const groundTarget = await import("../dist/code/browser/game/GroundTarget.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const controls = await import("../dist/code/browser/input/Controls.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const CORPSE = 7n;

/** A world with one lootable corpse under the pointer, recording what a click asks of it. */
function worldStub() {
  const selections = [];
  const loots = [];
  const corpse = { guid: CORPSE, typeId: 3, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0]]) };
  return {
    selections, loots,
    state: { selfGuid: 1n, objects: new Map([[CORPSE, corpse]]) }, targetGuid: undefined, chatLog: [],
    // Recorded only: the target frame's repaint stays on its empty branch.
    selectTarget(guid) { selections.push(guid); },
    openLoot(guid) { loots.push(guid); },
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, aurasFor: () => [],
    displayName: () => "",
  };
}

function pointer(name, event) {
  for (const handler of dom.worldCanvas.listeners.get(name) ?? []) handler(event);
}

const base = { pointerId: 1, clientX: 40, clientY: 40, movementX: 0, movementY: 0, preventDefault() {} };

function rightClick() {
  pointer("pointerdown", { ...base, button: 2, buttons: 2 });
  pointer("pointerup", { ...base, button: 2, buttons: 0 });
}

function rightDrag() {
  pointer("pointerdown", { ...base, button: 2, buttons: 2 });
  pointer("pointermove", { ...base, movementX: 12, buttons: 2 });
  pointer("pointerup", { ...base, button: 2, buttons: 0 });
}

/** A published stock trade skill owner whose enchant waits while `armed` holds. */
function publishEnchant() {
  const owner = {
    armed: true, cancels: 0, closes: 0,
    isOpen: () => true,
    open: () => true,
    close() { this.closes += 1; return true; },
    targeting() { return this.armed; },
    cancelTargeting() {
      if (!this.armed) return false;
      this.armed = false;
      this.cancels += 1;
      return true;
    },
  };
  return { owner, release: tradeSkill.publishFrameXmlTradeSkill(owner) };
}

test("a right click on the world drops the waiting enchant, keeps the window and selects nothing", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  const { owner, release } = publishEnchant();
  try {
    rightClick();
    assert.equal(owner.cancels, 1, "SpellStopTargeting dropped the enchant");
    assert.equal(owner.armed, false);
    assert.equal(owner.closes, 0, "the TradeSkillFrame stays open");
    assert.deepEqual(world.selections, [], "the cancelling click selects nothing");
    assert.deepEqual(world.loots, [], "and opens nothing");
    // Nothing is armed any more: the next right click is the ordinary select-and-interact.
    rightClick();
    assert.equal(owner.cancels, 1);
    assert.deepEqual(world.selections, [CORPSE]);
    assert.deepEqual(world.loots, [CORPSE]);
  } finally {
    release();
    game.world = undefined;
    game.scene = undefined;
  }
});

test("a right drag with the enchant waiting turns the camera and leaves the enchant armed", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  const { owner, release } = publishEnchant();
  try {
    rightDrag();
    assert.equal(owner.cancels, 0, "a drag is the camera's, not a click");
    assert.equal(owner.armed, true);
    assert.deepEqual(world.selections, []);
    assert.deepEqual(world.loots, []);
  } finally {
    release();
    game.world = undefined;
    game.scene = undefined;
  }
});

test("the ground reticle is cancelled by a right click too, and with nothing published the click is native", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  try {
    groundTarget.beginGroundTarget(116);
    assert.equal(groundTarget.pendingGroundTarget(), 116);
    rightClick();
    assert.equal(groundTarget.pendingGroundTarget(), undefined, "the reticle is dropped");
    assert.deepEqual(world.selections, [], "and that click selected nothing");
    // Unpublished, the stock owner answers false and the right click interacts.
    rightClick();
    assert.deepEqual(world.selections, [CORPSE]);
    assert.deepEqual(world.loots, [CORPSE]);
  } finally {
    groundTarget.cancelGroundTarget();
    game.world = undefined;
    game.scene = undefined;
  }
});

test("a throwing owner is demoted and the click stays native", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  let demoted = 0;
  const release = tradeSkill.publishFrameXmlTradeSkill({
    isOpen: () => false, open: () => false, close: () => false,
    cancelTargeting() { throw new Error("broken VM"); },
    demote() { demoted += 1; },
  });
  try {
    rightClick();
    assert.equal(demoted, 1);
    assert.deepEqual(world.selections, [CORPSE]);
  } finally {
    release();
    game.world = undefined;
    game.scene = undefined;
  }
});
