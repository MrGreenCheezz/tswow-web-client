import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import * as animation from '../dist/code/browser/AnimatedModel.js';
import * as world from '../dist/code/browser/WorldRenderer3D.js';
import * as spells from '../dist/code/browser/SpellVisuals.js';
import * as particles from '../dist/code/browser/ParticleRender.js';
import { boneOf } from '../dist/code/browser/Attachment.js';
import { updateBatchColours } from '../dist/code/browser/ModelBuild.js';
import { BONE_SPHERICAL_BILLBOARD as SPHERE, BONE_CYLINDRICAL_BILLBOARD_Z as CYLINDER } from '../dist/code/browser/Wvm.js';
import { effectFixture, compareArrays } from './fixtures/billboard-effects.mjs';
import * as missileFlight from '../dist/code/browser/MissileFlight.js'; // 05.10: ревью G2 — straight homing (slice E)

// Execute the production visual/effect passes without a WebGL constructor. Only asset loading,
// prewarming and expiry are stubbed; placement, billboards, admission and emitters are real.
const source = readFileSync(new URL('../src/browser/WorldRenderer3D.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('renderer.ts', source, ts.ScriptTarget.ES2022, true);
const renderer = parsed.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'WorldRenderer3D');
const methods = ['#updateVisuals', '#faceModelSpace', '#orientVisualFrame', '#applySpellVisualTransform',
  '#applySpellBillboards', '#attachmentBone', '#updateEffects'].map(name => {
  const member = renderer.members.find(m => m.name?.getText(parsed) === name);
  assert.ok(member, name);
  return member.getText(parsed).replaceAll('#', '');
});
const constants = ['EFFECT_RANGE', 'EFFECT_RANGE_SQUARED', 'EFFECT_BUDGET', 'EFFECT_BUILD_BUDGET',
  'VISUAL_EFFECT_BUDGET', 'EMPTY_EFFECTS', 'IDENTITY_MATRIX', '_scratchScale', // 05.10: ревью G2 — slice E dropped the arc scratch `_flightPoint`
  'IDENTITY_QUATERNION', 'M2_FROM_SCENE',
  '_missileSample', // 05.10: ревью G2 — slice E's homing sample
].map(name => {
  const declaration = parsed.statements.filter(ts.isVariableStatement)
    .flatMap(s => [...s.declarationList.declarations]).find(d => d.name.getText(parsed) === name);
  assert.ok(declaration, name);
  return `const ${declaration.getText(parsed)};`;
});
const js = ts.transpileModule(`${constants.join('\n')}\nclass Harness { ${methods.join('\n')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness(legacy) {
  const deps = { THREE, ...animation, ...world, ...spells, ...particles, ...missileFlight, boneOf, updateBatchColours }; // 05.10: ревью G2 — + MissileFlight
  if (legacy) {
    // Restore exactly the two former eager propagation points around the unchanged real passes.
    deps.applyGlobalSequenceBones = (...args) => {
      animation.applyGlobalSequenceBones(...args);
      args[0].root.updateMatrixWorld(true);
    };
    deps.applyBillboardBones = (instance, template, camera) => animation.applyBillboardBones(instance, template, camera);
  }
  const Harness = Function(...Object.keys(deps), `${js}; return Harness;`)(...Object.values(deps));
  const h = new Harness();
  Object.assign(h, {
    visuals: [], pendingVisualAnimations: [], units: new Map(), environment: new Map(), gameObjects: new Map(),
    effects: new Map(), visualGroup: new THREE.Group(), effectGroup: new THREE.Group(),
    camera: new THREE.PerspectiveCamera(), billboard: {}, boneMatrix: new THREE.Matrix4(),
    // 12.08: the effects pass culls emitters against the camera's frustum.
    effectFrustum: new THREE.Frustum(), effectFrustumMatrix: new THREE.Matrix4(),
    baseUrl: 'fixture', replaySeed: 12340, experimentalShaderProfile: { fantasyGlow: false },
    programWarmup: { registerObject() {} }, pumpSpellPrewarm() {}, markExpiredSpellEffectPhases() {},
    // A new set is held until its programs are warm; this harness has no warm pass, so nothing holds.
    effectWarmHold: { hold() {}, release() {}, forget() {}, clear() {} },
    purgeFailedSpellEffectPhases() {}, spellAssetState: () => ({ ready: true, failed: false }),
    acquireSpellTexture: () => new THREE.Texture(), spellAttachmentOffset: () => new THREE.Vector3(.13, .21, -.09),
    dropEffects(key) { const held = this.effects.get(key); if (held) particles.disposeModelEffects(held.effects); this.effects.delete(key); },
  });
  return h;
}

function templateOf(flags) {
  return animation.buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.from([-1, 0, 1, 2, 1, 4]),
    pivots: Float32Array.from([0, 0, 0, 0, 0, .2, 0, 0, .5, .1, 0, .8, -.1, 0, .6, .2, 0, 1]),
    flags: Uint16Array.from(flags), animations: [0],
    clips: [{ animationId: 0, duration: 2, channels: Array.from({ length: 6 }, (_, bone) => ({
      bone, kind: 1, times: Float32Array.from([0, 2]), values: Float32Array.from([
        0, 0, 0, 1, 0, Math.sin(.15 + bone * .04), 0, Math.cos(.15 + bone * .04)]),
    })) }],
    globalChannels: [{ bone: 4, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, .2, -.1, .3]) }],
  }, 2);
}

function fixture(legacy, kind, flags, withEmitters = true) {
  const h = harness(legacy), scene = new THREE.Scene(), template = templateOf(flags);
  scene.add(h.visualGroup, h.effectGroup);
  const material = new THREE.MeshBasicMaterial();
  const skinned = animation.instantiateSkinned(template, material);
  const node = new THREE.Group(), frame = new THREE.Group();
  node.add(frame); frame.add(skinned.root); h.visualGroup.add(node);
  const action = skinned.mixer.clipAction(template.clips.get(0)).play();
  const wvm = { ...effectFixture(5), globalSequences: Uint32Array.from([1000]) };
  if (!withEmitters) { wvm.particleEmitters = []; wvm.ribbonEmitters = []; }
  const instance = { path: 'fixture.m2', scale: .9, startedAt: 0, endsAt: Infinity,
    modelPlayback: 'hold', attachment: -1, position: { x: 1, y: 2, z: 3 },
    transform: { offset: [.1, .2, .3], rotation: [.1, .2, .3] } };
  if (kind === 'flight') instance.flight = { from: { x: 1, y: 2, z: 3 }, to: { x: 12, y: -3, z: 9 } };
  if (kind === 'flight') instance.endsAt = 10_000;
  const visual = { key: 'spell:fixture', handle: { id: 1 }, instance, node, frame, wvm, template, skinned, action,
    authoredEndsAt: instance.endsAt, playbackStartedAt: 0, effectsLoadDeadline: Infinity, effectsPhaseStatus: 'ready' };
  h.visuals.push(visual);
  const unitNode = new THREE.Group(), unitRig = animation.instantiateSkinned(template, material);
  const unitWvm = { attachments: [{ id: 7, bone: 3, position: [0, 0, 0] }], particleEmitters: [], ribbonEmitters: [] };
  unitNode.add(unitRig.root); scene.add(unitNode);
  const unit = { node: unitNode, skinned: unitRig, wvm: unitWvm, template, attached: new Map() }; // 05.10: ревью G2 — weapon glows (E) read `attached`
  if (kind === 'root' || kind === 'bone') { instance.anchor = 1n; h.units.set(1n, unit); }
  if (kind === 'bone') instance.attachment = 7;
  const detail = new THREE.Object3D(); detail.position.set(.1, .2, .3); skinned.skeleton.bones[5].add(detail);
  let visits = 0;
  for (const method of ['updateMatrixWorld', 'updateWorldMatrix']) {
    const original = detail[method];
    detail[method] = function(...args) { visits++; return original.apply(this, args); };
  }
  return { h, scene, visual, unit, unitRig, detail, visits: () => visits,
    dispose() { for (const key of h.effects.keys()) h.dropEffects(key); animation.disposeSkinnedInstance(skinned);
      animation.disposeSkinnedInstance(unitRig); material.dispose(); template.geometry.dispose(); } };
}

for (const kind of ['position', 'flight', 'root', 'bone']) for (const flags of [[0, 0, 0, 0, 0, 0], [0, SPHERE, 0, CYLINDER, 0, 0]]) {
  test(`spell propagation preserves ${kind} placement, global bones, particles and ribbons (${flags})`, () => {
    const states = [fixture(true, kind, flags), fixture(false, kind, flags)];
    let nonemptyParticles = false, nonemptyRibbons = false;
    try {
      for (let tick = 0; tick < 90; tick++) {
        const now = 100 + tick * 1000 / 60;
        for (const state of states) {
          const { h, scene, visual, unit, unitRig } = state;
          h.camera.position.set(Math.sin(tick * .06) * 8, 3, Math.cos(tick * .06) * 8);
          h.camera.lookAt(1, 2, 0); h.camera.updateMatrixWorld(true);
          unit.node.position.set(Math.sin(tick * .04) * 2, 1, 3);
          unit.node.rotation.set(.1, tick * .03, .2);
          unit.node.scale.set(1.2, .8, 1.1); unit.node.visible = tick < 45 || tick > 50;
          unitRig.skeleton.bones[3].rotation.x = tick * .02;
          // A preloaded future spell and an absent root remain hidden until eligible again.
          visual.instance.startedAt = tick >= 20 && tick < 25 ? now + 500 : 0;
          if (kind === 'root' && tick >= 60 && tick < 65) h.units.delete(1n);
          else if (kind === 'root' || kind === 'bone') h.units.set(1n, unit);
          if (kind === 'position') visual.instance.position.x = 1 + Math.sin(tick * .1);
          h.updateVisuals(now, 1 / 60, undefined);
          h.updateEffects({ x: 0, y: 0, z: 0 }, now, 1 / 60);
          scene.updateMatrixWorld();
          visual.skinned.skeleton.update();
          const emitters = h.effects.get(visual.key)?.effects.emitters;
          nonemptyParticles ||= (emitters?.[0]?.geometry.drawRange.count ?? 0) > 0;
          nonemptyRibbons ||= (emitters?.[1]?.geometry.drawRange.count ?? 0) > 0;
        }
        const [a, b] = states;
        assert.equal(a.visual.node.visible, b.visual.node.visible, `root visibility ${tick}`);
        assert.equal(a.visual.frame.visible, b.visual.frame.visible, `content visibility ${tick}`);
        assert.ok(compareArrays(a.visual.node.matrixWorld.elements, b.visual.node.matrixWorld.elements) < 1e-10);
        assert.ok(compareArrays(a.detail.matrixWorld.elements, b.detail.matrixWorld.elements) < 1e-10);
        assert.deepEqual(a.visual.skinned.skeleton.boneMatrices, b.visual.skinned.skeleton.boneMatrices, `palette ${tick}`);
        const ae = a.h.effects.get(a.visual.key)?.effects, be = b.h.effects.get(b.visual.key)?.effects;
        assert.equal(Boolean(ae), Boolean(be));
        if (ae) for (let i = 0; i < ae.emitters.length; i++) {
          assert.equal(ae.emitters[i].geometry.drawRange.count, be.emitters[i].geometry.drawRange.count);
          for (const attribute of ['positions', 'uvs', 'colors']) {
            assert.deepEqual(ae.emitters[i].buffers[attribute], be.emitters[i].buffers[attribute], `emitter ${i} ${attribute} ${tick}`);
          }
        }
      }
      assert.ok(nonemptyParticles && nonemptyRibbons, 'real particle and ribbon geometry was emitted');
    } finally { states.forEach(state => state.dispose()); }
  });
}

test('spell visuals defer full tree propagation until an emitter reader or scene submission needs it', () => {
  for (const emitters of [false, true]) for (const billboard of [0, SPHERE]) {
    const state = fixture(false, 'position', [0, billboard, 0, 0, 0, 0], emitters);
    try {
      state.h.updateVisuals(100, 1 / 60, undefined);
      assert.equal(state.visits(), 0, 'placing a billboard spell must not visit unrelated descendants');
      state.h.updateEffects({ x: 0, y: 0, z: 0 }, 100, 1 / 60);
      assert.equal(state.visits(), emitters ? 1 : 0, 'only a live emitter needs the early full propagation');
      state.scene.updateMatrixWorld();
      assert.equal(state.visits(), emitters ? 2 : 1, 'one final scene traversal remains');
      assert.notDeepEqual(state.detail.matrixWorld, new THREE.Matrix4(), 'ordinary submission still propagates the rig');
    } finally { state.dispose(); }
  }
});
