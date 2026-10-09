import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import { StaticSceneryGroup } from "../dist/code/browser/StaticSceneryGroup.js";

function frozen(x) {
  const node = new THREE.Group();
  node.position.set(x, 0, 0);
  node.updateMatrix();
  return node;
}

function freeze(node) {
  node.updateMatrixWorld(true);
  node.traverse((part) => { part.matrixAutoUpdate = false; part.matrixWorldAutoUpdate = false; });
}

function counted(object, calls) {
  const original = object.updateMatrixWorld.bind(object);
  object.updateMatrixWorld = (force) => { calls.push(object.name); original(force); };
}

test("frozen placements are not walked while the group stays put; live ones are walked as three walks them", () => {
  const scene = new THREE.Scene();
  const group = new StaticSceneryGroup();
  scene.add(group);
  const still = frozen(10); still.name = "still";
  const mesh = new THREE.Mesh(); mesh.name = "stillMesh"; mesh.position.set(0, 2, 0); still.add(mesh);
  group.add(still);
  const growing = new THREE.Group(); growing.name = "growing"; growing.position.set(-5, 0, 0);
  const leaf = new THREE.Mesh(); leaf.name = "leaf"; growing.add(leaf);
  group.add(growing);
  freeze(still);
  const calls = [];
  [still, mesh, growing, leaf].forEach((object) => counted(object, calls));

  scene.updateMatrixWorld(); // first walk: the group has not been placed yet, so it walks everything
  assert.deepEqual(calls.sort(), ["growing", "leaf", "still", "stillMesh"].sort());
  calls.length = 0;
  scene.updateMatrixWorld(); // the scene recomposes itself and arrives forced, as in the renderer
  assert.deepEqual(calls.sort(), ["growing", "leaf"].sort(), "the frozen subtree is skipped");
  assert.deepEqual(mesh.matrixWorld.elements.slice(12, 15), [10, 2, 0], "its world matrix is the frozen one");

  growing.position.x = -7;
  calls.length = 0;
  scene.updateMatrixWorld();
  assert.deepEqual(leaf.matrixWorld.elements.slice(12, 15), [-7, 0, 0], "a live node still follows its matrix");

  // The group itself moves: every child is walked again and follows.
  group.position.y = 3;
  calls.length = 0;
  scene.updateMatrixWorld();
  assert.ok(calls.includes("still"), "a moved group walks its frozen children");
  assert.deepEqual(mesh.matrixWorld.elements.slice(12, 15), [10, 2, 0],
    "a frozen node keeps its own world matrix, as three leaves it when matrixWorldAutoUpdate is off");
});

test("a stand-in hung under a frozen room keeps the world matrix written when it was made", () => {
  const scene = new THREE.Scene();
  const group = new StaticSceneryGroup();
  scene.add(group);
  const building = frozen(20);
  group.add(building);
  freeze(building);
  scene.updateMatrixWorld(); // the group has long been placed when rooms arrive
  // A room hung later, composed and frozen as #updateWmoGroups does, then its proxy made from it.
  const room = new THREE.Mesh();
  building.add(room);
  room.updateMatrixWorld(true);
  room.matrixAutoUpdate = false;
  room.matrixWorldAutoUpdate = false;
  const proxy = new THREE.Mesh();
  proxy.matrixAutoUpdate = false;
  room.add(proxy);
  proxy.matrixWorld.multiplyMatrices(room.matrixWorld, proxy.matrix);
  const calls = [];
  counted(proxy, calls);
  for (let frame = 0; frame < 3; frame++) scene.updateMatrixWorld();
  assert.equal(calls.length, 0, "never walked");
  assert.deepEqual(proxy.matrixWorld.elements.slice(12, 15), [20, 0, 0], "and still where its room is");
});

test("a pending update is honoured; three's own walk is unchanged for anything else", () => {
  const scene = new THREE.Scene();
  const group = new StaticSceneryGroup();
  scene.add(group);
  const node = frozen(1);
  group.add(node);
  freeze(node);
  scene.updateMatrixWorld();
  const calls = [];
  counted(node, calls);
  scene.updateMatrixWorld();
  assert.equal(calls.length, 0);
  node.matrixWorldNeedsUpdate = true;
  scene.updateMatrixWorld();
  assert.equal(calls.length, 1, "a node that asks for an update is walked");
});

test("the renderer uses it for the scenery group and freezes a static building's rooms as they are hung", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /readonly #environmentGroup = new StaticSceneryGroup\(\);/);
  assert.match(source, /if \(staticEnvironment\) \{\s+rendered\.mesh\.updateMatrixWorld\(true\);\s+rendered\.mesh\.matrixAutoUpdate = false;\s+rendered\.mesh\.matrixWorldAutoUpdate = false;/);
  const attach = source.indexOf("rendered.mesh.matrixWorldAutoUpdate = false;");
  assert.ok(attach > 0 && attach < source.indexOf("this.#syncWmoRoomShadow(placed, index, rendered, true"),
    "frozen before its shadow stand-in reads its world matrix");
});
