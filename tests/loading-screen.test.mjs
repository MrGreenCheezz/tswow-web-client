import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { advancePhysics, beginHeld, releaseAllInput, sendMovement } from "../dist/code/browser/input/Movement.js";
import {
  hideLoadingScreen, loadingScreenVisible, resetLoadingScreen, showLoadingScreen,
  updateLoadingScreen, worldPhysicsReady,
} from "../dist/code/browser/ui/LoadingScreen.js";

function node() {
  const attributes = new Map();
  const style = new Map();
  return {
    hidden: false, textContent: "", children: [],
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    style: { setProperty(name, value) { style.set(name, value); }, getPropertyValue(name) { return style.get(name) ?? ""; } },
  };
}

const panel = node();
globalThis.document = {
  getElementById(id) { return id === "world-panel" ? panel : undefined; },
  createElement() { return node(); },
};

function destination() {
  const object = { position: { x: 0, y: 0, z: 25, orientation: 0 }, fields: new Map(), motion: undefined };
  return {
    mapId: 1,
    state: { selfGuid: 1n, objects: new Map([[1n, object]]) },
    movementState: {
      rooted: false, waterWalking: false, featherFall: false, hovering: false,
      canFly: false, gravityDisabled: false, collisionHeight: 0,
    },
    speeds: new Map(),
    sendMovement() {},
  };
}

test("the transfer curtain blocks physics until terrain and collision answer", () => {
  game.world = destination();
  game.terrain = { isReady: () => false };
  game.collision = { refresh() {}, isReady: () => false };
  showLoadingScreen("Hero");
  assert.equal(worldPhysicsReady(), false);
  updateLoadingScreen(performance.now());
  assert.equal(loadingScreenVisible(), true);
  assert.equal(worldPhysicsReady(), false);
  hideLoadingScreen();
  game.world = undefined;
  game.terrain = undefined;
  game.collision = undefined;
  game.worldLoading = false;
});

test("the transfer curtain has a finite safe degradation timeout", () => {
  game.world = destination();
  game.terrain = { isReady: () => false };
  game.collision = { refresh() {}, isReady: () => false };
  showLoadingScreen("Hero");
  updateLoadingScreen(performance.now() + 20_001);
  // The entry soak renders a few hidden frames after release: bounded draining, not one call.
  for (let frame = 0; frame < 10 && loadingScreenVisible(); frame++) {
    updateLoadingScreen(performance.now() + 20_001 + frame);
  }
  assert.equal(loadingScreenVisible(), false);
  assert.equal(worldPhysicsReady(), true);
  resetLoadingScreen();
  game.world = undefined;
  game.terrain = undefined;
  game.collision = undefined;
  game.worldLoading = false;
});

test("the entry soak renders hidden frames after the barrier before the reveal", () => {
  game.world = destination();
  game.terrain = { isReady: () => true };
  game.collision = { refresh() {}, isReady: () => true };
  showLoadingScreen("Hero");
  updateLoadingScreen(performance.now());
  assert.equal(loadingScreenVisible(), true,
    "the first panorama uploads behind the curtain, not on the first visible frame");
  assert.equal(worldPhysicsReady(), true, "physics already runs during the soak");
  for (let frame = 0; frame < 10 && loadingScreenVisible(); frame++) {
    updateLoadingScreen(performance.now());
  }
  assert.equal(loadingScreenVisible(), false, "the soak is a few frames, not forever");
  resetLoadingScreen();
  game.world = undefined;
  game.terrain = undefined;
  game.collision = undefined;
  game.worldLoading = false;
});

test("physics and movement packets stay still while the transfer barrier is closed", () => {
  const world = destination();
  const position = world.state.objects.get(1n).position;
  const sent = [];
  world.sendMovement = (...args) => sent.push(args);
  game.world = world;
  game.worldLoading = true;
  advancePhysics(1 / 60);
  sendMovement(0x1234);
  assert.equal(position.z, 25);
  assert.equal(sent.length, 0);
  game.world = undefined;
  game.worldLoading = false;
});

