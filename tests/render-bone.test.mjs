import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { RenderBone } from '../dist/code/browser/RenderBone.js';
import {
  M2_TO_SCENE, buildSkinnedTemplateFrom, instantiateSkinned,
  applyGlobalSequenceBones, applyStrafeYaw, applyBillboardBones, skinDemandFor,
} from '../dist/code/browser/AnimatedModel.js';
import { BONE_SPHERICAL_BILLBOARD } from '../dist/code/browser/Wvm.js';

test('managed bone paths follow attachment add/remove, attach, clear and subtree reparenting', () => {
  const a = new RenderBone(), b = new RenderBone(), c = new RenderBone(), other = new RenderBone();
  a.add(b); b.add(c);
  assert.equal(a.visible, false); assert.equal(b.visible, false);
  const group = new THREE.Group();
  c.add(group);
  assert.ok(a.visible && b.visible && c.visible, 'empty unmanaged groups allow later renderable children');
  group.add(new THREE.Mesh()); group.visible = false;
  assert.equal(a.visible, true, 'attachment visibility remains on the attachment');
  group.removeFromParent();
  assert.equal(a.visible, false); assert.equal(b.visible, false); assert.equal(c.visible, false);
  c.attach(new THREE.PointLight());
  assert.ok(a.visible && b.visible && c.visible, 'attach bypasses add but still opens the path');
  other.add(b);
  assert.equal(a.visible, false); assert.ok(other.visible && b.visible);
  c.clear();
  assert.equal(other.visible, false); assert.equal(b.visible, false);
  const ordinaryBone = new THREE.Bone();
  c.add(ordinaryBone);
  assert.equal(other.visible, true, 'unmanaged bones are conservative because their children can change');
  ordinaryBone.add(new THREE.Mesh());
  assert.equal(other.visible, true);
  c.remove(ordinaryBone);
  assert.equal(other.visible, false);
  c.add(new THREE.Group(), new THREE.PointLight());
  assert.equal(other.visible, true);
  c.clear();
  assert.equal(other.visible, false);
});

test('cloned managed hierarchies track attachment mutations independently', () => {
  const root = new RenderBone(), child = new RenderBone();
  root.add(child); child.add(new THREE.Group());
  const copy = root.clone();
  assert.ok(copy.visible && copy.children[0].visible);
  copy.children[0].clear();
  assert.equal(copy.visible, false); assert.equal(root.visible, true);
  const shallow = root.clone(false);
  assert.equal(shallow.visible, false);
  shallow.add(new THREE.Group());
  assert.equal(shallow.visible, true);
});

test('managed bone rotation behaves as an ordinary bone and stays a plain data property', () => {
  const managed = new RenderBone(), ordinary = new THREE.Bone();
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, -1.1, .7, 'XYZ'));
  // The mixer path: a quaternion write through fromArray, as PropertyBinding performs it.
  for (const bone of [managed, ordinary]) bone.quaternion.fromArray(turn.toArray());
  assert.deepEqual(managed.rotation.toArray(), ordinary.rotation.toArray());
  for (const bone of [managed, ordinary]) bone.quaternion.slerp(new THREE.Quaternion(), .25);
  assert.deepEqual(managed.rotation.toArray(), ordinary.rotation.toArray());
  // Euler writes after a stale quaternion change start from the current angles, as before.
  for (const bone of [managed, ordinary]) bone.quaternion.set(0, .2, 0, Math.sqrt(1 - .04));
  for (const bone of [managed, ordinary]) bone.rotation.x = .5;
  assert.deepEqual(managed.quaternion.toArray(), ordinary.quaternion.toArray());
  assert.deepEqual(managed.rotation.toArray(), ordinary.rotation.toArray());
  for (const bone of [managed, ordinary]) bone.rotation.set(.1, .2, .3, 'ZYX');
  assert.deepEqual(managed.quaternion.toArray(), ordinary.quaternion.toArray());
  const copy = new RenderBone().copy(managed), plain = new THREE.Bone().copy(ordinary);
  assert.deepEqual(copy.rotation.toArray(), plain.rotation.toArray());
  assert.deepEqual(copy.quaternion.toArray(), plain.quaternion.toArray());
  assert.equal(managed.rotation, managed.rotation, 'the Euler object keeps its identity');
  // An accessor defined on the instance drops every bone into V8's dictionary mode, which made
  // each bone property read on the pose and matrix paths a hash lookup.
  for (const name of ['position', 'rotation', 'quaternion', 'scale']) {
    const descriptor = Object.getOwnPropertyDescriptor(managed, name);
    assert.ok(descriptor && 'value' in descriptor, `${name} is a data property`);
  }
});

