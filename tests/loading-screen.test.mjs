import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { advancePhysics, beginHeld, releaseAllInput, sendMovement } from "../dist/code/browser/input/Movement.js";
import {
  hideLoadingScreen, loadingScreenVisible, resetLoadingScreen, showLoadingScreen,
  updateLoadingScreen, worldPhysicsReady,
} from "../dist/code/browser/ui/LoadingScreen.js";

function node() {
  return { hidden: false, textContent: "", append() {}, setAttribute() {} };
}

const panel = node();
globalThis.document = {
  getElementById(id) { return id === "world-panel" ? panel : undefined; },
  createElement() { return node(); },
};

function destination() {
  const object = { position: { x: 0, y: 0, z: 25, orientation: 0 } };
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
  assert.equal(loadingScreenVisible(), false);
  assert.equal(worldPhysicsReady(), true);
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
