import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import * as rendererExports from '../dist/code/browser/WorldRenderer3D.js';
import {applyBlendMode, cloneMaterialFaded} from '../dist/code/browser/ModelBuild.js';
import {spawnFadeFactor} from '../dist/code/browser/AnimatedModel.js';
import {glowBodyMeshes, makeGlowBody, mountGlowBodies} from '../dist/code/browser/WeaponGlowBody.js'; // 05.10: ревью E2
import {attachGlowAnchors, glowAnchorsOf, glowPlacement} from '../dist/code/browser/WeaponGlow.js'; // 05.10: ревью E2

const source = await readFile(new URL('../src/browser/WorldRenderer3D.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('WorldRenderer3D.ts', source, ts.ScriptTarget.ES2022, true);
const rendererClass = parsed.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'WorldRenderer3D');
const methods = ['#applyUnitOpacity', '#releaseUnitOpacity', '#unitOpacityStale', '#unitOpacityMeshes',
  '#gameObjectFadeMeshes', '#applyGameObjectOpacity'].map(name => {
    const method = rendererClass.members.find(n => n.name?.getText(parsed) === name);
    assert.ok(method, name);
    return method.getText(parsed).replaceAll('#', '');
  });
const harnessCode = ts.transpileModule('class Harness { ' + methods.join('\n') + ' }', {
  compilerOptions: {target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.None},
}).outputText;
const Harness = Function('THREE', 'borrowFadedMaterials', 'returnBorrowedMaterials',
  'updateBorrowedMaterials', 'spawnFadeFactor', 'GAMEOBJECT_FADE_STEPS',
  'glowBodyMeshes', 'glowAnchorsOf', // 05.10: ревью E2
  harnessCode + '; return Harness;')(
    THREE, rendererExports.borrowFadedMaterials, rendererExports.returnBorrowedMaterials,
    rendererExports.updateBorrowedMaterials, spawnFadeFactor, 6, glowBodyMeshes, glowAnchorsOf);
function harness() {
  const h = new Harness();
  h.programWarmup = {registerObject() {}};
  return h;
}
function unitFixture() {
  const shared = [new THREE.MeshBasicMaterial({opacity:.8}), new THREE.MeshStandardMaterial()];
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), shared);
  return {shared, mesh, unit:{material:new THREE.MeshStandardMaterial(), unitOpacity:1, visual:mesh,
    attached:new Map(), shadowCaster:true}};
}

test('a unit spawn fade keeps its materials and shader owners across opacity steps', () => {
  const h = harness(), {shared,mesh,unit} = unitFixture();
  h.applyUnitOpacity(unit, 0);
  const copies = mesh.material;
  let disposed = 0;
  copies.forEach(m => m.addEventListener('dispose', () => disposed++));
  for (const factor of [.1,.2,.4,.6,.8,.35]) {
    h.applyUnitOpacity(unit, factor);
    assert.ok(mesh.material === copies, 'an opacity change must retain the compiled material owners');
    assert.equal(disposed, 0, 'shader programs must not be released while the fade is active');
    assert.equal(copies[0].opacity, shared[0].opacity * factor);
    assert.equal(shared[0].opacity, .8, 'other units still read the unchanged shared source');
  }
  h.applyUnitOpacity(unit, 1);
  assert.equal(mesh.material, shared);
  assert.equal(disposed, copies.length);
  h.applyUnitOpacity(unit, 1);
  assert.equal(disposed, copies.length, 'settled frames never dispose twice');
});

test('game-object fade steps retain the same private materials until full opacity', () => {
  const h = harness(), {shared,mesh} = unitFixture();
  const rendered = {visual:mesh, admittedAt:1000};
  h.applyGameObjectOpacity(rendered, 1000);
  const copies = mesh.material;
  let disposed = 0;
  copies.forEach(m => m.addEventListener('dispose', () => disposed++));
  for (const now of [1040,1080,1160,1200,1280,1320]) {
    h.applyGameObjectOpacity(rendered, now);
    assert.ok(mesh.material === copies, 'quantized opacity must not cause recompilation either');
    assert.equal(copies[0].opacity, .8 * (Math.round(spawnFadeFactor(1000,now)*6)/6));
    assert.equal(disposed, 0);
  }
  h.applyGameObjectOpacity(rendered, 1400);
  assert.equal(mesh.material, shared);
  assert.equal(disposed, copies.length);
});

