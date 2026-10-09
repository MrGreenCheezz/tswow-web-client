import assert from "node:assert/strict";
import test from "node:test";

// DEC-B 3.11 (04.10): FlipCameraYaw's yaw (Wow.exe camera+0x12c) survives the right button. The steer
// turns the character by camera+0x11c alone (0x6023d0 → 0x5fb260) and the final yaw adds +0x12c after
// it (0x604490), so a flipped camera stays flipped while the character turns. Harness: the fake DOM of
// input-mouse-gesture.test.mjs; Controls and Movement are real.

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
const documentListeners = new Map();
let exits = 0;
globalThis.document = {
  activeElement: null,
  pointerLockElement: null,
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
  addEventListener(name, handler) { documentListeners.set(name, [...(documentListeners.get(name) ?? []), handler]); },
  exitPointerLock() {
    exits += 1;
    this.pointerLockElement = null;
  },
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
const dom = await import("../dist/code/browser/ui/Dom.js");
const controls = await import("../dist/code/browser/input/Controls.js");
const movement = await import("../dist/code/browser/input/Movement.js");
const settingsModule = await import("../dist/code/browser/ui/Settings.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const canvas = dom.worldCanvas;
let lockRequests = 0;
canvas.requestPointerLock = () => {
  lockRequests += 1;
  document.pointerLockElement = canvas;
};
const fireCanvas = (name, event) => { for (const handler of canvas.listeners.get(name) ?? []) handler(event); };
const fireDocument = (name) => { for (const handler of documentListeners.get(name) ?? []) handler({}); };
const pointer = (name, buttons, movementX = 0, movementY = 0) => fireCanvas(name, {
  pointerId: 1, clientX: 40, clientY: 40, movementX, movementY, button: buttons & 2 ? 2 : 0, buttons, preventDefault() {},
});
function key(type, code) {
  window.fire(type, {
    code, target: document.body, defaultPrevented: false, repeat: false,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {},
  });
}

function worldWithMover(sent) {
  const mover = { position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const selections = [];
  return {
    mover, selections,
    mapId: 0, movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(), targetGuid: 7n, chatLog: [],
    sendMovement: (opcode) => {
      sent.push(opcode);
      mover.position = { ...mover.position };
    },
    selectTarget(guid) { this.targetGuid = guid; selections.push(guid); },
    aurasFor: () => [], displayName: () => "", closeLoot() {},
  };
}

function withWorld(body) {
  const sent = [];
  const world = worldWithMover(sent);
  movement.forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  game.camera.yaw = 0;
  const pitch = game.camera.pitch;
  lockRequests = 0;
  exits = 0;
  document.pointerLockElement = null;
  try {
    body(world, sent);
  } finally {
    pointer("pointerup", 0);
    controls.clearHeldKeys();
    movement.forgetMovementState();
    game.world = undefined;
    game.camera.yaw = 0;
    game.camera.pitch = pitch;
  }
}

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} against ${expected}`);
const wrap = (angle) => angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));

test("the right button turns the character by the yaw without the flip; the flip stays on the camera", () => {
  withWorld((world) => {
    try {
      game.camera.flipYaw = wrap(Math.PI);
      game.camera.yaw = wrap(Math.PI + 0.4);
      pointer("pointerdown", 2);
      near(world.mover.position.orientation, 0.4, "the character faces where the unflipped camera looked");
      near(game.camera.yaw, wrap(Math.PI), "and the camera still looks back at it");
      pointer("pointermove", 2, 10, 0);
      near(game.camera.yaw, wrap(Math.PI), "the steering drag turns the character, the flip stays");
      assert.ok(world.mover.position.orientation !== 0.4, "the drag turned the character");
    } finally {
      game.camera.flipYaw = undefined;
    }
  });
});

test("without a flip the right button is what it was: the whole yaw spent, the camera behind", () => {
  withWorld((world) => {
    game.camera.yaw = 0.5;
    pointer("pointerdown", 2);
    near(world.mover.position.orientation, 0.5, "faces the camera's look");
    assert.equal(game.camera.yaw, 0);
  });
});
