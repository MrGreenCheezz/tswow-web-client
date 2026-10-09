// 7.05 variant A (owner decision 05.10): moving transports outside the game-object limits.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  GAMEOBJECT_TRANSPORT_BUDGET,
  GAMEOBJECT_TRANSPORT_RANGE,
  gameObjectWithinAdmissionRange,
  selectGameObjectAdmissionWithTransports,
  transportWmoViewer,
} from "../dist/code/browser/GameObjectTransportAdmission.js";
import {
  GAMEOBJECT_BUDGET,
  GAMEOBJECT_RANGE,
  placeEnvironmentNode,
  wmoGroupBoxes,
  wmoGroupsInRange,
  wmoShellRange,
} from "../dist/code/browser/WorldRenderer3D.js";

const candidate = (value, distance, transport, extra = {}) =>
  ({ value, distance, transport, pinned: false, visible: true, ...extra });

test("a moving transport keeps the 750-yard far range and a quota of eight", () => {
  assert.equal(GAMEOBJECT_TRANSPORT_RANGE, 750);
  assert.equal(GAMEOBJECT_TRANSPORT_BUDGET, 8);
  assert.equal(GAMEOBJECT_RANGE, 120);
  assert.equal(gameObjectWithinAdmissionRange(300, true, GAMEOBJECT_RANGE), true);
  assert.equal(gameObjectWithinAdmissionRange(300, false, GAMEOBJECT_RANGE), false);
  assert.equal(gameObjectWithinAdmissionRange(750, true, GAMEOBJECT_RANGE), true);
  assert.equal(gameObjectWithinAdmissionRange(751, true, GAMEOBJECT_RANGE), false);
  assert.equal(gameObjectWithinAdmissionRange(120, false, GAMEOBJECT_RANGE), true);
  // The old `distance > GAMEOBJECT_RANGE` filter kept a non-finite distance (ranked last).
  assert.equal(gameObjectWithinAdmissionRange(Number.NaN, false, GAMEOBJECT_RANGE), true);
});

test("transports are admitted outside a full ordinary budget, and the ordinary pick is unchanged", () => {
  const ordinary = Array.from({ length: GAMEOBJECT_BUDGET + 20 }, (_, index) =>
    candidate(`door-${index}`, 1 + index, false));
  const ships = [candidate("ship", 300, true), candidate("lift", 40, true)];
  const { admitted, dropped } = selectGameObjectAdmissionWithTransports(
    [...ships, ...ordinary], GAMEOBJECT_BUDGET);
  const names = admitted.map(({ value }) => value);
  assert.equal(names.length, GAMEOBJECT_BUDGET + 2);
  assert.deepEqual(names.slice(0, GAMEOBJECT_BUDGET),
    ordinary.slice(0, GAMEOBJECT_BUDGET).map(({ value }) => value));
  assert.deepEqual(names.slice(GAMEOBJECT_BUDGET), ["lift", "ship"]);
  assert.equal(dropped, 20);
});

test("over the transport quota the farthest transport drops; a pinned one is kept first", () => {
  const ships = Array.from({ length: 10 }, (_, index) => candidate(`ship-${index}`, 100 + index * 60, true));
  let { admitted, dropped } = selectGameObjectAdmissionWithTransports(ships, GAMEOBJECT_BUDGET);
  assert.deepEqual(admitted.map(({ value }) => value), ships.slice(0, 8).map(({ value }) => value));
  assert.equal(dropped, 2);

  const pinned = ships.map((ship) => ship.value === "ship-9" ? { ...ship, pinned: true } : ship);
  ({ admitted, dropped } = selectGameObjectAdmissionWithTransports(pinned, GAMEOBJECT_BUDGET));
  assert.deepEqual(admitted.map(({ value }) => value),
    ["ship-9", ...ships.slice(0, 7).map(({ value }) => value)]);
  assert.equal(dropped, 2);
});

test("an invisible unpinned transport is not admitted and not counted as dropped", () => {
  const { admitted, dropped } = selectGameObjectAdmissionWithTransports(
    [candidate("ship", 300, true, { visible: false }), candidate("door", 5, false), candidate("zeppelin", 500, true),
      candidate("chest behind", 2, false, { visible: false })],
    GAMEOBJECT_BUDGET);
  assert.deepEqual(admitted.map(({ value }) => value), ["door", "zeppelin"]);
  assert.equal(dropped, 0);
});

const VMAP = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

function placement(x, y, z, yawDegrees) {
  return { id: 1, kind: "wmo", name: "ship.wmo", x, y, z, rotationX: 0, rotationY: yawDegrees, rotationZ: 0, scale: 1 };
}

test("the player is carried from a moved transport into its build placement", () => {
  const built = placement(700, 50, 0, 30);
  const buildNode = placeEnvironmentNode(new THREE.Group(), built);
  buildNode.updateMatrixWorld(true);
  const buildModelToWorld = buildNode.matrixWorld.clone().multiply(VMAP);

  const now = placeEnvironmentNode(new THREE.Group(), placement(10, -20, 3, 120));
  now.updateMatrixWorld(true);
  const currentModelToWorld = now.matrixWorld.clone().multiply(VMAP);
  const player = { x: 14, y: -25, z: 5 };
  const out = { x: 0, y: 0, z: 0 };
  assert.equal(transportWmoViewer(buildModelToWorld, now, player, out), out);

  const expected = new THREE.Vector3(player.x, player.z, -player.y)
    .applyMatrix4(currentModelToWorld.clone().invert());
  const got = new THREE.Vector3(out.x, out.z, -out.y).applyMatrix4(buildModelToWorld.clone().invert());
  assert.ok(Math.abs(expected.x - got.x) < 1e-6);
  assert.ok(Math.abs(expected.y - got.y) < 1e-6);
  assert.ok(Math.abs(expected.z - got.z) < 1e-6);
  // An unmoved transport answers the player unchanged.
  const same = transportWmoViewer(buildModelToWorld, buildNode, player, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(same.x - player.x) < 1e-6 && Math.abs(same.y - player.y) < 1e-6
    && Math.abs(same.z - player.z) < 1e-6);
});

