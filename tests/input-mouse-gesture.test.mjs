import assert from "node:assert/strict";
import test from "node:test";

// 5.14: the mouse gesture — the right button turns the character to the camera's look and makes A/D
// strafe (Wow.exe 0x005fafb0), a drag past the click threshold locks the pointer and the last button
// up releases it, a lock lost mid-drag ends the gesture, deselectOnClick and mouseInvertPitch. The fake
// DOM of input-controls-residuals.test.mjs with pointer-lock hooks; Controls and Movement are real.

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

test("a drag past the click threshold locks the pointer once; the last button up releases it", () => {
  withWorld(() => {
    pointer("pointerdown", 2);
    pointer("pointermove", 2, 2, 0);
    assert.equal(lockRequests, 0, "inside the click threshold the cursor stays");
    pointer("pointermove", 2, 5, 0);
    assert.equal(lockRequests, 1, "past it the drag takes the pointer");
    // The lock takes the pointer over from the capture: that is not the gesture ending.
    fireCanvas("lostpointercapture", {});
    assert.equal(canvas.classList.contains("camera-dragging"), true, "the drag goes on under the lock");
    pointer("pointermove", 2, 5, 0);
    assert.equal(lockRequests, 1, "asked once per drag");
    pointer("pointerup", 0);
    assert.equal(exits, 1, "the cursor comes back when the button does");
    // A click is never locked.
    pointer("pointerdown", 1);
    pointer("pointerup", 0);
    assert.equal(lockRequests, 1);
  });
});

test("a lock lost under a held button (Escape, Alt-Tab) ends the gesture", () => {
  withWorld((world, sent) => {
    pointer("pointerdown", 3);
    pointer("pointermove", 3, 6, 0);
    assert.equal(lockRequests, 1);
    assert.deepEqual(sent.filter((op) => op === OPCODES.MSG_MOVE_START_FORWARD), [OPCODES.MSG_MOVE_START_FORWARD],
      "both buttons run forward");
    document.pointerLockElement = null;
    fireDocument("pointerlockchange");
    assert.equal(canvas.classList.contains("camera-dragging"), false, "the gesture is over");
    assert.equal(sent.at(-1), OPCODES.MSG_MOVE_STOP, "and the two-button run stops with it");
  });
});

test("the right button turns the character to the camera's look without moving the view", () => {
  withWorld((world, sent) => {
    game.camera.yaw = 0.5;
    pointer("pointerdown", 2);
    assert.ok(Math.abs(world.mover.position.orientation - 0.5) < 1e-12, "the character faces where the camera looked");
    assert.equal(game.camera.yaw, 0, "the offset is spent, so the view stays where it was");
    pointer("pointerup", 0);
    assert.equal(sent.at(-1), OPCODES.MSG_MOVE_SET_FACING, "the new facing reaches the server even on a click");
  });
});

test("A and D strafe while the right button is held, and turn again when it comes up", () => {
  withWorld((world, sent) => {
    key("keydown", "KeyA");
    assert.equal(sent.at(-1), OPCODES.MSG_MOVE_START_TURN_LEFT);
    pointer("pointerdown", 2);
    assert.deepEqual(sent.slice(-2), [OPCODES.MSG_MOVE_STOP_TURN, OPCODES.MSG_MOVE_START_STRAFE_LEFT]);
    pointer("pointerup", 0);
    assert.deepEqual(sent.slice(-2), [OPCODES.MSG_MOVE_STOP_STRAFE, OPCODES.MSG_MOVE_START_TURN_LEFT]);
    key("keyup", "KeyA");
    pointer("pointerdown", 2);
    key("keydown", "KeyD");
    assert.equal(sent.at(-1), OPCODES.MSG_MOVE_START_STRAFE_RIGHT, "a key pressed under the button strafes at once");
    key("keyup", "KeyD");
  });
});

test("deselectOnClick off keeps the target on a click on bare ground; mouseInvertPitch turns the tilt over", () => {
  const before = settingsModule.settings().deselectOnClick;
  withWorld((world) => {
    pointer("pointerdown", 1);
    pointer("pointerup", 0);
    assert.deepEqual(world.selections, [undefined], "by default bare ground drops the target");
    settingsModule.settings().deselectOnClick = false;
    pointer("pointerdown", 1);
    pointer("pointerup", 0);
    assert.deepEqual(world.selections, [undefined], "with it off the click selects nothing new");
  });
  settingsModule.settings().deselectOnClick = before ?? true;
  withWorld(() => {
    const start = game.camera.pitch;
    pointer("pointerdown", 1);
    pointer("pointermove", 1, 0, 10);
    const normal = game.camera.pitch - start;
    pointer("pointerup", 0);
    game.camera.pitch = start;
    settingsModule.settings().mouseInvertPitch = true;
    pointer("pointerdown", 1);
    pointer("pointermove", 1, 0, 10);
    const inverted = game.camera.pitch - start;
    pointer("pointerup", 0);
    settingsModule.settings().mouseInvertPitch = false;
    assert.ok(normal < 0, "dragging down looks down by default");
    assert.ok(Math.abs(inverted + normal) < 1e-12, "and up when inverted, by the same angle");
  });
});

test("a refused lock is not asked for again on every move of the same drag", async () => {
  let asked = 0;
  const previous = canvas.requestPointerLock;
  canvas.requestPointerLock = () => { asked += 1; return Promise.reject(new Error("no activation")); };
  const sent = [];
  movement.forgetMovementState();
  game.world = worldWithMover(sent);
  game.worldLoading = false;
  try {
    pointer("pointerdown", 2);
    pointer("pointermove", 2, 6, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pointer("pointermove", 2, 6, 0);
    pointer("pointermove", 2, 6, 0);
    assert.equal(asked, 1, "one request per gesture");
    assert.equal(canvas.classList.contains("camera-dragging"), true, "the captured drag goes on");
    pointer("pointerup", 0);
    pointer("pointerdown", 2);
    pointer("pointermove", 2, 6, 0);
    assert.equal(asked, 2, "the next gesture asks again");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    pointer("pointerup", 0);
    canvas.requestPointerLock = previous;
    controls.clearHeldKeys();
    movement.forgetMovementState();
    game.world = undefined;
  }
});
