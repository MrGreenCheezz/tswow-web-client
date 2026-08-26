import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { FRAME_WINDOW, FrameClock, RESELECT_DISTANCE, shouldReselect } from "../dist/code/browser/RenderStats.js";
import {
  instanceCapacity, instanceable, instanceableBuild, placeEnvironmentNode, ADT_MODEL_TO_SCENE,
} from "../dist/code/browser/WorldRenderer3D.js";
import { buildModel } from "../dist/code/browser/ModelBuild.js";

test("the frame clock reports the mean, the rate and the frame the player actually feels", () => {
  const clock = new FrameClock(100);
  assert.equal(clock.average, 0, "nothing measured is zero and not a division by it");
  assert.equal(clock.fps, 0);
  assert.equal(clock.worst, 0);

  for (let frame = 0; frame < 95; frame++) clock.add(16);
  for (let frame = 0; frame < 5; frame++) clock.add(80);
  assert.equal(clock.count, 100);
  assert.ok(Math.abs(clock.average - 19.2) < 1e-9, `${clock.average}`);
  assert.ok(Math.abs(clock.fps - 1000 / 19.2) < 1e-9);
  // The whole reason the worst frame is reported beside the mean: this run stutters five times a
  // second and its mean says 19 ms, which reads as a comfortable sixty. A ninety-fifth percentile
  // would say 16 here — 95% of these frames really are good — which is why it is the maximum.
  assert.equal(clock.worst, 80);
});

test("the frame window forgets, so a hitch does not haunt the reading forever", () => {
  const clock = new FrameClock(4);
  clock.add(100);
  clock.add(10);
  clock.add(10);
  clock.add(10);
  assert.ok(Math.abs(clock.average - 32.5) < 1e-9);
  // One more frame pushes the hitch out of the window entirely.
  clock.add(10);
  assert.equal(clock.count, 4);
  assert.ok(Math.abs(clock.average - 10) < 1e-9, `${clock.average}`);
  assert.equal(clock.worst, 10);
});

test("a frame time that is not a number is dropped rather than poisoning the mean", () => {
  const clock = new FrameClock(8);
  clock.add(16);
  clock.add(Number.NaN);
  clock.add(Number.POSITIVE_INFINITY);
  clock.add(-5);
  assert.equal(clock.count, 1);
  assert.equal(clock.average, 16);
  clock.reset();
  assert.equal(clock.count, 0);
  assert.equal(clock.average, 0);
  assert.equal(FRAME_WINDOW, 120, "two seconds at sixty");
});

test("the environment ranking is not redone for four yards of walking", () => {
  // It costs 1.26 ms a frame in Stormwind at the former 230-yard leash — 42,797 placements ranked
  // from scratch, standing still included. The live leash is 300 yards, but the placement budget
  // remains capped and four yards still cannot change what it picks.
  const at = { x: 100, y: 200, generation: 3 };
  assert.equal(shouldReselect(undefined, { x: 0, y: 0 }, 0), true, "the first frame has no answer yet");
  assert.equal(shouldReselect(at, { x: 100, y: 200 }, 3), false);
  assert.equal(shouldReselect(at, { x: 103, y: 200 }, 3), false);
  assert.equal(shouldReselect(at, { x: 100 + RESELECT_DISTANCE, y: 200 }, 3), true);
  assert.equal(shouldReselect(at, { x: 103, y: 203 }, 3), true, "diagonally is still a distance");
  // A tile landing adds placements, and standing still must not hide them.
  assert.equal(shouldReselect(at, { x: 100, y: 200 }, 4), true);
});

test("a model with emitters is never drawn as an instance", () => {
  // An instance has no object of its own, and `#updateEffects` places a torch's sparks by reading
  // the world matrix of the mesh holding the torch. Instancing one leaves its sparks at the map's
  // origin — visible from anywhere, and nowhere near the torch.
  const plain = { wvm: { particleEmitters: [], ribbonEmitters: [] } };
  assert.equal(instanceable(plain), true);
  assert.equal(instanceable({ wvm: { particleEmitters: [{}], ribbonEmitters: [] } }), false);
  assert.equal(instanceable({ wvm: { particleEmitters: [], ribbonEmitters: [{}] } }), false);
  // A building is drawn a room at a time and has no single mesh to copy.
  assert.equal(instanceable({ ...plain, wmo: {} }), false);
  // A stand-in shape is not the model.
  assert.equal(instanceable(undefined), false);
  assert.equal(instanceable({}), false);
});

test("a doodad with a blended material is not instanced", () => {
  // three sorts transparent *objects*, so a hundred copies that used to be a hundred entries in
  // that sorted list become one and stop being ordered among themselves — a blended doodad drawn
  // in buffer order shows through the one in front of it. Opaque and alpha-tested runs do not
  // care: their order is a hint about overdraw and nothing else.
  const opaque = new THREE.MeshBasicMaterial();
  const blended = new THREE.MeshBasicMaterial({ transparent: true });
  const cutout = new THREE.MeshBasicMaterial({ alphaTest: 224 / 255 });
  assert.equal(instanceableBuild(opaque), true);
  assert.equal(instanceableBuild(blended), false);
  assert.equal(instanceableBuild(cutout), true, "an alpha gate is not transparency");
  assert.equal(instanceableBuild([opaque, cutout]), true);
  assert.equal(instanceableBuild([opaque, blended]), false, "one blended run is enough");
});

