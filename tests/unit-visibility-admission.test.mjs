import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { selectUnitAdmission } from "../dist/code/browser/RenderAdmission.js";
import {
  conservativeUnitVisibilityRadius,
  unitSphereVisibleInFrustum,
  unitWireHasCompositeSilhouette,
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

test("nearer retained units behind the camera cannot starve visible unit admission", () => {
  const planes = cameraFrustum().planes;
  const behind = Array.from({ length: 80 }, (_, index) => ({
    value: `behind-${index}`,
    distance: index + 1,
    pinned: false,
    visible: unitSphereVisibleInFrustum(0, 0, 10, 1, planes, 1),
  }));
  const visible = Array.from({ length: 80 }, (_, index) => ({
    value: `visible-${index}`,
    distance: 100 + index,
    pinned: false,
    visible: unitSphereVisibleInFrustum(0, 0, -10, 1, planes, 1),
  }));
  const pinned = { value: "pinned-behind-and-outside", distance: Number.MAX_VALUE, pinned: true, visible: false };
  const resident = [...behind, ...visible, pinned];
  const admission = selectUnitAdmission(resident, 64);

  assert.equal(resident.length, 161, "frustum-culled candidates remain in the resident input set");
  assert.equal(admission.admitted.length, 64);
  assert.equal(admission.admitted[0].value, pinned.value, "pinned candidates stay first and bypass visibility");
  assert.equal(admission.admitted.some(({ value }) => value.startsWith("behind-")), false);
  assert.deepEqual(
    admission.admitted.slice(1).map(({ value }) => value),
    visible.slice(0, 63).map(({ value }) => value),
    "visible units retain stable nearest order after the pinned entry",
  );
  assert.equal(admission.dropped, 17,
    "only visible/pinned budget rejects count as dropped; 80 culled candidates do not");
});

test("unit admission preserves original ordinal across exact distance ties", () => {
  const tied = Array.from({ length: 70 }, (_, index) => ({
    value: index, distance: 12, pinned: false, visible: true,
  }));
  assert.deepEqual(
    selectUnitAdmission(tied, 64).admitted.map(({ value }) => value),
    Array.from({ length: 64 }, (_, index) => index),
  );
});

test("conservative unit radius encloses authored corners, shifted rest sphere, and current height", () => {
  const bounds = { min: [-1, -2, 0], max: [3, 4, 5], radius: 1 };
  const rest = { center: { x: 2, y: 0, z: 0 }, radius: 2 };
  assert.ok(Math.abs(conservativeUnitVisibilityRadius(bounds, rest, 2, 13) - Math.sqrt(50) * 2) < 1e-12,
    "the furthest scaled header AABB corner encloses the ordinary silhouette");
  assert.equal(conservativeUnitVisibilityRadius(bounds, rest, 2, 20), 20,
    "a current tall silhouette expands the origin-centred sphere");
  assert.equal(conservativeUnitVisibilityRadius(
    { min: [-1, -1, -1], max: [1, 1, 1], radius: 1 },
    { center: { x: 3, y: 0, z: 0 }, radius: 2 },
    2,
    1,
  ), 10, "a shifted built rest sphere is enclosed from the unit origin");
});

test("invalid unit bounds and camera data fail open, while the frustum margin protects its boundary", () => {
  const validRest = { center: { x: 0, y: 0, z: 0 }, radius: 1 };
  assert.equal(conservativeUnitVisibilityRadius(
    { min: [2, -1, -1], max: [1, 1, 1], radius: 1 }, validRest, 1, 2,
  ), undefined, "inverted bounds are unknown rather than cullable");
  assert.equal(conservativeUnitVisibilityRadius(
    { min: [-1, -1, -1], max: [1, 1, Number.NaN], radius: 1 }, validRest, 1, 2,
  ), undefined);
  assert.equal(unitSphereVisibleInFrustum(0, 0, 0, Number.NaN, [], 1), true);
  assert.equal(unitSphereVisibleInFrustum(0, 0, 0, 1, [
    { normal: { x: Number.NaN, y: 0, z: 0 }, constant: 0 },
  ], 1), true);
  assert.equal(unitSphereVisibleInFrustum(10, 0, 0, 1, [
    { normal: { x: -1, y: 0, z: 0 }, constant: 0 },
    { normal: { x: Number.NaN, y: 0, z: 0 }, constant: 0 },
  ], 0), true, "an invalid later plane fail-opens before an earlier rejecting plane can cull");

  const rightPlane = [{ normal: { x: -1, y: 0, z: 0 }, constant: 10 }];
  assert.equal(unitSphereVisibleInFrustum(11.3, 0, 0, 0.4, rightPlane, 1), true,
    "the near-frustum margin retains a sphere just beyond the nominal plane");
  assert.equal(unitSphereVisibleInFrustum(11.6, 0, 0, 0.4, rightPlane, 1), false);
});

test("wire mount and attachment-capable player item slots fail open without metadata lookups", () => {
  const object = { typeId: 4, fields: new Map() };
  assert.equal(unitWireHasCompositeSilhouette(object), false);
  object.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 2404);
  assert.equal(unitWireHasCompositeSilhouette(object), true, "a pending mount model is already composite on the wire");
  object.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, -2404);
  assert.equal(unitWireHasCompositeSilhouette(object), true, "a malformed negative mount display id must fail open");
  object.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 0);

  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
  for (const slot of [0, 2, 15, 16, 17]) {
    object.fields.clear();
    assert.equal(unitWireHasCompositeSilhouette(object), false);
    object.fields.set(first + slot * stride, 1000 + slot);
    assert.equal(unitWireHasCompositeSilhouette(object), true, `equipment slot ${slot} must fail open while pending/changed`);
  }
  object.fields.clear();
  object.fields.set(first + 4 * stride, 1004);
  assert.equal(unitWireHasCompositeSilhouette(object), false,
    "body-painted slots alone do not claim an out-of-body attachment silhouette");
});

