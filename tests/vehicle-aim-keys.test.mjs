import assert from "node:assert/strict";
import test from "node:test";

// 11.02-input: VEHICLEAIMUP / VEHICLEAIMDOWN are held keys of the pitch axis itself — Wow.exe registers
// VehicleAimUpStart/Stop and VehicleAimDownStart/Stop as PitchUpStart/Stop and PitchDownStart/Stop (0x005fc8e0,
// 0x005fc570, 0x005fc920, 0x005fc5c0; .runtime/re-2026-10-03/l1102e/notes.txt). A key bound to them goes through
// the real Controls.ts and Movement.ts here (the fake DOM of input-movement-modifiers.test.mjs) and starts and
// stops exactly what Insert/Delete (PITCHUP/PITCHDOWN, DefaultBindings.wtf) start and stop.

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
const store = new Map();
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, String(value)); } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const controls = await import("../dist/code/browser/input/Controls.js");
const movement = await import("../dist/code/browser/input/Movement.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const { startVehicleData } = await import("../dist/code/browser/VehicleClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { MOVEMENT_FLAGS } = await import("../dist/code/world/MovementProtocol.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_FORMAT,
} = await import("../dist/code/world/VehicleDbc.js");
const { VEHICLE_FLAGS: F } = await import("../dist/code/world/VehicleSeatModel.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const SELF = 1n;
const VEHICLE = 0xf150_7d9a_0000_0042n;
const KIT = 9004; // ALLOW_PITCHING only: the keys pitch it on the ground (vehicle-movement-flags.test.mjs's KEYS)

function vehicleRow(id, flags) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  row[VEHICLE_COLUMN.Flags] = flags;
  return row;
}
const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [vehicleRow(KIT, F.ALLOW_PITCHING)],
  seats: [[...VEHICLE_SEAT_FORMAT].map((_, column) => (column === 0 ? 1 : 0))],
  indicators: [],
  indicatorSeats: [],
};

function key(type, code, modifiers = {}) {
  let prevented = false;
  window.fire(type, {
    code, target: document.body, defaultPrevented: false, repeat: false,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers,
    preventDefault() { prevented = true; },
  });
  return prevented;
}

/** The character driving a vehicle with ALLOW_PITCHING (11.02-A's shape): the vehicle is the mover. */
function drivenWorld(sent) {
  const toggles = () => ({ rooted: false, waterWalking: false, featherFall: false, hovering: false,
    canFly: false, gravityDisabled: false, collisionHeight: 0 });
  const character = { guid: SELF, typeId: 4, movementFlags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const vehicle = {
    guid: VEHICLE, typeId: 3, movementFlags: 0, vehicleId: KIT, position: { x: 0, y: 0, z: 0, orientation: 0 },
    speeds: new Map([["pitchRate", 1]]), fields: new Map(),
  };
  const world = {
    mapId: 0, movementReady: true, controlledGuid: VEHICLE,
    state: { selfGuid: SELF, objects: new Map([[SELF, character], [VEHICLE, vehicle]]) },
    movementState: toggles(), speeds: new Map(),
    movementStateOf: () => toggles(), speedsOf: () => new Map(),
    targetGuid: undefined, chatLog: [],
    sendMovement: (opcode) => sent.push(["character", opcode]),
    sendMovementAs: (guid, opcode, flags) => {
      sent.push([guid === VEHICLE ? "vehicle" : "other", opcode, flags & (MOVEMENT_FLAGS.pitchUp | MOVEMENT_FLAGS.pitchDown)]);
      vehicle.position = { ...vehicle.position };
    },
    selectTarget() {}, aurasFor: () => [], displayName: () => "",
  };
  return world;
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

test("11.02-input: a key on VEHICLEAIMUP / VEHICLEAIMDOWN starts and stops the pitch as Insert / Delete do", async () => {
  const client = startVehicleData("ws://127.0.2.1:18090", { fetch: async () => new Response(JSON.stringify(ANSWER), { status: 200 }) });
  await client.load();
  bindings.useBindingStorage({ getItem: () => null, setItem() {} });
  try {
    bindings.bindAction("vehicleAimUp", 0, "KeyY");
    bindings.bindAction("vehicleAimDown", 0, "KeyH");
    const viaAim = [];
    withWorld(drivenWorld(viaAim), () => {
      assert.equal(key("keydown", "KeyY"), true, "the key is the game's");
      key("keyup", "KeyY");
      key("keydown", "KeyH");
      key("keyup", "KeyH");
    });
    const viaPitch = [];
    withWorld(drivenWorld(viaPitch), () => {
      key("keydown", "Insert");
      key("keyup", "Insert");
      key("keydown", "Delete");
      key("keyup", "Delete");
    });
    assert.deepEqual(viaAim, [
      ["vehicle", OPCODES.MSG_MOVE_START_PITCH_UP, MOVEMENT_FLAGS.pitchUp], ["vehicle", OPCODES.MSG_MOVE_STOP_PITCH, 0],
      ["vehicle", OPCODES.MSG_MOVE_START_PITCH_DOWN, MOVEMENT_FLAGS.pitchDown], ["vehicle", OPCODES.MSG_MOVE_STOP_PITCH, 0],
    ]);
    assert.deepEqual(viaAim, viaPitch, "one pitch axis, two names (VehicleAimUpStart is PitchUpStart)");
    // Both keys of one direction down: one bit; the first release stops it, as the client's single input bit does.
    const both = [];
    withWorld(drivenWorld(both), () => {
      key("keydown", "Insert");
      key("keydown", "KeyY");
      key("keyup", "KeyY");
      key("keyup", "Insert");
    });
    assert.deepEqual(both.map(([, opcode]) => opcode), [OPCODES.MSG_MOVE_START_PITCH_UP, OPCODES.MSG_MOVE_STOP_PITCH]);
  } finally {
    bindings.useBindingStorage(undefined);
  }
});
