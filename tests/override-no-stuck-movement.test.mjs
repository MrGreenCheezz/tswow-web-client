import assert from "node:assert/strict";
import test from "node:test";

// Review of lane L2 (WORK_PLAN 3.11, 04.10): an override binding (SetOverrideBinding) that names a
// movement command is now held by Controls like the table's own key. The review asks that no path
// leaves the character running: window blur, the override cleared or changed while held, the key let
// go while an edit box has focus, the same key bound to a pressed (not held) command, the strafe
// modifier mid-hold, and the OS autorepeat. And that an ordinary W press puts the same movement
// packets on the wire with or without overrides present. The fake DOM of
// input-movement-modifiers.test.mjs; Controls, Bindings, Movement and FrameXmlBinding are real.

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
const bindings = await import("../dist/code/browser/input/Bindings.js");
const { FrameXmlBindingModel } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const storage = new Map();
bindings.useBindingStorage({ getItem: (name) => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) });
bindings.resetBindings();

function key(type, code, { target = document.body, repeat = false, ...modifiers } = {}) {
  let prevented = false;
  window.fire(type, {
    code, key: code, target, defaultPrevented: false, repeat,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers,
    preventDefault() { prevented = true; },
  });
  return prevented;
}

const OWNER = "table: 0x1";
const OTHER = "table: 0x2";
const NAMES = new Map(Object.entries(OPCODES).map(([name, value]) => [value, name]));

/** Runs `body` in a world whose mover reports every movement packet, in full, to `wire`. */
function inWorld(body) {
  const wire = [];
  const opcodes = [];
  const mover = { position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const runs = [];
  const model = new FrameXmlBindingModel({ runAction: (action) => { runs.push(action); return true; } });
  movement.forgetMovementState();
  game.world = {
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
      opcodes.push(NAMES.get(args[0]));
      wire.push(JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? `${value}n` : value)));
    },
    selectTarget() {}, aurasFor: () => [], displayName: () => "",
  };
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  try {
    body({ wire, opcodes, model, runs });
  } finally {
    controls.clearHeldKeys();
    bindings.clearAllOverrideBindings();
    movement.forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
  }
}

const still = () => [movement.forwardAxis(), movement.strafeAxis(), movement.turnAxis()];

test("an ordinary W press is the same bytes with no override, an unrelated one, or W overridden to MOVEFORWARD", () => {
  const press = (setup) => {
    let sent;
    inWorld(({ wire, model }) => {
      setup(model);
      key("keydown", "KeyW");
      key("keydown", "KeyW", { repeat: true });
      key("keyup", "KeyW");
      sent = [...wire];
    });
    return sent;
  };
  const plain = press(() => {});
  assert.equal(plain.length, 2, "start and stop");
  assert.deepEqual(press((model) => { assert.equal(model.setOverride(OTHER, false, "H", "MOVEBACKWARD"), true); }), plain);
  assert.deepEqual(press((model) => { assert.equal(model.setOverride(OTHER, true, "CTRL-W", "JUMP"), true); }), plain);
  assert.deepEqual(press((model) => { assert.equal(model.setOverride(OWNER, false, "W", "MOVEFORWARD"), true); }), plain);
});

test("window blur while an override holds the move stops it, and the late keyup sends nothing more", () => {
  inWorld(({ opcodes, model }) => {
    model.setOverride(OWNER, false, "H", "MOVEFORWARD");
    key("keydown", "KeyH");
    assert.deepEqual(opcodes, ["MSG_MOVE_START_FORWARD"]);
    window.fire("blur", {});
    assert.deepEqual(still(), [0, 0, 0]);
    assert.deepEqual(opcodes, ["MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP"]);
    key("keyup", "KeyH");
    assert.deepEqual(opcodes, ["MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP"]);
  });
});

test("the override cleared or changed while its key is held: the release stops what the press started", () => {
  inWorld(({ opcodes, model }) => {
    model.setOverride(OWNER, false, "H", "MOVEFORWARD");
    key("keydown", "KeyH");
    model.clearOverrides(OWNER);
    key("keyup", "KeyH");
    assert.deepEqual(still(), [0, 0, 0], "cleared mid-hold");
    model.setOverride(OWNER, false, "H", "MOVEFORWARD");
    key("keydown", "KeyH");
    model.setOverride(OWNER, false, "H", "MOVEBACKWARD");
    key("keyup", "KeyH");
    assert.deepEqual(still(), [0, 0, 0], "changed mid-hold");
    key("keydown", "KeyH");
    assert.equal(movement.forwardAxis(), -1, "the next press is the new command");
    key("keyup", "KeyH");
    assert.deepEqual(opcodes, [
      "MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP", "MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP",
      "MSG_MOVE_START_BACKWARD", "MSG_MOVE_STOP",
    ]);
  });
});

test("an override set on a table key already held: the release still stops the table's move", () => {
  inWorld(({ opcodes, model }) => {
    key("keydown", "KeyW");
    model.setOverride(OWNER, false, "W", "MOVEBACKWARD");
    key("keyup", "KeyW");
    assert.deepEqual(still(), [0, 0, 0]);
    assert.deepEqual(opcodes, ["MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP"]);
  });
});

test("the key let go while an edit box has focus still releases the override's move", () => {
  inWorld(({ opcodes, model }) => {
    model.setOverride(OWNER, false, "H", "STRAFELEFT");
    key("keydown", "KeyH");
    const box = new FakeInput();
    box.focus();
    key("keydown", "KeyH", { target: box, repeat: true });
    key("keyup", "KeyH", { target: box });
    box.blur();
    assert.deepEqual(still(), [0, 0, 0]);
    assert.deepEqual(opcodes, ["MSG_MOVE_START_STRAFE_LEFT", "MSG_MOVE_STOP_STRAFE"]);
  });
});

test("W overridden to a pressed command runs it once and never moves; nothing is left held", () => {
  inWorld(({ opcodes, model, runs }) => {
    model.setOverride(OWNER, false, "W", "TARGETNEARESTENEMY");
    assert.equal(key("keydown", "KeyW"), true);
    key("keydown", "KeyW", { repeat: true });
    key("keyup", "KeyW");
    assert.deepEqual(runs, ["targetNearestEnemy"]);
    assert.deepEqual(opcodes, []);
    model.clearOverrides(OWNER);
    key("keydown", "KeyW");
    key("keyup", "KeyW");
    assert.deepEqual(opcodes, ["MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP"], "the table's W is back");
  });
});

test("a held override turn becomes a strafe under Shift and stops on its release, autorepeat silent", () => {
  inWorld(({ opcodes, model }) => {
    model.setOverride(OWNER, false, "H", "TURNLEFT");
    key("keydown", "KeyH");
    key("keydown", "KeyH", { repeat: true });
    key("keydown", "ShiftLeft", { shiftKey: true });
    key("keydown", "KeyH", { repeat: true, shiftKey: true });
    key("keyup", "KeyH", { shiftKey: true });
    key("keyup", "ShiftLeft");
    assert.deepEqual(still(), [0, 0, 0]);
    assert.deepEqual(opcodes, [
      "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN", "MSG_MOVE_START_STRAFE_LEFT", "MSG_MOVE_STOP_STRAFE",
    ]);
  });
});