test("an instanced draw grows in powers of two and never below two", () => {
  assert.equal(instanceCapacity(1), 2);
  assert.equal(instanceCapacity(2), 2);
  assert.equal(instanceCapacity(3), 4);
  assert.equal(instanceCapacity(4), 4);
  assert.equal(instanceCapacity(5), 8);
  assert.equal(instanceCapacity(24), 32);
  // The measured shape of the problem: inside Stormwind the selection is about 120 placements over
  // 8 to 14 distinct models, so the largest group is tens and not thousands.
  assert.equal(instanceCapacity(120), 128);
});

test("an instance matrix is the placement's own, so a copy stands where its node did", () => {
  // The whole safety of instancing rests on this: nothing is recomputed, the matrix is taken from
  // the mesh that would otherwise have been drawn. If the two ever disagreed, every barrel in
  // Stormwind would move.
  const object = {
    id: 1, kind: "m2", name: "BARRELLOWPOLY.M2",
    x: -8913.25, y: 554.5, z: 93.75,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1.25,
    quaternionX: 0, quaternionY: Math.SQRT1_2, quaternionZ: 0, quaternionW: Math.SQRT1_2,
  };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.quaternion.copy(ADT_MODEL_TO_SCENE);
  const node = placeEnvironmentNode(new THREE.Group(), object);
  node.add(mesh);
  node.matrixAutoUpdate = false;
  node.updateMatrix();
  node.updateMatrixWorld(true);
  const instance = mesh.matrixWorld.clone();

  // The same placement built the ordinary way, drawn with the matrix three would have composed.
  const reference = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  reference.quaternion.copy(ADT_MODEL_TO_SCENE);
  const referenceNode = placeEnvironmentNode(new THREE.Group(), object);
  referenceNode.add(reference);
  referenceNode.updateMatrixWorld(true);
  for (let element = 0; element < 16; element++) {
    assert.ok(Math.abs(instance.elements[element] - reference.matrixWorld.elements[element]) < 1e-9,
      `element ${element}: ${instance.elements[element]} vs ${reference.matrixWorld.elements[element]}`);
  }
});

test("a frozen placement keeps its matrix, and a room hung on it afterwards still lands", () => {
  // Placed scenery stops composing its matrices, which is only safe if two things hold: the frozen
  // node keeps the world matrix it was given, and a child added *after* the freeze still gets one.
  // The second is why buildings were at first exempted — wrongly: `updateMatrixWorld` recurses
  // into children whatever the parent's flags say, so a room hung on a frozen building lands.
  const scene = new THREE.Group();
  const node = placeEnvironmentNode(new THREE.Group(), {
    id: 2, kind: "wmo", name: "Stormwind.wmo",
    x: -8913.25, y: 554.5, z: 93.75,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  });
  scene.add(node);
  node.matrixAutoUpdate = false;
  node.updateMatrix();
  node.updateMatrixWorld(true);
  node.traverse((part) => {
    part.matrixAutoUpdate = false;
    part.matrixWorldAutoUpdate = false;
  });
  const frozen = node.matrixWorld.clone();

  const room = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  room.position.set(1, 2, 3);
  node.add(room);
  // A whole-scene update, which is what every frame does.
  scene.updateMatrixWorld(true);

  for (let element = 0; element < 16; element++) {
    assert.ok(Math.abs(node.matrixWorld.elements[element] - frozen.elements[element]) < 1e-9,
      "the frozen node kept its own placement");
  }
  const expected = new THREE.Vector3(1, 2, 3).applyMatrix4(frozen);
  assert.ok(Math.abs(room.matrixWorld.elements[12] - expected.x) < 1e-6, "the late room is placed");
  assert.ok(Math.abs(room.matrixWorld.elements[13] - expected.y) < 1e-6);
  assert.ok(Math.abs(room.matrixWorld.elements[14] - expected.z) < 1e-6);
});

test("a built model carries a bounding sphere that encloses it, computed once", () => {
  // Without one, three computes it lazily on the first frame the doodad is drawn — a second walk
  // over every vertex, on the worst frame to spend it. It has to enclose, or frustum culling drops
  // the model while part of it is still on screen.
  const positions = new Float32Array([0, 0, 0, 3, 0, 0, 0, 4, 0, -1, -2, 5]);
  const model = {
    positions,
    normals: new Float32Array(positions.length),
    uv0: new Float32Array(positions.length / 3 * 2),
    uv1: new Float32Array(positions.length / 3 * 2),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [{ submesh: 0, textures: [], uvSets: [0, 0], blendMode: 0, materialFlags: 0, renderFlags: 0, priority: 0, uvAnimation: -1, colour: -1, alpha: -1 }],
    textures: [],
    bounds: { min: [-1, -2, 0], max: [3, 4, 5], radius: 1 },
    particleEmitters: [], ribbonEmitters: [],
  };
  const built = buildModel(model, { modelPath: "X.M2", baseUrl: "", loadTexture: () => new THREE.Texture() });
  const sphere = built.geometry.boundingSphere;
  assert.ok(sphere, "the sphere is supplied rather than left to be computed later");
  const point = new THREE.Vector3();
  for (let index = 0; index < positions.length; index += 3) {
    point.set(positions[index], positions[index + 1], positions[index + 2]);
    assert.ok(sphere.containsPoint(point), `vertex ${index / 3} is outside the sphere`);
  }
  // And the file's own radius of 1 is nowhere near enough to hold it, which is why the box is used.
  assert.ok(sphere.radius > 1);
});
