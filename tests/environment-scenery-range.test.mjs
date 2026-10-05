import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  ENVIRONMENT_DETAIL_MAX,
  ENVIRONMENT_DETAIL_MIN,
  ENVIRONMENT_FAR_RANGE,
  ENVIRONMENT_RANGE,
  ENVIRONMENT_SCENERY_BUDGET,
  ENVIRONMENT_SCENERY_MAX_RANGE,
  ENVIRONMENT_SCENERY_MIN_RANGE,
  ENVIRONMENT_SCENERY_RANGE_PER_YARD,
  ENVIRONMENT_VEGETATION_RANGE,
  environmentCandidatesInRange,
  environmentDetailScale,
  environmentDrawRange,
  environmentObjectVisibleInFrustum,
  environmentResidentsInRange,
  environmentSceneryRange,
  environmentSourceVisibilitySphere,
  selectEnvironmentAdmission,
} from "../dist/code/browser/WorldRenderer3D.js";
import { createCamera } from "../dist/code/browser/SimpleScene.js";
import { ENVIRONMENT_RESIDENT_HYSTERESIS, ENVIRONMENT_STREAM_RANGE, terrainGrid } from "../dist/code/browser/Terrain.js";
import { SETTING_DEFINITIONS } from "../dist/code/browser/ui/SettingsModel.js";

function m2(id, x, y, radius, options = {}) {
  return {
    id, kind: "m2", name: options.name ?? `World\\Doodads\\${id}.m2`, x, y, z: options.z ?? 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: options.scale ?? 1,
    ...(radius === undefined ? {} : { admissionRadius: radius }),
    ...(options.interior ? { interior: true } : {}),
  };
}

