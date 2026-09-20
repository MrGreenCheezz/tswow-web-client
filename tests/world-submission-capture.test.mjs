import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { WorldSubmissionCapture } from '../dist/code/browser/WorldSubmissionCapture.js';

function fixture(t) {
  let time = 1000;
  const tick = ms => { time += ms; };
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const bone = new THREE.Bone();
  scene.add(bone);
  const skeleton = new THREE.Skeleton([bone]);
  const nativeSkeleton = THREE.Skeleton.prototype.update;
  THREE.Skeleton.prototype.update = function () { tick(3); return nativeSkeleton.call(this); };
  t.after(() => { THREE.Skeleton.prototype.update = nativeSkeleton; });
  const matrices = scene.updateMatrixWorld;
  scene.updateMatrixWorld = function (force) { tick(2); matrices.call(this, force); };
  const mesh = new THREE.SkinnedMesh(), plain = new THREE.Mesh();
  const geometry = new THREE.BufferGeometry(), material = new THREE.MeshBasicMaterial();
  let throwOnDraw = false;
  const renderer = {
    info: { render: { calls: 0 } },
    shadowMap: { render(_lights, inputScene, inputCamera) {
      assert.equal(this, renderer.shadowMap);
      assert.equal(inputScene, scene); assert.equal(inputCamera, camera);
      tick(5); skeleton.update(); draw(mesh); tick(7);
    } },
    renderBufferDirect(inputCamera, inputScene, inputGeometry, inputMaterial, object) {
      assert.equal(this, renderer);
      assert.equal(inputScene, scene); assert.equal(inputCamera, camera);
      assert.equal(inputGeometry, geometry); assert.equal(inputMaterial, material);
      tick(4);
      if (throwOnDraw) throw new Error('intentional draw failure');
      this.info.render.calls += object.userData.draws ?? 1;
    },
    render(inputScene, inputCamera) {
      assert.equal(this, renderer);
      assert.equal(inputScene, scene); assert.equal(inputCamera, camera);
      tick(1); scene.updateMatrixWorld(); skeleton.update();
      this.shadowMap.render([], scene, camera);
      draw(mesh); draw(plain);
      plain.userData.draws = 0; draw(plain); delete plain.userData.draws;
      tick(1);
    },
  };
  function draw(object) { renderer.renderBufferDirect(camera, scene, geometry, material, object, null); }
  const originals = [scene.updateMatrixWorld, THREE.Skeleton.prototype.update,
    renderer.shadowMap.render, renderer.renderBufferDirect];
  const restored = () => assert.deepEqual([scene.updateMatrixWorld, THREE.Skeleton.prototype.update,
    renderer.shadowMap.render, renderer.renderBufferDirect], originals);
  return { scene, camera, skeleton, renderer, tick, restored, clock: () => time,
    fail: () => { throwOnDraw = true; }, recover: () => { throwOnDraw = false; } };
}

test('submission parts are exclusive and count actual draws, including shadow palettes', t => {
  const f = fixture(t), probe = new WorldSubmissionCapture(f.clock);
  assert.equal(probe.snapshot(), undefined);
  probe.render(f.renderer, f.scene, f.camera);
  const sample = probe.snapshot();
  assert.deepEqual(sample.partsMs, { matrices: 2, mainSkeletons: 3, mainDraws: 12,
    shadowSkeletons: 3, shadowDraws: 4, shadowOther: 12, other: 2 });
  assert.equal(sample.totalMs, 38);
  assert.equal(Object.values(sample.partsMs).reduce((a, b) => a + b), sample.totalMs);
  assert.deepEqual(sample.calls, { mainDraws: 2, shadowDraws: 1, mainSkinnedDraws: 1,
    shadowSkinnedDraws: 1, skeletonUpdates: 2, bonesUpdated: 2 });
  assert.equal(sample.hookSetupRestoreMs, 0);
  assert.equal(sample.failed, false);
  assert.deepEqual(Array.from(f.skeleton.boneMatrices), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  f.restored();
});

test('capture cadence is bounded and ordinary submissions still execute', t => {
  const f = fixture(t), probe = new WorldSubmissionCapture(f.clock);
  probe.render(f.renderer, f.scene, f.camera);
  const first = probe.snapshot();
  f.tick(50);
  probe.render(f.renderer, f.scene, f.camera);
  assert.equal(probe.snapshot().partsMs, first.partsMs, 'no sample before the 500-ms deadline');
  assert.equal(f.renderer.info.render.calls, 6, 'unsampled frame still drew everything');
  f.tick(500);
  probe.render(f.renderer, f.scene, f.camera);
  assert.notEqual(probe.snapshot().partsMs, first.partsMs);
  f.restored();
});

test('throwing draw restores every hook and releases the reentrancy guard', t => {
  const f = fixture(t), probe = new WorldSubmissionCapture(f.clock);
  f.fail();
  assert.throws(() => probe.render(f.renderer, f.scene, f.camera), /intentional draw failure/);
  assert.equal(probe.snapshot().failed, true);
  f.restored();
  f.recover();
  const next = new WorldSubmissionCapture(f.clock);
  next.render(f.renderer, f.scene, f.camera);
  assert.equal(next.snapshot().failed, false);
  f.restored();
});

test('inherited matrix method is restored without leaving an own property', t => {
  const f = fixture(t), probe = new WorldSubmissionCapture(f.clock);
  delete f.scene.updateMatrixWorld;
  assert.equal(Object.hasOwn(f.scene, 'updateMatrixWorld'), false);
  probe.render(f.renderer, f.scene, f.camera);
  assert.equal(Object.hasOwn(f.scene, 'updateMatrixWorld'), false);
  assert.equal(f.scene.updateMatrixWorld, THREE.Scene.prototype.updateMatrixWorld);
});

test('nested renderer capture cannot replace the outer prototype hooks', t => {
  const f = fixture(t), outer = new WorldSubmissionCapture(f.clock), inner = new WorldSubmissionCapture(f.clock);
  const normal = f.renderer.render;
  let nesting = false;
  f.renderer.render = function (...args) {
    if (!nesting) {
      nesting = true;
      try { inner.render(this, ...args); } finally { nesting = false; }
    } else normal.apply(this, args);
  };
  outer.render(f.renderer, f.scene, f.camera);
  assert.equal(inner.snapshot(), undefined);
  assert.equal(outer.snapshot().failed, false);
  f.restored();
});
