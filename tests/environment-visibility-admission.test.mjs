import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  ENVIRONMENT_WARM_EXTERIOR_BUDGET,
  ENVIRONMENT_WARM_INTERIOR_BUDGET,
  environmentCandidatesInRange,
  environmentObjectVisibleInFrustum,
  placementDistance,
  selectEnvironment,
  selectEnvironmentAdmission,
} from "../dist/code/browser/WorldRenderer3D.js";

const WORLD_SOURCE = new URL("../src/browser/WorldRenderer3D.ts", import.meta.url);

function bounds(minX, minY, minZ, maxX, maxY, maxZ) {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function placement(id, x, y, options = {}) {
  return {
    id,
    kind: options.kind ?? "m2",
    name: options.name ?? `World\\Environment\\${id}.m2`,
    x,
    y,
    z: options.z ?? 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scale: 1,
    ...(options.interior === undefined ? {} : { interior: options.interior }),
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    ...options.extra,
  };
}

function plane(normal, constant) {
  return new THREE.Plane(new THREE.Vector3(...normal), constant);
}

/** Six planes for a scene-space axis-aligned box. Plane distances are non-negative inside. */
function sceneBoxPlanes(center, radius) {
  return [
    plane([1, 0, 0], -(center.x - radius)),
    plane([-1, 0, 0], center.x + radius),
    plane([0, 1, 0], -(center.y - radius)),
    plane([0, -1, 0], center.y + radius),
    plane([0, 0, 1], -(center.z - radius)),
    plane([0, 0, -1], center.z + radius),
  ];
}

function objectOf(entry) {
  return entry?.object ?? entry?.value ?? entry;
}

function entriesOf(selection) {
  if (Array.isArray(selection)) return selection;
  if (Array.isArray(selection?.admitted)) return selection.admitted;
  if (Array.isArray(selection?.selected)) return selection.selected;
  throw new TypeError("selectEnvironmentAdmission must return admitted entries");
}

function ids(entries) {
  return entries.map((entry) => objectOf(entry).id);
}

function distanceOf(entry, player) {
  return entry?.distance ?? placementDistance(objectOf(entry), player);
}

async function worldSource() {
  return readFile(WORLD_SOURCE, "utf8");
}

function updateEnvironmentSource(source) {
  const start = source.indexOf("  #updateEnvironment(");
  assert.notEqual(start, -1, "WorldRenderer3D must retain a dedicated environment admission pass");
  const end = source.indexOf("\n  /** Releases one scenery placement", start);
  return source.slice(start, end === -1 ? source.length : end);
}

test("environment admission exports bounded hidden budgets and preserves strict leashes", () => {
  assert.equal(ENVIRONMENT_WARM_EXTERIOR_BUDGET, 960);
  assert.equal(ENVIRONMENT_WARM_INTERIOR_BUDGET, 360);

  const player = { x: 0, y: 0 };
  const objects = [
    placement("exterior-inside", 299.999, 0),
    placement("exterior-boundary", 300, 0),
    placement("interior-inside", 59.999, 0, { interior: true }),
    placement("interior-boundary", 60, 0, { interior: true }),
    placement("negative-inside", -299.999, 0),
    placement("negative-boundary", -300, 0),
  ];

  const candidates = environmentCandidatesInRange(objects, player);
  assert.deepEqual(ids(candidates), [
    "exterior-inside",
    "interior-inside",
    "negative-inside",
  ], "the outer and interior leashes are strict (<), including negative coordinates");
});

test("static frustum admission uses wire AABB, scene mapping, and fail-open categories", () => {
  const rejectAll = [plane([1, 0, 0], -100)];

  const valid = placement("valid", 0, 0, {
    z: 0,
    bounds: bounds(-1, -1, -1, 1, 1, 1),
  });
  const inverted = placement("inverted", 0, 0, {
    bounds: bounds(2, -1, -1, 1, 1, 1),
  });
  const malformed = placement("malformed", 0, 0, {
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: Number.NaN, maxY: 1, maxZ: 1 },
  });
  const missing = placement("missing", 0, 0);

  assert.equal(environmentObjectVisibleInFrustum(valid, rejectAll), false);
  assert.equal(environmentObjectVisibleInFrustum(inverted, rejectAll), true);
  assert.equal(environmentObjectVisibleInFrustum(malformed, rejectAll), true);
  assert.equal(environmentObjectVisibleInFrustum(missing, rejectAll), true);
  assert.equal(environmentObjectVisibleInFrustum(valid, [
    ...rejectAll,
    { normal: { x: Number.NaN, y: 0, z: 0 }, constant: 0 },
  ]), true, "a malformed later plane makes the complete classification fail open");

  // ADT/WVM world (x, y, z) is rendered as scene (x, z, -y), not scene (x, y, z).
  const mapped = placement("mapped", 10, 20, {
    z: 30,
    bounds: bounds(9, 19, 29, 11, 21, 31),
  });
  assert.equal(
    environmentObjectVisibleInFrustum(mapped, sceneBoxPlanes({ x: 10, y: 30, z: -20 }, 4)),
    true,
  );
  assert.equal(
    environmentObjectVisibleInFrustum(mapped, sceneBoxPlanes({ x: 10, y: 30, z: 20 }, 0.25)),
    false,
    "the negated world y axis is observable at the frustum boundary",
  );

  // No static bounds is a conservative case. A retained sphere can refine it, but only when the
  // caller supplies a valid static sphere; missing/malformed spheres remain fail-open.
  const retained = placement("retained-sphere", 0, 0);
  const sphereOutside = { x: 100, y: 0, z: 0, radius: 1 };
  const sphereInside = { x: 0, y: 0, z: 0, radius: 1 };
  // The accepted half-space is x <= 10, so the retained sphere at x=100 is wholly outside.
  const sphereReject = [plane([-1, 0, 0], 10)];
  assert.equal(environmentObjectVisibleInFrustum(retained, sphereReject, 1, sphereOutside), false);
  assert.equal(environmentObjectVisibleInFrustum(retained, sphereReject, 1, sphereInside), true);
  assert.equal(environmentObjectVisibleInFrustum(retained, sphereReject, 1, undefined), true);
  assert.equal(
    environmentObjectVisibleInFrustum(retained, sphereReject, 1, { x: Number.NaN, y: 0, z: 0, radius: 1 }),
    true,
  );

  // Model categories are deliberately absent from the wire object. The renderer decides whether
  // a retained model is static enough to supply a sphere; this pure predicate never performs that
  // resource inspection itself.
  assert.equal("animated" in retained, false);
  assert.equal("particleEmitters" in retained, false);
  assert.equal("composite" in retained, false);
});

