import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { SimpleScene, createCamera, gameObjectLabel, gameObjectType, healthRatio, projectPoint } from "../dist/code/browser/SimpleScene.js";

test("scene projection centers points on the camera axis and rejects points behind it", () => {
  const camera = createCamera({ x: 0, y: 0, z: 0, orientation: 0 });
  const center = projectPoint({ x: 10, y: 0, z: 0 }, camera, 800, 450);
  assert.ok(center);
  assert.ok(Math.abs(center.x - 400) < 0.001);
  assert.equal(projectPoint({ x: -50, y: 0, z: 13 }, camera, 800, 450), undefined);
  const rotated = createCamera({ x: 0, y: 0, z: 0, orientation: 0 }, Math.PI / 2);
  const rotatedCenter = projectPoint({ x: 0, y: 10, z: 0 }, rotated, 800, 450);
  assert.ok(rotatedCenter);
  assert.ok(Math.abs(rotatedCenter.x - 400) < 0.001);
  assert.equal(projectPoint({ x: 0, y: -50, z: 13 }, rotated, 800, 450), undefined);
});

test("scene healthbars clamp server health to a visible ratio", () => {
  const object = { fields: new Map() };
  object.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 125);
  object.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100);
  assert.equal(healthRatio(object), 1);
  object.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, -1);
  assert.equal(healthRatio(object), 0);
});

test("scene draws terrain, unit avatars and gameobjects through Canvas 2D", () => {
  let fills = 0;
  let arcs = 0;
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    fill: () => fills++,
    arc: () => arcs++,
    measureText: (text) => ({ width: text.length * 6 }),
  }, { get: (target, property) => target[property] ?? (() => {}) });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 800, height: 450 }),
  };
  const unit = (guid, typeId, x, health, displayId) => ({
    guid,
    typeId,
    position: { x, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
      [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100],
      [UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId],
    ]),
  });
  const player = unit(1n, 4, 0, 100, 49);
  const creature = unit(2n, 3, 15, 70, 19723);
  const gameobject = {
    guid: 3n,
    typeId: 5,
    position: { x: 20, y: 2, z: 0, orientation: 0 },
    fields: new Map([
      [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, 321],
      [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 3 << 8],
    ]),
  };
  const environment = [{
    id: 10,
    kind: "wmo",
    name: "ExampleHouse.wmo",
    x: 25,
    y: -4,
    z: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scale: 1,
    bounds: { minX: 22, minY: -7, minZ: 0, maxX: 28, maxY: -1, maxZ: 6 },
  }];

  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    new SimpleScene(canvas).draw({ selfGuid: 1n, objects: new Map([[1n, player], [2n, creature], [3n, gameobject]]) }, () => 0, 2n, environment);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.ok(fills > 100);
  assert.ok(arcs >= 4);
  assert.equal(gameObjectType(gameobject), 3);
  assert.equal(gameObjectLabel(gameobject), "Сундук");
});
