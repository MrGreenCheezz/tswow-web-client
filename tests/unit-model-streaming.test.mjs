import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as THREE from "three";
import { FrameBuildBudget } from "../dist/code/browser/FrameBuildBudget.js";
import { hypot2 } from "../dist/code/browser/GroundCover.js";
import { selectUnitAdmission } from "../dist/code/browser/RenderAdmission.js";

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
function bodyHarness(budget = new FrameBuildBudget(2, 2, () => 0)) {
  const Harness = methods(["#attachSkinnedModel", "#updateMount"], {
    characterSlots: () => new Map(), worldCharacterGeosets: () => new Set([0]),
    TEXTURE_TYPE_BODY: 1, M2_TO_SCENE: new THREE.Quaternion(),
    modelKey: (model, textures) => model,
    mountInstanceMatches: (current, wanted) => current === wanted,
  });
  const harness = new Harness();
  Object.assign(harness, {
    unitBuildBudget: budget, skinnedTemplates: new Map(), builtUnits: {},
    legacySkinnedFailures: new WeakSet(), atlasFrameDemands: new Set(),
    builtCacheKey: (_cache, key) => key,
    programWarmup: { registerObject() {} },
    builds: 0, mounts: 0, seats: 0, drops: 0,
    buildRigged() {
      this.builds++;
      return { built: { geometry: new THREE.BufferGeometry(), materials: [], height: 2 } };
    },
    clearUnitNode(unit) { unit.node.clear(); },
    attachMount(unit, metadata) { this.mounts++; unit.mount = { metadata }; },
    seatRider() { this.seats++; }, dropMount(unit) { this.drops++; delete unit.mount; },
  });
  return harness;
}
const metadata = { model: "test.m2", textures: [], scale: 1 };
const model = { wvm: { textures: [] } };
const unit = () => ({ node: new THREE.Group(), applied: "previous" });

test("simultaneously ready bodies share a two-build frame slice, retaining deferred bodies", () => {
  const harness = bodyHarness();
  const crowd = Array.from({ length: 64 }, unit);
  let frames = 0;
  while (crowd.some(u => u.applied !== "ready")) {
    harness.unitBuildBudget.begin();
    const before = harness.builds;
    for (const u of crowd) {
      if (u.applied === "ready") continue;
      const reason = harness.attachSkinnedModel(u, metadata, "ready", model);
      if (reason === "queued") assert.equal(u.applied, "previous");
      else assert.equal(reason, undefined);
    }
    assert.equal(harness.builds - before, 2);
    frames++;
    assert.ok(frames <= 32);
  }
  assert.equal(frames, 32);
});

test("waiting assets, atlases and cached template failures do not starve ready neighbours", () => {
  const harness = bodyHarness();
  harness.skinnedTemplates.set("invalid", null);
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "missing", undefined), "artifact");
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "invalid", model), "template");
  const invalidLegacy = {};
  harness.legacySkinnedFailures.add(invalidLegacy);
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "invalid-legacy", invalidLegacy), "template");
  harness.atlases = { get() {}, compose() {} };
  assert.equal(harness.attachSkinnedModel(unit(), { ...metadata, appearance: { body: [{}] } },
    "atlas", { wvm: { textures: [{ type: 1 }] } }), "atlas");
  assert.ok(harness.atlasFrameDemands.has("atlas"));
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "one", model), undefined);
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "two", model), undefined);
  assert.equal(harness.builds, 2);
});

test("a slow build ends this frame's slice, with progress restored next frame", () => {
  let now = 100;
  const budget = new FrameBuildBudget(2, 2, () => now);
  const harness = bodyHarness(budget);
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "one", model), undefined);
  now += 3;
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "two", model), "queued");
  budget.begin();
  assert.equal(harness.attachSkinnedModel(unit(), metadata, "two", model), undefined);
});

