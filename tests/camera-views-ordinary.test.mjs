import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// DEC-review 3.11 (04.10): the ordinary camera — no FlipCameraYaw, no view key — is what it was before DEC-B. The
// baseline is Controls.ts and CameraRig.ts themselves with every `DEC-B 3.11` hook taken back to the line that
// stood there (each asserted to match exactly once), loaded beside the real modules over the same dependencies;
// both run one scripted session — the right button's turn, its steering drag and release, the left button's look,
// the follow while running, the two-button run, the wheel, the Lua TurnOrAction button — and every camera number,
// the character's facing and every movement packet are compared exactly (Object.is). Loop.ts's hook is the idle
// `cameraViews.frame`, which must write nothing on the rig, and `cameraViews.gliding`, false without a switch.
// Harness: the fake DOM of camera-flip-steer.test.mjs; Controls, Movement, Settings are real.

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
  exitPointerLock() { this.pointerLockElement = null; },
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

// One clock for both runs: the facing throttle and every timer read it.
const clock = { now: 1000 };
const realNow = performance.now;
performance.now = () => clock.now;
test.after(() => { performance.now = realNow; });

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const movement = await import("../dist/code/browser/input/Movement.js");
const commands = await import("../dist/code/browser/input/MovementCommands.js");
const rigModule = await import("../dist/code/browser/game/CameraRig.js");
const { CameraViews } = await import("../dist/code/browser/game/CameraViews.js");
const { CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_PITCH } = await import("../dist/code/browser/SimpleScene.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
usePanelHost({ viewport: document.body, attach() {} });

// ---- the baselines: Controls.ts and CameraRig.ts without their DEC-B 3.11 hooks ----------------------------

const RIG_TS = new URL("../src/browser/game/CameraRig.ts", import.meta.url);
const RIG_DIST = new URL("../dist/code/browser/game/CameraRig.js", import.meta.url);
const CONTROLS_TS = new URL("../src/browser/input/Controls.ts", import.meta.url);
const CONTROLS_DIST = new URL("../dist/code/browser/input/Controls.js", import.meta.url);

/** Each DEC-B 3.11 hook of CameraRig.ts, and what stood in its place before (git HEAD d25bc8f). */
const RIG_HOOKS = [
  ["  /**\n"
    + "   * DEC-B 3.11: FlipCameraYaw's part of `yaw` (Wow.exe camera+0x12c, CameraViews.ts) — kept by the\n"
    + "   * follow and the steer, which work on the rest. Absent or 0 without a flip.\n"
    + "   */\n"
    + "  flipYaw?: number | undefined;\n", ""],
  ["  rig.yaw = stepAngle(rig.yaw, rig.flipYaw ?? 0, yawStep); // DEC-B 3.11: home is the flip (was 0)\n",
    "  rig.yaw = stepAngle(rig.yaw, 0, yawStep);\n"],
];

/** Each DEC-B 3.11 hook of Controls.ts, and what stood in its place before (git HEAD d25bc8f). */
const CONTROLS_HOOKS = [
  ["import { cameraYawOffFlip } from \"../game/CameraViews.js\"; // DEC-B 3.11\n", ""],
  ["  // DEC-B 3.11: by the yaw without FlipCameraYaw's part, which stays (Wow.exe 0x6023d0 turns by camera+0x11c);\n"
    + "  // was `game.camera.yaw !== 0 && turnCharacterBy(game.camera.yaw)` and `yaw = 0` — the same without a flip.\n"
    + "  if (right && !wasRight && cameraYawOffFlip(game.camera) !== 0 && turnCharacterBy(cameraYawOffFlip(game.camera))) {\n"
    + "    game.camera.yaw = game.camera.flipYaw ?? 0;\n",
  "  if (right && !wasRight && game.camera.yaw !== 0 && turnCharacterBy(game.camera.yaw)) {\n"
    + "    game.camera.yaw = 0;\n"],
  ["        camera.yaw = camera.flipYaw ?? 0; // DEC-B 3.11: home is the flip (was 0)\n", "        camera.yaw = 0;\n"],
  ["  // DEC-B 3.11: without FlipCameraYaw's part, as the button's press (syncButtons).\n"
    + "  if (right && !rightBefore && cameraYawOffFlip(game.camera) !== 0 && turnCharacterBy(cameraYawOffFlip(game.camera))) {\n"
    + "    game.camera.yaw = game.camera.flipYaw ?? 0;\n",
  "  if (right && !rightBefore && game.camera.yaw !== 0 && turnCharacterBy(game.camera.yaw)) {\n"
    + "    game.camera.yaw = 0;\n"],
];

function baseline(sourceUrl, distUrl, hooks, overrides = {}) {
  let source = readFileSync(sourceUrl, "utf8").replace(/\r\n/g, "\n");
  for (const [hook, before] of hooks) {
    assert.equal(source.split(hook).length - 1, 1, `the DEC-B 3.11 hook stands where the review found it:\n${hook}`);
    source = source.replace(hook, before);
  }
  const left = source.split("\n").filter((line) => line.includes("DEC-B"));
  assert.deepEqual(left, [], "no other DEC-B 3.11 hook");
  // The relative imports become absolute, so the copy shares every dependency module with the real one.
  source = source.replace(/((?:from|import)\s+)"(\.{1,2}\/[^"]+)"/g,
    (_, lead, specifier) => `${lead}"${overrides[specifier] ?? new URL(specifier, distUrl).href}"`);
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}