test("frustum visibility is applied before independent quotas and all-visible ties match legacy selection", () => {
  const player = { x: 0, y: 0 };
  const hiddenNear = placement("hidden-near", 1, 0, {
    z: 1_000,
    bounds: bounds(0, -1, 999, 2, 1, 1_001),
  });
  const visibleFar = placement("visible-far", 200, 0, {
    bounds: bounds(199, -1, -1, 201, 1, 1),
  });
  // Keep the far horizontal object while rejecting the nearest object far above the camera.
  const visibilityPlanes = [plane([0, -1, 0], 50)];
  const admission = entriesOf(selectEnvironmentAdmission(
    environmentCandidatesInRange([hiddenNear, visibleFar], player),
    visibilityPlanes,
  ));
  assert.deepEqual(ids(admission), ["visible-far"], "a hidden nearest placement cannot spend a quota slot");

  // Equal-distance point placements force the selector to prove stable source-ordinal tie order,
  // independently for the exterior 320 and interior 120 quotas.
  const exterior = Array.from({ length: 325 }, (_, index) => placement(
    `exterior-${index}`,
    index % 2 === 0 ? 12 : -12,
    0,
  ));
  const interior = Array.from({ length: 125 }, (_, index) => placement(
    `interior-${index}`,
    index % 2 === 0 ? 12 : -12,
    0,
    { interior: true },
  ));
  const all = [...exterior, ...interior];
  const allVisible = sceneBoxPlanes({ x: 0, y: 0, z: 0 }, 1_000);
  const candidates = environmentCandidatesInRange(all, player);
  const actual = entriesOf(selectEnvironmentAdmission(candidates, allVisible));
  const expected = selectEnvironment(all, player);

  assert.equal(actual.length, expected.length);
  assert.deepEqual(ids(actual), expected.map(({ object }) => object.id));
  for (let index = 0; index < actual.length; index++) {
    assert.equal(objectOf(actual[index]), expected[index].object, `identity at stable ordinal ${index}`);
    assert.equal(distanceOf(actual[index], player), expected[index].distance, `distance at ${index}`);
  }
  assert.deepEqual(ids(actual.slice(0, 320)), exterior.slice(0, 320).map(({ id }) => id));
  assert.deepEqual(ids(actual.slice(320)), interior.slice(0, 120).map(({ id }) => id));
});