test("renderer admission is lookup-free, current-only, and keeps culled residents dormant", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const updateStart = source.indexOf("  #updateUnits(");
  const updateEnd = source.indexOf("\n  /**", updateStart + 10);
  const update = source.slice(updateStart, updateEnd);
  const admissionAt = update.indexOf("const admission = selectUnitAdmission");
  const frustumAt = update.indexOf("this.#frustumMatrix.multiplyMatrices");
  assert.ok(updateStart >= 0 && updateEnd > updateStart && frustumAt >= 0 && admissionAt > frustumAt,
    "the camera frustum is composed before unit budget admission");

  const candidatePass = update.slice(update.indexOf("for (const object of state.objects.values())"), admissionAt);
  for (const forbidden of ["creatureModel?.(", "mountModel?.(", "client?.model", "#drawUnit(", "image("]) {
    assert.equal(candidatePass.includes(forbidden), false, `admission must not call ${forbidden}`);
  }
  assert.match(candidatePass, /this\.#units\.get\(object\.guid\)/,
    "admission reads only retained renderer measurements after wire fields");
  assert.match(update, /const inRange = new Set\(candidates\.map\(\(\{ value \}\) => value\.guid\)\)/,
    "every distance-resident candidate remains resident even when visibility rejects it");
  assert.match(update, /if \(inRange\.has\(guid\) && !drawn\.has\(guid\)\) unit\.node\.visible = false/,
    "culled and budget-dormant retained nodes are hidden every frame");
  assert.match(update, /for \(const \[rank, \{ value: object, distance \}\] of admission\.admitted\.entries\(\)\)/,
    "camera re-entry draws and updates an admitted retained unit in the same frame");

  const radiusStart = source.indexOf("  #unitVisibilityRadius(");
  const radiusEnd = source.indexOf("\n  /**", radiusStart + 10);
  const radius = source.slice(radiusStart, radiusEnd);
  assert.match(radius, /!unit\.wvm \|\| !unit\.built/);
  assert.match(radius, /unitWireHasCompositeSilhouette\(object\)/,
    "live mount/equipment wire state is checked before retained model measurements");
  assert.match(radius, /unit\.body/);
  assert.match(radius, /unit\.decodedModel \|\| unit\.legacyGeometry \|\| unit\.mount \|\| unit\.attached\.size > 0/,
    "stand-ins, legacy bodies, mounts, and attached silhouettes all fail open");
  assert.match(radius, /unit\.admissionHasAuthoredAttachments !== false/,
    "authored attachments fail open even while their separate models are pending");
  assert.match(radius, /unit\.wvm\.particleEmitters\.length > 0 \|\| unit\.wvm\.ribbonEmitters\.length > 0/,
    "separately rendered WVM emitters cannot be enclosed by the body bounds");
  assert.match(radius, /unit\.admissionDisplayId !== displayId \|\| unit\.admissionObjectScale !== objectScale/,
    "a changed display or live object scale cannot use stale retained bounds");
  assert.match(source, /unit\.admissionHasAuthoredAttachments = \(metadata\?\.appearance\?\.attached\.length \?\? 0\) > 0/,
    "the settled appearance stamps authored attachments before later admission frames");
  assert.match(source, /if \(!this\.#formalBenchmarkIsolation\) \{\s*for \(const guid of this\.#portraits\.targetGuids\(\)\) pinned\.add\(guid\)/,
    "portrait protection remains outside formal benchmark isolation");
});

test("unit visibility hot helpers contain no transient array or callback iteration", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const radiusStart = source.indexOf("export function conservativeUnitVisibilityRadius(");
  const sphereStart = source.indexOf("export function unitSphereVisibleInFrustum(");
  const radius = source.slice(radiusStart, sphereStart);
  const sphereEnd = source.indexOf("\n}\n", sphereStart) + 3;
  const sphere = source.slice(sphereStart, sphereEnd);
  for (const [name, body] of [["radius", radius], ["sphere", sphere]]) {
    assert.doesNotMatch(body, /\bnew\s+/u, `${name} helper must not allocate objects`);
    assert.doesNotMatch(body, /\bconst\s+\w+\s*=\s*\[/u, `${name} helper must not allocate arrays`);
    assert.doesNotMatch(body, /\.\.\./u, `${name} helper must not spread iterables`);
    assert.doesNotMatch(body, /\.(?:some|every|map|filter|forEach|reduce)\(/u,
      `${name} helper must not allocate or dispatch callback iteration`);
  }
  assert.doesNotMatch(sphere, /\bfor\s*\([^)]*\bof\b/u,
    "sphere helper must use indexed plane passes without invoking an iterator");
});
