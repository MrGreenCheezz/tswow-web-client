import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import * as animation from '../dist/code/browser/AnimatedModel.js';
import { boneOf } from '../dist/code/browser/Attachment.js';
import { BONE_SPHERICAL_BILLBOARD as SPHERE, BONE_CYLINDRICAL_BILLBOARD_X as X,
  BONE_CYLINDRICAL_BILLBOARD_Y as Y, BONE_CYLINDRICAL_BILLBOARD_Z as Z } from '../dist/code/browser/Wvm.js';
import { buildModelEffects, updateModelEffects, disposeModelEffects } from '../dist/code/browser/ParticleRender.js';
import { placeOnAttachmentBone } from '../dist/code/browser/WorldRenderer3D.js';
import { UnitSceneGroup } from '../dist/code/browser/UnitSceneGroup.js';
import { effectFixture, compareArrays } from './fixtures/billboard-effects.mjs';

// Execute the actual private reader without constructing WebGL. This is the production seam
// that must refresh the requested path when #animateUnit defers its full matrix propagation.
const source = readFileSync(new URL('../src/browser/WorldRenderer3D.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('renderer.ts', source, ts.ScriptTarget.ES2022, true);
const renderer = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'WorldRenderer3D');
const reader = renderer?.members.find(member => member.name?.getText(parsed) === '#attachmentBone');
assert.ok(reader, 'production attachment reader exists');
const readerJs = ts.transpileModule(`class Harness { ${reader.getText(parsed).replaceAll('#', '')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const ReaderHarness = Function('boneOf', `${readerJs}; return Harness;`)(boneOf);

function templateOf(flags) {
  const parents = Int16Array.from([-1, 0, 1, 2, 2, 1, 5, 6]);
  const pivots = Float32Array.from([0, 0, 1.8, 0, 0, 1.2, 0, 0, 1, 0, -.2, .5,
    0, .2, .5, 0, 0, 1.5, 0, 0, 1.6, 0, 0, 1.7]);
  return animation.buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents, pivots, flags: Uint16Array.from(flags), animations: [0],
    clips: [{ animationId: 0, duration: 1, channels: Array.from({ length: 8 }, (_, bone) => ({
      bone, kind: 1, times: Float32Array.from([0, 1]), values: Float32Array.from([
        0, 0, 0, 1, Math.sin(.1 + bone * .04), 0, 0, Math.cos(.1 + bone * .04)]),
    })) }],
    globalChannels: [{ bone: 4, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, .1, .2, .3]) }],
  }, 2);
}
const material = new THREE.MeshBasicMaterial(), loops = Uint32Array.from([1000]);
const view = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
function setup(api, template, mounted) {
  const scene = new THREE.Scene(), outer = new THREE.Group(), unit = new UnitSceneGroup();
  scene.add(outer); outer.add(unit);
  const body = api.instantiateSkinned(template, material), mount = mounted ? api.instantiateSkinned(template, material) : undefined;
  if (mount) { unit.add(mount.root); mount.skeleton.bones[6].add(body.root); }
  else unit.add(body.root);
  const rigs = mount ? [mount, body] : [body];
  for (const rig of rigs) rig.mixer.clipAction(template.clips.get(0)).play();
  const equipment = new THREE.Group(), detail = new THREE.Object3D(), spell = new THREE.Object3D();
  body.skeleton.bones[7].add(equipment); equipment.add(detail); detail.position.set(.1, .2, .3); scene.add(spell);
  const effects = buildModelEffects(effectFixture(4), { baseUrl: '', loadTexture: () => new THREE.Texture(), seed: 42 });
  scene.add(effects.group);
  const reader = new ReaderHarness();
  reader.units = new Map([[1n, { skinned: body, wvm: { attachments: [{ id: 7, bone: 7, position: [0, 0, 0] }] } }]]);
  return { api, scene, outer, unit, rigs, body, mount, equipment, detail, spell, effects, reader };
}

for (const mounted of [false, true]) for (const flags of [[0, 0, SPHERE, 0, 0, SPHERE, SPHERE, 0], [0, 0, X, Y, 0, Z, SPHERE, 0]]) {
  test(`deferred billboard ${mounted ? 'mounted' : 'unit'} pose preserves render, spell attachments and actual particle/ribbon output (${flags})`, () => {
    const template = templateOf(flags), states = [setup(animation, template, mounted), setup(animation, template, mounted)];
    const camera = new THREE.PerspectiveCamera(), offset = new THREE.Vector3(.11, .22, .33), skin = new THREE.Matrix4();
    let nonemptyEffects = false, staleWithoutGuard = false;
    for (let frame = 0; frame < 120; frame++) {
      camera.position.set(Math.cos(frame * .04) * 6, 2 + Math.sin(frame * .02), Math.sin(frame * .04) * 6);
      camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
      for (const [side, state] of states.entries()) {
        state.outer.rotation.set(.1, frame * .01, .3);
        state.outer.scale.set(1.1 + Math.sin(frame * .03) * .2, .9, 1.2);
        state.unit.position.set(2 + Math.sin(frame * .1), 3, 4);
        state.unit.visible = frame < 70 || frame > 75;
        state.body.root.scale.setScalar(1 + Math.sin(frame * .02) * .1);
        state.equipment.rotation.y = frame * .07;
        if (state.mount) {
          // Exercise the same parent and inverse nesting changes as mount/unmount and scale auras.
          (frame >= 45 && frame < 55 ? state.unit : state.mount.skeleton.bones[6]).add(state.body.root);
          state.mount.root.scale.setScalar(.7 + frame * .001);
          state.body.root.position.set(.1, .2, .3);
        }
        for (const rig of state.rigs) {
          rig.mixer.update(1 / 60);
          state.api.applyGlobalSequenceBones(rig, template, loops, frame * 1000 / 60);
          state.api.applyStrafeYaw(rig, { pelvis: 1, torso: [5] }, frame % 40 < 20 ? .3 : 0);
        }
        for (const rig of state.rigs) state.api.applyBillboardBones(rig, template, camera, side === 0);

        // #updateVisuals runs before both effects and scene.render. Execute its actual attachment
        // reader: raw matrixWorld on unrelated attachment bone 7 would otherwise stay stale.
        const bone = state.body.skeleton.bones[7], stale = bone.matrixWorld.clone();
        if (side) assert.equal(state.reader.attachmentBone(1n, 7), bone);
        if (side && compareArrays(stale.elements, bone.matrixWorld.elements) > 1e-9) staleWithoutGuard = true;
        placeOnAttachmentBone(bone.matrixWorld, offset, .8, state.spell);
        state.spell.updateMatrix();

        // The current #updateEffects contract explicitly refreshes the complete rig before
        // sampling skin matrices. Test the real particle and ribbon simulation, not just mocks.
        state.body.root.updateWorldMatrix(true, true);
        updateModelEffects(state.effects, 1 / 60, { matrixFor: bone => skin
          .multiplyMatrices(state.body.skeleton.bones[bone].matrixWorld, template.boneInverses[bone]).elements,
        animationMs: frame * 1000 / 60, worldMs: frame * 1000 / 60 }, view);
        nonemptyEffects ||= state.effects.emitters.every(e => e.geometry.drawRange.count > 0);
        state.scene.updateMatrixWorld();
        // Three does not submit a hidden UnitSceneGroup or upload its palettes. Explicit spell
        // and effect readers above still run while hidden; full rendering must match on reveal.
        if (state.unit.visible) for (const rig of state.rigs) rig.skeleton.update();
      }
      const [a, b] = states;
      assert.ok(compareArrays(a.spell.matrix.elements, b.spell.matrix.elements) < 1e-9, `spell frame ${frame}`);
      assert.ok(compareArrays(a.detail.matrixWorld.elements, b.detail.matrixWorld.elements) < 1e-9, `equipment frame ${frame}`);
      for (let i = 0; i < a.rigs.length; i++) {
        if (!a.unit.visible) continue;
        for (let bone = 0; bone < 8; bone++) assert.ok(compareArrays(a.rigs[i].skeleton.bones[bone].matrixWorld.elements,
          b.rigs[i].skeleton.bones[bone].matrixWorld.elements) < 1e-9, `world frame ${frame}, rig ${i}, bone ${bone}`);
        assert.deepEqual(a.rigs[i].skeleton.boneMatrices, b.rigs[i].skeleton.boneMatrices, `palette frame ${frame}`);
      }
      for (let i = 0; i < a.effects.emitters.length; i++) {
        const ae = a.effects.emitters[i], be = b.effects.emitters[i];
        assert.equal(ae.geometry.drawRange.count, be.geometry.drawRange.count);
        for (const attr of ['positions', 'uvs', 'colors']) assert.deepEqual(ae.buffers[attr], be.buffers[attr], `effect ${i} ${attr}, frame ${frame}`);
      }
    }
    assert.ok(staleWithoutGuard, 'the raw spell reader test exercises genuinely stale world matrices');
    assert.ok(nonemptyEffects, 'both particle and ribbon geometry was generated');
    for (const state of states) { disposeModelEffects(state.effects); for (const rig of state.rigs) state.api.disposeSkinnedInstance(rig); }
  });
}

test('deferral removes the full subtree visit until render and keeps the default immediate contract', () => {
  const template = templateOf([0, 0, SPHERE, 0, 0, 0, 0, 0]);
  const state = setup(animation, template, false), camera = new THREE.PerspectiveCamera();
  let visits = 0;
  const update = state.detail.updateWorldMatrix;
  state.detail.updateWorldMatrix = function (...args) { visits++; return update.apply(this, args); };
  state.body.mixer.update(.1); state.unit.position.x = 4;
  animation.applyBillboardBones(state.body, template, camera, false);
  assert.equal(visits, 0);
  state.scene.updateMatrixWorld();
  const rendered = state.detail.matrixWorld.clone();
  animation.applyBillboardBones(state.body, template, camera);
  assert.equal(visits, 1, 'default still updates unrelated equipment immediately');
  assert.deepEqual(state.detail.matrixWorld, rendered);
  disposeModelEffects(state.effects); animation.disposeSkinnedInstance(state.body);
});

test('the production attachment reader refreshes a hidden mounted bone without visiting unrelated children', () => {
  const template = templateOf([0, 0, SPHERE, 0, 0, 0, 0, 0]);
  const state = setup(animation, template, true);
  state.scene.updateMatrixWorld();
  state.unit.visible = false;
  state.unit.position.set(7, 3, 2);
  state.outer.scale.set(1.4, .6, 1.2);
  state.mount.skeleton.bones[6].rotation.z = .5;
  state.body.skeleton.bones[7].position.x += .4;
  const bone = state.body.skeleton.bones[7], before = bone.matrixWorld.clone();
  let unrelatedVisits = 0;
  const updateDetail = state.detail.updateWorldMatrix;
  state.detail.updateWorldMatrix = function (...args) { unrelatedVisits++; return updateDetail.apply(this, args); };
  assert.equal(state.reader.attachmentBone(1n, 7), bone);
  assert.equal(unrelatedVisits, 0, 'refresh only the target path, not equipment beneath it');
  const read = bone.matrixWorld.clone();
  assert.notDeepEqual(read, before, 'the hidden saddle and bone movement reached the reader');
  state.body.root.updateWorldMatrix(true, true);
  assert.deepEqual(read, bone.matrixWorld, 'the returned matrix was already the complete current world transform');
  assert.equal(state.reader.attachmentBone(1n, 999), undefined);
  assert.equal(state.reader.attachmentBone(999n, 7), undefined);
  state.reader.units.set(2n, {});
  assert.equal(state.reader.attachmentBone(2n, 7), undefined);
  disposeModelEffects(state.effects);
  for (const rig of state.rigs) animation.disposeSkinnedInstance(rig);
});