test("environment update admits candidates before resource lookup and keeps warm residents separate from disposal", async () => {
  const source = await worldSource();
  const update = updateEnvironmentSource(source);
  const candidateAt = update.indexOf("environmentCandidatesInRange(");
  const admissionAt = update.indexOf("selectEnvironmentAdmission(");
  const modelAt = update.indexOf("client?.model(");
  assert.ok(candidateAt >= 0, "the update pass must produce cheap wire candidates first");
  assert.ok(admissionAt > candidateAt, "frustum/admission follows candidate collection");
  assert.ok(modelAt > admissionAt, "model lookup begins only after admission");

  const preResource = update.slice(candidateAt, modelAt);
  for (const forbidden of ["requestModel", "#collisionModels", "#buildWmoLiquid", "#updateWmoGroups", "image("]) {
    assert.equal(preResource.includes(forbidden), false, `candidate pass must not call ${forbidden}`);
  }

  const retainedVisibilityAt = update.indexOf("selectEnvironmentAdmission(");
  assert.ok(retainedVisibilityAt >= 0, "static admission must consult the frustum-aware selector");
  const retainedContext = update.slice(retainedVisibilityAt, retainedVisibilityAt + 600);
  assert.match(retainedContext, /rendered(?:\?\.)?source\s*===\s*object/,
    "retained static spheres must be borrowed only from the exact placement entry");
  assert.match(retainedContext, /#environmentVisibilitySpheres\.get\(object\)/,
    "a measured sphere survives warm-node eviction without rebuilding the hidden M2");
  assert.doesNotMatch(retainedContext, /client\?\.model|#collisionModels|requestModel|image\(/,
    "retained-sphere admission cannot perform a resource lookup");
  assert.match(source,
    /WeakMap<EnvironmentObject, EnvironmentVisibilitySphere>/,
    "evicted-node measurements must not retain tile objects or model resources");
  assert.match(update, /#environmentVisibilitySpheres\.set\(object, visibilitySphere\)/,
    "a safe static measurement is cached before its warm node can be evicted");
  assert.match(update,
    /else if \(model\)[\s\S]{0,260}#environmentVisibilitySpheres\.delete\(object\)/,
    "a temporary model cache miss cannot erase the exact sphere used for warm re-entry");
  assert.match(update,
    /rendered\.wvm !== undefined && rendered\.wvm !== model\.wvm/,
    "a resolved WVM identity replacement invalidates the retained node and its measurement");

  const admissionStateAt = update.indexOf("#setEnvironmentAdmitted(");
  assert.ok(admissionStateAt >= 0, "in-range residents must be reconciled against draw admission");
  const disposalAt = update.lastIndexOf("#removeEnvironment(");
  assert.match(update, /if\s*\(!?\s*inRange\.has\([^)]*\)\)/,
    "disposal must be keyed to leaving the spatial range, not merely losing the frame quota");
  assert.ok(disposalAt >= 0 && disposalAt > admissionStateAt,
    "out-of-range disposal is a separate later branch");

  const admittedStart = source.indexOf("  #setEnvironmentAdmitted(");
  const admittedEnd = source.indexOf("\n  #", admittedStart + 1);
  const admittedState = source.slice(admittedStart, admittedEnd < 0 ? source.length : admittedEnd);
  assert.match(admittedState, /rendered\.node\.visible\s*=\s*false/,
    "a non-admitted retained placement becomes warm-hidden");
  assert.doesNotMatch(admittedState, /#disposeEnvironment|#dropEffects|#environment\.delete/,
    "changing draw admission must not dispose, drop effects, or delete the resident");
});

