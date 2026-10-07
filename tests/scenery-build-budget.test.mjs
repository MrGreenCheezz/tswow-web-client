import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as THREE from "three";
import { FrameBuildBudget } from "../dist/code/browser/FrameBuildBudget.js";
import { hypot2 } from "../dist/code/browser/GroundCover.js";
import { selectGameObjectAdmission } from "../dist/code/browser/RenderAdmission.js";
import { sameWmoSelection } from "../dist/code/browser/WmoGroupRange.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import * as transportAdmission from "../dist/code/browser/GameObjectTransportAdmission.js"; // 06.10-7.24: 05.10-7.05's helpers

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

/** `BuiltModelCache`'s surface the room pass reads: `peek` without touching, `epoch` on set/delete. */
class EpochCache extends Map {
  epoch = 0;
  peeks = 0;
  peek(key) { this.peeks++; return super.get(key); }
  set(key, value) { this.epoch++; return super.set(key, value); }
  delete(key) {
    const had = super.delete(key);
    if (had) this.epoch++;
    return had;
  }
}

function rooms(cost = 3) {
  const Harness = methods(["#updateWmoGroups", "#clearWmoGroups"], { WMO_GROUP_BUILD_BUDGET: 6, sameWmoSelection });
  const harness = new Harness();
  let clock = 0;
  let meshes = 0;
  Object.assign(harness, {
    submissionSerial: 1, wmoGroupBuildSerial: -1, wmoGroupBuilds: 0, wmoGroupsPending: 0,
    wmoGroupBuildBudget: new FrameBuildBudget(6, 2, () => clock),
    wmoGeometryBuild: { retain() {} },
    programWarmup: { unregisterObject() {} },
    // The warm hold (tests/program-warmup-shadow-depth.test.mjs) only hides a room until its
    // programs link; construction and attachment, which this suite measures, are unaffected.
    holdWmoGroupUntilWarm() {},
    wmoGeometries: new EpochCache(),
    wmoGroupCacheKey: (model, index) => `${model.id}:${index}`,
    wmoGroupMesh(model, index) {
      // The real mesh builder takes the material budget after its incremental geometry is ready.
      if (!this.wmoGroupBuildBudget.take()) return undefined;
      clock += cost;
      meshes++;
      const cacheKey = this.wmoGroupCacheKey(model, index);
      const entry = this.wmoGeometries.peek(cacheKey) ?? { cacheKey };
      if (this.wmoGeometries.peek(cacheKey) !== entry) this.wmoGeometries.set(cacheKey, entry);
      return { entry, mesh: new THREE.Object3D() };
    },
  });
  const placement = id => {
    const placed = {
      model: { id, groups: Array.from({ length: 6 }, (_, i) => ({ mesh: {}, exterior: i === 5, indoor: i !== 5 })) },
      // P1-12a: the distance table, answering a test-controlled selection.
      selection: [0, 1, 2, 3, 4, 5],
      built: new Map(),
    };
    placed.ranges = { select: () => placed.selection };
    return placed;
  };
  return { harness, placement, player: { x: 0, y: 0, z: 0 }, meshes: () => meshes };
}

