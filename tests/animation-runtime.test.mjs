import assert from "node:assert/strict";
import test from "node:test";
import { addSkinnedClips, buildSkinnedTemplateFrom, mergeSkinnedClips, skinnedClipsBoneSpan, instantiateSkinned } from "../dist/code/browser/AnimatedModel.js";
import * as THREE from "three";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── animation-clip-cache.test.mjs
{
function clip(animationId, bone = 1, channels = true) {
  return {
    animationId, duration: 1,
    channels: channels ? [{
      bone, kind: 0,
      times: Float32Array.from([0, 1]),
      values: Float32Array.from([0, 0, 0, 1, 0, 0]),
    }] : [],
  };
}

function rig(pivot = 2) {
  return {
    parents: Int16Array.from([-1, 0]),
    flags: Uint16Array.from([0, 0]),
    pivots: Float32Array.from([0, 0, 0, pivot, 0, 0]),
    clips: [clip(0)],
    animations: [0, 10, 11, 12, 13],
    globalChannels: [],
  };
}

function template(skeleton) {
  const built = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), skeleton, 2);
  assert.ok(built);
  return built;
}

test("appearance templates share compiled clips only for the exact decoded skeleton", () => {
  const skeleton = rig();
  const first = template(skeleton);
  const second = template(skeleton);
  assert.notStrictEqual(first.clips, second.clips);
  assert.notStrictEqual(first.overlayClips, second.overlayClips);
  assert.strictEqual(first.clips.get(0), second.clips.get(0));
  assert.strictEqual(first.overlayClips.get(0), second.overlayClips.get(0));
  first.clips.set(99, new THREE.AnimationClip("local", 1, []));
  assert.equal(second.clips.has(99), false);

  const differentRig = { ...skeleton, pivots: Float32Array.from([0, 0, 0, 5, 0, 0]) };
  const third = template(differentRig);
  assert.notStrictEqual(first.clips.get(0), third.clips.get(0));
  assert.equal(first.clips.get(0).tracks[0].values[0], 2);
  assert.equal(third.clips.get(0).tracks[0].values[0], 5);
});

test("incremental sidecar merge prioritizes wanted clips, counts empty entries, and reuses compilation", () => {
  const skeleton = rig();
  const first = template(skeleton);
  const second = template(skeleton);
  const sidecar = [clip(10), clip(11, 1, false), clip(12), clip(13)];
  const one = { maxClips: 1, milliseconds: Infinity };
  assert.deepEqual(mergeSkinnedClips(first, sidecar, { ...one, wanted: [13] }),
    { added: 1, complete: false });
  assert.equal(first.clips.has(13), true);
  assert.equal(first.clips.has(10), false);
  assert.deepEqual(mergeSkinnedClips(first, sidecar, one), { added: 1, complete: false });
  assert.deepEqual(mergeSkinnedClips(first, sidecar, one), { added: 0, complete: false });
  assert.deepEqual(mergeSkinnedClips(first, sidecar, one), { added: 1, complete: true });
  assert.equal(addSkinnedClips(first, sidecar), 0);

  assert.equal(addSkinnedClips(second, sidecar), 3);
  for (const id of [10, 12, 13]) {
    assert.strictEqual(first.clips.get(id), second.clips.get(id));
    assert.strictEqual(first.overlayClips.get(id), second.overlayClips.get(id));
  }
  assert.notStrictEqual(first.clips, second.clips);
});

test("incremental merge honors a soft time budget and resumes on the next call", () => {
  const built = template(rig());
  const sidecar = [clip(10), clip(12), clip(13)];
  skinnedClipsBoneSpan(sidecar);
  let tick = 0;
  const now = () => tick++;
  assert.deepEqual(mergeSkinnedClips(built, sidecar,
    { maxClips: 3, milliseconds: 1, now }), { added: 1, complete: false });
  assert.equal(built.clips.has(12), false);
  assert.deepEqual(mergeSkinnedClips(built, sidecar,
    { maxClips: 3, milliseconds: 1, now }), { added: 1, complete: false });
  assert.deepEqual(mergeSkinnedClips(built, sidecar,
    { maxClips: 3, milliseconds: 1, now }), { added: 1, complete: true });
});

