import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import { UPDATE_FIELDS } from '../dist/code/generated/updateFields.js';

// Exercise the actual attachment construction method; the asset request/build boundary is stubbed.
const source = readFileSync(new URL('../src/browser/WorldRenderer3D.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('renderer.ts', source, ts.ScriptTarget.ES2022, true);
const renderer = parsed.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'WorldRenderer3D');
const method = renderer.members.find(m => m.name?.getText(parsed) === '#updateAttachments');
const js = ts.transpileModule(`class Harness { ${method.getText(parsed).replaceAll('#', '')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const root = new THREE.Group(), bone = new THREE.Bone();
  root.add(bone);
  // P2-03a: a folded build's slot depth; these meshes are plain fixtures.
  const deps = { THREE, UPDATE_FIELDS, applySlotDepth: () => {}, attachmentPoint: () => 1, boneOf: () => bone,
    worldAttachmentPoint: () => 1, sheatheOf: () => undefined, // 05.10-A7a-G2 6.08
    glowSlotsKey: () => "", glowPlacement: () => [], attachGlowAnchors() {}, resolveGlowModels() {}, mountGlowBodies: () => 0, glowAnchorsOf: () => [], // 05.10-A7a-G2: 6.14 helpers the harness lacked
    attachmentOffset: () => new THREE.Vector3(), attachmentRotation: () => undefined,
    TEXTURE_TYPE_OBJECT_SKIN: 2, EVERY_GEOSET: 'all',
    attachedOf: (metadata) => metadata?.appearance?.attached }; // 05.10-A7a-B 6.02
  const Harness = Function(...Object.keys(deps), js + '; return Harness;')(...Object.values(deps));
  const harness = new Harness();
  const geometry = new THREE.BoxGeometry(1, 2, 0.5);
  geometry.computeBoundingSphere();
  Object.assign(harness, { unitBuildBudget: { take: () => true }, builtUnits: {},
    programWarmup: { registerObject() {} },
    wvmBuild: () => ({ geometry, materials: [new THREE.MeshBasicMaterial()] }) });
  const unit = { attached: new Map(), skinned: {}, template: {} };
  harness.updateAttachments(unit, { appearance: { attached: [{ slot: 15, side: 0, model: 'weapon', texture: '' }] } },
    { fields: new Map() }, { model: () => ({ wvm: {} }) }, { wvm: { attachments: [{}] } });
  return { root, bone, mesh: [...unit.attached.values()][0] };
}

function frustum(extent) {
  const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.1, 100);
  camera.position.z = 20;
  camera.updateMatrixWorld();
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}
const submits = (mesh, view) => !mesh.frustumCulled || view.intersectsObject(mesh);

test('rigid equipment outside the view is culled using its current bone transform', () => {
  const { root, bone, mesh } = fixture();
  const view = frustum(10);
  assert.equal(mesh.frustumCulled, true);
  for (const x of [0, 50, 0, -50, 0]) {
    root.position.x = x;
    bone.rotation.z += 0.7;
    root.scale.set(1.2, 2, 0.8);
    root.updateMatrixWorld(true);
    assert.equal(submits(mesh, view), x === 0, 'entry and exit use the current world matrix');
  }
});

test('offscreen equipment can still enter the independent shadow camera', () => {
  const { root, mesh } = fixture();
  mesh.castShadow = true;
  root.position.x = 50;
  root.updateMatrixWorld(true);
  assert.equal(submits(mesh, frustum(10)), false);
  assert.equal(submits(mesh, frustum(100)), true);
  root.position.x = 200;
  root.updateMatrixWorld(true);
  assert.equal(submits(mesh, frustum(100)), false);
});

test('an attachment whose centre is past the edge remains when its scaled bounds overlap', () => {
  const { root, bone, mesh } = fixture();
  root.position.x = 10.5;
  bone.rotation.z = Math.PI / 2;
  bone.scale.setScalar(2);
  root.updateMatrixWorld(true);
  assert.equal(submits(mesh, frustum(10)), true);
});
