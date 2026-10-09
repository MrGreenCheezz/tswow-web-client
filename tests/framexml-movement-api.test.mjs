import assert from "node:assert/strict";
import test from "node:test";

// Lane L8 (WORK_PLAN 5.09, 04.10): the stock movement C API — MoveForwardStart/Stop and the rest of Wow.exe's
// registration table 0x00ad1938…0x00ad1ad4, SitStandOrDescendStart 0x0051b1d0 — and RunBinding with a keystate,
// over the held machinery a key uses (FrameXmlMovementApi.ts → FrameXmlBindingModel → input/MovementCommands.ts →
// Controls → Movement). A Start is no new edge for a command already held (0x005fa170), a Stop clears it whoever
// held it (0x005fa450), TurnOrAction/CameraOrSelectOrMove are the buttons' bits. The fake DOM of
// override-no-stuck-movement.test.mjs; Controls, Bindings, Movement and FrameXmlBinding are real.

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
const { worldCanvas } = await import("../dist/code/browser/ui/Dom.js");
const controls = await import("../dist/code/browser/input/Controls.js");
const movement = await import("../dist/code/browser/input/Movement.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const { FrameXmlBindingModel, FRAMEXML_BINDING_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");
const { FRAMEXML_MOVEMENT_NAMES } = await import("../dist/code/browser/framexml/FrameXmlMovementApi.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const storage = new Map();
bindings.useBindingStorage({ getItem: (name) => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) });
bindings.resetBindings();

function key(type, code, { target = document.body, repeat = false, ...modifiers } = {}) {
  window.fire(type, {
    code, key: code, target, defaultPrevented: false, repeat,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers,
    preventDefault() {},
  });
}

function pointer(type, buttons) {
  for (const handler of worldCanvas.listeners.get(type) ?? []) {
    handler({ button: buttons & 2 ? 2 : 0, buttons, pointerId: 1, clientX: 0, clientY: 0, movementX: 0, movementY: 0,
      preventDefault() {} });
  }
}

const NAMES = new Map(Object.entries(OPCODES).map(([name, value]) => [value, name]));

/** Runs `body` in a world whose mover reports every movement packet to `wire`; `lua(name, ...args)` calls the C API. */
function inWorld(body) {
  const wire = [];
  const opcodes = [];
  const stands = [];
  const mover = { guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map() };
  const runs = [];
  const model = new FrameXmlBindingModel({ runAction: (action) => { runs.push(action); return true; } });
  const seam = { keyBindings: model };
  const lua = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
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
    setStandState: (state) => { stands.push(state); },
    selectTarget() {}, aurasFor: () => [], displayName: () => "",
  };
  game.worldLoading = false;
  game.terrain = { heightAt: () => 0, liquidAt: () => undefined, isHole: () => false };
  game.camera.yaw = 0;
  try {
    body({ wire, opcodes, model, runs, lua, mover, stands });
  } finally {
    pointer("pointerup", 0);
    controls.clearHeldKeys();
    movement.forgetMovementState();
    game.world = undefined;
    game.terrain = undefined;
    game.camera.yaw = 0;
  }
}

const axes = () => [movement.forwardAxis(), movement.strafeAxis(), movement.turnAxis()];