test('retained fade values match fresh copies for every authored blend mode, including zero', () => {
  for (let mode=0; mode<8; mode++) {
    const source = new THREE.MeshBasicMaterial({color:0x789abc, opacity:.8});
    applyBlendMode(source, mode);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), source);
    const borrows = rendererExports.borrowFadedMaterials([mesh], 0);
    const retained = mesh.material;
    for (const factor of [.1,.6,.3,0,.8]) {
      rendererExports.updateBorrowedMaterials(borrows, factor);
      const fresh = cloneMaterialFaded(source, factor);
      assert.equal(mesh.material, retained);
      assert.equal(retained.opacity, fresh.opacity, 'blend ' + mode);
      assert.equal(retained.alphaTest, fresh.alphaTest, 'blend ' + mode);
      assert.deepEqual(retained.color, fresh.color, 'blend ' + mode);
      assert.equal(retained.transparent, fresh.transparent, 'blend ' + mode);
      assert.equal(retained.depthWrite, fresh.depthWrite, 'blend ' + mode);
      fresh.dispose();
    }
    if (mode===1) {
      const version = retained.version;
      rendererExports.updateBorrowedMaterials(borrows, .4);
      assert.equal(retained.version, version, 'positive cutout thresholds are uniforms, not new variants');
    }
    rendererExports.returnBorrowedMaterials(borrows);
    assert.equal(mesh.material, source);
    assert.equal(source.opacity, .8);
  }
});

test('equipment arriving during a fade is borrowed and all shared sources are restored', () => {
  const h = harness(), {shared,mesh,unit} = unitFixture();
  h.applyUnitOpacity(unit, .35);
  const first = mesh.material;
  let retired = 0;
  first.forEach(m => m.addEventListener('dispose', () => retired++));
  const weaponSource = new THREE.MeshBasicMaterial();
  const weapon = new THREE.Mesh(new THREE.BufferGeometry(), weaponSource);
  unit.attached.set('weapon', weapon);
  h.applyUnitOpacity(unit, .35);
  assert.equal(retired, first.length, 'replaced borrowers release their previous private materials');
  assert.notEqual(weapon.material, weaponSource);
  assert.equal(weapon.material.opacity, .35);
  const second = mesh.material;
  h.applyUnitOpacity(unit, .5);
  assert.ok(mesh.material === second);
  assert.equal(weapon.material.opacity, .5);
  unit.attached.delete('weapon');
  h.applyUnitOpacity(unit, .5);
  assert.equal(weapon.material, weaponSource, 'a removed attachment releases its private copies');
  h.releaseUnitOpacity(unit);
  assert.equal(mesh.material, shared);
  assert.equal(unit.opacityBorrows, undefined);
});
// 05.10: ревью E2 (6.14) — a weapon's glow body is equipment too: a stealthed, invisible or spawning unit fades it
// with the blade instead of leaving a glowing effect floating at full strength.
test('a glow body on a weapon fades with its unit and gives its shared materials back', () => {
  const h = harness(), {unit} = unitFixture();
  const weaponSource = new THREE.MeshBasicMaterial();
  const weapon = new THREE.Mesh(new THREE.BufferGeometry(), weaponSource);
  attachGlowAnchors(weapon, {attachments: [{id: 4, bone: 0, position: [0, 0, 1]}]},
    glowPlacement([4], [null, null, null, null, 'Spells\Enchantments\Sparkle_A.m2']), 'unit:1:glow:15/right');
  unit.attached.set('weapon', weapon);
  h.applyUnitOpacity(unit, .35);
  const bodyShared = [new THREE.MeshBasicMaterial({opacity: .9})];
  const body = makeGlowBody({geometry: new THREE.BufferGeometry(), materials: bodyShared}, undefined);
  const anchors = glowAnchorsOf(weapon);
  anchors[0].wvm = {indices: new Uint16Array(3), batches: [{}]};
  mountGlowBodies(anchors, () => body);
  h.applyUnitOpacity(unit, .35);
  assert.notEqual(body.object.material, bodyShared, 'the body arriving mid-fade borrows faded copies');
  assert.equal(body.object.material[0].opacity, .9 * .35);
  h.applyUnitOpacity(unit, .5);
  assert.equal(body.object.material[0].opacity, .9 * .5);
  h.applyUnitOpacity(unit, 1);
  assert.ok(body.object.material === bodyShared, 'full opacity hands the shared array back');
  assert.equal(bodyShared[0].opacity, .9, 'the shared source is never written');
});