function makeTemplate(count = 96) {
  const parents = Int16Array.from({ length: count }, (_, bone) => bone === 0 ? -1 : (bone - 1) >>> 1);
  const pivots = Float32Array.from({ length: count * 3 }, (_, index) => (index % 11) * .1);
  const flags = new Uint16Array(count);
  flags[10] = BONE_SPHERICAL_BILLBOARD; flags[12] = BONE_SPHERICAL_BILLBOARD;
  const channels = Array.from({ length: count }, (_, bone) => ({
    bone, kind: 1, times: Float32Array.from([0, 1]),
    values: Float32Array.from([0, 0, 0, 1, Math.sin(.1 + bone * .01), 0, 0, Math.cos(.1 + bone * .01)]),
  }));
  return buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents, pivots, flags, clips: [{ animationId: 0, duration: 1, channels }], animations: [0],
    globalChannels: [{ bone: 11, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, .1, .2, .3]) }],
  }, 2);
}

// Ordinary Three bones are the comparison path. Geometry, pivots, inverse matrices and clips
// are identical to instantiateSkinned; only render traversal visibility differs.
function ordinaryRig(template, material) {
  const root = new THREE.Group(); root.quaternion.copy(M2_TO_SCENE);
  const bones = [];
  for (let index = 0; index < template.parents.length; index++) {
    const bone = new THREE.Bone(), parent = template.parents[index];
    bone.name = `bone${index}`;
    bone.position.fromArray(template.pivots, index * 3);
    if (parent >= 0) {
      bone.position.sub(new THREE.Vector3().fromArray(template.pivots, parent * 3));
      bones[parent].add(bone);
    } else root.add(bone);
    bones.push(bone);
  }
  const mesh = new THREE.SkinnedMesh(template.geometry, material);
  mesh.frustumCulled = false; root.add(mesh);
  mesh.bind(new THREE.Skeleton(bones, template.boneInverses), new THREE.Matrix4());
  root.skeleton = mesh.skeleton;
  return { root, mesh, skeleton: mesh.skeleton, mixer: new THREE.AnimationMixer(root) };
}

const material = new THREE.MeshBasicMaterial(), attachmentGeometry = new THREE.BoxGeometry(.2, .3, .4);
function setup(template, instantiate) {
  const scene = new THREE.Scene(), unit = new THREE.Group(); scene.add(unit);
  const mount = instantiate(template, material), rider = instantiate(template, material);
  mount.mesh.name = 'body'; rider.mesh.name = 'rider';
  mount.mesh.castShadow = true; rider.mesh.castShadow = true;
  unit.add(mount.root);
  const rigs = [mount, rider];
  for (const rig of rigs) rig.mixer.clipAction(template.clips.get(0)).play();
  const gear = new THREE.Mesh(attachmentGeometry, material); gear.name = 'weapon'; gear.castShadow = true;
  const group = new THREE.Group(), later = new THREE.Mesh(attachmentGeometry, material);
  later.name = 'later'; later.castShadow = true;
  const light = new THREE.PointLight(); light.name = 'light';
  mount.skeleton.bones[7].add(gear); mount.skeleton.bones[9].add(group); mount.skeleton.bones[1].add(light);
  return { scene, unit, mount, rider, rigs, gear, group, later, light };
}

function visibleObjects(root, camera, shadow) {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const objects = [];
  function visit(object) {
    if (!object.visible) return;
    if (object.layers.test(camera.layers) && (object.isMesh || object.isLight) && (!shadow || object.castShadow)) {
      if (!object.isMesh || !object.frustumCulled || frustum.intersectsObject(object)) objects.push(object.name);
    }
    for (const child of object.children) visit(child);
  }
  visit(root); return objects.sort();
}