const RIG_BEFORE_URL = baseline(RIG_TS, RIG_DIST, RIG_HOOKS);
const rigBefore = await import(RIG_BEFORE_URL);

// ---- the fake world and the session ----------------------------------------------------------------------------

const canvas = dom.worldCanvas;
canvas.requestPointerLock = () => { document.pointerLockElement = canvas; };
const fireCanvas = (name, event) => { for (const handler of canvas.listeners.get(name) ?? []) handler(event); };
const pointer = (name, buttons, movementX = 0, movementY = 0) => fireCanvas(name, {
  pointerId: 1, clientX: 40, clientY: 40, movementX, movementY, button: buttons & 2 ? 2 : 0, buttons, preventDefault() {},
});
const key = (type, code) => window.fire(type, {
  code, target: document.body, defaultPrevented: false, repeat: false,
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {},
});
const wheel = (deltaY) => fireCanvas("wheel", { deltaY, deltaMode: 0, preventDefault() {} });

function worldWithMover(sent) {
  const mover = { guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0.25 }, fields: new Map() };
  return {
    mover, mapId: 0, movementReady: true,
    state: { selfGuid: 1n, objects: new Map([[1n, mover]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(), targetGuid: undefined, chatLog: [],
    sendMovement: (opcode, flags, position) => {
      sent.push([opcode, flags, position?.x, position?.y, position?.z, position?.orientation]);
      mover.position = { ...mover.position };
    },
    selectTarget() {}, aurasFor: () => [], displayName: () => "", closeLoot() {},
  };
}

/** The scripted session with one Controls module: every camera number, the facing and the packets after each step. */
function session(controls, flip, start) {
  clock.now = start;
  const sent = [];
  const world = worldWithMover(sent);
  movement.forgetMovementState();
  game.world = world;
  game.worldLoading = false;
  const camera = game.camera;
  Object.assign(camera, { yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE });
  if (flip === "absent") delete camera.flipYaw;
  else camera.flipYaw = flip;
  const steps = [];
  const snap = (step) => {
    steps.push([step, camera.yaw, camera.pitch, camera.distance, world.mover.position.orientation, sent.length, ...sent.flat()]);
    sent.length = 0;
  };
  const tick = (ms) => { clock.now += ms; };
  try {
    // The right button with the camera looked aside: the character turns to it, the camera comes behind.
    camera.yaw = 0.7;
    pointer("pointerdown", 2);
    snap("right down");
    for (let move = 0; move < 3; move += 1) {
      tick(120);
      pointer("pointermove", 2, 12, -5);
      snap(`steer ${move}`);
    }
    tick(50);
    pointer("pointerup", 0);
    snap("right up");
    // The left button looks around alone.
    pointer("pointerdown", 1);
    tick(16);
    pointer("pointermove", 1, -20, 4);
    pointer("pointermove", 1, -35, 2);
    pointer("pointerup", 0);
    snap("left look");
    // Running with the camera aside: the follow brings it home at cameraYawSmoothSpeed (style 4 by default).
    key("keydown", "KeyW");
    for (let frame = 0; frame < 8; frame += 1) {
      tick(16);
      controls.advanceCameraAutoFollow(0.016);
      snap(`follow ${frame}`);
    }
    key("keyup", "KeyW");
    snap("stop");
    // Behind the back, both buttons: the two-button run and its steering.
    camera.yaw = -2.9;
    tick(300);
    pointer("pointerdown", 3);
    tick(16);
    pointer("pointermove", 3, 30, 0);
    tick(300);
    pointer("pointerup", 0);
    snap("mouse run");
    // The follow standing still: style 4 waits for movement.
    camera.yaw = 0.4;
    controls.advanceCameraAutoFollow(0.016);
    snap("follow still");
    // The wheel, in and out, to first person and back.
    wheel(300);
    wheel(-120);
    for (let notch = 0; notch < 12; notch += 1) wheel(-400);
    snap("wheel in");
    wheel(200);
    snap("wheel out");
    // TurnOrAction from Lua (MovementCommands): the right button's turn without a button.
    camera.yaw = 1.1;
    tick(300);
    commands.movementCommandInput().button(commands.TURN_OR_ACTION, true);
    snap("lua right down");
    tick(300);
    commands.movementCommandInput().button(commands.TURN_OR_ACTION, false);
    snap("lua right up");
    // A press with the camera already behind turns nothing on the press; the drag then steers.
    camera.yaw = 0;
    tick(300);
    pointer("pointerdown", 2);
    snap("right down behind");
    pointer("pointermove", 2, -9, 3);
    tick(300);
    pointer("pointerup", 0);
    snap("steer from behind");
  } finally {
    pointer("pointerup", 0);
    key("keyup", "KeyW");
    controls.clearHeldKeys();
    movement.forgetMovementState();
    game.world = undefined;
    delete camera.flipYaw;
  }
  return steps;
}

/** Each session starts a long while after the last one: Movement's facing throttle remembers the last send. */
let sessionStart = 0;
const nextStart = () => (sessionStart += 1_000_000);

/** Wires one Controls copy on fresh listener maps and runs the session for each flip state. */
function runAll(controls) {
  canvas.listeners = new Map();
  windowListeners.clear();
  documentListeners.clear();
  controls.wireControls();
  return {
    absent: session(controls, "absent", nextStart()),
    undefined: session(controls, undefined, nextStart()),
    zero: session(controls, 0, nextStart()),
  };
}

test("the ordinary camera with the DEC-B hooks is exactly the camera before them", async () => {
  // The real modules first, wired and run, then the baseline wired in their place and run the same way.
  const controls = await import("../dist/code/browser/input/Controls.js");
  const after = runAll(controls);
  const before = runAll(await import(baseline(CONTROLS_TS, CONTROLS_DIST, CONTROLS_HOOKS, { "../game/CameraRig.js": RIG_BEFORE_URL })));
  for (const flip of ["absent", "undefined", "zero"]) {
    assert.deepStrictEqual(after[flip], before[flip], `flipYaw ${flip}: every number and packet as before`);
  }
  // The session did what it is meant to exercise.
  const steps = new Map(after.absent.map((row) => [row[0], row]));
  assert.ok(steps.get("right down")[5] > 0, "the right button sent the facing");
  assert.equal(steps.get("right down")[1], 0, "and brought the camera behind");
  assert.ok(steps.get("right up").includes(OPCODES.MSG_MOVE_SET_FACING), "the release reported the facing");
  assert.notEqual(steps.get("left look")[1], 0, "the left button looked aside");
  assert.equal(steps.get("follow 7")[1], 0, "the follow brought it home while running");
  assert.equal(steps.get("follow still")[1], 0.4, "and waits while standing (style 4)");
  assert.equal(steps.get("wheel in")[3], 0, "the wheel reached first person");
  assert.ok(steps.get("lua right down")[5] > 0, "TurnOrAction turned the character");
});

test("the follow's arithmetic without a flip is the baseline's, bit for bit", () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const styles = [0, 1, 2, 3, 4, 5];
  for (let sample = 0; sample < 4000; sample += 1) {
    const yaw = (random() - 0.5) * 4 * Math.PI;
    const pitch = (random() - 0.5) * 3;
    const style = styles[Math.floor(random() * styles.length)];
    const speed = [0, 90, 180, 270, -5, Number.NaN][Math.floor(random() * 6)];
    const moving = random() < 0.5;
    const held = random() < 0.2;
    const elapsed = [0, 0.004, 0.016, 0.1, 1, -1][Math.floor(random() * 6)];
    const flip = sample % 3 === 0 ? {} : sample % 3 === 1 ? { flipYaw: 0 } : { flipYaw: undefined };
    const now = { yaw, pitch, ...flip };
    const then = { yaw, pitch };
    rigModule.advanceCameraFollow(now, style, speed, moving, held, elapsed);
    rigBefore.advanceCameraFollow(then, style, speed, moving, held, elapsed);
    assert.ok(Object.is(now.yaw, then.yaw) && Object.is(now.pitch, then.pitch),
      `sample ${sample}: ${JSON.stringify([yaw, pitch, style, speed, moving, held, elapsed, flip])}`);
  }
});

test("the loop's idle view frame writes nothing on the camera and never holds the follow back", () => {
  const writes = [];
  const camera = { yaw: 0.3, pitch: -0.4, distance: 21.31, view: 21.31, viewPitch: -0.4, zoom: 21.31 };
  const rig = new Proxy(camera, { set(target, name, value) { writes.push(name); target[name] = value; return true; } });
  const views = new CameraViews(null);
  const worldA = {};
  const worldB = {};
  for (let frame = 0; frame < 50; frame += 1) views.frame(rig, frame * 16, worldA, "Tester");
  views.frame(rig, 900, worldB, "Tester");
  views.frame(rig, 916, worldB, undefined);
  for (let frame = 0; frame < 50; frame += 1) views.frame(rig, 1000 + frame * 16, worldB, undefined);
  assert.deepEqual(writes, [], "no switch, no flip: the rig is not touched, a new world included");
  assert.equal(views.gliding, false, "so Loop.ts runs advanceCameraAutoFollow every frame, as before");
  assert.deepEqual([camera.yaw, camera.pitch, camera.distance], [0.3, -0.4, 21.31]);
});