test("mounts share the body budget and keep seating the existing mount while replacement waits", () => {
  const harness = bodyHarness();
  harness.attachSkinnedModel(unit(), metadata, "one", model);
  harness.attachSkinnedModel(unit(), metadata, "two", model);
  const rider = { mount: { metadata: { ...metadata, model: "old.m2" } } };
  const old = rider.mount;
  const client = { model: () => model };
  harness.updateMount(rider, metadata, client);
  assert.equal(harness.mounts, 0);
  assert.equal(rider.mount, old);
  assert.equal(harness.seats, 1);
  harness.unitBuildBudget.begin();
  harness.updateMount(rider, metadata, client);
  assert.equal(harness.mounts, 1);
  harness.updateMount(rider, undefined, client);
  assert.equal(rider.mount, undefined);
});

test("renderer continues updating all admitted units and removes objects that left server visibility", () => {
  const Harness = methods(["#updateUnits"], {
    selectUnitAdmission, UNIT_DRAW_DISTANCE: 200, UNIT_BUDGET: 64, UNIT_FRUSTUM_MARGIN: 1,
    unitSphereVisibleInFrustum: () => true, unitCastsEnhancedShadow: () => false,
  });
  const h = new Harness();
  const camera = new THREE.PerspectiveCamera();
  Object.assign(h, {
    unitAnimationBudget: new FrameBuildBudget(), unitAnimationPrefetch: new Map(),
    standIns: { begin() {} }, unitBuildBudget: new FrameBuildBudget(2, 2, () => 0),
    atlasFrameDemands: new Set(), atlasFrameActive: new Set(), frustumMatrix: new THREE.Matrix4(),
    camera, frustum: new THREE.Frustum(), selection: {}, formalBenchmarkIsolation: true,
    units: new Map(), actions: new Map(), unitGroup: new THREE.Group(), draws: [],
    unitVisibilityRadius: () => undefined, clearUnitNode() {}, dropEffects() {},
    drawUnit(object) {
      this.draws.push(object.guid);
      if (!this.units.has(object.guid)) this.units.set(object.guid, {
        node: new THREE.Group(), material: new THREE.MeshBasicMaterial(),
      });
    },
  });
  const objects = new Map(Array.from({ length: 12 }, (_, i) => [BigInt(i), {
    guid: BigInt(i), typeId: 3, position: { x: i, y: 0, z: 0 },
  }]));
  const state = { objects, selfGuid: 11n };
  const draw = () => h.updateUnits(state, { x: 11, y: 0, z: 0 }, 1, 1 / 60);
  draw();
  assert.equal(h.draws.length, 12);
  assert.equal(h.draws[0], 11n, "self receives first build opportunity");
  objects.delete(0n);
  h.draws.length = 0;
  draw();
  assert.equal(h.draws.length, 11);
  assert.equal(h.units.has(0n), false);
});

test("equipment requests continue but ready attachment builds share the body and mount slice", () => {
  const bone = new THREE.Group();
  const Harness = methods(["#updateAttachments"], {
    UPDATE_FIELDS: { UNIT_FIELD_BYTES_2: { offset: 10 } },
    attachmentPoint: item => item.point, boneOf: () => bone,
    attachmentOffset: () => new THREE.Vector3(), attachmentRotation: () => undefined,
    TEXTURE_TYPE_OBJECT_SKIN: 11, EVERY_GEOSET: "all",
  });
  const h = new Harness();
  let builds = 0, requests = 0;
  Object.assign(h, {
    unitBuildBudget: new FrameBuildBudget(2, 2, () => 0), builtUnits: {},
    programWarmup: { registerObject() {} }, disposeAttachedGlow() {},
    wvmBuild() { builds++; return { geometry: new THREE.BufferGeometry(), materials: [] }; },
  });
  const rendered = { attached: new Map(), skinned: {}, template: { pivots: [] } };
  const items = [1, 2, 3].map(slot => ({ slot, side: 0, point: slot, model: `${slot}.m2`, texture: "" }));
  const appearance = { ...metadata, appearance: { attached: items } };
  const object = { fields: new Map() };
  const client = { model() { requests++; return model; } };
  const decoded = { wvm: { attachments: [1] } };
  h.unitBuildBudget.take(); // This frame already built the body.
  h.updateAttachments(rendered, appearance, object, client, decoded);
  assert.equal(builds, 1);
  assert.equal(requests, 3, "all resource requests continue despite construction budget");
  h.unitBuildBudget.begin();
  h.updateAttachments(rendered, appearance, object, client, decoded);
  assert.equal(builds, 3);
  assert.equal(rendered.attached.size, 3);
  h.updateAttachments(rendered, { ...metadata, appearance: { attached: [] } }, object, client, decoded);
  assert.equal(rendered.attached.size, 0, "obsolete equipment is removed even with an exhausted budget");
});