test('palettes and visible main/shadow objects match ordinary bones through mounted attachment changes', () => {
  const template = makeTemplate(), twins = [setup(template, ordinaryRig), setup(template, instantiateSkinned)];
  const camera = new THREE.PerspectiveCamera(55, 1, .1, 100), shadow = new THREE.PerspectiveCamera(80, 1, .1, 100);
  const globalSequences = Uint32Array.from([1000]);
  for (let frame = 0; frame < 120; frame++) {
    camera.position.set(Math.cos(frame * .02) * 7, 3, Math.sin(frame * .02) * 7);
    camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
    shadow.position.set(-4, 7, 3); shadow.lookAt(0, 1, 0); shadow.updateMatrixWorld(true);
    for (const state of twins) {
      const { mount, rider, gear, group, later, light } = state;
      state.unit.position.x = Math.sin(frame * .04) * .5; state.unit.rotation.y = frame * .01;
      if (frame === 5) group.add(later);
      if (frame === 15) mount.skeleton.bones[13].add(gear);
      if (frame === 25) mount.skeleton.bones[15].attach(gear);
      if (frame === 35) { mount.skeleton.bones[2].add(rider.root); rider.root.position.set(0, 0, 1); }
      if (frame === 45) rider.skeleton.bones[7].add(gear);
      if (frame === 55) group.visible = false;
      if (frame === 65) group.visible = true;
      if (frame === 75) gear.removeFromParent();
      if (frame === 85) light.removeFromParent();
      if (frame === 95) rider.root.removeFromParent();
      if (frame === 105) group.clear();
      for (const rig of state.rigs) {
        rig.mixer.update(1 / 60);
        applyGlobalSequenceBones(rig, template, globalSequences, frame * 1000 / 60);
        applyStrafeYaw(rig, { pelvis: 1, torso: [] }, .2);
        applyBillboardBones(rig, template, camera);
      }
      state.scene.updateMatrixWorld(true);
      for (const rig of state.rigs) { rig.root.updateWorldMatrix(true, true); rig.skeleton.update(); }
    }
    for (let rig = 0; rig < 2; rig++) {
      assert.deepEqual(twins[1].rigs[rig].skeleton.boneMatrices, twins[0].rigs[rig].skeleton.boneMatrices,
        `palette frame ${frame}, rig ${rig}`);
    }
    assert.deepEqual(visibleObjects(twins[1].scene, camera, false), visibleObjects(twins[0].scene, camera, false),
      `main drawables frame ${frame}`);
    assert.deepEqual(visibleObjects(twins[1].scene, shadow, true), visibleObjects(twins[0].scene, shadow, true),
      `shadow drawables frame ${frame}`);
  }
});

test('bone-only branches stop render traversal while every skeleton matrix remains current', () => {
  const template = makeTemplate(), a = setup(template, ordinaryRig), b = setup(template, instantiateSkinned);
  for (const state of [a, b]) {
    state.gear.removeFromParent(); state.group.removeFromParent(); state.light.removeFromParent();
    state.mount.mixer.update(.3); state.scene.updateMatrixWorld(true); state.mount.skeleton.update();
  }
  function visits(root) {
    let count = 0;
    function visit(object) { count++; if (!object.visible) return; for (const child of object.children) visit(child); }
    visit(root); return count;
  }
  assert.deepEqual(b.mount.skeleton.boneMatrices, a.mount.skeleton.boneMatrices);
  assert.equal(visits(a.scene), 4 + template.parents.length);
  assert.equal(visits(b.scene), 4 + [...template.parents].filter(parent => parent < 0).length);
});

