import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  SHADOW_CASTER_PRUNE_FRAMES, ShadowCasterList, ShadowCasterRoot, referenceShadowWalk, shadowCasterKind,
} from "../dist/code/browser/ShadowCasterList.js";
import { RenderBone } from "../dist/code/browser/RenderBone.js";

const SHADOW_PROXY_LAYER = 29;
const SHADOW_FAR_LAYER = 30;

function box() {
  return new THREE.BoxGeometry(1, 1, 1);
}

function caster(list, parent, options = {}) {
  const material = options.material ?? new THREE.MeshStandardMaterial();
  const mesh = options.make ? options.make(material) : new THREE.Mesh(box(), material);
  mesh.castShadow = options.casts ?? true;
  if (options.layers) mesh.layers.set(options.layers[0]);
  for (const layer of options.layers?.slice(1) ?? []) mesh.layers.enable(layer);
  if (options.position) mesh.position.set(...options.position);
  parent.add(mesh);
  if (options.register !== false) list.set(mesh, mesh.castShadow, options.owner, options.gate, options.ref);
  return mesh;
}

/** A light frustum wide enough for the whole fixture except the one mesh placed far outside it. */
function lightView(layers) {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.5, 500);
  camera.position.set(0, 200, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const view = new THREE.Camera();
  view.layers.set(layers[0]);
  for (const layer of layers.slice(1)) view.layers.enable(layer);
  return { view, frustum };
}

/** The fixture: every case the list has to agree with three's own walk on. */
function fixture() {
  const list = new ShadowCasterList();
  const scene = new THREE.Scene();
  const environment = new THREE.Group();
  scene.add(environment);
  const meshes = {};
  // Plain scenery, a small prop that does not cast, and one outside the light frustum.
  meshes.tree = caster(list, environment);
  meshes.crate = caster(list, environment, { casts: false });
  meshes.outside = caster(list, environment, { position: [400, 0, 0] });
  // A hidden ancestor (a warm hold, a hidden room) hides its casters.
  const held = new THREE.Group();
  held.visible = false;
  environment.add(held);
  meshes.held = caster(list, held);
  // Retained scenery the view did not admit: its owner is hidden, gate 2 shows it to the shadow pass.
  const retained = new THREE.Group();
  retained.visible = false;
  environment.add(retained);
  const retainedRef = { gate: 2 };
  const gate = (ref) => ref.gate;
  meshes.retained = caster(list, retained, { owner: retained, gate, ref: retainedRef });
  // … but a hidden node below the owner still hides.
  const innerHidden = new THREE.Group();
  innerHidden.visible = false;
  retained.add(innerHidden);
  meshes.retainedHidden = caster(list, innerHidden, { owner: retained, gate, ref: retainedRef });
  // Layers: a proxy on 29 and a far caster on 0 + 30.
  meshes.proxy = caster(list, environment, { layers: [SHADOW_PROXY_LAYER] });
  meshes.far = caster(list, environment, { layers: [0, SHADOW_FAR_LAYER] });
  meshes.farOnly = caster(list, environment, { layers: [SHADOW_FAR_LAYER] });
  // Instanced, with and without colour, alpha-keyed foliage.
  meshes.instanced = caster(list, environment, { make: (material) => new THREE.InstancedMesh(box(), material, 4) });
  meshes.instancedColour = caster(list, environment, {
    make: (material) => {
      const mesh = new THREE.InstancedMesh(box(), material, 4);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      return mesh;
    },
  });
  meshes.leaves = caster(list, environment, {
    material: new THREE.MeshStandardMaterial({ alphaTest: 0.5, map: new THREE.Texture() }),
  });
  // A unit: a skinned body, its render bones (bone-only branches hidden), a sword under a bone.
  const units = new THREE.Group();
  scene.add(units);
  const unit = new THREE.Group();
  units.add(unit);
  const root = new RenderBone();
  const hand = new RenderBone();
  const toe = new RenderBone();
  root.add(hand, toe);
  const geometry = box();
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(geometry.attributes.position.count * 4), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 4), 4));
  meshes.body = caster(list, unit, { make: (material) => new THREE.SkinnedMesh(geometry, material) });
  meshes.body.add(root);
  meshes.body.bind(new THREE.Skeleton([root, hand, toe]));
  meshes.sword = caster(list, hand);
  // A hidden unit casts nothing.
  const hiddenUnit = new THREE.Group();
  hiddenUnit.visible = false;
  units.add(hiddenUnit);
  meshes.hiddenUnit = caster(list, hiddenUnit);
  scene.updateMatrixWorld(true);
  return { list, scene, meshes, retained, retainedRef, root, hand, toe, environment, unit };
}

