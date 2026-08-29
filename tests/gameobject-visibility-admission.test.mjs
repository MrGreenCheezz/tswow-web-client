import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { selectGameObjectAdmission } from "../dist/code/browser/RenderAdmission.js";
import {
  conservativeGameObjectVisibilityRadius,
  gameObjectWireIsMovingTransport,
} from "../dist/code/browser/WorldRenderer3D.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

function cameraFrustum() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

test("nearer retained game objects behind the camera cannot starve visible admission", () => {
  const planes = cameraFrustum().planes;
  const behind = Array.from({ length: 120 }, (_, index) => ({
    value: `behind-${index}`,
    distance: index + 1,
    pinned: false,
    visible: planes.every((plane) => plane.distanceToPoint(new THREE.Vector3(0, 0, 10)) >= -1),
  }));
  const visible = Array.from({ length: 120 }, (_, index) => ({
    value: `visible-${index}`,
    distance: 200 + index,
    pinned: false,
    visible: planes.every((plane) => plane.distanceToPoint(new THREE.Vector3(0, 0, -10)) >= -1),
  }));
  const pinned = { value: "pinned-behind", distance: 80, pinned: true, visible: false };
  const resident = [...behind, ...visible, pinned];
  const admission = selectGameObjectAdmission(resident, 96);

  assert.equal(admission.admitted.length, 96);
  assert.equal(admission.admitted[0].value, pinned.value, "the pinned in-range object bypasses visibility");
  assert.equal(admission.admitted.some(({ value }) => value.startsWith("behind-")), false);
  assert.deepEqual(
    admission.admitted.slice(1).map(({ value }) => value),
    visible.slice(0, 95).map(({ value }) => value),
    "visible objects retain stable nearest order after the pinned entry",
  );
  assert.equal(admission.dropped, 25,
    "only visible/pinned budget rejects count as dropped; frustum-culled residents do not");
});

test("game-object admission preserves input order across exact distance ties", () => {
  const tied = Array.from({ length: 110 }, (_, index) => ({
    value: index, distance: 12, pinned: false, visible: true,
  }));
  assert.deepEqual(
    selectGameObjectAdmission(tied, 96).admitted.map(({ value }) => value),
    Array.from({ length: 96 }, (_, index) => index),
  );
});

test("game-object admission keeps a visible top-K and reports only eligible budget rejects", () => {
  const candidates = [
    { value: "visible-far", distance: 30, pinned: false, visible: true },
    { value: "culled-near", distance: 1, pinned: false, visible: false },
    { value: "visible-near", distance: 2, pinned: false, visible: true },
    { value: "pinned", distance: 90, pinned: true, visible: false },
    { value: "visible-mid", distance: 20, pinned: false, visible: true },
  ];
  const before = structuredClone(candidates);
  const admission = selectGameObjectAdmission(candidates, 3);

  assert.deepEqual(
    admission.admitted.map(({ value }) => value),
    ["pinned", "visible-near", "visible-mid"],
    "pinned objects win the shared budget, then visible objects use nearest stable order",
  );
  assert.equal(admission.dropped, 1,
    "only visible/pinned candidates rejected by the budget count as dropped");
  assert.deepEqual(candidates, before, "admission does not mutate the resident candidate list");
});

test("static game-object bounds enclose a shifted rest sphere and fail open on invalid data", () => {
  assert.equal(conservativeGameObjectVisibilityRadius(
    { center: { x: 3, y: 4, z: 0 }, radius: 2 },
    2,
  ), 14, "rotation about the placement origin cannot escape the origin-centred sphere");
  assert.equal(conservativeGameObjectVisibilityRadius(
    { center: { x: Number.NaN, y: 0, z: 0 }, radius: 2 },
    1,
  ), undefined);
  assert.equal(conservativeGameObjectVisibilityRadius(
    { center: { x: 0, y: 0, z: 0 }, radius: -1 },
    1,
  ), undefined);
  assert.equal(conservativeGameObjectVisibilityRadius(
    { center: { x: 0, y: 0, z: 0 }, radius: 1 },
    Number.POSITIVE_INFINITY,
  ), undefined);
  assert.equal(conservativeGameObjectVisibilityRadius(
    { center: { x: 0, y: 0, z: 0 }, radius: Number.NaN },
    1,
  ), undefined);
  assert.equal(conservativeGameObjectVisibilityRadius(
    { center: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }, radius: 1 },
    1,
  ), undefined);
  assert.equal(conservativeGameObjectVisibilityRadius(
    { center: { x: 0, y: 0, z: 0 }, radius: 1 },
    0,
  ), undefined);
});