test("a ship built far out keeps its rooms once it has sailed to the player", () => {
  const room = (minX, maxX, exterior) => ({
    triangleCount: 12,
    boundsValid: true,
    exterior,
    indoor: !exterior,
    bounds: { minX, minY: -5, minZ: 0, maxX, maxY: 5, maxZ: 10 },
  });
  const model = { groups: [room(-20, 20, true), room(-5, 5, false)] };
  const built = placement(700, 0, 0, 0);
  const boxes = wmoGroupBoxes(model, built);
  const buildNode = placeEnvironmentNode(new THREE.Group(), built);
  buildNode.updateMatrixWorld(true);
  const buildModelToWorld = buildNode.matrixWorld.clone().multiply(VMAP);

  const dock = placeEnvironmentNode(new THREE.Group(), placement(0, 0, 0, 0));
  const player = { x: 0, y: 30, z: 0 };
  assert.deepEqual(wmoGroupsInRange(model, boxes, player), [], "the stale boxes alone lose the ship");
  const viewer = transportWmoViewer(buildModelToWorld, dock, player, { x: 0, y: 0, z: 0 });
  assert.deepEqual(wmoGroupsInRange(model, boxes, viewer), [0, 1]);
});

test("the renderer wires the transport range, quota and WMO viewer into #updateGameObjects", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #updateGameObjects(");
  const end = source.indexOf("  #stampGameObjectAdmission(", start);
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /gameObjectWithinAdmissionRange\(distance, transport, GAMEOBJECT_RANGE\)/);
  assert.match(body, /selectGameObjectAdmissionWithTransports\(candidates, GAMEOBJECT_BUDGET\)/);
  assert.match(body, /transport = gameObjectWireIsMovingTransport\(object\)/);
  assert.match(body, /transportWmoViewer\(rendered\.wmo\.modelToWorld, rendered\.node, player,/);
  assert.doesNotMatch(body, /distance > GAMEOBJECT_RANGE\)/);
});

// 05.10: ревью 7.05 — a zeppelin's hull (transport_zeppelin.wmo, exterior group 77.8 × 37.9 × 55.8
// yd, diagonal 102.9 < WMO_SHELL_FAR_MIN_DIAGONAL 120) kept the 250-yard near shell leash, so a
// zeppelin admitted at 300–750 yards drew no room at all; whether it got the far leash depended on
// the yaw it happened to be built at (its rotated box reaches 128.5 yd at 45°). A moving transport's
// shell holds its own admission range, as Wow.exe draws it to the far clip.
test("a moving transport's hull holds the transport range whatever its size or build yaw", async () => {
  const { GAMEOBJECT_TRANSPORT_SHELL_RANGE } = await import("../dist/code/browser/GameObjectTransportAdmission.js");
  assert.equal(GAMEOBJECT_TRANSPORT_SHELL_RANGE, GAMEOBJECT_TRANSPORT_RANGE);
  const model = { groups: [
    { triangleCount: 12, boundsValid: true, exterior: false, indoor: true,
      bounds: { minX: -10, minY: -6, minZ: 0, maxX: 10, maxY: 6, maxZ: 7 } },
    { triangleCount: 12, boundsValid: true, exterior: true, indoor: false,
      bounds: { minX: -38.9, minY: -18.95, minZ: -20, maxX: 38.9, maxY: 18.95, maxZ: 35.8 } },
  ] };
  const boxes = wmoGroupBoxes(model, placement(0, 0, 0, 0));
  const player = { x: 0, y: 600, z: 0 };
  assert.deepEqual(wmoGroupsInRange(model, boxes, player), [], "the near shell leash loses the hull");
  assert.deepEqual(wmoGroupsInRange(model, boxes, player, undefined, GAMEOBJECT_TRANSPORT_SHELL_RANGE), [1]);
  assert.deepEqual(wmoGroupsInRange(model, boxes, { x: 0, y: 800, z: 0 }, undefined, GAMEOBJECT_TRANSPORT_SHELL_RANGE), []);

  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("  #updateGameObjects(");
  const body = source.slice(start, source.indexOf("  #stampGameObjectAdmission(", start));
  assert.match(body, /#updateWmoGroups\(rendered\.wmo, viewer, rendered\.node, client, false,\s*\n?\s*transportShell \? GAMEOBJECT_TRANSPORT_SHELL_RANGE : undefined\)/);
  const groups = source.slice(source.indexOf("  #updateWmoGroups("), source.indexOf("  #wmoRoomsFromOpenAir("));
  // P1-12a: the placement's range table answers with the hull leash (tests/wmo-range-table.test.mjs).
  assert.match(groups, /placed\.ranges\.select\(player\.x, player\.y, shellRange\)/);
  const { WmoRangeTable } = await import("../dist/code/browser/WmoGroupRange.js");
  const table = new WmoRangeTable(model, boxes, 60, wmoShellRange);
  assert.deepEqual(table.select(player.x, player.y), []);
  assert.deepEqual(table.select(player.x, player.y, GAMEOBJECT_TRANSPORT_SHELL_RANGE), [1]);
  assert.deepEqual(table.select(0, 800, GAMEOBJECT_TRANSPORT_SHELL_RANGE), []);
  assert.deepEqual(table.select(player.x, player.y), [], "dropping the hull leash drops the hull");
});
