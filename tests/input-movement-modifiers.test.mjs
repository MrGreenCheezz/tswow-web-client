import assert from "node:assert/strict";
import test from "node:test";

// 5.15: a movement key still moves with Ctrl or Alt held when the chord has no binding of its own,
// and a key pressed before the server hands over control (movementReady false) starts the move on
// the first frame after it does. The fake DOM of input-controls-residuals.test.mjs; Controls and
// Movement are the real modules.

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
globalThis.HTMLInputElement = FakeInput;
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLButtonElement = class extends FakeNode {};
globalThis.HTMLElement = FakeNode;
const elements = new Map();
globalThis.document = {
  activeElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  documentElement: new FakeNode("html"),
  createElement(tag) { return tag === "input" ? new FakeInput() : new FakeNode(tag); },
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
const controls = await import("../dist/code/browser/input/Controls.js");
const movement = await import("../dist/code/browser/input/Movement.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

function key(type, code, modifiers = {}) {
  let prevented = false;
  window.fire(type, {
    code, target: document.body, defaultPrevented: false, repeat: false,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers,
    preventDefault() { prevented = true; },
  });
  return prevented;
}

function worldWithMover(sent) {
  const mover = { position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  return {
    mapId: 0,
    movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(),
    targetGuid: undefined,
    chatLog: [],
    sendMovement: (...args) => {
      sent.push(args[0]);
      mover.position = { ...mover.position };
    },
    selectTarget() {}, aurasFor: () => [], displayName: () => "",
  };
}

function withWorld(world, body) {
  movement.forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  try {
    body();
  } finally {
    controls.clearHeldKeys();
    movement.forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
  }
}

for (const [name, modifiers] of [["Ctrl", { ctrlKey: true }], ["Alt", { altKey: true }]]) {
  test(`W with ${name} held runs forward, and its release stops it whatever the modifier does`, () => {
    const sent = [];
    withWorld(worldWithMover(sent), () => {
      assert.equal(key("keydown", "KeyW", modifiers), true, "the movement chord is the game's, not the browser's");
      assert.deepEqual(sent, [OPCODES.MSG_MOVE_START_FORWARD]);
      // The modifier comes up first; the key's release still ends the move it started.
      key("keyup", "KeyW");
      assert.deepEqual(sent, [OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_STOP]);
    });
  });
}

test("an exact chord still wins, and the bare-key fallback is only for held actions", () => {
  // Digit1 alone is action button 1, a pressed action: Ctrl+1 without a binding of its own must
  // not fall back to it (only a held movement key ignores Ctrl/Alt).
  assert.equal(controls.resolveKeyAction({ code: "Digit1", ctrlKey: false, altKey: false, shiftKey: false }), "action1");
  assert.notEqual(controls.resolveKeyAction({ code: "Digit1", ctrlKey: true, altKey: false, shiftKey: false }), "action1");
  assert.notEqual(controls.resolveKeyAction({ code: "Digit1", ctrlKey: false, altKey: true, shiftKey: false }), "action1");
  // Shift+1 is the page switch, bound exactly.
  assert.equal(controls.resolveKeyAction({ code: "Digit1", ctrlKey: false, altKey: false, shiftKey: true }), "actionPage1");
  assert.equal(controls.resolveKeyAction({ code: "KeyW", ctrlKey: true, altKey: true, shiftKey: true }), "moveForward");
});

test("a key held before the server hands over control starts the move on the first frame after it", () => {
  const sent = [];
  const world = worldWithMover(sent);
  world.movementReady = false;
  withWorld(world, () => {
    key("keydown", "KeyW");
    assert.deepEqual(sent, [], "nothing goes out before SET_ACTIVE_MOVER / CLIENT_CONTROL_UPDATE");
    movement.advancePhysics(1 / 60);
    assert.deepEqual(sent, [], "a frame before control does not move or send");
    assert.equal(world.state.objects.get(1n).position.x, 0, "and the body did not drift unannounced");
    world.movementReady = true;
    movement.advancePhysics(1 / 60);
    assert.deepEqual(sent, [OPCODES.MSG_MOVE_START_FORWARD], "the held key goes out once control arrives");
    assert.ok(world.state.objects.get(1n).position.x > 0, "and the character runs in that same frame");
    movement.advancePhysics(1 / 60);
    assert.deepEqual(sent, [OPCODES.MSG_MOVE_START_FORWARD], "the next frame does not repeat it");
    key("keyup", "KeyW");
    assert.deepEqual(sent, [OPCODES.MSG_MOVE_START_FORWARD, OPCODES.MSG_MOVE_STOP]);
  });
});

test("the sit key held through the loading screen does not sit the character down", () => {
  const sent = [];
  const world = worldWithMover(sent);
  world.movementReady = false;
  let stood = 0;
  world.setStandState = () => { stood += 1; };
  world.standState = () => 0;
  withWorld(world, () => {
    key("keydown", "KeyX");
    assert.equal(stood, 0, "the verb on the way down waits for control");
    key("keyup", "KeyX");
  });
});

test("5.18 FOLLOWTARGET follows the target; a refusal is the client's error line", async () => {
  const { runAction } = await import("../dist/code/browser/input/Actions.js");
  const { followTargetGuid, cancelFollow } = await import("../dist/code/browser/input/Follow.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const sent = [];
  const world = worldWithMover(sent);
  const friend = { guid: 2n, typeId: 4, position: { x: 5, y: 0, z: 0, orientation: 0 }, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100]]) };
  world.state.objects.set(2n, friend);
  world.targetGuid = 2n;
  world.names = { get: () => "Друг" };
  const statuses = [];
  world.onSpellStatus = (text, error) => statuses.push([text, error]);
  withWorld(world, () => {
    assert.equal(runAction("followTarget"), true);
    assert.equal(followTargetGuid(), 2n);
    cancelFollow();
    friend.typeId = 3;
    runAction("followTarget");
    assert.equal(followTargetGuid(), undefined, "a creature is not followed");
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0][1], true, "as an error");
    world.targetGuid = undefined;
    runAction("followTarget");
    assert.equal(statuses.length, 2, "no target: ERR_GENERIC_NO_TARGET");
  });
});

test("5.15 a key held through a loading screen starts the run when the curtain opens", () => {
  const sent = [];
  const world = worldWithMover(sent);
  withWorld(world, () => {
    // Control was had before the transfer, then the curtain came down.
    movement.advancePhysics(1 / 60);
    game.worldLoading = true;
    world.movementReady = false;
    movement.releaseAllInput();
    key("keydown", "KeyW");
    movement.advancePhysics(1 / 60);
    assert.deepEqual(sent, [], "nothing under the loading screen");
    game.worldLoading = false;
    movement.advancePhysics(1 / 60);
    assert.deepEqual(sent, [], "nor before the new mover is ours");
    world.movementReady = true;
    movement.advancePhysics(1 / 60);
    assert.deepEqual(sent, [OPCODES.MSG_MOVE_START_FORWARD]);
    // And when control stays through the curtain (a short teleport), the end of loading is the edge.
    key("keyup", "KeyW");
    sent.length = 0;
    game.worldLoading = true;
    key("keydown", "KeyW");
    movement.advancePhysics(1 / 60);
    game.worldLoading = false;
    movement.advancePhysics(1 / 60);
    assert.deepEqual(sent, [OPCODES.MSG_MOVE_START_FORWARD], "the held key goes out once the curtain opens");
    key("keyup", "KeyW");
    game.worldLoading = false;
  });
});