test("input pressed during the curtain is reconciled when the barrier opens", () => {
  const world = destination();
  const sent = [];
  world.movementReady = true;
  world.sendMovement = (...args) => sent.push(args);
  game.world = world;
  showLoadingScreen("Hero");
  beginHeld("moveForward");
  assert.equal(sent.length, 0, "the key must not send against the destination while it is loading");
  hideLoadingScreen();
  assert.equal(sent.length, 1, "the held axis is sent once the destination is ready");
  releaseAllInput();
  game.world = undefined;
  game.worldLoading = false;
});

test("taxi spline owns movement and gravity until the server releases the rider", () => {
  const world = destination();
  const rider = world.state.objects.get(1n);
  rider.motion = { splineId: 17, points: [], lengths: [], totalLength: 0,
    startedAt: 0, duration: 1000, cyclic: false, flying: true, finalOrientation: undefined };
  rider.fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x00100000]]);
  world.movementReady = true;
  const sent = [];
  world.sendMovement = (...args) => sent.push(args);
  game.world = world;
  game.worldLoading = false;
  const original = { ...rider.position };
  beginHeld("moveForward");
  advancePhysics(1 / 60);
  assert.deepEqual(rider.position, original, "local physics must not pull a taxi rider toward terrain");
  assert.equal(sent.length, 0, "keys must not send movement during server flight");
  rider.motion = undefined;
  advancePhysics(1 / 60);
  assert.equal(sent.length, 0, "the last spline frame is still taxi-controlled until the server clears its flag");
  rider.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0);
  advancePhysics(1 / 60);
  assert.equal(sent.filter(([opcode]) => opcode === OPCODES.MSG_MOVE_START_FORWARD).length, 1,
    "a key held through landing must be reconciled when control returns");
  releaseAllInput();
  game.world = undefined;
});

test("the curtain shows the destination map's stock picture and the stock bar", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:8090/dbc/loading-screens");
    return { ok: true, status: 200, json: async () => ({ 1: {
      file: "Interface\\Glues\\LoadingScreens\\LoadScreenKalimdor.blp",
      wide: "Interface\\Glues\\LoadingScreens\\LoadScreenKalimdorWide.blp",
    } }) };
  };
  try {
    panel.clientWidth = 1920;
    panel.clientHeight = 1080;
    game.world = destination();
    game.terrain = { isReady: () => false };
    game.collision = { refresh() {}, isReady: () => false };
    showLoadingScreen("Hero", "", { mapId: 1, gateway: "ws://127.0.0.1:8090/auth" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const root = panel.children.at(-1);
    const stage = root.children[0];
    const [art, , , bar] = stage.children;
    assert.equal(art.src, "http://127.0.0.1:8090/texture?path="
      + encodeURIComponent("Interface\\Glues\\LoadingScreens\\LoadScreenKalimdorWide.blp"));
    assert.equal(stage.getAttribute("data-wide"), "true", "a 16:9 panel takes the Wide twin");
    const border = bar.children[1];
    assert.match(border.src, /Loading-BarBorder\.blp$/);
    // The bar starts empty and creeps toward the terrain stage's ceiling while terrain loads.
    assert.equal(bar.style.getPropertyValue("--loading-progress"), "0.0000");
    const shown = performance.now();
    updateLoadingScreen(shown);
    updateLoadingScreen(shown + 1000);
    const filled = Number(bar.style.getPropertyValue("--loading-progress"));
    assert.ok(filled > 0.2 && filled < 0.62, `${filled}`);
    resetLoadingScreen();
  } finally {
    globalThis.fetch = realFetch;
    panel.clientWidth = undefined;
    panel.clientHeight = undefined;
    game.world = undefined;
    game.terrain = undefined;
    game.collision = undefined;
    game.worldLoading = false;
  }
});