test("the names are Wow.exe's 3.3.5a registration table, every one a seam answer", () => {
  const table = [
    "JumpOrAscendStart", "AscendStop", "SitStandOrDescendStart", "DescendStop", "ToggleRun", "ToggleAutoRun",
    "MoveForwardStart", "MoveForwardStop", "MoveBackwardStart", "MoveBackwardStop", "TurnLeftStart", "TurnLeftStop",
    "TurnRightStart", "TurnRightStop", "StrafeLeftStart", "StrafeLeftStop", "StrafeRightStart", "StrafeRightStop",
    "PitchUpStart", "PitchUpStop", "PitchDownStart", "PitchDownStop", "VehicleAimUpStart", "VehicleAimUpStop",
    "VehicleAimDownStart", "VehicleAimDownStop", "TurnOrActionStart", "TurnOrActionStop", "CameraOrSelectOrMoveStart",
    "CameraOrSelectOrMoveStop", "MoveAndSteerStart", "MoveAndSteerStop", "MouselookStart", "MouselookStop",
    "IsMouselooking",
  ];
  assert.deepEqual([...FRAMEXML_MOVEMENT_NAMES], table);
  for (const name of table) {
    assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} reaches the VM`);
  }
  // 3.3.5a registers neither (str scan of Wow.exe.clean): they are later clients' names.
  assert.equal(FRAMEXML_SEAM_BINDINGS.ToggleWalk, undefined);
  assert.equal(FRAMEXML_SEAM_BINDINGS.ToggleMouseMove, undefined);
});

test("each name reaches the held machinery as its Bindings.xml body would; RunBinding holds and lets go", () => {
  const calls = [];
  let looking = false;
  const runs = [];
  const model = new FrameXmlBindingModel({
    runAction: (action) => { runs.push(action); return true; },
    movement: {
      hold: (action, down) => calls.push(["hold", action, down]),
      button: (bit, down) => calls.push(["button", bit, down]),
      mouselooking: () => looking,
    },
  });
  const seam = { keyBindings: model };
  const lua = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const expect = (name, ...expected) => {
    calls.length = 0;
    assert.deepEqual(lua(name), [], `${name} returns nothing`);
    assert.deepEqual(calls, expected, name);
  };
  expect("MoveForwardStart", ["hold", "moveForward", true]);
  expect("MoveForwardStop", ["hold", "moveForward", false]);
  expect("MoveBackwardStart", ["hold", "moveBackward", true]);
  expect("TurnLeftStart", ["hold", "turnLeft", true]);
  expect("TurnRightStop", ["hold", "turnRight", false]);
  expect("StrafeLeftStart", ["hold", "strafeLeft", true]);
  expect("StrafeRightStop", ["hold", "strafeRight", false]);
  expect("JumpOrAscendStart", ["hold", "jump", true]);
  expect("AscendStop", ["hold", "jump", false]);
  expect("SitStandOrDescendStart", ["hold", "sitOrStand", true]);
  expect("DescendStop", ["hold", "sitOrStand", false]);
  expect("PitchUpStart", ["hold", "pitchUp", true]);
  expect("PitchDownStop", ["hold", "pitchDown", false]);
  // Without the vehicle tables FrameXmlVehicleAim.ts falls back to these: the same functions in Wow.exe.
  expect("VehicleAimUpStart", ["hold", "pitchUp", true]);
  expect("VehicleAimDownStop", ["hold", "pitchDown", false]);
  expect("TurnOrActionStart", ["button", 1, true]);
  expect("CameraOrSelectOrMoveStop", ["button", 2, false]);
  expect("MoveAndSteerStart", ["button", 2, true], ["button", 1, true]);
  expect("MoveAndSteerStop", ["button", 2, false], ["button", 1, false]);
  expect("MouselookStart", ["button", 1, true]);
  expect("MouselookStop", ["button", 1, false]);
  assert.deepEqual(lua("IsMouselooking"), [], "nil while nothing turns with the mouse");
  looking = true;
  assert.deepEqual(lua("IsMouselooking"), [1]);
  expect("ToggleAutoRun");
  expect("ToggleRun");
  assert.deepEqual(runs, ["toggleAutoRun", "toggleWalkRun"], "the toggles are their rows' verbs");

  // RunBinding: a held command both ways (StackSplitFrame_OnKeyUp's "up"), a pressed one once on the way down.
  runs.length = 0;
  calls.length = 0;
  model.run("MOVEFORWARD");
  model.run("MOVEFORWARD", "up");
  model.run("JUMP", "down");
  model.run("VEHICLEAIMUP", "up");
  model.run("PITCHDOWN");
  model.run("TOGGLEWORLDMAP", "up");
  model.run("TOGGLEWORLDMAP");
  assert.deepEqual(calls, [
    ["hold", "moveForward", true], ["hold", "moveForward", false], ["hold", "jump", true],
    ["hold", "vehicleAimUp", false], ["hold", "pitchDown", true],
  ]);
  assert.deepEqual(runs, ["toggleWorldMap"]);
  assert.equal(FRAMEXML_BINDING_BINDINGS.RunBinding(seam, ["STRAFELEFT", "up"]).length, 0);
  assert.deepEqual(calls.at(-1), ["hold", "strafeLeft", false]);
  // A model with no host input and none registered does nothing (the offline preview).
  const lone = new FrameXmlBindingModel({});
  assert.doesNotThrow(() => lone.hold("moveForward", true));
});

test("MoveForwardStart/Stop are W's own packets; a Start on a held command is no new edge", () => {
  const viaKey = [];
  inWorld(({ wire }) => {
    key("keydown", "KeyW");
    key("keydown", "KeyW", { repeat: true });
    key("keyup", "KeyW");
    viaKey.push(...wire);
  });
  inWorld(({ wire, opcodes, lua }) => {
    lua("MoveForwardStart");
    assert.deepEqual(axes(), [1, 0, 0]);
    lua("MoveForwardStart");
    lua("MoveForwardStop");
    assert.deepEqual(axes(), [0, 0, 0]);
    lua("MoveForwardStop");
    assert.deepEqual(opcodes, ["MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP"]);
    assert.deepEqual(wire, viaKey, "the same bytes as the key");
  });
});

test("a Stop clears the command whoever held it: the key's release then does nothing, its autorepeat starts nothing", () => {
  inWorld(({ opcodes, lua }) => {
    key("keydown", "KeyW");
    lua("MoveForwardStop");
    assert.deepEqual(axes(), [0, 0, 0]);
    key("keydown", "KeyW", { repeat: true });
    assert.deepEqual(axes(), [0, 0, 0], "autorepeat is not a press");
    key("keyup", "KeyW");
    key("keydown", "KeyW");
    assert.equal(movement.forwardAxis(), 1, "a fresh press moves again");
    key("keyup", "KeyW");
    // A Start while the key is down is no new edge, and the key's release stops it (its Stop clears the bit).
    key("keydown", "KeyA");
    lua("TurnLeftStart");
    key("keyup", "KeyA");
    assert.deepEqual(axes(), [0, 0, 0]);
    assert.deepEqual(opcodes, [
      "MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP", "MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP",
      "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN",
    ]);
    // …and a later Start holds it again.
    lua("TurnLeftStart");
    assert.equal(movement.turnAxis(), 1);
    lua("TurnLeftStop");
    assert.equal(movement.turnAxis(), 0);
    // A stopped Lua hold is gone, not parked: the strafe modifier finds nothing of it to start.
    key("keydown", "ShiftLeft", { shiftKey: true });
    key("keyup", "ShiftLeft");
    assert.deepEqual(axes(), [0, 0, 0]);
    // TurnLeftStop stops the turn key that the strafe modifier made a strafe (one bit, 0x100, in Wow.exe).
    key("keydown", "ShiftLeft", { shiftKey: true });
    key("keydown", "KeyA", { shiftKey: true });
    assert.deepEqual(axes(), [0, 1, 0]);
    lua("TurnLeftStop");
    assert.deepEqual(axes(), [0, 0, 0]);
    key("keyup", "KeyA", { shiftKey: true });
    key("keyup", "ShiftLeft");
  });
});

test("RunBinding(cmd) and RunBinding(cmd, \"up\") hold and release through the live table", () => {
  inWorld(({ opcodes, model, runs }) => {
    model.run("STRAFELEFT");
    assert.deepEqual(axes(), [0, 1, 0]);
    model.run("STRAFELEFT", "up");
    model.run("MOVEBACKWARD", "down");
    assert.equal(movement.forwardAxis(), -1);
    model.run("MOVEBACKWARD", "up");
    assert.deepEqual(axes(), [0, 0, 0]);
    assert.deepEqual(opcodes, ["MSG_MOVE_START_STRAFE_LEFT", "MSG_MOVE_STOP_STRAFE", "MSG_MOVE_START_BACKWARD", "MSG_MOVE_STOP"]);
    assert.deepEqual(runs, [], "held commands are no verbs");
  });
});

test("SitStandOrDescendStart sits once on the way down, as the X key; DescendStop lets go", () => {
  inWorld(({ lua, stands }) => {
    lua("SitStandOrDescendStart");
    lua("SitStandOrDescendStart");
    lua("DescendStop");
    assert.equal(stands.length, 1, "one sit, no second edge while held");
    key("keydown", "KeyX");
    key("keyup", "KeyX");
    assert.equal(stands.length, 2, "the key the same way");
  });
});

test("the mouse commands are the buttons' bits: both run, the right one steers and makes the turn keys strafe", () => {
  inWorld(({ opcodes, lua, mover }) => {
    lua("MoveAndSteerStart");
    assert.deepEqual(axes(), [1, 0, 0]);
    assert.deepEqual(lua("IsMouselooking"), [1]);
    lua("TurnLeftStart");
    assert.deepEqual(axes(), [1, 1, 0], "a turn under the right button's bit strafes");
    lua("MoveAndSteerStop");
    assert.deepEqual(axes(), [0, 0, 1], "and turns again once it is let go");
    assert.deepEqual(lua("IsMouselooking"), []);
    lua("TurnLeftStop");
    assert.deepEqual(opcodes, [
      "MSG_MOVE_START_FORWARD", "MSG_MOVE_START_STRAFE_LEFT", "MSG_MOVE_STOP",
      "MSG_MOVE_STOP_STRAFE", "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN",
    ]);
    // The right button physically down and the left's command from Lua are the two-button run as well, and the
    // mouse moving on does not take the Lua half away.
    opcodes.length = 0;
    pointer("pointerdown", 2);
    lua("CameraOrSelectOrMoveStart");
    assert.equal(movement.forwardAxis(), 1);
    pointer("pointermove", 2);
    assert.equal(movement.forwardAxis(), 1, "a pointer move keeps the Lua button");
    lua("CameraOrSelectOrMoveStop");
    assert.equal(movement.forwardAxis(), 0);
    pointer("pointerup", 0);
    assert.deepEqual(opcodes, ["MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP"]);
    // A gesture abandoned (lost capture) leaves what Lua holds held.
    pointer("pointerdown", 1);
    lua("MoveAndSteerStart");
    pointer("pointercancel", 0);
    assert.equal(movement.forwardAxis(), 1, "MoveAndSteer survives the mouse's gesture ending");
    lua("MoveAndSteerStop");
    assert.equal(movement.forwardAxis(), 0);
    // The right button's bit going down turns the character to the camera, as its press does; the release reports it.
    opcodes.length = 0;
    game.camera.yaw = 0.5;
    lua("TurnOrActionStart");
    assert.equal(game.camera.yaw, 0);
    assert.ok(Math.abs(mover.position.orientation - 0.5) < 1e-9, `faces ${mover.position.orientation}`);
    assert.deepEqual(opcodes, ["MSG_MOVE_SET_FACING"]);
    lua("TurnOrActionStop");
    assert.deepEqual(opcodes, ["MSG_MOVE_SET_FACING", "MSG_MOVE_SET_FACING"], "and the release reports the facing");
    lua("TurnOrActionStart");
    lua("TurnOrActionStop");
    assert.equal(opcodes.length, 2, "no turn, no facing to report");
  });
});

test("the right button's Lua bit makes a held turn key strafe, and a turn key pressed under it", () => {
  inWorld(({ opcodes, lua }) => {
    key("keydown", "KeyA");
    lua("MouselookStart");
    assert.deepEqual(axes(), [0, 1, 0], "the held A strafes now");
    lua("MouselookStop");
    assert.deepEqual(axes(), [0, 0, 1], "and turns again");
    key("keyup", "KeyA");
    lua("MouselookStart");
    key("keydown", "KeyD");
    assert.deepEqual(axes(), [0, -1, 0], "D pressed under it strafes");
    key("keyup", "KeyD");
    lua("MouselookStop");
    assert.deepEqual(opcodes, [
      "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN", "MSG_MOVE_START_STRAFE_LEFT", "MSG_MOVE_STOP_STRAFE",
      "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN", "MSG_MOVE_START_STRAFE_RIGHT", "MSG_MOVE_STOP_STRAFE",
    ]);
  });
});

test("Mouselook steers a swimmer's pitch as the right button does, and holds the camera's auto-follow", () => {
  inWorld(({ lua, mover }) => {
    game.terrain = { heightAt: () => -20, liquidAt: () => ({ height: 0, type: 1 }), isHole: () => false };
    mover.position.z = -5;
    movement.advancePhysics(1 / 60);
    assert.equal(movement.characterMotion().mode, "swim");
    const pitch = game.camera.pitch;
    game.camera.pitch = -0.3;
    try {
      lua("MouselookStart");
      movement.advancePhysics(1 / 60);
      assert.ok(Math.abs(movement.characterPitchNow() + 0.3) < 1e-9, `pitch ${movement.characterPitchNow()}`);
      // While it is held the camera does not swing back behind the character (5.14 auto-follow).
      game.camera.yaw = 0.5;
      lua("MoveForwardStart");
      controls.advanceCameraAutoFollow(0.1);
      assert.equal(game.camera.yaw, 0.5);
      lua("MouselookStop");
      controls.advanceCameraAutoFollow(0.1);
      assert.ok(game.camera.yaw < 0.5, `follows again: ${game.camera.yaw}`);
      lua("MoveForwardStop");
    } finally {
      game.camera.pitch = pitch;
    }
  });
});

test("the world changing under the player lets the Lua buttons go", () => {
  inWorld(({ lua }) => {
    lua("MouselookStart");
    controls.clearHeldKeys();
    assert.deepEqual(lua("IsMouselooking"), []);
    lua("TurnLeftStart");
    assert.deepEqual(axes(), [0, 0, 1]);
    lua("TurnLeftStop");
  });
});

test("focus lost lets every Lua hold and button go", () => {
  inWorld(({ opcodes, lua }) => {
    lua("MoveForwardStart");
    lua("MouselookStart");
    lua("TurnRightStart");
    assert.deepEqual(axes(), [1, -1, 0]);
    window.fire("blur", {});
    assert.deepEqual(axes(), [0, 0, 0]);
    assert.deepEqual(lua("IsMouselooking"), []);
    lua("TurnRightStart");
    assert.deepEqual(axes(), [0, 0, -1], "a turn again, not a strafe");
    lua("TurnRightStop");
    assert.equal(opcodes.at(-1), "MSG_MOVE_STOP_TURN");
  });
});

// L8-review 5.09: what a Stop let go stays let go until its key comes up — the strafe modifier (Shift, the right
// button, the Lua right-button bit) does not start it again as a strafe (Wow.exe: TurnLeftStop cleared bit 0x100,
// and 0x005fafb0 makes strafes only of turn bits that are set).
test("a key a Stop let go is not started again by the strafe modifier; a Start takes it up under the modifier", () => {
  inWorld(({ opcodes, lua }) => {
    key("keydown", "KeyA");
    lua("TurnLeftStop");
    assert.deepEqual(axes(), [0, 0, 0]);
    key("keydown", "ShiftLeft", { shiftKey: true });
    assert.deepEqual(axes(), [0, 0, 0], "Shift starts no strafe from a stopped key");
    key("keyup", "ShiftLeft");
    pointer("pointerdown", 2);
    assert.deepEqual(axes(), [0, 0, 0], "nor does the right button");
    pointer("pointerup", 0);
    lua("MouselookStart");
    assert.deepEqual(axes(), [0, 0, 0], "nor the right button's Lua bit");
    lua("MouselookStop");
    // A Start while the key is still down takes the key's hold up again, as the modifiers are now.
    key("keydown", "ShiftLeft", { shiftKey: true });
    lua("TurnLeftStart");
    assert.deepEqual(axes(), [0, 1, 0], "held again, a strafe under Shift");
    key("keyup", "ShiftLeft");
    assert.deepEqual(axes(), [0, 0, 1], "a turn again without it");
    key("keyup", "KeyA");
    assert.deepEqual(axes(), [0, 0, 0], "the key's release stops it");
    assert.deepEqual(opcodes, [
      "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN",
      "MSG_MOVE_START_STRAFE_LEFT", "MSG_MOVE_STOP_STRAFE", "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN",
    ]);
  });
});

// L8-review 5.09: focus lost with the Lua right-button bit held stops the steering too — the pitch of a swimmer no
// longer follows the camera (the blur handler's abandonGesture returns early when no physical button is down).
test("focus lost with Mouselook held from Lua stops steering the swimmer's pitch", () => {
  inWorld(({ lua, mover }) => {
    game.terrain = { heightAt: () => -20, liquidAt: () => ({ height: 0, type: 1 }), isHole: () => false };
    mover.position.z = -5;
    movement.advancePhysics(1 / 60);
    assert.equal(movement.characterMotion().mode, "swim");
    const pitch = game.camera.pitch;
    try {
      game.camera.pitch = -0.3;
      lua("MouselookStart");
      movement.advancePhysics(1 / 60);
      assert.ok(Math.abs(movement.characterPitchNow() + 0.3) < 1e-9);
      window.fire("blur", {});
      game.camera.pitch = -0.6;
      movement.advancePhysics(1 / 60);
      assert.ok(movement.characterPitchNow() > -0.31, `the pitch levels out rather than following: ${movement.characterPitchNow()}`);
    } finally {
      game.camera.pitch = pitch;
    }
  });
});

// L8-review 5.09: the other way round — a key's release is its Stop (Bindings.xml TURNLEFT: TurnLeftStop on "up"), which
// clears the bit a Lua Start set as well (0x005fa450); the Lua hold must not linger and come back under the modifier.
test("a key's release lets a Lua hold of the same command go too; the strafe modifier finds nothing of it", () => {
  inWorld(({ opcodes, lua }) => {
    lua("TurnLeftStart");
    key("keydown", "KeyA");
    key("keyup", "KeyA");
    assert.deepEqual(axes(), [0, 0, 0]);
    key("keydown", "ShiftLeft", { shiftKey: true });
    assert.deepEqual(axes(), [0, 0, 0], "no strafe from the Lua hold the key's release stopped");
    key("keyup", "ShiftLeft");
    lua("TurnLeftStart");
    assert.deepEqual(axes(), [0, 0, 1], "a new Start holds it again");
    lua("TurnLeftStop");
    assert.deepEqual(opcodes, ["MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN", "MSG_MOVE_START_TURN_LEFT", "MSG_MOVE_STOP_TURN"]);
  });
});

// L8-review 5.09: the buttons are the same two bits as the Lua commands (0x1 right, 0x2 left), so a physical button
// coming up is its Stop for whoever set the bit (0x005fa450): MoveAndSteerStart and a right click — the release
// clears 0x1, the two-button run ends, 0x2 stays. Kept apart, the Lua bit outlived the button and ran on.
test("a physical button's release clears the Lua command on its bit; the other bit stays", () => {
  inWorld(({ opcodes, lua }) => {
    lua("MoveAndSteerStart");
    assert.equal(movement.forwardAxis(), 1);
    pointer("pointerdown", 2);
    pointer("pointerup", 0);
    assert.equal(movement.forwardAxis(), 0, "the right button's release ends the two-button run");
    assert.deepEqual(lua("IsMouselooking"), [], "and the mouselook bit");
    lua("TurnOrActionStart");
    assert.equal(movement.forwardAxis(), 1, "the left bit was still held");
    lua("MoveAndSteerStop");
    assert.equal(movement.forwardAxis(), 0);
    pointer("pointerdown", 1);
    lua("CameraOrSelectOrMoveStart");
    pointer("pointerup", 0);
    lua("TurnOrActionStart");
    assert.equal(movement.forwardAxis(), 0, "the left release cleared the left bit too");
    lua("TurnOrActionStop");
    assert.deepEqual(opcodes.filter((name) => name !== "MSG_MOVE_SET_FACING"),
      ["MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP", "MSG_MOVE_START_FORWARD", "MSG_MOVE_STOP"]);
  });
});
