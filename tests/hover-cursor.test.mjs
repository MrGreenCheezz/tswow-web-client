// Л1, after the review: the cursor under the pointer — what it says, and when it is allowed to
// say it. Two findings live here, and neither had a test.
//
// The clock is stubbed rather than real: the throttle is what is being tested, and a test that
// depended on how long two synchronous calls take would say something different on every machine.
// The timer is real, because the tail pass is one `setTimeout` and waiting 30 ms for it is cheaper
// than replacing the runtime's timers underneath the test runner.

import assert from "node:assert/strict";
import test from "node:test";

let clock = 10_000;

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "", listeners,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append() {}, prepend() {}, appendChild(child) { return child; }, replaceChildren() {},
      remove() {}, focus() {}, blur() {},
      addEventListener(name, handler) { listeners.set(name, handler); },
      removeEventListener(name) { listeners.delete(name); },
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      setPointerCapture() {}, releasePointerCapture() {},
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
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
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};
// Read at call time by `updateHoverCursor`, so the throttle can be stepped a millisecond at a time.
globalThis.performance = { now: () => clock };

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { wireControls } = await import("../dist/code/browser/input/Controls.js");

const worldCanvas = document.getElementById("world-canvas");
wireControls();
const pointerMove = worldCanvas.listeners.get("pointermove");
const pointerLeave = worldCanvas.listeners.get("pointerleave");
assert.ok(pointerMove && pointerLeave, "the canvas has to be wired for any of this to mean anything");

/** How the throttle is spelled in `Controls.ts`: one frame at 60 Hz. */
const HOVER_INTERVAL = 16;

function unit(guid, { typeId = 3, health = 100, dynamicFlags = 0 } = {}) {
  return {
    guid, typeId,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
      [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100],
      [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, dynamicFlags],
    ]),
  };
}

/**
 * A world with three things standing in it, and a scene that answers by the x of the click.
 *
 * 100 is the live mob, 200 the body that still holds loot, 300 the body somebody has emptied, and
 * anything else is bare ground.
 */
function scene() {
  const objects = new Map([
    [1n, unit(1n, { typeId: 4 })],
    [2n, unit(2n, { health: 60 })],
    [3n, unit(3n, { health: 0, dynamicFlags: 0x01 })],
    [4n, unit(4n, { health: 0, dynamicFlags: 0x04 })],
  ]);
  game.world = { state: { selfGuid: 1n, objects } };
  game.collision = undefined;
  game.scene = { pick: (x) => (x === 100 ? 2n : x === 200 ? 3n : x === 300 ? 4n : undefined) };
  worldCanvas.style.cursor = "";
}

const move = (x) => pointerMove({ buttons: 0, clientX: x, clientY: 10, movementX: 0, movementY: 0 });
const settle = () => new Promise((resolve) => setTimeout(resolve, HOVER_INTERVAL * 2));

test("Л1 the cursor answers with the bag only where there is loot, and the hand everywhere else", () => {
  scene();
  clock += 1_000;
  move(100);
  assert.equal(worldCanvas.style.cursor, "pointer", "a living unit is a hand");

  clock += 1_000;
  move(200);
  assert.match(worldCanvas.style.cursor, /^url\("data:image\/svg\+xml,/, "a body with loot is the bag");
  assert.match(worldCanvas.style.cursor, /, pointer$/, "with the keyword a browser falls back to");

  // The review's second finding. An emptied body used to fall into the same branch as a miss and
  // get the bare ground's `crosshair` — but `pick` had answered with it, `#pushUnitHit` gives it a
  // box, the right button still sends the loot request and the target frame still offers
  // «Обыскать» with a working click. The bit is per viewer and arrives a packet late under a
  // group's round-robin (`LootHandler.cpp:430` is the only forced resend, and only in one branch),
  // so the window where a body is clickable and unmarked is one the slice itself describes.
  clock += 1_000;
  move(300);
  assert.equal(worldCanvas.style.cursor, "pointer",
    "a spent body is still clickable, so the cursor must not say it is ground");

  clock += 1_000;
  move(900);
  assert.equal(worldCanvas.style.cursor, "", "and bare ground is left to the stylesheet's crosshair");
});

test("Л1 the last sample of a flick is taken, not dropped", async () => {
  // A pure leading-edge throttle loses the end of every gesture: the player sweeps from a mob onto
  // the body lying beside it and stops, the last `pointermove` arrives less than 16 ms after the
  // one before, and there is no next event to make up for it. At a mouse speed of 1000 px/s that
  // is up to 16 px of travel the cursor says nothing about, and it lasts until the hand moves
  // again — which, having arrived, it is not about to do.
  scene();
  clock += 1_000;
  move(100);
  assert.equal(worldCanvas.style.cursor, "pointer");

  // Inside the window: dropped by the leading edge, and armed as a tail.
  clock += 4;
  move(200);
  assert.equal(worldCanvas.style.cursor, "pointer", "the throttle still holds the leading edge");
  await settle();
  assert.match(worldCanvas.style.cursor, /^url\("data:image\/svg\+xml,/, "and the tail lands on it");
});

test("Л1 a tail pass is dropped when the pointer has already moved on", async () => {
  scene();
  clock += 1_000;
  move(100);

  // Two samples inside one window: the first tail must not outlive the second event, or the cursor
  // would be answered about a point the pointer left two moves ago.
  clock += 2;
  move(200);
  clock += 2;
  move(900);
  await settle();
  assert.equal(worldCanvas.style.cursor, "", "the second move won, and it was over bare ground");

  // And leaving the canvas cancels whatever was still armed: the interface owns its own cursor,
  // and a bag written after the pointer has gone would be waiting when it came back.
  clock += 1_000;
  move(100);
  clock += 2;
  move(200);
  pointerLeave();
  await settle();
  assert.equal(worldCanvas.style.cursor, "");
});