const ids = (meshes) => meshes.map((mesh) => mesh.id).sort((a, b) => a - b);

function compare(list, scene, layers, shown) {
  const { view, frustum } = lightView(layers);
  const reference = [];
  referenceShadowWalk(scene, view, frustum, reference, shown);
  list.beginFrame(scene);
  const root = new ShadowCasterRoot();
  list.fill(root, 0);
  const got = [];
  referenceShadowWalk(root, view, frustum, got);
  return { reference, got, root };
}

test("the list hands three exactly the casters its walk of the scene would draw", () => {
  const { list, scene, meshes, retained } = fixture();
  // Bone-only branches are hidden by RenderBone; the hand carries the sword and stays visible.
  const shown = (node) => node === retained;
  for (const layers of [[0, SHADOW_PROXY_LAYER], [SHADOW_FAR_LAYER]]) {
    const { reference, got } = compare(list, scene, layers, shown);
    assert.deepEqual(ids(got), ids(reference), `layers ${layers}`);
    assert.equal(new Set(got).size, got.length, "nothing is handed over twice");
  }
  const { got } = compare(list, scene, [0, SHADOW_PROXY_LAYER], shown);
  for (const name of ["tree", "retained", "proxy", "far", "instanced", "instancedColour", "leaves", "body", "sword"]) {
    assert.ok(got.includes(meshes[name]), `${name} casts`);
  }
  for (const name of ["crate", "outside", "held", "retainedHidden", "farOnly", "hiddenUnit"]) {
    assert.ok(!got.includes(meshes[name]), `${name} does not cast`);
  }
  assert.equal(list.stats.shadowOnlyOwners, 1, "one owner shown for the shadow pass only");
  assert.ok(list.stats.nested >= 1, "the sword under the body's bones is reached through the body");
});

test("a gate of 0 or 1 keeps the owner's own visibility", () => {
  const { list, scene, meshes, retained, retainedRef } = fixture();
  retainedRef.gate = 1;
  let { got } = compare(list, scene, [0, SHADOW_PROXY_LAYER]);
  assert.ok(!got.includes(meshes.retained), "gate 1 with a hidden owner casts nothing");
  retained.visible = true;
  retainedRef.gate = 0;
  ({ got } = compare(list, scene, [0, SHADOW_PROXY_LAYER]));
  assert.ok(!got.includes(meshes.retained), "gate 0 casts nothing even when visible");
  retainedRef.gate = 1;
  ({ got } = compare(list, scene, [0, SHADOW_PROXY_LAYER]));
  assert.ok(got.includes(meshes.retained));
});

test("kinds are grouped, and odd views take them in the mirrored order", () => {
  const { list, scene } = fixture();
  list.beginFrame(scene);
  const root = new ShadowCasterRoot();
  const kindsOf = () => root.children.flatMap((group) => group.children).map((mesh) => shadowCasterKind(mesh));
  list.fill(root, 0);
  const even = kindsOf();
  list.fill(root, 1);
  const odd = kindsOf();
  const runs = (kinds) => kinds.filter((kind, index) => index === 0 || kinds[index - 1] !== kind);
  assert.deepEqual(runs(even), [0, 1, 2, 3], "plain, instanced, instanced-colour, skinned");
  assert.deepEqual(runs(odd), [3, 2, 1, 0]);
  assert.equal(even.at(-1), odd[0], "consecutive cascades meet on one kind");
  // Alpha-keyed meshes sit together inside their kind.
  list.fill(root, 0);
  const plain = root.children.slice(0, 2).map((group) => group.children.length);
  assert.ok(plain[1] >= 1, "the alpha-keyed plain mesh has its own run");
  // The kind groups borrow the meshes without adopting them.
  for (const group of root.children) for (const mesh of group.children) assert.notEqual(mesh.parent, group);
});