test("sidecar prefetch requests are cheap and critical poses get the frame slice before background work", () => {
  const merged = [];
  const Harness = methods(["#prefetchSidecarAnimations", "#requestAnimations"], {
    needsSidecarAnimations: (template, wanted) => !template.merged && !template.clips.has(wanted[0]),
    mergeSkinnedClips(template, clips, options) {
      merged.push(options.wanted ?? "background");
      return { added: 1, complete: false };
    },
  });
  const h = new Harness();
  h.unitAnimationBudget = new FrameBuildBudget(2, 1, () => 0);
  const template = { parents: [0], animations: new Set([1, 2, 3]), clips: new Map() };
  let requests = 0;
  const client = { animations() { requests++; return []; } };
  h.prefetchSidecarAnimations(template, "model.m2", client, true);
  assert.equal(requests, 1);
  assert.equal(merged.length, 0, "building the body only requests the sidecar");
  h.requestAnimations(template, [3], client, metadata);
  h.prefetchSidecarAnimations(template, "model.m2", client);
  h.prefetchSidecarAnimations(template, "other.m2", client);
  assert.deepEqual(merged, [[3], "background"]);
  assert.equal(template.merged, false, "a partial slice must not mark the sidecar complete");
  assert.equal(requests, 4, "exhausting CPU budget does not block the download");
  h.unitAnimationBudget.begin();
  h.prefetchSidecarAnimations(template, "model.m2", client);
  assert.equal(merged.length, 3);
});

// The single action slot (`#playAction` over a Map<guid, record>) was replaced by per-unit
// `UnitActionQueue`s settled in `#settleUnitAction`/`#entryAnimation`. These four keep the same
// asset-wait guarantees on the new methods: the harness is the same source extraction.
async function actionHarness() {
  const { pendingActionExpired, pendingActionFate } = await import("../dist/code/browser/AnimatedModel.js");
  const arbiter = await import("../dist/code/browser/UnitActionArbiter.js");
  const resolve = (clips, wanted) => wanted.find(id => clips.has(id));
  const Harness = methods(["#settleUnitAction", "#advanceLeadIn", "#entryAnimation", "#releaseUnitAction",
    "#requestAnimations"], {
    pendingActionExpired, pendingActionFate,
    unitActionDisplay: arbiter.unitActionDisplay, unitActionEndsOnMovement: arbiter.unitActionEndsOnMovement,
    animationPlaysOnUpperBody: () => true, ANIMATION_IDS: { Stand: 0 }, poseAnimation: () => ({ wanted: [0] }),
    ACTION_CLIP_WAIT: 900, ACTION_SIDECAR_WAIT: 3000,
    isUnitMoving: () => false, isTerminalUnitPose: pose => pose.dead === true,
    weaponPose: () => "unarmed", actionAnimation: () => [7],
    resolveSpellVisualAnimation: resolve, resolveActionAnimation: clips => resolve(clips, [7]),
    spellVisualAnimationCandidates: wanted => wanted,
    needsSidecarAnimations: template => !template.merged && !template.clips.has(7),
    mergeSkinnedClips(template) {
      template.clips.set(7, {});
      return { added: 1, complete: true };
    },
  });
  const h = new Harness();
  Object.assign(h, {
    unitAnimationBudget: new FrameBuildBudget(2, 1, () => 0),
    played: [],
    startUnitAction(_unit, _queue, entry, animation) {
      entry.started = true;
      this.played.push(animation);
    },
    clearOverlay() {},
  });
  const rendered = { template: { parents: [0], clips: new Map(), animations: new Set([7]) } };
  const queue = (held = false, overrides = {}) => {
    const actions = new arbiter.UnitActionQueue();
    actions.submit({
      layer: "emote", held, until: held ? 5000 : 4000,
      payload: {
        wanted: [7], action: undefined, stage: "main", sequenceAt: 0,
        waitUntil: 900, sidecarWaitUntil: 3000, source: "external", ...overrides,
      },
    }, 0);
    return actions;
  };
  const client = { animations: () => [], animationsInFlight: () => false };
  const exhaust = () => { h.unitAnimationBudget.take(); h.unitAnimationBudget.take(); };
  return { h, rendered, queue, client, exhaust };
}