// Forty drawn vertices weighted to four bones; ten more, outside every group, weighted to bone 90.
function weightedTemplate() {
  const template = makeTemplate();
  const drawn = [3, 20, 21, 44], vertices = 50;
  const position = new Float32Array(vertices * 3), skinIndex = new Uint16Array(vertices * 4);
  const skinWeight = new Float32Array(vertices * 4);
  for (let vertex = 0; vertex < vertices; vertex++) {
    position.set([Math.sin(vertex), vertex * .05, Math.cos(vertex)], vertex * 3);
    skinIndex.set([vertex < 40 ? drawn[vertex % 4] : 90, 60, 0, 0], vertex * 4);
    // Bone 60 is named on every vertex, always with zero weight: it moves nothing.
    skinWeight.set([1, 0, 0, 0], vertex * 4);
  }
  const geometry = template.geometry;
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(Array.from({ length: vertices }, (_, vertex) => vertex));
  geometry.addGroup(0, 24, 0); geometry.addGroup(24, 16, 0);
  return template;
}

test('skin demand names the weighted bones of drawn triangles and every ancestor above them', () => {
  const demand = skinDemandFor(weightedTemplate());
  assert.deepEqual([...demand.palette], [3, 20, 21, 44]);
  const expected = new Set();
  for (const bone of [3, 20, 21, 44]) for (let at = bone; at >= 0; at = (at - 1) >>> 1) { expected.add(at); if (at === 0) break; }
  assert.deepEqual([...demand.branch].flatMap((flag, bone) => flag ? [bone] : []), [...expected].sort((a, b) => a - b));
  assert.equal(skinDemandFor(makeTemplate()), undefined, 'a geometry without skin attributes demands every bone');
});

test('undrawn bone branches skip the render pass without changing palettes, explicit reads or attachments', () => {
  const template = weightedTemplate();
  const ordinary = setup(template, ordinaryRig), managed = setup(template, instantiateSkinned);
  for (const state of [ordinary, managed]) {
    state.gear.removeFromParent(); state.group.removeFromParent(); state.light.removeFromParent();
  }
  const camera = new THREE.PerspectiveCamera(55, 1, .1, 100);
  const palette = [...skinDemandFor(template).palette];
  const entries = (skeleton) => palette.map((bone) => [...skeleton.boneMatrices.subarray(bone * 16, bone * 16 + 16)]);
  let pending = 0, skipped = 0;
  for (let frame = 0; frame < 90; frame++) {
    camera.position.set(Math.cos(frame * .03) * 6, 2, Math.sin(frame * .03) * 6); camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld(true);
    // The renderer's crowd cadence: a pose every third frame, the frames between it frozen.
    const posed = frame % 3 === 0;
    pending += 1 / 60;
    if (frame === 30) { managed.mount.skeleton.bones[90].add(managed.later); ordinary.mount.skeleton.bones[90].add(ordinary.later); }
    for (const state of [ordinary, managed]) {
      state.unit.position.x = Math.sin(frame * .05); state.unit.rotation.y = frame * .02;
      const rig = state.mount;
      if (state === managed) rig.skeleton.setPoseFrozen(!posed);
      if (posed) {
        rig.mixer.update(pending);
        applyGlobalSequenceBones(rig, template, Uint32Array.from([1000]), frame * 1000 / 60);
        applyBillboardBones(rig, template, camera, false);
      }
      state.scene.updateMatrixWorld();
      rig.skeleton.update();
    }
    if (posed) pending = 0;
    assert.deepEqual(entries(managed.mount.skeleton), entries(ordinary.mount.skeleton), `palette frame ${frame}`);
    if (frame >= 30) {
      assert.deepEqual(managed.later.matrixWorld.elements, ordinary.later.matrixWorld.elements,
        `attachment on an undrawn bone, frame ${frame}`);
    } else if (!managed.mount.skeleton.bones[70].matrixWorld.equals(ordinary.mount.skeleton.bones[70].matrixWorld)) {
      skipped++;
    }
    if (frame % 7 === 0) {
      for (const bone of [60, 70, 90, 95]) {
        managed.mount.skeleton.bones[bone].updateWorldMatrix(true, false);
        ordinary.mount.skeleton.bones[bone].updateWorldMatrix(true, false);
        assert.deepEqual(managed.mount.skeleton.bones[bone].matrixWorld.elements,
          ordinary.mount.skeleton.bones[bone].matrixWorld.elements, `explicit read of bone ${bone}, frame ${frame}`);
      }
    }
  }
  assert.ok(skipped > 0, 'the undrawn branch was left out of the render pass');
});