test("transport wire types are classified without path or metadata lookups", () => {
  const object = { fields: new Map() };
  assert.equal(gameObjectWireIsMovingTransport(object), false);
  object.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 11 << 8);
  assert.equal(gameObjectWireIsMovingTransport(object), true, "GAMEOBJECT_TYPE_TRANSPORT moves on a client path");
  object.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 15 << 8);
  assert.equal(gameObjectWireIsMovingTransport(object), true, "GAMEOBJECT_TYPE_MO_TRANSPORT is server-moved");
  for (const type of [0, 3, 10, 19, 32]) {
    object.fields.set(UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, type << 8);
    assert.equal(gameObjectWireIsMovingTransport(object), false, `ordinary type ${type} is not a moving transport`);
  }
});

test("renderer gates game-object requests on visibility admission and keeps rejected residents warm", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const updateStart = source.indexOf("  #updateGameObjects(");
  const updateEnd = source.indexOf("\n  /**", updateStart + 10);
  const update = source.slice(updateStart, updateEnd);
  const admissionAt = update.indexOf("const admission = selectGameObjectAdmission");
  const frustumAt = update.indexOf("this.#frustumMatrix.multiplyMatrices");
  assert.ok(updateStart >= 0 && updateEnd > updateStart && frustumAt >= 0 && admissionAt > frustumAt,
    "the camera frustum is composed before the game-object budget");
  assert.match(update, /if \(this\.#selection\.target\) pinned\.add\(this\.#selection\.target\.guid\)/,
    "the selected target receives game-object priority");
  assert.match(update, /if \(this\.#selection\.focus\) pinned\.add\(this\.#selection\.focus\.guid\)/,
    "the selected focus receives game-object priority");

  const candidatePass = update.slice(update.indexOf("for (const object of state.objects.values())"), admissionAt);
  for (const forbidden of [
    "metadata?.(", "client?.model", "paths?.path", "#buildGameObject(", "#updateWmoGroups(",
    "#poseGameObject(", "#requestGameObjectPoses(", "image(",
  ]) {
    assert.equal(candidatePass.includes(forbidden), false, `admission must not call ${forbidden}`);
  }
  assert.match(candidatePass, /if \(distance > GAMEOBJECT_RANGE\) continue;/,
    "target/focus priority does not extend game-object residency range");
  assert.doesNotMatch(candidatePass, /distance > GAMEOBJECT_RANGE\s*&&\s*!isPinned/,
    "a target/focus pin must not bypass the game-object resident range");
  assert.match(candidatePass, /this\.#gameObjectVisibilityRadius\(object, this\.#gameObjects\.get\(object\.guid\)\)/,
    "candidate classification reads only retained measurements after wire fields");
  assert.match(candidatePass, /const visible = isPinned \|\| radius === undefined \|\|/,
    "unknown silhouettes fail open while trusted static bounds participate in visibility");
  assert.doesNotMatch(candidatePass, /(?:metadata|client|paths)\b|image\(|#placeGameObject\(|#disposeGameObject\(/,
    "candidate classification cannot resolve visual resources or mutate a resident");
  assert.match(update, /const admission = selectGameObjectAdmission\(candidates, GAMEOBJECT_BUDGET\)/,
    "the visibility-filtered candidate set is budgeted by the stable selector");
  assert.match(update, /this\.#gameObjectsDropped = admission\.dropped/,
    "telemetry reports only visible/pinned budget rejects");
  assert.match(update, /this\.#gameObjectsDrawn = admission\.admitted\.length/,
    "draw telemetry equals the number of admitted objects");
  assert.doesNotMatch(update, /this\.#gameObjectsDropped = Math\.max\(0, kept\.length - GAMEOBJECT_BUDGET\)/,
    "frustum-culled residents must not be reported as budget drops");
  assert.match(update, /const inRange = new Set\(candidates\.map\(\(\{ value \}\) => value\.guid\)\)/,
    "frustum-culled and over-budget objects remain distance residents");
  const admittedLoopAt = update.indexOf("for (const { value: object } of admission.admitted)");
  assert.ok(admittedLoopAt >= 0, "admitted objects are processed in the same frame as selection");
  const admittedLoop = update.slice(admittedLoopAt, update.indexOf("\n    }", admittedLoopAt) + 6);
  assert.match(admittedLoop, /#placeGameObject\(/,
    "camera re-entry places an admitted resident in the same frame");
  assert.match(admittedLoop, /#poseGameObject\(/,
    "camera re-entry poses an admitted resident in the same frame");
  assert.ok(admittedLoop.indexOf("#placeGameObject(") < admittedLoop.indexOf("#poseGameObject("),
    "placement precedes pose so animation and effects see the current transform");
  assert.match(update, /for \(const \{ value: object \} of admission\.admitted\)/,
    "camera re-entry places and updates an admitted resident in the same frame");
  const warmStart = update.indexOf("if (inRange.has(guid) && !drawn.has(guid))");
  const warmEnd = update.indexOf("\n    }", warmStart);
  assert.ok(warmStart >= 0 && warmEnd > warmStart, "in-range non-admitted residents have a warm hide branch");
  const warmBranch = update.slice(warmStart, warmEnd);
  assert.match(warmBranch, /rendered\.node\.visible = false/,
    "frustum-culled and over-budget residents are hidden every frame");
  assert.doesNotMatch(warmBranch, /#disposeGameObject\(|#dropEffects\(|#gameObjectAnimations\.delete\(/,
    "warm residents preserve rig, effects, and queued animation state");
  assert.match(update, /if \(rendered\.wmo\) this\.#clearWmoGroups\(rendered\.wmo, rendered\.node\);/,
    "hidden WMO residents release live room geometry without dropping their outer state");
  assert.match(update, /if \(inRange\.has\(guid\)\) continue;\s*this\.#disposeGameObject\(rendered\)/,
    "only objects outside the distance-resident set are disposed");

  const radiusStart = source.indexOf("  #gameObjectVisibilityRadius(");
  const radiusEnd = source.indexOf("\n  /**", radiusStart + 10);
  const radius = source.slice(radiusStart, radiusEnd);
  assert.match(radius, /!rendered \|\| !rendered\.actual/,
    "absent and loading/empty residents fail open");
  assert.match(radius, /rendered\.wmo \|\| rendered\.decodedModel \|\| rendered\.legacyGeometry/,
    "composite WMO and legacy silhouettes fail open");
  assert.match(radius, /!rendered\.wvm \|\| !rendered\.built/,
    "loading and empty model residents fail open");
  assert.match(radius, /rendered\.skinned/,
    "rigged animation cannot use static rest bounds");
  assert.match(radius, /particleEmitters\.length > 0 \|\| rendered\.wvm\.ribbonEmitters\.length > 0/,
    "separately rendered emitters cannot be enclosed by mesh geometry");
  assert.match(radius, /gameObjectWireIsMovingTransport\(object\)/,
    "moving transports fail open from current wire data");
  assert.match(radius, /rendered\.admissionDisplayId !== displayId/);
  assert.match(radius, /rendered\.admissionScale !== scale/);
  assert.match(radius, /rendered\.admissionEntry !== entry/,
    "display, scale, and transport entry changes cannot reuse stale retained bounds");
  assert.match(radius, /rendered\.wvm\.bounds/,
    "only the retained WVM bounds are eligible for static culling");
  assert.match(radius, /rendered\.built\.geometry\.boundingSphere/,
    "the retained built geometry supplies the second half of the conservative silhouette");
  assert.match(radius, /Number\.isFinite/,
    "malformed bounds and wire revisions fail open instead of culling");
  assert.doesNotMatch(radius, /const center = \{/,
    "trusted static admission must not allocate a temporary center for every resident every frame");
  assert.doesNotMatch(radius, /conservativeGameObjectVisibilityRadius\(\s*\{/,
    "trusted static admission must not allocate temporary sphere wrappers in the candidate hot path");

  const disposeAt = update.lastIndexOf("if (inRange.has(guid)) continue;");
  assert.ok(disposeAt > warmStart, "out-of-range disposal is separate from warm hiding");
  const disposeBranch = update.slice(disposeAt);
  assert.match(disposeBranch, /#disposeGameObject\(rendered\)/,
    "only objects that leave the distance resident set are disposed");
  assert.match(disposeBranch, /#gameObjectAnimations\.delete\(guid\)/,
    "out-of-range disposal may drop the animation queue with the resident");
});

test("game-object admission stamps only the current model identity and resets transport phase on entry changes", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const updateStart = source.indexOf("  #updateGameObjects(");
  const updateEnd = source.indexOf("\n  /**", updateStart + 10);
  const update = source.slice(updateStart, updateEnd);
  const stampCall = "#stampGameObjectAdmission(rendered, object";
  const stampAt = update.indexOf(stampCall);
  assert.ok(stampAt >= 0, "admitted objects record an admission identity");

  // A valid scale must be installed on the retained node before its WVM can be trusted. This
  // catches the old ordering where the stamp preceded #placeGameObject (which applied scale).
  const placeAt = update.indexOf("#placeGameObject(");
  const directScaleAt = update.indexOf("rendered.node.scale.setScalar(");
  assert.ok((directScaleAt >= 0 && directScaleAt < stampAt) || (placeAt >= 0 && placeAt < stampAt),
    "the live game-object scale is applied before admission is stamped");

  // The stamp must not turn an unresolved display/model revision into proof that the old WVM is
  // current. Passing the model identity into the stamp and checking rendered.model makes a change
  // from display A to unresolved display B fail open until B is actually resolved.
  const stampStart = source.indexOf("  #stampGameObjectAdmission(");
  const stampEnd = source.indexOf("\n  /**", stampStart + 10);
  const stamp = source.slice(stampStart, stampEnd);
  assert.match(stamp, /modelName/, "admission stamps carry the current display model identity");
  assert.match(stamp, /rendered\.model/, "admission rejects a retained model from an older display revision");
  assert.match(update, /#stampGameObjectAdmission\(rendered, object, modelName(?:, model)?\)/,
    "the draw pass supplies current metadata/model identity to admission stamping");
  const identityGuardAt = stamp.search(/if \(!modelName \|\| !model \|\| rendered\.model !== modelName/);
  const identityGuardEnd = stamp.indexOf("const displayId", identityGuardAt);
  assert.ok(identityGuardAt >= 0 && identityGuardEnd > identityGuardAt,
    "admission has an explicit unresolved/mismatched model identity guard");
  const identityGuard = stamp.slice(identityGuardAt, identityGuardEnd);
  assert.match(identityGuard, /#clearGameObjectAdmissionTrust\(rendered\)/,
    "an unresolved model identity clears its whole stale proof");
  assert.ok(identityGuard.lastIndexOf("return;") > identityGuard.indexOf("#clearGameObjectAdmissionTrust"),
    "the guard clears admission identity before returning");

  const clearStart = source.indexOf("  #clearGameObjectAdmissionTrust(");
  const clearEnd = source.indexOf("\n  /**", clearStart + 10);
  const clear = source.slice(clearStart, clearEnd);
  for (const field of [
    "admissionDisplayId", "admissionScale", "admissionEntry", "admissionMetadataRevision",
  ]) {
    assert.match(clear, new RegExp(`delete rendered\\.${field}`),
      `trust clearing invalidates stale ${field}`);
  }

  // A display id can be remapped while its old WVM is warm. That revision must invalidate the old
  // proof before the candidate pass; otherwise a culled resident never reaches metadata/model
  // resolution and can remain stuck on the old model indefinitely.
  const candidateAt = update.indexOf("for (const object of state.objects.values())");
  const refreshAt = update.indexOf("#refreshGameObjectAdmissionTrust(");
  assert.ok(refreshAt >= 0 && refreshAt < candidateAt,
    "metadata revision changes refresh retained trust before visibility classification");
  const refreshStart = source.indexOf("  #refreshGameObjectAdmissionTrust(");
  const refreshEnd = source.indexOf("\n  /**", refreshStart + 10);
  const refresh = source.slice(refreshStart, refreshEnd);
  assert.match(refresh, /metadataRevision/,
    "trust refresh is driven by the metadata cache revision");
  assert.match(refresh, /metadata\?\.\(rendered\.admissionDisplayId\)\?\.model/,
    "a changed cache revision revalidates each stamped display mapping");
  assert.match(refresh, /#clearGameObjectAdmissionTrust\(rendered\)/,
    "an unresolved or remapped display clears its stale bounds before candidate admission");
  const radiusStart = source.indexOf("  #gameObjectVisibilityRadius(");
  const radiusEnd = source.indexOf("\n  /**", radiusStart + 10);
  const radius = source.slice(radiusStart, radiusEnd);
  assert.match(radius, /rendered\.admissionMetadataRevision !== this\.#gameObjectMetadataRevision/,
    "candidate culling requires a stamp from the current metadata revision");

  const loopSource = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const formalHostSource = await readFile(
    new URL("../src/browser/LiveFormalRenderBenchmarkHost.ts", import.meta.url), "utf8",
  );
  assert.match(loopSource, /game\.gameObjectMetadata\?\.revision/,
    "the live draw path supplies the metadata revision");
  assert.match(formalHostSource, /resources\.gameObjectMetadata\.revision/,
    "the formal replay draw path supplies the same metadata revision contract");

  // OBJECT_FIELD_ENTRY keys transport paths. A changed entry must not reuse the old phase clock,
  // and the new entry must be installed before #placeGameObject asks paths.path(entry).
  const placeStart = source.indexOf("  #placeGameObject(");
  const placeEnd = source.indexOf("\n  /**", placeStart + 10);
  const place = source.slice(placeStart, placeEnd);
  assert.match(place, /if \(nextEntry !== rendered\.entry\)/,
    "entry revision is compared with the retained transport identity");
  assert.match(place, /delete rendered\.phaseAt/,
    "entry changes restart transport phase acquisition");
  assert.match(place, /delete rendered\.phaseMs/,
    "entry changes discard the old transport phase");
  assert.match(place, /rendered\.entry = nextEntry/,
    "the current transport entry is installed before path lookup");
});

test("game-object effects skip warm-hidden residents before emitter admission", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const effectsStart = source.indexOf("  #updateEffects(");
  const effectsEnd = source.indexOf("\n  #markExpiredSpellEffectPhases", effectsStart + 10);
  const effects = source.slice(effectsStart, effectsEnd);
  const objectStart = effects.indexOf("for (const [guid, rendered] of this.#gameObjects)");
  const unitStart = effects.indexOf("for (const [guid, unit] of this.#units)", objectStart + 10);
  assert.ok(objectStart >= 0 && unitStart > objectStart, "effects has a distinct game-object pass");
  const objects = effects.slice(objectStart, unitStart);
  const hiddenAt = objects.indexOf("!rendered.node.visible");
  const emitterAt = objects.indexOf("rendered.wvm.particleEmitters");
  const distanceAt = objects.indexOf("const distance");
  const pushAt = objects.indexOf("wanted.push");
  assert.ok(hiddenAt >= 0, "game-object effects read the final node visibility");
  assert.ok(hiddenAt < emitterAt && hiddenAt < distanceAt && hiddenAt < pushAt,
    "warm-hidden residents are rejected before emitter, distance, or wanted-list work");
  const guardEnd = objects.indexOf("continue;", hiddenAt);
  assert.ok(guardEnd > hiddenAt && guardEnd < pushAt,
    "a warm-hidden game object cannot enter the effect admission list");
  assert.match(objects.slice(hiddenAt, guardEnd + "continue;".length),
    /!rendered\.node\.visible[\s\S]*rendered\.wvm\.particleEmitters[\s\S]*continue;/,
    "the visibility guard covers emitter-bearing game objects before admission");
});

test("rigged game-object re-entry refreshes matrixWorld before frustum testing and pose", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const updateStart = source.indexOf("  #updateGameObjects(");
  const updateEnd = source.indexOf("\n  /**", updateStart + 10);
  const update = source.slice(updateStart, updateEnd);
  const placeAt = update.indexOf("this.#placeGameObject(");
  const frustumAt = update.indexOf("this.#frustum.intersectsObject(rendered.skinned.mesh)");
  const poseAt = update.indexOf("this.#poseGameObject(");
  assert.ok(placeAt >= 0 && frustumAt > placeAt && poseAt > frustumAt,
    "placement, fresh-matrix frustum admission, and pose happen in this frame's order");

  // Frustum.intersectsObject reads the mesh's matrixWorld. Re-entry can follow a previous frame in
  // which the node was dormant, so refreshing only the parent node or waiting for renderer.render
  // is too late: the current mesh and its parent chain must be composed before this test.
  const beforeFrustum = update.slice(placeAt, frustumAt);
  assert.match(beforeFrustum, /rendered\.skinned\.mesh\.updateWorldMatrix\(true,\s*false\)/,
    "the current skinned mesh and its parents have fresh matrixWorld before frustum admission");
});
