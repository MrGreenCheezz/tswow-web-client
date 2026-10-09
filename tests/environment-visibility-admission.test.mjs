import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  ENVIRONMENT_FAR_RANGE,
  ENVIRONMENT_RANGE,
  ENVIRONMENT_SCENERY_BUDGET,
  ENVIRONMENT_VEGETATION_RANGE,
  ENVIRONMENT_WARM_EXTERIOR_BUDGET,
  ENVIRONMENT_WARM_INTERIOR_BUDGET,
  cameraAngleDelta,
  environmentBoundsDiagonal,
  environmentCandidatesInRange,
  environmentFarEligible,
  environmentObjectVisibleInFrustum,
  environmentResidentsInRange,
  environmentVegetation,
  placementDistance,
  selectEnvironment,
  selectEnvironmentAdmission,
  vegetationGrowthScale,
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
  assert.equal(ENVIRONMENT_WARM_INTERIOR_BUDGET, 1080);

  const player = { x: 0, y: 0 };
  const objects = [
    placement("exterior-inside", ENVIRONMENT_RANGE - 0.001, 0),
    placement("exterior-boundary", ENVIRONMENT_RANGE, 0),
    placement("interior-inside", 59.999, 0, { interior: true }),
    placement("interior-boundary", 60, 0, { interior: true }),
    placement("negative-inside", -ENVIRONMENT_RANGE + 0.001, 0),
    placement("negative-boundary", -ENVIRONMENT_RANGE, 0),
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

test("large outdoor WMO shells hold a far leash on their own quota", () => {
  const player = { x: 0, y: 0 };
  // Wire box 90×90×30: diagonal ~131 yards, earning the far leash.
  const castle = placement("castle", 500, 0, {
    kind: "wmo",
    bounds: bounds(455, -45, 0, 545, 45, 30),
  });
  assert.equal(environmentBoundsDiagonal(castle.bounds), Math.hypot(90, 90, 30));
  assert.equal(environmentFarEligible(castle), true);
  assert.equal(ENVIRONMENT_FAR_RANGE, 750);

  // Same box on an M2, an interior, a small WMO and a malformed box: all stay near.
  const m2 = placement("m2-big-box", 500, 0, { bounds: bounds(460, -40, 0, 540, 40, 30) });
  const interior = placement("hall-inside", 500, 0, {
    kind: "wmo", interior: true, bounds: bounds(460, -40, 0, 540, 40, 30),
  });
  const hut = placement("hut", 500, 0, { kind: "wmo", bounds: bounds(495, -5, 0, 505, 5, 4) });
  const broken = placement("broken", 500, 0, {
    kind: "wmo", bounds: { minX: 10, minY: 0, minZ: 0, maxX: 0, maxY: 1, maxZ: 1 },
  });
  for (const object of [m2, interior, hut, broken]) {
    assert.equal(environmentFarEligible(object), false, `${object.id} stays on the near leash`);
  }
  assert.equal(environmentBoundsDiagonal(undefined), undefined);
  assert.equal(environmentBoundsDiagonal(broken.bounds), undefined);

  // The near budget is fully spent on clutter, yet the castle is still admitted — and the
  // far-range rock, which earns no leash, is not even a candidate.
  const clutter = Array.from({ length: 320 }, (_, index) => placement(`clutter-${index}`, 10, 0));
  const rock = placement("rock", 500, 0);
  const candidates = environmentCandidatesInRange([...clutter, castle, rock], player);
  assert.ok(candidates.some((entry) => entry.object.id === "castle"));
  assert.ok(!candidates.some((entry) => entry.object.id === "rock"));
  const admitted = entriesOf(selectEnvironmentAdmission(candidates, []));
  assert.equal(admitted.filter((entry) => objectOf(entry).id.startsWith("clutter-")).length, 320);
  assert.ok(ids(admitted).includes("castle"), "the far castle wins its own quota, not the near one");

  // A far castle beyond even the far leash stays out.
  const tooFar = placement("too-far", 800, 0, {
    kind: "wmo",
    bounds: bounds(760, -40, 0, 840, 40, 30),
  });
  assert.ok(!environmentCandidatesInRange([tooFar], player).length);
});

test("vegetation holds a longer leash and grows in instead of popping", () => {
  const player = { x: 0, y: 0 };
  assert.equal(ENVIRONMENT_VEGETATION_RANGE, 600);
  const pine = (id, x, extra = {}) => placement(id, x, 0, {
    name: "World\\Trees\\Pine01.m2", ...extra,
  });
  assert.equal(environmentVegetation(pine("a", 10)), true);
  assert.equal(environmentVegetation(placement("house", 10)), false);
  assert.equal(environmentVegetation(pine("b", 10, { interior: true })), false,
    "indoor vegetation is a room prop, not a tree on a hill");

  // Candidates: a pine at 500 yards is in, a rock at 500 is out, a pine at 650 is out.
  const candidates = environmentCandidatesInRange(
    [pine("pine-far", 500), placement("rock", 500, 0), pine("pine-too-far", 650)], player);
  assert.deepEqual(ids(candidates), ["pine-far"]);

  // The near budget is fully spent on clutter, yet the far pine is still admitted on the far
  // quota — the same quota the castles use, nearest-first among themselves.
  const clutter = Array.from({ length: 320 }, (_, index) => placement(`vclutter-${index}`, 10, 0));
  const admitted = entriesOf(selectEnvironmentAdmission(
    environmentCandidatesInRange([...clutter, pine("pine-far", 500)], player), []));
  assert.equal(admitted.filter((entry) => objectOf(entry).id.startsWith("vclutter-")).length, 320);
  assert.ok(ids(admitted).includes("pine-far"));

  // Grow-in math: from a quarter, ease-out cubic, settled and clamped.
  assert.equal(vegetationGrowthScale(100, 100), 0.25);
  assert.equal(vegetationGrowthScale(100, 130), 1);
  assert.equal(vegetationGrowthScale(100, 200), 1, "a hidden tree settles while dormant");
  assert.equal(vegetationGrowthScale(100, 115), 0.25 + 0.75 * (1 - 0.5 ** 3));
  // Explicit spans: far first sights grow slow and subtle, near ones only soften the edge.
  assert.equal(vegetationGrowthScale(0, 45, 45), 1);
  assert.ok(vegetationGrowthScale(0, 22, 45) < vegetationGrowthScale(0, 22, 12),
    "the far curve lags the near one mid-growth");
  assert.equal(vegetationGrowthScale(0, 12, 12), 1);
  assert.equal(vegetationGrowthScale(0, 5, 0), vegetationGrowthScale(0, 5),
    "a bogus span falls back to the default window");
  let previous = 0;
  for (let serial = 100; serial <= 130; serial++) {
    const scale = vegetationGrowthScale(100, serial);
    assert.ok(scale >= previous, "growth never shrinks");
    previous = scale;
  }
});

test("the renderer grows admitted vegetation and freezes it settled", async () => {
  const source = await worldSource();
  const update = updateEnvironmentSource(source);
  assert.match(update, /const growing = environmentVegetation\(object\) && rendered\.skinned === undefined/,
    "only unrigged vegetation grows; sails keep their live matrices");
  assert.match(update, /&& rendered\.actual && rendered\.visual !== undefined && !everVisible && !suppressGrowth;/,
    "loading cones appear as they always have; only real first sights ease in, never mid-sweep");
  assert.match(update, /rendered\.growthStartedAt = this\.#submissionSerial;/,
    "growth is clocked in submitted frames, so hitches do not fast-forward it");
  assert.match(update, /node\.scale\.setScalar\(object\.scale \* VEGETATION_GROWTH_FROM\)/,
    "growth multiplies the placement scale rather than replacing it");
  assert.match(update, /node\.matrixAutoUpdate = !growing;/,
    "a growing subtree stays live: freezing it would pin the first scale until the settle pop");
  assert.match(update, /if \(!growing\) this\.#assignEnvironmentInstance\(/,
    "a mid-growth matrix never becomes instance state");
  assert.match(update, /this\.#updateVegetationGrowth\(client\);/,
    "the growth pass runs inside the environment update");
  const growthStart = source.indexOf("  #updateVegetationGrowth(");
  const growthEnd = source.indexOf("\n  #", growthStart + 10);
  const growth = source.slice(growthStart, growthEnd);
  assert.match(growth, /node\.scale\.setScalar\(baseScale\);/,
    "a settled tree is restored to exactly its authored scale");
  assert.match(growth, /part\.matrixWorldAutoUpdate = false;/,
    "settling re-freezes the subtree like any other placement");
  assert.match(growth, /rendered\.growthStartedAt = undefined;/,
    "a settled tree costs no per-frame work afterwards");
  assert.match(growth, /node\.updateMatrix\(\);/,
    "same-frame readers see the stepped scale, not last render's");
  assert.match(source, /everVisible: boolean \| undefined;/,
    "a seen placement is remembered so frustum re-entry reads whole at once");
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
  // independently for the exterior scenery and interior 360 quotas.
  const exterior = Array.from({ length: ENVIRONMENT_SCENERY_BUDGET + 5 }, (_, index) => placement(
    `exterior-${index}`,
    index % 2 === 0 ? 12 : -12,
    0,
  ));
  const interior = Array.from({ length: 365 }, (_, index) => placement(
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
  assert.deepEqual(ids(actual.slice(0, ENVIRONMENT_SCENERY_BUDGET)),
    exterior.slice(0, ENVIRONMENT_SCENERY_BUDGET).map(({ id }) => id));
  assert.deepEqual(ids(actual.slice(ENVIRONMENT_SCENERY_BUDGET)), interior.slice(0, 360).map(({ id }) => id));
});

test("environment update admits candidates before resource lookup and keeps warm residents separate from disposal", async () => {
  const source = await worldSource();
  const update = updateEnvironmentSource(source);
  const candidateAt = update.indexOf("environmentRankInRange(");
  // P2-04c: the update pass admits through the allocation-free single pass.
  const admissionAt = update.indexOf("admitEnvironmentInto(");
  const modelAt = update.indexOf("client?.model(");
  assert.ok(candidateAt >= 0, "the update pass must produce cheap wire candidates first");
  assert.ok(admissionAt > candidateAt, "frustum/admission follows candidate collection");
  assert.ok(modelAt > admissionAt, "model lookup begins only after admission");

  const preResource = update.slice(candidateAt, modelAt);
  for (const forbidden of ["requestModel", "#collisionModels", "#buildWmoLiquid", "#updateWmoGroups", "image("]) {
    assert.equal(preResource.includes(forbidden), false, `candidate pass must not call ${forbidden}`);
  }

  const retainedVisibilityAt = update.indexOf("admitEnvironmentInto(");
  assert.ok(retainedVisibilityAt >= 0, "static admission must consult the frustum-aware selector");
  assert.match(update.slice(retainedVisibilityAt, retainedVisibilityAt + 400), /this\.#retainedEnvironmentSphere,/,
    "the retained-sphere lookup is the renderer's own field, not a closure per run");
  const sphereAt = source.indexOf("readonly #retainedEnvironmentSphere = ");
  assert.ok(sphereAt >= 0);
  const retainedContext = source.slice(sphereAt, sphereAt + 600);
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

test("warm-cap enforcement is cadenced instead of scanning every frame", async () => {
  const source = await worldSource();
  assert.match(source, /const WARM_PRUNE_INTERVAL_FRAMES = 30;/,
    "the enforcement cadence is a named constant beside the warm budgets");
  const update = updateEnvironmentSource(source);
  assert.match(update, /#warmPruneAtSerial/,
    "the last enforcement frame is tracked on the renderer");
  assert.match(update, /#submissionSerial - this\.#warmPruneAtSerial >= WARM_PRUNE_INTERVAL_FRAMES/,
    "enforcement runs at most every thirty submitted frames");
});

test("draw admission and prefetch are cadenced while growth skips without growers", async () => {
  const source = await worldSource();
  const update = updateEnvironmentSource(source);
  assert.match(update, /#cameraTurnRate > CAMERA_FAST_TURN_RATE/,
    "a fast sweep keeps every-frame admission while calm frames reuse the set");
  assert.match(update, /#lastAdmitted/, "the admitted set is retained across skipped frames");
  const prefetch = update.slice(update.indexOf("  #prefetchEnvironmentModels(client:"),
    update.indexOf("  #updateVegetationGrowth(client:"));
  const renewAt = prefetch.indexOf("client.retainModelPrefetch(");
  const gateAt = prefetch.indexOf("if ((this.#submissionSerial & 3) !== 0) return;");
  const scanAt = prefetch.indexOf("selectPrefetchModels(");
  assert.ok(renewAt >= 0 && gateAt > renewAt && scanAt > gateAt,
    "renew pending work each frame while scanning only every fourth frame");
  assert.match(update, /if \(this\.#growingVegetation <= 0\) return;/,
    "the growth scan is skipped until a grow-in starts");
});

test("hidden warm caps and admitted-only draw paths are explicit in the renderer", async () => {
  const source = await worldSource();
  const update = updateEnvironmentSource(source);
  assert.match(source, /export\s+const\s+ENVIRONMENT_WARM_EXTERIOR_BUDGET\s*=\s*960/);
  assert.match(source, /export\s+const\s+ENVIRONMENT_WARM_INTERIOR_BUDGET\s*=\s*1_080/);
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

test("camera snap detection wraps around PI and ignores non-finite input", () => {
  assert.equal(cameraAngleDelta(0, 0), 0);
  assert.equal(cameraAngleDelta(0, Math.PI), Math.PI);
  assert.ok(Math.abs(cameraAngleDelta(Math.PI - 0.1, -Math.PI + 0.1) - 0.2) < 1e-9,
    "crossing the branch cut measures the short way around");
  assert.ok(Math.abs(cameraAngleDelta(0, 3 * Math.PI) - Math.PI) < 1e-9,
    "a full turn and a half reads as half a turn");
  assert.equal(cameraAngleDelta(Number.NaN, 1), 0);
  assert.equal(cameraAngleDelta(1, Number.POSITIVE_INFINITY), 0);
});

test("a camera snap suppresses grow-ins while sustained sweeps keep them", async () => {
  const source = await worldSource();
  assert.match(source, /const CAMERA_FLICK_RADIANS = 0\.3;/,
    "a single-frame snap past seventeen degrees masks an instant appearance");
  assert.match(source, /const CAMERA_FAST_TURN_RATE = 3\.0;/,
    "a sustained sweep keeps suppression alive without another snap");
  const drawStart = source.indexOf("  draw(");
  const drawEnd = source.indexOf("\n  #", drawStart + 10);
  const draw = source.slice(drawStart, drawEnd);
  assert.match(draw, /cameraAngleDelta\(this\.#lastCameraYaw, cameraYaw\)/,
    "snap detection compares against the previous drawn frame");
  assert.match(draw, /this\.#turnSuppressUntilSerial = this\.#submissionSerial \+ CAMERA_FLICK_SUPPRESS_FRAMES;/,
    "suppression is clocked in submission serials, like the growth it gates");
  const update = updateEnvironmentSource(source);
  assert.match(update, /const suppressGrowth = this\.#submissionSerial < this\.#turnSuppressUntilSerial;/,
    "first sights admitted mid-sweep read whole at once");
  assert.match(update, /else if \(rendered\.actual && rendered\.visual !== undefined\) \{/,
    "a suppressed first sight is stamped seen so a later calm frame cannot shrink it");
});

test("turn-frame intake is capped for nodes and WMO rooms, shells first", async () => {
  const source = await worldSource();
  assert.match(source, /const ENVIRONMENT_BUILD_BUDGET = 16;/,
    "a 180-degree snap ramps admitted nodes over frames instead of landing in one");
  assert.match(source, /const WMO_GROUP_BUILD_BUDGET = 6;/,
    "a newly admitted castle ramps its rooms instead of hitching one frame");
  const update = updateEnvironmentSource(source);
  assert.match(update, /let environmentBuilds = 0;/, "the node budget resets every frame");
  // 05.10 suite-fix 2: 7.18 (05.10-A7b-9) counts the waiting stand-in inside the skip block.
  assert.match(update, /if \(environmentBuilds >= ENVIRONMENT_BUILD_BUDGET(?: \|\| !this\.#environmentBuildBudget\.take\(\))?\) \{[^{}]*\bcontinue;\s*\}/,
    "a skipped admission is retried while it is still admitted");
  const wmoStart = source.indexOf("  #updateWmoGroups(");
  const wmoEnd = source.indexOf("\n  #", wmoStart + 10);
  const wmo = source.slice(wmoStart, wmoEnd);
  assert.match(wmo, /if \(this\.#wmoGroupBuildSerial !== this\.#submissionSerial\) \{/,
    "the room budget is shared across buildings and resets per submitted frame");
  assert.match(wmo, /if \(buildable\.length > 1\) buildable\.sort\(shellFirst\);/,
    "the skyline attaches first even when a small room set exceeds the elapsed slice");
  assert.match(wmo, /if \(this\.#wmoGroupBuilds >= WMO_GROUP_BUILD_BUDGET\) break;/,
    "detaches stay uncapped while builds wait their turn");
});