const ids = (entries) => entries.map(({ object }) => object.id);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} != ${expected}`);

test("an M2's leash scales with its own size between a floor and the vegetation leash", () => {
  assert.equal(ENVIRONMENT_SCENERY_RANGE_PER_YARD, 50);
  assert.equal(ENVIRONMENT_SCENERY_MIN_RANGE, 90);
  assert.equal(ENVIRONMENT_SCENERY_MAX_RANGE, ENVIRONMENT_VEGETATION_RANGE);
  // Elwynn's own radii: canopy tree, mid tree, pine, bush, fence, post, pebble.
  assert.equal(environmentSceneryRange(m2("canopy", 0, 0, 60.1)), 600);
  near(environmentSceneryRange(m2("mid", 0, 0, 11.9)), 595);
  near(environmentSceneryRange(m2("pine", 0, 0, 9.2)), 460);
  near(environmentSceneryRange(m2("bush", 0, 0, 5.1)), 255);
  near(environmentSceneryRange(m2("post", 0, 0, 1.9)), 95);
  assert.equal(environmentSceneryRange(m2("pebble", 0, 0, 0.3, { scale: 2 })), 90);
  near(environmentSceneryRange(m2("scaled", 0, 0, 5.1, { scale: 0.5 })), 127.5,
    "the placement scale is part of the size");
  // Detail: the stock 0.5–1.5 multiplier, capped by the streaming footprint's far leash.
  assert.equal(environmentSceneryRange(m2("canopy", 0, 0, 60.1), 1.5), ENVIRONMENT_FAR_RANGE);
  near(environmentSceneryRange(m2("bush", 0, 0, 5.1), 1.5), 382.5);
  assert.equal(environmentSceneryRange(m2("canopy", 0, 0, 60.1), 0.5), 300);
  assert.equal(environmentSceneryRange(m2("pebble", 0, 0, 0.3), 0.5), 45);
  assert.equal(environmentSceneryRange(m2("bush", 0, 0, 5.1), 99), environmentSceneryRange(m2("bush", 0, 0, 5.1), 1.5));
  near(environmentSceneryRange(m2("bush", 0, 0, 5.1), Number.NaN), 255, "junk detail reads as 1");
  // No trustworthy size: the legacy path decides.
  assert.equal(environmentSceneryRange(m2("rigged", 0, 0, undefined)), undefined);
  assert.equal(environmentSceneryRange(m2("negative", 0, 0, -1)), undefined);
  assert.equal(environmentSceneryRange(m2("zero-scale", 0, 0, 4, { scale: 0 })), undefined);
  assert.equal(environmentSceneryRange(m2("room", 0, 0, 4, { interior: true })), undefined);
  assert.equal(environmentSceneryRange({ ...m2("shell", 0, 0, 4), kind: "wmo" }), undefined);
  assert.equal(ENVIRONMENT_FAR_RANGE + ENVIRONMENT_RESIDENT_HYSTERESIS <= ENVIRONMENT_STREAM_RANGE, true,
    "the longest scenery leash plus its resident band stays inside the streamed footprint");
});

test("unsized placements keep the legacy leashes; detail scales M2s only", () => {
  assert.equal(environmentDetailScale(0.1), ENVIRONMENT_DETAIL_MIN);
  assert.equal(environmentDetailScale(7), ENVIRONMENT_DETAIL_MAX);
  assert.equal(environmentDrawRange(m2("lamp", 0, 0, undefined)), ENVIRONMENT_RANGE);
  assert.equal(environmentDrawRange(m2("tree", 0, 0, undefined, { name: "World\\Trees\\Oak01.m2" })),
    ENVIRONMENT_VEGETATION_RANGE);
  assert.equal(environmentDrawRange(m2("lamp", 0, 0, undefined), 1.5), 600);
  assert.equal(environmentDrawRange(m2("tree", 0, 0, undefined, { name: "World\\Trees\\Oak01.m2" }), 1.5),
    ENVIRONMENT_FAR_RANGE);
  assert.equal(environmentDrawRange(m2("room", 0, 0, 4, { interior: true }), 1.5), 60);
  const hut = { ...m2("hut", 0, 0, undefined), kind: "wmo", bounds: { minX: -5, minY: -5, minZ: 0, maxX: 5, maxY: 5, maxZ: 4 } };
  assert.equal(environmentDrawRange(hut, 1.5), ENVIRONMENT_RANGE, "buildings are not scenery doodads");
});

// 05.10-A7b-0 1.23: a street lamp is named after no tree, so it keeps the 400-yard leash.
test("1.23 an unsized street lamp or dragon spine is not vegetation: legacy 400, not 600", () => {
  const lamp = m2("lamp", 0, 0, undefined, { name: "WORLD\\GENERIC\\HUMAN\\PASSIVE DOODADS\\LAMPS\\STORMWINDSTREETLAMP01.M2" });
  assert.equal(environmentDrawRange(lamp), ENVIRONMENT_RANGE);
  const spine = m2("spine", 0, 0, undefined, { name: "WORLD\\EXPANSION02\\DOODADS\\DRAGONBLIGHT\\DB_DRAGONSPINE02BLUE.M2" });
  assert.equal(environmentDrawRange(spine), ENVIRONMENT_RANGE);
});

// 05.10-A7b-0 7.22: 320/48 are the WMO budgets, not M2 slots (M2s have the 1 024 scenery budget).
test("7.22 the visual-tile generator no longer says M2s consume the 320 exterior slots", () => {
  const source = readFileSync(new URL("../tools/generate-visual-tile.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("320 exterior slots"));
});

test("candidates and residents follow each placement's own leash, horizontally", () => {
  const player = { x: 0, y: 0 };
  const objects = [
    m2("pebble-in", 89, 0, 0.3), m2("pebble-out", 91, 0, 0.3),
    m2("bush-in", 250, 0, 5.1), m2("bush-out", 260, 0, 5.1),
    m2("canopy-in", 0, 599, 60.1), m2("canopy-out", 0, 601, 60.1),
    // Three hundred yards below the flying player is still zero yards away on the ground.
    m2("under", 0, 0, 11.9, { z: -300 }),
  ];
  assert.deepEqual(ids(environmentCandidatesInRange(objects, player)).sort(),
    ["bush-in", "canopy-in", "pebble-in", "under"]);
  assert.deepEqual(ids(environmentCandidatesInRange(objects, player, 1.5)).sort(),
    ["bush-in", "bush-out", "canopy-in", "canopy-out", "pebble-in", "pebble-out", "under"]);
  const residents = environmentResidentsInRange(objects, player);
  assert.equal(residents.find(({ object }) => object.id === "canopy-out")?.range, 600,
    "residents carry the leash the prefetch band is measured from");
  assert.ok(ids(residents).includes("pebble-out"), "the resident band sits past each object's own leash");
});

test("a dense clutter field can no longer spend the trees' draw slots", () => {
  const player = { x: 0, y: 0 };
  // The old failure: 320 nearest visible placements, all clutter, and every tree past them lost.
  const clutter = Array.from({ length: 900 }, (_, index) => m2(`clutter-${index}`, 20 + (index % 60), 0, 3.9));
  const trees = Array.from({ length: 60 }, (_, index) => m2(`tree-${index}`, 300 + index * 4, 0, 60.1));
  const admitted = ids(selectEnvironmentAdmission(environmentCandidatesInRange([...clutter, ...trees], player), []));
  assert.equal(admitted.filter((id) => id.startsWith("tree-")).length, 60);
  assert.equal(admitted.filter((id) => id.startsWith("clutter-")).length, 900);
});

test("an overloaded scenery quota sheds the farthest for their size first", () => {
  const player = { x: 0, y: 0 };
  // Pebbles at 80 of their 90 yards (0.89 of the leash) against canopy trees at 400 of 600 (0.67).
  const pebbles = Array.from({ length: ENVIRONMENT_SCENERY_BUDGET + 10 }, (_, index) => m2(`pebble-${index}`, 80, 0, 0.3));
  const canopies = Array.from({ length: 5 }, (_, index) => m2(`canopy-${index}`, 400, 0, 60.1));
  const admitted = selectEnvironmentAdmission(environmentCandidatesInRange([...pebbles, ...canopies], player), []);
  assert.equal(admitted.length, ENVIRONMENT_SCENERY_BUDGET);
  assert.deepEqual(ids(admitted.slice(0, 5)), canopies.map(({ id }) => id), "big trees rank first");
  // Fifteen over the quota: the shed pebbles are the last fifteen in stable source order.
  assert.equal(ids(admitted).includes(`pebble-${ENVIRONMENT_SCENERY_BUDGET - 5}`), false);
  assert.equal(ids(admitted).includes(`pebble-${ENVIRONMENT_SCENERY_BUDGET - 6}`), true);
});

function viewPlanes(player, pitch, distance) {
  const camera = createCamera(player, 0, pitch, distance, { pivotHeight: 1.6 });
  const three = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 4000);
  three.position.set(camera.position.x, camera.position.z, -camera.position.y);
  three.lookAt(camera.position.x + camera.forward.x, camera.position.z + camera.forward.z,
    -(camera.position.y + camera.forward.y));
  three.updateMatrixWorld();
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(three.projectionMatrix, three.matrixWorldInverse)).planes;
}

test("a camera flying 100 yards up admits every visible tree inside its leash", () => {
  const player = { x: 0, y: 0, z: 100, orientation: 0 };
  const trees = [];
  for (let x = -600; x <= 600; x += 25) {
    for (let y = -600; y <= 600; y += 25) trees.push(m2(`t${x}/${y}`, x, y, 11.9, { name: "World\Trees\ElwynnTreeMid01.m2" }));
  }
  for (const pitch of [-0.6, -1.3]) {
    const planes = viewPlanes(player, pitch, 35);
    const visibleInLeash = trees.filter((tree) => Math.hypot(tree.x, tree.y) < 595
      && environmentObjectVisibleInFrustum(tree, planes, 8, environmentSourceVisibilitySphere(tree)));
    const admitted = selectEnvironmentAdmission(environmentCandidatesInRange(trees, player), planes);
    assert.deepEqual(ids(admitted).sort(), visibleInLeash.map(({ id }) => id).sort(), `pitch ${pitch}`);
    if (pitch === -0.6) {
      assert.ok(visibleInLeash.length > 320, `the old quota would have cut this view (${visibleInLeash.length} trees)`);
    } else {
      assert.ok(admitted.some(({ object }) => Math.hypot(object.x, object.y) === 0),
        "looking down, the tree directly below the player stays drawn");
    }
  }
});

const forestTiles = (() => {
  const grid = terrainGrid(-9650, -350);
  const files = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) files.push(new URL(`../data/visual-tiles/0/${grid.x + dx}-${grid.y + dy}.json`, import.meta.url));
  }
  return files;
})();
const withForest = { skip: forestTiles.every((file) => existsSync(file)) ? false : "Elwynn visual tiles are not prepared" };

test("over the real Elwynn forest the canopy is drawn to its leash from the air", withForest, () => {
  const seen = new Set();
  const objects = [];
  for (const file of forestTiles) {
    for (const object of JSON.parse(readFileSync(file, "utf8"))) {
      if (!seen.has(object.id)) { seen.add(object.id); objects.push(object); }
    }
  }
  const player = { x: -9650, y: -350, z: 160, orientation: 4.5 };
  const planes = viewPlanes(player, -0.6, 35);
  const admitted = selectEnvironmentAdmission(environmentCandidatesInRange(objects, player), planes);
  const admittedIds = new Set(admitted.map(({ object }) => object.id));
  const bigInView = objects.filter((object) => object.kind === "m2" && object.interior !== true
    && object.admissionRadius * object.scale >= 12
    && Math.hypot(object.x - player.x, object.y - player.y) < 590
    && environmentObjectVisibleInFrustum(object, planes, 8, environmentSourceVisibilitySphere(object)));
  assert.ok(bigInView.length > 150, `a real forest view (${bigInView.length} big trees)`);
  assert.deepEqual(bigInView.filter((object) => !admittedIds.has(object.id)).map(({ id }) => id), [],
    "no big tree inside its leash is left out of the view");
  const scenery = admitted.filter(({ object }) => object.kind === "m2" && object.interior !== true);
  assert.ok(scenery.length < ENVIRONMENT_SCENERY_BUDGET, `the quota is a safety net (${scenery.length})`);
});

test("«Дальность прорисовки объектов» is the stock environmentDetail slider in percent, pushed to the renderer", async () => {
  const definition = SETTING_DEFINITIONS.find(({ id }) => id === "objectDistance");
  assert.deepEqual([definition?.group, definition?.fallback, definition?.min, definition?.max, definition?.step],
    ["Графика", 100, ENVIRONMENT_DETAIL_MIN * 100, ENVIRONMENT_DETAIL_MAX * 100, 25]);
  const settings = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  assert.match(settings, /setEnvironmentDetail\?\.\(settingNumber\(values, "objectDistance"\) \/ 100\)/);
  const world = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(world, /environmentCandidatesInRange\(pool, player, this\.#environmentDetail\)/,
    "the candidate pass reads the applied detail");
  assert.match(world, /setEnvironmentDetail\(detail: number\): void \{[\s\S]{0,200}this\.#environmentCandidatesAt = undefined;/,
    "a changed detail reselects on the next frame");
});
