import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as THREE from "three";
import { FrameBuildBudget } from "../dist/code/browser/FrameBuildBudget.js";
import { hypot2 } from "../dist/code/browser/GroundCover.js";
import { selectGameObjectAdmission } from "../dist/code/browser/RenderAdmission.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
function methods(names, dependencies = {}) {
  const parsed = ts.createSourceFile("renderer.ts", source, ts.ScriptTarget.ES2022, true);
  const renderer = parsed.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === "WorldRenderer3D");
  const members = names.map(name => {
    const member = renderer.members.find(m => m.name?.getText(parsed) === name);
    assert.ok(member, name);
    return member.getText(parsed).replaceAll("#", "");
  });
  const body = ts.transpileModule(`class Harness { ${members.join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // `hypot2` is the renderer's exact, allocation-free `Math.hypot`; every harnessed method may call it.
  const deps = { THREE, hypot2, ...dependencies };
  return Function(...Object.keys(deps), body + "; return Harness;")(...Object.values(deps));
}

function rooms(cost = 3) {
  const Harness = methods(["#updateWmoGroups"], { WMO_GROUP_BUILD_BUDGET: 6 });
  const harness = new Harness();
  let clock = 0;
  Object.assign(harness, {
    submissionSerial: 1, wmoGroupBuildSerial: -1, wmoGroupBuilds: 0,
    wmoGroupBuildBudget: new FrameBuildBudget(6, 2, () => clock),
    wmoGeometryBuild: { retain() {} },
    programWarmup: { unregisterObject() {} },
    // The warm hold (tests/program-warmup-shadow-depth.test.mjs) only hides a room until its
    // programs link; construction and attachment, which this suite measures, are unaffected.
    holdWmoGroupUntilWarm() {},
    wmoGeometries: new Map(),
    wmoGroupCacheKey: (model, index) => `${model.id}:${index}`,
    wmoGroupMesh(model, index) {
      // The real mesh builder takes the material budget after its incremental geometry is ready.
      if (!this.wmoGroupBuildBudget.take()) return undefined;
      clock += cost;
      const entry = {};
      this.wmoGeometries.set(this.wmoGroupCacheKey(model, index), entry);
      return { entry, mesh: new THREE.Object3D() };
    },
  });
  const placement = id => ({
    model: { id, groups: Array.from({ length: 6 }, (_, i) => ({ mesh: {}, exterior: i === 5, indoor: i !== 5 })) },
    rangeGroups: [0, 1, 2, 3, 4, 5], rangePlayer: { x: 0, y: 0, z: 0 }, built: new Map(),
  });
  return { harness, placement, player: { x: 0, y: 0, z: 0 } };
}

test("a costly WMO room stops construction across buildings until the next frame", () => {
  const { harness, placement, player } = rooms();
  const first = placement("first"), second = placement("second");
  const firstNode = new THREE.Group(), secondNode = new THREE.Group();
  harness.updateWmoGroups(first, player, firstNode);
  harness.updateWmoGroups(second, player, secondNode);
  assert.equal(first.built.size + second.built.size, 1);
  assert.ok(first.built.has(5), "the shell wins even when fewer than seven groups need building");
  first.rangeGroups = [];
  harness.updateWmoGroups(first, player, firstNode);
  assert.equal(firstNode.children.length, 0, "hiding remains immediate after the slice is spent");
  harness.submissionSerial++;
  harness.updateWmoGroups(second, player, secondNode);
  assert.equal(second.built.size, 1);
});

test("cheap WMO groups retain the six-build ceiling and eventually attach every room", () => {
  const { harness, placement, player } = rooms(0);
  const a = placement("a"), b = placement("b");
  harness.updateWmoGroups(a, player, new THREE.Group());
  harness.updateWmoGroups(b, player, new THREE.Group());
  assert.equal(a.built.size + b.built.size, 6);
  harness.submissionSerial++;
  harness.updateWmoGroups(b, player, new THREE.Group());
  assert.equal(b.built.size, 6);
});

function gameObjects(cost = 3) {
  const Harness = methods(["#updateGameObjects"], {
    UPDATE_FIELDS, GAMEOBJECT_RANGE: 300, GAMEOBJECT_BUDGET: 96, GAMEOBJECT_FRUSTUM_MARGIN: 1,
    selectGameObjectAdmission, legacyDecodedModelReplaced: () => false,
    fieldFloat: () => 1, clampSize: value => value,
  });
  const harness = new Harness();
  let clock = 0;
  const positions = new Map();
  Object.assign(harness, {
    selection: {}, camera: new THREE.PerspectiveCamera(), frustum: new THREE.Frustum(),
    frustumMatrix: new THREE.Matrix4(), gameObjects: new Map(), gameObjectGroup: new THREE.Group(),
    gameObjectAnimations: new Map(), gameObjectBuildBudget: new FrameBuildBudget(2, 2, () => clock),
    refreshGameObjectAdmissionTrust() {}, gameObjectVisibilityRadius() {},
    buildGameObject(_placement, _object, model, modelName) {
      clock += cost;
      return { actual: !!model, node: new THREE.Group(), model: modelName };
    },
    disposeGameObject(rendered) { rendered.node.removeFromParent(); }, dropEffects() {},
    placeGameObject(_rendered, object, position) { positions.set(object.guid, position.x); },
    stampGameObjectAdmission() {}, gameObjectFadeMeshes: () => [],
    applyGameObjectOpacity() {}, poseGameObject() {},
  });
  const state = { objects: new Map(Array.from({ length: 8 }, (_, i) => {
    const object = { guid: BigInt(i + 1), typeId: 5, fields: new Map(),
      position: { x: i, y: 0, z: 0, orientation: 0 } };
    return [object.guid, object];
  })) };
  const model = {};
  const draw = () => harness.updateGameObjects(state, { x: 0, y: 0, z: 0 },
    { model: () => model }, () => ({ model: "new.m2" }), 0, undefined, 100, 0.016);
  return { harness, state, positions, draw };
}

test("a ready game-object burst is spread across frames instead of built in a single loop", () => {
  const { harness, draw } = gameObjects();
  for (let frame = 1; frame <= 8; frame++) {
    draw();
    assert.equal(harness.gameObjects.size, frame);
  }
});

test("deferred replacements keep moving and retain their original nodes until built", () => {
  const { harness, state, positions, draw } = gameObjects();
  harness.clearWmoGroups = () => assert.fail("a deferred WMO replacement must retain its currently visible rooms");
  const oldNodes = new Map();
  for (const object of state.objects.values()) {
    const node = new THREE.Group();
    oldNodes.set(object.guid, node);
    harness.gameObjectGroup.add(node);
    harness.gameObjects.set(object.guid, { actual: true, node, model: "old.wmo", wmo: { model: {} } });
    object.position.x += 10;
  }
  draw();
  assert.equal([...harness.gameObjects.values()].filter(item => item.model === "new.m2").length, 1);
  for (const object of state.objects.values()) {
    assert.equal(positions.get(object.guid), object.position.x);
    if (object.guid !== 1n) assert.equal(harness.gameObjects.get(object.guid).node, oldNodes.get(object.guid));
  }
});

test("environment construction observes elapsed time and resumes without disposing retained nodes", () => {
  const Harness = methods(["#updateEnvironment"], {
    shouldReselect: () => false, CAMERA_FAST_TURN_RATE: 3, WARM_PRUNE_INTERVAL_FRAMES: 60,
    ENVIRONMENT_BUILD_BUDGET: 16, MODEL_RANGE: 100,
    legacyDecodedModelReplaced: () => false,
    environmentVegetation: () => false,
  });
  const harness = new Harness();
  let clock = 0;
  const objects = Array.from({ length: 20 }, (_, id) => ({ id, name: `prop${id}.m2`, kind: "m2" }));
  const candidates = objects.map(object => ({ object, distance: 1 }));
  Object.assign(harness, {
    environmentObjects: objects, environmentCandidates: candidates, environmentResidents: candidates,
    lastAdmitted: candidates, admissionCandidates: candidates, cameraTurnRate: 0, submissionSerial: 1,
    warmPruneAtSerial: 0, turnSuppressUntilSerial: 0, environment: new Map(),
    environmentGroup: new THREE.Group(), camera: new THREE.PerspectiveCamera(),
    frustum: new THREE.Frustum(), frustumMatrix: new THREE.Matrix4(),
    environmentBuildBudget: new FrameBuildBudget(16, 2, () => clock),
    doodadRig() {}, environmentNode() { clock += 3; return new THREE.Group(); },
    environmentVisibilitySphere() {}, assignEnvironmentInstance() {},
    prefetchEnvironmentModels() {}, updateVegetationGrowth() {}, poseDoodads() {}, updateInstances() {},
    setEnvironmentAdmitted() {},
    disposeEnvironment() { assert.fail("unchanged residents must not be rebuilt"); },
  });
  for (let frame = 1; frame <= 20; frame++) {
    harness.updateEnvironment({ x: 0, y: 0, z: 0 }, objects, undefined, 0.016);
    assert.equal(harness.environment.size, frame);
  }
  const retained = [...harness.environment.values()].map(item => item.node);
  harness.updateEnvironment({ x: 0, y: 0, z: 0 }, objects, undefined, 0.016);
  assert.deepEqual([...harness.environment.values()].map(item => item.node), retained);
});