test("validation reads a bounded part of a large channel list before compiling wanted clips", () => {
  const built = template(rig());
  let reads = 0;
  const channels = Array.from({ length: 400 }, () => ({
    get bone() { reads++; return 1; },
    kind: 1, times: Float32Array.from([0]), values: Float32Array.from([0, 0, 0, 1]),
  }));
  const sidecar = [{ animationId: 10, duration: 1, channels }, clip(13)];
  let tick = 0;
  let result = mergeSkinnedClips(built, sidecar, {
    wanted: [13], maxClips: 1, milliseconds: 3, now: () => tick++,
  });
  assert.deepEqual(result, { added: 0, complete: false });
  assert.ok(reads > 0 && reads <= 2, "indexing obeys the injected wall-clock budget");
  assert.equal(built.clips.has(10), false);
  assert.equal(built.clips.has(13), false);
  for (let call = 0; call < 20 && result.added === 0; call++) {
    const before = reads;
    result = mergeSkinnedClips(built, sidecar,
      { wanted: [13], maxClips: 1, milliseconds: Infinity });
    assert.ok(reads - before <= 64, "one call reads at most its bounded index step allowance");
    if (reads < channels.length) assert.equal(result.added, 0, "no clip is built before full validation");
  }
  assert.equal(reads, channels.length);
  assert.equal(result.added, 1);
  assert.equal(result.complete, false);
  assert.equal(built.clips.has(13), true, "wanted clip is first after validation");
  assert.equal(built.clips.has(10), false);
  assert.equal(addSkinnedClips(built, sidecar), 1, "full merge completes the remaining source");
});

test("a late wide channel rejects the whole sidecar before any valid clip is installed", () => {
  const built = template(rig());
  let reads = 0;
  const channels = Array.from({ length: 400 }, (_, at) => ({
    get bone() { reads++; return at === 399 ? 2 : 1; },
    kind: 1, times: Float32Array.from([0]), values: Float32Array.from([0, 0, 0, 1]),
  }));
  const sidecar = [clip(10), { animationId: 12, duration: 1, channels }];
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    let result;
    for (let call = 0; call < 20; call++) {
      const before = reads;
      result = mergeSkinnedClips(built, sidecar,
        { wanted: [10], maxClips: 1, milliseconds: Infinity });
      assert.ok(reads - before <= 64);
      assert.equal(built.clips.has(10), false);
      if (result.complete) break;
    }
    assert.deepEqual(result, { added: 0, complete: true });
    assert.equal(reads, channels.length);
    assert.equal(warnings, 1);
    assert.equal(skinnedClipsBoneSpan(sidecar), 3, "synchronous span API returns the full answer");
    assert.equal(addSkinnedClips(built, sidecar), 0);
  } finally {
    console.warn = warn;
  }
});
}

// ── animation-palette.test.mjs
{
function makeRig() {
  const count = 48;
  const template = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.from({ length: count }, (_, i) => i === 0 ? -1 : (i - 1) >>> 1),
    pivots: Float32Array.from({ length: count * 3 }, (_, i) => (i % 13 - 6) * .2),
    flags: new Uint16Array(count), animations: [0], globalChannels: [],
    clips: [{ animationId: 0, duration: 1, channels: Array.from({ length: count }, (_, bone) => ({
      bone, kind: 1, times: Float32Array.from([0, 1]),
      values: Float32Array.from([0, 0, 0, 1, Math.sin(bone * .01), 0, 0, Math.cos(bone * .01)]),
    })) }],
  }, 2);
  const rig = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  rig.mixer.clipAction(template.clips.get(0)).play();
  return rig;
}

function referencePalette(rig) {
  THREE.Skeleton.prototype.update.call(rig.skeleton);
  return rig.skeleton.boneMatrices.slice();
}

test('M2 pivot palettes avoid general 4x4 products for every bone', () => {
  const rig = makeRig();
  rig.root.updateMatrixWorld(true);
  const multiply = THREE.Matrix4.prototype.multiplyMatrices;
  let products = 0;
  THREE.Matrix4.prototype.multiplyMatrices = function (...args) {
    products++;
    return multiply.apply(this, args);
  };
  try { rig.skeleton.update(); }
  finally { THREE.Matrix4.prototype.multiplyMatrices = multiply; }
  assert.equal(products, 0, 'translation-only inverse binds require only the translated final column');
});