test("a costly WMO room stops construction across buildings until the next frame", () => {
  const { harness, placement, player } = rooms();
  const first = placement("first"), second = placement("second");
  const firstNode = new THREE.Group(), secondNode = new THREE.Group();
  harness.updateWmoGroups(first, player, firstNode);
  harness.updateWmoGroups(second, player, secondNode);
  assert.equal(first.built.size + second.built.size, 1);
  assert.ok(first.built.has(5), "the shell wins even when fewer than seven groups need building");
  first.selection = [];
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

/** One placement with every room attached and the pass settled on it. */
function settledRooms() {
  const fixture = rooms(0);
  const placed = fixture.placement("settled");
  const node = new THREE.Group();
  const frame = () => {
    fixture.harness.submissionSerial++;
    fixture.harness.updateWmoGroups(placed, fixture.player, node);
  };
  frame();
  assert.equal(placed.built.size, 6);
  assert.equal(placed.appliedSettled, true);
  return { ...fixture, placed, node, frame };
}

test("P1-12b: a settled frame builds, peeks and touches nothing", () => {
  const { harness, placed, node, frame, meshes } = settledRooms();
  const before = { meshes: meshes(), peeks: harness.wmoGeometries.peeks, children: [...node.children] };
  let touches = 0;
  const get = harness.wmoGeometries.get.bind(harness.wmoGeometries);
  harness.wmoGeometries.get = (key) => { touches++; return get(key); };
  // A fresh array with the same rooms, as a portal walk would hand out, is the same selection.
  placed.selection = [...placed.selection];
  frame();
  frame();
  assert.equal(meshes(), before.meshes, "no room mesh was asked for");
  assert.equal(harness.wmoGeometries.peeks, before.peeks, "no entry was peeked");
  assert.equal(touches, 0, "no entry was touched");
  assert.deepEqual(node.children, before.children);
  assert.equal(placed.built.size, 6);
});

test("P1-12b: a selection change detaches at once and touches the leaving room", () => {
  const { harness, placed, node, frame } = settledRooms();
  const touched = [];
  const get = harness.wmoGeometries.get.bind(harness.wmoGeometries);
  harness.wmoGeometries.get = (key) => { touched.push(key); return get(key); };
  placed.selection = [0, 1, 2, 3, 5];
  frame();
  assert.equal(placed.built.has(4), false);
  assert.equal(node.children.length, 5);
  assert.deepEqual(touched, ["settled:4"], "only the room that left becomes recent");
  assert.equal(placed.appliedSettled, true);
});

test("P1-12b: a cache epoch change with a replaced entry detaches the room and attaches it anew", () => {
  const { harness, placed, node, frame } = settledRooms();
  const old = placed.built.get(2);
  // Another placement (or an eviction and rebuild) replaced the entry under the same key.
  harness.wmoGeometries.set("settled:2", { cacheKey: "settled:2" });
  frame();
  const now = placed.built.get(2);
  assert.ok(now && now !== old, "the room was rebuilt on the current entry");
  assert.equal(now.entry, harness.wmoGeometries.get("settled:2"));
  assert.equal(node.children.includes(old.mesh), false);
  assert.equal(node.children.includes(now.mesh), true);
  assert.equal(node.children.length, 6);
});

test("P1-12b: after clearWmoGroups the next frame attaches every room again", () => {
  const { harness, placed, node, frame, meshes } = settledRooms();
  harness.clearWmoGroups(placed, node);
  assert.equal(node.children.length, 0);
  assert.equal(placed.appliedSettled, false);
  const before = meshes();
  frame();
  assert.equal(meshes() - before, 6);
  assert.equal(placed.built.size, 6);
  assert.equal(node.children.length, 6);
});

test("P1-12b: a frame that could not build every wanted room is not settled", () => {
  const fixture = rooms(3);
  const placed = fixture.placement("slow");
  const node = new THREE.Group();
  fixture.harness.updateWmoGroups(placed, fixture.player, node);
  assert.ok(placed.built.size < 6);
  assert.equal(placed.appliedSettled, false);
  for (let frame = 0; frame < 6 && placed.built.size < 6; frame++) {
    fixture.harness.submissionSerial++;
    fixture.harness.updateWmoGroups(placed, fixture.player, node);
  }
  assert.equal(placed.built.size, 6, "the remaining rooms attach on later frames");
  assert.equal(placed.appliedSettled, true);
});

function gameObjects(cost = 3) {
  const Harness = methods(["#updateGameObjects"], {
    UPDATE_FIELDS, GAMEOBJECT_RANGE: 300, GAMEOBJECT_BUDGET: 96, GAMEOBJECT_FRUSTUM_MARGIN: 1,
    selectGameObjectAdmission, legacyDecodedModelReplaced: () => false,
    fieldFloat: () => 1, clampSize: value => value,
    // 06.10-7.24: the build placement turns by the node yaw; 05.10-7.05 asks about moving transports.
    gameObjectNodeYaw: (orientation) => orientation + Math.PI, gameObjectWireIsMovingTransport: () => false,
    ...transportAdmission,
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
    // 05.10 suite-fix 2: the 7.18 stand-in ledger (05.10-A7b-9) — a model-less build is a stand-in.
    environmentFarEligible: () => false, drawableModel: model => model !== undefined, standInKind: () => "none",
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
    environmentStandIns: { begin() {} }, environmentStandInMarkers: { beginFrame() {}, endFrame() {} },
    noteEnvironmentStandIn() {},
    disposeEnvironment() { assert.fail("unchanged residents must not be rebuilt"); },
  });
  for (let frame = 1; frame <= 20; frame++) {
    harness.updateEnvironment({ x: 0, y: 0, z: 0 }, objects, undefined, 0.016);
    assert.equal(harness.environment.size, frame);
  }
  const retained = [...harness.environment.values()].map(item => item.node);
  harness.updateEnvironment({ x: 0, y: 0, z: 0 }, objects, undefined, 0.016);
  // 05.10 suite-fix 2: identities compared as primitives — a three.js node never reaches assert.
  const after = [...harness.environment.values()].map(item => item.node);
  assert.equal(after.length, retained.length);
  assert.equal(after.filter((node, index) => node !== retained[index]).length, 0, "every retained node is kept");
});