test("an emote with a resident sidecar survives CPU queuing past 900ms and plays once compiled", async () => {
  const { h, rendered, queue, client, exhaust } = await actionHarness();
  const actions = queue();
  exhaust();
  assert.equal(h.settleUnitAction(rendered, actions, {}, 1100, client, metadata), undefined);
  assert.equal(actions.size, 1);
  h.unitAnimationBudget.begin();
  assert.equal(h.settleUnitAction(rendered, actions, {}, 1133, client, metadata), "full");
  assert.deepEqual(h.played, [7]);
});

test("queued animation compilation retains the outer action deadline and strict stale-shot guard", async () => {
  const { h, rendered, queue, client, exhaust } = await actionHarness();
  exhaust();
  const late = queue();
  assert.equal(h.settleUnitAction(rendered, late, {}, 3000, client, metadata), undefined);
  assert.equal(late.size, 0);
  const shot = queue(false, { action: "shoot", waitUntil: 1500 });
  assert.equal(h.settleUnitAction(rendered, shot, {}, 1500, client, metadata), undefined);
  assert.equal(shot.size, 0);
  const corpse = queue();
  assert.equal(h.settleUnitAction(rendered, corpse, { dead: true }, 1100, client, metadata), undefined);
  assert.equal(corpse.size, 0);
  assert.deepEqual(h.played, []);
});

test("a queued emote cannot resurrect when CPU budget or its clip becomes ready at the deadline", async () => {
  for (const externallyReady of [false, true]) {
    const { h, rendered, queue, client, exhaust } = await actionHarness();
    const actions = queue();
    exhaust();
    assert.equal(h.settleUnitAction(rendered, actions, {}, 1100, client, metadata), undefined);
    assert.equal(actions.size, 1);
    h.unitAnimationBudget.begin();
    if (externallyReady) rendered.template.clips.set(7, {});
    assert.equal(h.settleUnitAction(rendered, actions, {}, 3000, client, metadata), undefined);
    assert.equal(actions.size, 0);
    assert.deepEqual(h.played, []);
  }
});

test("a held action that started in time outlives the asset wait while its hold remains active", async () => {
  const { h, rendered, queue, client } = await actionHarness();
  const actions = queue(true);
  assert.equal(h.settleUnitAction(rendered, actions, {}, 500, client, metadata), "full");
  assert.equal(actions.entries[0].payload.waitingForClip, undefined);
  assert.equal(h.settleUnitAction(rendered, actions, {}, 3500, client, metadata), "full");
  assert.equal(actions.size, 1);
  assert.equal(h.settleUnitAction(rendered, actions, {}, 5000, client, metadata), undefined);
  assert.equal(actions.size, 0);
});