test('moving, rotated, nonuniformly scaled and reparented rigs retain reference palettes and GPU uploads', () => {
  const rig = makeRig(), scene = new THREE.Scene(), outer = new THREE.Group();
  scene.add(outer); outer.add(rig.root);
  rig.skeleton.computeBoneTexture();
  for (let frame = 0; frame < 90; frame++) {
    outer.position.set(frame * .3, -frame * .05, 3);
    outer.rotation.set(frame * .01, frame * -.02, frame * .03);
    outer.scale.set(1 + frame * .01, .7, 1.3);
    rig.root.position.set(.5, -.3, frame * .02);
    rig.mixer.update(1 / 120);
    if (frame === 30) scene.attach(rig.root);
    if (frame === 60) outer.attach(rig.root);
    scene.updateMatrixWorld(true);
    const expected = referencePalette(rig);
    const version = rig.skeleton.boneTexture.version;
    rig.skeleton.update();
    assert.deepEqual(rig.skeleton.boneMatrices, expected, `palette at frame ${frame}`);
    assert.equal(rig.skeleton.boneTexture.version, version + 1);
    assert.equal(rig.skeleton.boneTexture.image.data, rig.skeleton.boneMatrices);
  }
});

test('edited inverse binds and recalculated bind poses still use the full matrix contract', () => {
  const rig = makeRig();
  rig.root.position.set(4, -3, 2);
  rig.mixer.update(.3);
  rig.root.updateMatrixWorld(true);
  rig.skeleton.boneInverses[3].makeRotationY(.6);
  rig.skeleton.boneInverses[7].makeScale(.7, 1.2, .9);
  rig.skeleton.boneInverses[9].elements[3] = .1;
  rig.skeleton.boneInverses[11] = new THREE.Matrix4().makeTranslation(5, -6, 7);
  let expected = referencePalette(rig);
  rig.skeleton.update();
  assert.deepEqual(rig.skeleton.boneMatrices, expected);
  rig.skeleton.calculateInverses();
  rig.mixer.update(.2);
  rig.root.updateMatrixWorld(true);
  expected = referencePalette(rig);
  rig.skeleton.update();
  assert.deepEqual(rig.skeleton.boneMatrices, expected);
});
}

// ── animation-rig-performance.test.mjs
{
function makeTemplate(count = 96) {
  const parents = Int16Array.from({ length: count }, (_, index) => index === 0 ? -1 : (index - 1) >>> 1);
  const pivots = Float32Array.from({ length: count * 3 }, (_, index) => (index % 7) / 4);
  const channels = Array.from({ length: count }, (_, bone) => ({
    bone, kind: 0, times: Float32Array.from([0, 1]),
    values: Float32Array.from([0, 0, 0, bone / 96, 0, 0]),
  }));
  return buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents, pivots, flags: new Uint16Array(count),
    clips: [{ animationId: 0, duration: 1, channels }], animations: [0], globalChannels: [],
  }, 2);
}

test('new clips bind fixed rig bone names in linear work and keep each rig independent', () => {
  const count = 192, template = makeTemplate(count);
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  let nameReads = 0;
  for (const bone of instance.skeleton.bones) {
    const name = bone.name;
    Object.defineProperty(bone, 'name', { get() { nameReads++; return name; } });
  }
  instance.mixer.clipAction(template.clips.get(0)).play();
  assert.ok(nameReads <= count * 3, `expected O(bones) binding reads, got ${nameReads}`);
  instance.mixer.update(0.5);
  for (let index = 0; index < count; index++) {
    const parent = template.parents[index];
    const rest = template.pivots[index * 3] - (parent >= 0 ? template.pivots[parent * 3] : 0);
    assert.ok(Math.abs(instance.skeleton.bones[index].position.x - rest - index / 192) < 1e-6);
  }
});

test('mount clips use their own indexed bones after the rider is parented into the rig', () => {
  const template = makeTemplate(32), material = new THREE.MeshBasicMaterial();
  const mount = instantiateSkinned(template, material), rider = instantiateSkinned(template, material);
  mount.skeleton.bones[0].add(rider.root);
  const riderBefore = rider.skeleton.bones.map(bone => bone.position.clone());
  mount.mixer.clipAction(template.clips.get(0)).play();
  mount.mixer.update(0.5);
  for (let index = 0; index < rider.skeleton.bones.length; index++) {
    assert.deepEqual(rider.skeleton.bones[index].position, riderBefore[index]);
    assert.equal(mount.skeleton.getBoneByName(`bone${index}`), mount.skeleton.bones[index]);
    assert.equal(rider.skeleton.getBoneByName(`bone${index}`), rider.skeleton.bones[index]);
  }
  mount.skeleton.bones[3].name = 'renamed';
  assert.equal(mount.skeleton.getBoneByName('bone3'), undefined);
  assert.equal(mount.skeleton.getBoneByName('renamed'), mount.skeleton.bones[3]);
});
}