test("an entry whose chain no longer reaches the scene is dropped, and casts again when re-registered", () => {
  const { list, scene, meshes, environment } = fixture();
  environment.remove(meshes.tree);
  const before = list.stats.entries;
  for (let frame = 0; frame < SHADOW_CASTER_PRUNE_FRAMES - 1; frame++) list.beginFrame(scene);
  assert.equal(list.stats.entries, before, "a detached entry is kept for a while");
  environment.add(meshes.tree);
  list.beginFrame(scene);
  let { got } = compare(list, scene, [0, SHADOW_PROXY_LAYER]);
  assert.ok(got.includes(meshes.tree), "hung back in time, it casts at once");
  environment.remove(meshes.tree);
  for (let frame = 0; frame < SHADOW_CASTER_PRUNE_FRAMES; frame++) list.beginFrame(scene);
  assert.equal(list.stats.entries, before - 1);
  assert.ok(list.stats.pruned >= 1);
  assert.equal(list.has(meshes.tree), false);
  environment.add(meshes.tree);
  list.set(meshes.tree, true);
  ({ got } = compare(list, scene, [0, SHADOW_PROXY_LAYER]));
  assert.ok(got.includes(meshes.tree));
  list.set(meshes.tree, false);
  ({ got } = compare(list, scene, [0, SHADOW_PROXY_LAYER]));
  assert.ok(!got.includes(meshes.tree), "set(false) drops it at once");
});

test("a nested caster is drawn once, through its ancestor or on its own", () => {
  const { list, scene, meshes, retained } = fixture();
  const shown = (node) => node === retained;
  let { got, reference } = compare(list, scene, [0, SHADOW_PROXY_LAYER], shown);
  assert.equal(got.filter((mesh) => mesh === meshes.sword).length, 1);
  assert.equal(reference.filter((mesh) => mesh === meshes.sword).length, 1);
  // The body stops casting (a translucent fade): the sword is handed over by itself.
  meshes.body.castShadow = false;
  list.set(meshes.body, false);
  ({ got, reference } = compare(list, scene, [0, SHADOW_PROXY_LAYER], shown));
  assert.equal(got.filter((mesh) => mesh === meshes.sword).length, 1);
  assert.deepEqual(ids(got), ids(reference));
  assert.equal(list.stats.nested, 0);
});

test("a gate-2 caster that is its own hidden owner reaches three's walk only while shown", () => {
  const list = new ShadowCasterList();
  const scene = new THREE.Scene();
  // A legacy placement: `rendered.node` is the mesh itself.
  const legacy = caster(list, scene, { register: false });
  legacy.visible = false;
  list.set(legacy, true, legacy, () => 2, {});
  scene.updateMatrixWorld(true);
  const { view, frustum } = lightView([0, SHADOW_PROXY_LAYER]);
  const reference = [];
  referenceShadowWalk(scene, view, frustum, reference, (node) => node === legacy);
  assert.deepEqual(reference, [legacy], "the old toggle showed it");
  list.beginFrame(scene);
  const root = new ShadowCasterRoot();
  list.fill(root, 0);
  const hidden = [];
  referenceShadowWalk(root, view, frustum, hidden);
  assert.deepEqual(hidden, [], "three stops at its own visible = false");
  list.showShadowOnly();
  const shown = [];
  referenceShadowWalk(root, view, frustum, shown);
  list.hideShadowOnly();
  assert.deepEqual(shown, [legacy]);
  assert.equal(legacy.visible, false);
  assert.equal(list.stats.shadowOnlyOwners, 1);
});