test("hidden warm caps and admitted-only draw paths are explicit in the renderer", async () => {
  const source = await worldSource();
  const update = updateEnvironmentSource(source);
  assert.match(source, /export\s+const\s+ENVIRONMENT_WARM_EXTERIOR_BUDGET\s*=\s*960/);
  assert.match(source, /export\s+const\s+ENVIRONMENT_WARM_INTERIOR_BUDGET\s*=\s*360/);
  assert.match(update, /ENVIRONMENT_WARM_EXTERIOR_BUDGET/);
  assert.match(update, /ENVIRONMENT_WARM_INTERIOR_BUDGET/);
  assert.match(source, /warm[\s\S]{0,180}(?:LRU|budget)|(?:LRU|budget)[\s\S]{0,180}warm/i,
    "warm resident accounting must be explicitly bounded");

  const instancesStart = source.indexOf("  #updateInstances(");
  const instancesEnd = source.indexOf("\n  #", instancesStart + 1);
  const instances = source.slice(instancesStart, instancesEnd < 0 ? source.length : instancesEnd);
  assert.match(instances, /(?:admitted|drawn)/i,
    "instance submission must consume the admitted/drawn set rather than all warm residents");

  const effectsStart = source.indexOf("  #updateEffects(");
  const effectsEnd = source.indexOf("\n  #", effectsStart + 1);
  const effects = source.slice(effectsStart, effectsEnd < 0 ? source.length : effectsEnd);
  assert.match(effects, /!\s*rendered\.admitted[\s\S]{0,220}(?:particleEmitters|ribbonEmitters)/,
    "hidden warm environment residents must not submit emitters");

  const doodadsStart = source.indexOf("  #poseDoodads(");
  const doodadsEnd = source.indexOf("\n  #", doodadsStart + 1);
  const doodads = source.slice(doodadsStart, doodadsEnd < 0 ? source.length : doodadsEnd);
  assert.match(doodads, /if \(!rendered\.admitted/,
    "doodad posing must be restricted to admitted/drawn residents");
  assert.match(doodads, /posed\.push/);

  const wmoAt = update.indexOf("#updateWmoGroups(");
  const liquidAt = update.indexOf("#buildWmoLiquid(");
  assert.ok(wmoAt > admissionAt(update), "WMO portal groups remain refinement after parent admission");
  assert.ok(liquidAt > admissionAt(update), "liquid construction remains after parent admission");
  const drawLoopAt = update.indexOf("for (const { object, distance } of admitted)");
  assert.ok(drawLoopAt > admissionAt(update), "resource work iterates only the admitted parent list");
  assert.ok(wmoAt > drawLoopAt, "WMO group work stays inside the admitted parent path");
  assert.ok(liquidAt > drawLoopAt, "liquid work stays inside the admitted parent path");

  const sphereStart = source.indexOf("  #environmentVisibilitySphere(");
  const sphereEnd = source.indexOf("\n  #", sphereStart + 1);
  const sphere = source.slice(sphereStart, sphereEnd < 0 ? source.length : sphereEnd);
  assert.match(sphere, /rendered\.skinned|rendered\.wmo/,
    "animated and composite WMO placements cannot lend a static retained sphere");
  assert.match(sphere, /particleEmitters|ribbonEmitters/,
    "separately-rendered emitters keep their placement fail-open");
});

function admissionAt(update) {
  return update.indexOf("selectEnvironmentAdmission(");
}
