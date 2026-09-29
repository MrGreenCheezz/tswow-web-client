import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { readFile } from "node:fs/promises";
import {
  clonePortraitMaterials,
  PortraitRenderer,
  portraitLightingProfile,
} from "../dist/code/browser/PortraitRenderer.js";
import {
  applyWorldLight,
  createWorldLightUniforms,
} from "../dist/code/browser/WorldLighting.js";

function canvas(width = 4, height = 4) {
  const value = { width, height, dataset: {}, image: undefined };
  const context = {
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(image) { value.image = image; },
    clearRect() { value.image = undefined; },
  };
  value.getContext = () => context;
  return value;
}

function referenceSrgbByte(byte) {
  const linear = byte / 255;
  const srgb = linear <= 0.0031308
    ? 12.92 * linear
    : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, srgb)) * 255);
}

function fakeRenderer() {
  const state = {
    target: { name: "world" },
    viewport: new THREE.Vector4(3, 4, 5, 6),
    scissor: new THREE.Vector4(7, 8, 9, 10),
    scissorTest: true,
    clear: new THREE.Color(0x123456),
    alpha: 0.37,
    autoClear: false,
    reads: 0,
    renders: 0,
    visiblePortraitGroups: [],
    visibleBonePositions: [],
    targets: [],
    programs: new Map(),
    lifecycle: [],
    programCreations: 0,
  };
  const records = new Map();
  const profile = scene => scene.children.filter(child => child.isLight && child.visible)
    .map(child => child.type).sort().join(",");
  function acquirePrograms(scene, targetScene) {
    const materials = new Set();
    scene.traverseVisible(mesh => {
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        let record = records.get(material);
        if (!record) {
          record = { programs: new Map(), uniforms: {} };
          records.set(material, record);
          material.addEventListener("dispose", () => {
            for (const program of record.programs.values()) {
              if (--program.references === 0) {
                program.program = undefined;
                state.programs.delete(program.key);
              }
            }
            records.delete(material);
          });
        }
        const sides = material.transparent && material.side === THREE.DoubleSide
          ? [THREE.BackSide, THREE.FrontSide] : [material.side];
        for (const side of sides) {
          const key = JSON.stringify([material.type, material.customProgramCacheKey(), side,
            !!mesh.isSkinnedMesh, profile(targetScene)]);
          if (record.programs.has(key)) continue;
          let program = state.programs.get(key);
          if (!program) {
            program = { key, id: state.programCreations++, program: {}, references: 0,
              isReady: () => true, getUniforms: () => ({}) };
            state.programs.set(key, program);
          }
          program.references++;
          record.programs.set(key, program);
          record.currentProgram = program;
        }
      }
    });
    return materials;
  }
  const renderer = {
    extensions: { has: () => true },
    properties: { get: material => records.get(material) },
    getRenderTarget: () => state.target,
    setRenderTarget(value) { state.target = value; },
    getViewport: (value) => value.copy(state.viewport),
    setViewport(value, y, width, height) {
      if (value?.isVector4) state.viewport.copy(value);
      else state.viewport.set(value, y, width, height);
    },
    getScissor: (value) => value.copy(state.scissor),
    setScissor(value, y, width, height) {
      if (value?.isVector4) state.scissor.copy(value);
      else state.scissor.set(value, y, width, height);
    },
    getScissorTest: () => state.scissorTest,
    setScissorTest(value) { state.scissorTest = value; },
    getClearColor: (value) => value.copy(state.clear),
    setClearColor(value, alpha) { state.clear.copy(value); state.alpha = alpha; },
    getClearAlpha: () => state.alpha,
    clear() {},
    render(scene) {
      state.renders++;
      state.lifecycle.push({ kind: "render", profile: profile(scene) });
      acquirePrograms(scene, scene);
      const groups = scene.children.filter((child) => child.name?.startsWith("portrait-") && child.visible);
      state.visiblePortraitGroups.push(groups.length);
      const bones = [];
      for (const group of groups) group.traverse((child) => {
        if (child.isBone) bones.push(child.position.x);
      });
      state.visibleBonePositions.push(bones);
    },
    compile(scene, _camera, targetScene) {
      const materials = acquirePrograms(scene, targetScene);
      state.lifecycle.push({ kind: "compile", profile: profile(targetScene), materials: materials.size });
      return materials;
    },
    async readRenderTargetPixelsAsync(target, x, y, width, height, pixels) {
      state.reads++;
      state.targets.push(target);
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) pixels[(row * width + column) * 4] = row + 1;
      }
    },
    get autoClear() { return state.autoClear; },
    set autoClear(value) { state.autoClear = value; },
  };
  return { renderer, state };
}

function source(key = "human") {
  return {
    key,
    buildKey: "shared-build",
    model: {
      bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 2], radius: 1 },
      attachments: [],
      portraitCamera: {
        fov: Math.PI / 4, near: 0.1, far: 20,
        position: [2, 0, 1], target: [0, 0, 1],
      },
    },
    built: {
      geometry: new THREE.BoxGeometry(1, 1, 1), materials: [new THREE.MeshBasicMaterial()],
      height: 2, texturePaths: [], ownedTextures: [],
    },
    scale: 1,
  };
}

function skinnedSource(key = "rigged", liveBones) {
  return {
    ...source(key),
    template: {
      geometry: new THREE.BufferGeometry(),
      clips: new Map(), animations: new Set([1]),
      boneInverses: [new THREE.Matrix4()], parents: new Int16Array([-1]),
      pivots: new Float32Array([0, 0, 0]), flags: new Uint16Array([0]),
      billboards: [], height: 2,
    },
    ...(liveBones ? { liveBones } : {}),
  };
}

function deferredReadbacks(renderer, state) {
  const pending = [];
  renderer.readRenderTargetPixelsAsync = (target, _x, _y, width, height, pixels) => {
    state.reads++;
    state.targets.push(target);
    return new Promise((resolve, reject) => pending.push({
      width, height,
      resolve(value = 55) {
        for (let index = 0; index < pixels.length; index += 4) {
          pixels[index] = value;
          pixels[index + 1] = value;
          pixels[index + 2] = value;
          pixels[index + 3] = 255;
        }
        resolve(pixels);
      },
      reject,
    }));
  };
  return pending;
}

test("pending portrait readback never blocks or repeats a world frame and restores renderer state immediately", async () => {
  const { renderer, state } = fakeRenderer();
  const pending = deferredReadbacks(renderer, state);
  const output = canvas(2, 2);
  const current = source();
  const view = new PortraitRenderer(renderer, () => current);
  const previousTarget = state.target;
  view.setTargets(new Map([["player", { guid: 1n, canvas: output }]]));
  assert.equal(view.render(0), 1, "count submitted readbacks without waiting for the fence");
  assert.equal(output.image, undefined, "the 2D result is not available synchronously");
  assert.equal(state.target, previousTarget);
  assert.deepEqual(state.viewport.toArray(), [3, 4, 5, 6]);
  assert.deepEqual(state.scissor.toArray(), [7, 8, 9, 10]);
  assert.equal(state.scissorTest, true);
  assert.equal(state.autoClear, false);
  assert.equal(state.clear.getHex(), 0x123456);
  assert.equal(state.alpha, 0.37);
  assert.equal(view.needsPose(1n), false, "the submitted static pose does not need more world pose work");
  for (let frame = 1; frame <= 80; frame++) assert.equal(view.render(frame), 0);
  assert.equal(state.renders, 1);
  assert.equal(state.reads, 1, "at most one pending readback per slot");
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(output.dataset.portraitReady, "true");
  assert.equal(output.image.data[0], 128);
  assert.equal(output.image.data[3], 255);
  assert.equal(view.render(81), 0);
  view.dispose();
});

for (const change of ["guid", "guid-away-and-back", "source-key", "texture-revision", "canvas", "canvas-size", "missing-source"]) {
  test(`asynchronous portrait completion discards a stale ${change} without publishing old pixels`, async () => {
    const { renderer, state } = fakeRenderer();
    const pending = deferredReadbacks(renderer, state);
    const originalOutput = canvas(2, 2);
    let output = originalOutput;
    let current = source();
    const originalSource = current;
    const map = new THREE.Texture({ width: 1, height: 1 });
    current.built.materials[0].map = map;
    let guid = 1n;
    const view = new PortraitRenderer(renderer, () => current);
    const targets = () => new Map([["target", { guid, canvas: output }]]);
    view.setTargets(targets());
    assert.equal(view.render(0), 1);
    if (change === "guid") { guid = 2n; view.setTargets(targets()); }
    if (change === "guid-away-and-back") {
      guid = 2n; view.setTargets(targets());
      guid = 1n; view.setTargets(targets());
    }
    if (change === "source-key") current.key = "new-appearance";
    if (change === "texture-revision") map.needsUpdate = true;
    if (change === "canvas") { output = canvas(2, 2); view.setTargets(targets()); }
    if (change === "canvas-size") output.width = 4;
    if (change === "missing-source") current = undefined;
    // Deliberately settle without another render(): completion must validate live source/canvas state.
    pending[0].resolve();
    await Promise.resolve();
    assert.equal(originalOutput.image, undefined);
    assert.equal(output.image, undefined);
    if (!current) current = originalSource;
    assert.equal(view.render(1), 1, "the invalidated surface retries after its old fence settles");
    pending[1].resolve(100);
    await Promise.resolve();
    assert.equal(output.dataset.portraitReady, "true");
    assert.equal(output.image.data[0], referenceSrgbByte(100));
    view.dispose();
    map.dispose();
  });
}

test("clear and repopulate retain the per-slot pending limit and cannot publish the retired canvas", async () => {
  const { renderer, state } = fakeRenderer();
  const pending = deferredReadbacks(renderer, state);
  const first = canvas();
  const second = canvas();
  const view = new PortraitRenderer(renderer, () => source());
  view.setTargets(new Map([["target", { guid: 1n, canvas: first }]]));
  assert.equal(view.render(0), 1);
  view.clear();
  view.setTargets(new Map([["target", { guid: 2n, canvas: second }]]));
  for (let frame = 1; frame <= 20; frame++) assert.equal(view.render(frame), 0);
  assert.equal(pending.length, 1);
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(first.image, undefined);
  assert.equal(second.image, undefined);
  assert.equal(view.render(21), 1);
  pending[1].resolve();
  await Promise.resolve();
  assert.equal(second.dataset.portraitReady, "true");
  view.dispose();
});

test("dispose while a portrait fence is pending releases the model and ignores completion", async () => {
  const { renderer, state } = fakeRenderer();
  const pending = deferredReadbacks(renderer, state);
  const output = canvas();
  const current = source();
  const view = new PortraitRenderer(renderer, () => current);
  view.setTargets(new Map([["player", { guid: 1n, canvas: output }]]));
  assert.equal(view.render(0), 1);
  view.dispose();
  assert.equal(view.retainedBuilds().size, 0);
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(output.image, undefined);
  assert.equal(output.dataset.portraitReady, "false");
});

test("a rejected portrait readback preserves an existing snapshot and permits one later retry", async () => {
  const { renderer, state } = fakeRenderer();
  const pending = deferredReadbacks(renderer, state);
  const output = canvas();
  const current = source();
  const texture = new THREE.Texture();
  current.built.materials[0].map = texture;
  const view = new PortraitRenderer(renderer, () => current);
  view.setTargets(new Map([["player", { guid: 1n, canvas: output }]]));
  view.render(0);
  pending[0].resolve();
  await Promise.resolve();
  const snapshot = output.image;
  texture.needsUpdate = true;
  assert.equal(view.render(1), 1);
  assert.equal(view.render(2), 0);
  pending[1].reject(new Error("context loss while polling fence"));
  await Promise.resolve();
  assert.equal(output.image, snapshot);
  assert.equal(output.dataset.portraitReady, "true");
  assert.equal(view.render(3), 1);
  pending[2].resolve(100);
  await Promise.resolve();
  assert.notEqual(output.image, snapshot);
  assert.equal(output.image.data[0], referenceSrgbByte(100));
  view.dispose();
  texture.dispose();
});

test("independent portrait slots can complete in reverse order without sharing pixel buffers", async () => {
  const { renderer, state } = fakeRenderer();
  const pending = deferredReadbacks(renderer, state);
  const player = canvas(), target = canvas();
  const view = new PortraitRenderer(renderer, () => source());
  view.setTargets(new Map([["player", { guid: 1n, canvas: player }], ["target", { guid: 2n, canvas: target }]]));
  assert.equal(view.render(0), 2);
  pending[1].resolve(100);
  await Promise.resolve();
  assert.equal(target.image.data[0], referenceSrgbByte(100));
  assert.equal(player.image, undefined);
  pending[0].resolve(55);
  await Promise.resolve();
  assert.equal(player.image.data[0], referenceSrgbByte(55));
  assert.equal(target.image.data[0], referenceSrgbByte(100));
  view.dispose();
});

test("portrait program owners reuse exact variants after target retirement and drain larger light-profile batches", async () => {
  const { renderer, state } = fakeRenderer();
  const current = source("many-batches");
  current.built.materials = Array.from({ length: 7 }, (_, index) => {
    const material = new THREE.MeshStandardMaterial();
    material.customProgramCacheKey = () => `authored-batch-${index}`;
    return material;
  });
  const player = canvas(), target = canvas();
  const view = new PortraitRenderer(renderer, () => current);
  const targets = guid => new Map([["player", { guid: 1n, canvas: player }], ["target", { guid, canvas: target }]]);
  view.setTargets(targets(2n));
  assert.equal(view.render(0), 2);
  await Promise.resolve();
  const sequence = state.lifecycle;
  assert.deepEqual(sequence.map(event => event.kind), ["render", "compile", "compile", "render", "compile", "compile"],
    "retain already-rendered programs and finish all seven material entries before changing slot lights");
  assert.deepEqual(sequence.filter(event => event.kind === "compile").map(event => event.materials), [4, 3, 4, 3]);
  assert.notEqual(sequence[0].profile, sequence[3].profile, "player and HUD have different light counts");
  assert.equal(sequence[1].profile, sequence[0].profile);
  assert.equal(sequence[2].profile, sequence[0].profile);
  assert.equal(sequence[4].profile, sequence[3].profile);
  assert.equal(sequence[5].profile, sequence[3].profile);
  assert.equal(state.programCreations, 14, "seven real shader variants under each of the two light profiles");
  const ids = [...state.programs.values()].map(program => program.id).sort((a, b) => a - b);
  for (let cycle = 0; cycle < 10; cycle++) {
    view.setTargets(targets(BigInt(cycle + 3)));
    assert.equal(view.render(cycle + 1), 1);
    await Promise.resolve();
    assert.deepEqual([...state.programs.values()].map(program => program.id).sort((a, b) => a - b), ids,
      "disposing the preceding portrait's material clones cannot delete its last shader owner");
  }
  assert.equal(state.programCreations, 14);
  const compiles = state.lifecycle.length;
  assert.equal(view.render(100), 0);
  assert.equal(state.lifecycle.length, compiles, "a clean portrait never compiles per frame");
  view.clear();
  assert.equal(state.programs.size, 0, "clear releases both live shells and all retained program owners");
  view.dispose();
});

test("portrait material clones keep maps and flags but remove only the world shader wrapper", async () => {
  const map = new THREE.Texture();
  const world = new THREE.MeshStandardMaterial({ map, transparent: true, side: THREE.DoubleSide });
  const worldCompile = () => {};
  const worldCacheKey = () => "world-light";
  world.onBeforeCompile = worldCompile;
  world.customProgramCacheKey = worldCacheKey;
  applyWorldLight(world, createWorldLightUniforms(), "surface");
  const [portrait] = clonePortraitMaterials([world]);
  assert.notEqual(portrait, world);
  assert.equal(portrait.map, map, "portrait must borrow the loaded texture object");
  assert.equal(portrait.transparent, true);
  assert.equal(portrait.side, THREE.DoubleSide);
  assert.equal(portrait.onBeforeCompile, worldCompile, "the pre-world authored hook remains on portrait");
  assert.equal(portrait.customProgramCacheKey(), "world-light", "the pre-world key remains on portrait");
  assert.notEqual(portrait.onBeforeCompile, world.onBeforeCompile, "outer world shader hook must not leak into portrait");
  assert.notEqual(portrait.customProgramCacheKey, world.customProgramCacheKey, "outer world key must not leak into portrait");
  portrait.dispose();
  world.dispose();
  map.dispose();
});

test("party portrait slots share the existing renderer and paint four independent surfaces", async () => {
  const { renderer, state } = fakeRenderer();
  const view = new PortraitRenderer(renderer, () => source());
  const outputs = [1, 2, 3, 4].map(() => canvas());
  view.setTargets(new Map(outputs.map((output, index) => [
    `party${index + 1}`, { guid: BigInt(index + 1), canvas: output },
  ])));
  assert.deepEqual([...view.targetGuids()].sort((left, right) => Number(left - right)), [1n, 2n, 3n, 4n]);
  assert.equal(view.render(0), 4, "each stable party slot gets one shared-renderer readback");
  await Promise.resolve();
  assert.equal(state.reads, 4);
  assert.deepEqual(state.visiblePortraitGroups, [1, 1, 1, 1],
    "party surfaces remain isolated while sharing the one renderer");
  view.dispose();
});

test("paperdoll uses the shared renderer and performs only one dirty readback", async () => {
  const { renderer, state } = fakeRenderer();
  const output = canvas(8, 12);
  const view = new PortraitRenderer(renderer, () => source());
  view.setTargets(new Map([[
    "paperdoll", { guid: 77n, canvas: output },
  ]]));
  assert.equal(view.needsPose(77n), true);
  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.equal(state.reads, 1);
  assert.equal(view.needsPose(77n), false);
  assert.equal(view.render(1000), 0, "a clean full-body canvas must not read back every frame");
  await Promise.resolve();
  assert.equal(state.reads, 1);
  view.dispose();
});

test("paperdoll converts linear WebGL readback to display sRGB while preserving alpha", async () => {
  const { renderer, state } = fakeRenderer();
  renderer.readRenderTargetPixelsAsync = async (target, x, y, width, height, pixels) => {
    state.reads++;
    state.targets.push(target);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const offset = (row * width + column) * 4;
        pixels[offset] = 55;
        pixels[offset + 1] = 55;
        pixels[offset + 2] = 55;
        pixels[offset + 3] = 255;
      }
    }
  };
  const output = canvas(2, 2);
  const view = new PortraitRenderer(renderer, () => source("linear-readback"));
  view.setTargets(new Map([["paperdoll", { guid: 78n, canvas: output }]]));

  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.equal(referenceSrgbByte(0), 0);
  assert.equal(referenceSrgbByte(55), 128);
  assert.equal(referenceSrgbByte(255), 255);
  assert.deepEqual([...output.image.data], [
    128, 128, 128, 255,
    128, 128, 128, 255,
    128, 128, 128, 255,
    128, 128, 128, 255,
  ], "linear midtone bytes must be encoded for the 2D display surface without touching alpha");
  view.dispose();
});

test("portrait renderer disposes its material clones without disposing borrowed source materials", async () => {
  const { renderer } = fakeRenderer();
  const world = new THREE.MeshStandardMaterial();
  let cloneDisposals = 0;
  let sourceDisposals = 0;
  const originalDispose = THREE.Material.prototype.dispose;
  const sourceDispose = world.dispose;
  world.dispose = () => { sourceDisposals++; sourceDispose.call(world); };
  THREE.Material.prototype.dispose = function disposePortraitMaterial() {
    cloneDisposals++;
    return originalDispose.call(this);
  };
  try {
    const current = source("owned-material");
    current.built.materials = [world];
    const view = new PortraitRenderer(renderer, () => current);
    view.setTargets(new Map([["target", { guid: 23n, canvas: canvas() }]]));
    assert.equal(view.render(0), 1);
    await Promise.resolve();
    view.clear();
    assert.equal(cloneDisposals, 2, "clear releases the portrait shell and its inert compiled owner");
    assert.equal(sourceDisposals, 0, "the shared world material remains owned by the build");
  } finally {
    THREE.Material.prototype.dispose = originalDispose;
    world.dispose = sourceDispose;
    world.dispose();
  }
});

test("portrait surfaces expose their exact retained build until the root is cleared", async () => {
  const { renderer } = fakeRenderer();
  const current = source("retained");
  const view = new PortraitRenderer(renderer, () => current);
  view.setTargets(new Map([["player", { guid: 1n, canvas: canvas() }]]));
  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.deepEqual([...view.retainedBuilds()], [current.built]);
  assert.deepEqual([...view.retainedBuildKeys()], ["shared-build"]);
  // Target policy may change before the next portrait pass, but the old root still borrows it.
  view.setTargets(new Map());
  assert.deepEqual([...view.retainedBuilds()], [current.built]);
  assert.deepEqual([...view.retainedBuildKeys()], ["shared-build"]);
  view.clear();
  assert.deepEqual([...view.retainedBuilds()], []);
  assert.deepEqual([...view.retainedBuildKeys()], []);
});

test("portrait renderer reuses per-slot target, paints static portraits once, flips rows, and restores state", async () => {
  const { renderer, state } = fakeRenderer();
  let available = true;
  const output = canvas();
  const view = new PortraitRenderer(renderer, () => available ? source() : undefined);
  view.setTargets(new Map([["player", { guid: 1n, canvas: output }]]));
  assert.equal(view.targetGuids().has(1n), true);
  assert.equal(view.needsPose(1n), true, "a new target needs one world pose for the static snapshot");
  assert.deepEqual([...view.liveBuildKeys()], ["shared-build"]);
  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.equal(view.needsPose(1n), false, "a successfully painted portrait no longer needs animation time");
  assert.equal(state.reads, 1);
  assert.equal(output.dataset.portraitReady, "true");
  // WebGL's bottom row (4) is the first row in the DOM canvas after the explicit flip and sRGB encoding.
  assert.equal(output.image.data[0], referenceSrgbByte(4));
  const target = state.targets[0];
  assert.equal(view.render(50), 0);
  await Promise.resolve();
  assert.equal(view.needsPose(1n), false);
  assert.equal(state.reads, 1);
  assert.equal(view.render(100), 0);
  await Promise.resolve();
  assert.equal(state.targets.length, 1, "an unchanged static portrait must not trigger another GPU readback");
  assert.equal(state.targets[0], target);
  assert.equal(state.target.name, "world");
  assert.deepEqual([...state.viewport], [3, 4, 5, 6]);
  assert.deepEqual([...state.scissor], [7, 8, 9, 10]);
  assert.equal(state.scissorTest, true);
  assert.equal(state.alpha, 0.37);
  assert.equal(state.autoClear, false);

  available = false;
  assert.equal(view.render(200), 0);
  await Promise.resolve();
  assert.equal(output.dataset.portraitReady, "true", "temporary source loss must keep the last valid player portrait");
  assert.equal(view.needsPose(1n), true, "an unavailable portrait remains invalid until it can be snapshotted");
  view.clear();
  assert.equal(view.targetGuids().size, 0);
  assert.equal(view.needsPose(1n), false);
});

test("a temporary portrait source miss keeps only the current pixels and cannot leak them to another character", async () => {
  const { renderer } = fakeRenderer();
  let current = source("first-character");
  const output = canvas();
  const view = new PortraitRenderer(renderer, () => current);
  view.setTargets(new Map([["player", { guid: 1n, canvas: output }]]));
  view.render(0);
  await Promise.resolve();
  const image = output.image;
  current = undefined;
  for (let tick = 1; tick <= 3; tick++) {
    assert.equal(view.render(tick), 0);
    await Promise.resolve();
    assert.equal(output.image, image, "repeated cache misses must not blink the player portrait");
    assert.equal(output.dataset.portraitReady, "true");
    assert.deepEqual([...view.retainedBuilds()], [], "fallback retains pixels, never disposed world resources");
  }
  current = source("rebuilt-appearance");
  assert.equal(view.render(4), 1, "a rebuilt appearance replaces the temporary snapshot");
  await Promise.resolve();
  assert.notEqual(output.image, image);
  view.clear();
  assert.equal(output.image, undefined, "world exit clears the previous character image");
  current = undefined;
  view.setTargets(new Map([["player", { guid: 2n, canvas: output }]]));
  view.render(5);
  await Promise.resolve();
  assert.equal(output.dataset.portraitReady, "false", "reentry never shows another character's old portrait");
  current = source("next-character");
  assert.equal(view.render(6), 1);
  await Promise.resolve();
  view.setTargets(new Map([["player", { guid: 3n, canvas: output }]]));
  assert.equal(output.image, undefined, "changing only the GUID invalidates the snapshot immediately");
  view.dispose();
});

test("portrait target render target is resized in place and fallback is deterministic", async () => {
  const { renderer, state } = fakeRenderer();
  const output = canvas(4, 4);
  const view = new PortraitRenderer(renderer, () => source("fallback"));
  view.setTargets(new Map([["target", { guid: 2n, canvas: output }]]));
  view.render(0);
  await Promise.resolve();
  assert.equal(view.needsPose(2n), false);
  const target = state.targets[0];
  output.width = 8;
  output.height = 8;
  view.setTargets(new Map([["target", { guid: 2n, canvas: output }]]));
  assert.equal(view.needsPose(2n), true, "a backing-store resize invalidates the static pose snapshot");
  view.render(100);
  await Promise.resolve();
  assert.equal(view.needsPose(2n), false);
  assert.equal(state.targets[1], target, "resize must use WebGLRenderTarget.setSize, not recreate per frame");
  view.clear();
});

test("portrait slots isolate their roots and freeze the live skeleton pose at first paint", async () => {
  const { renderer, state } = fakeRenderer();
  const outputs = [canvas(), canvas()];
  const sources = new Map([
    [1n, source("one")],
    [2n, source("two")],
  ]);
  const view = new PortraitRenderer(renderer, (guid) => sources.get(guid));
  view.setTargets(new Map([
    ["player", { guid: 1n, canvas: outputs[0] }],
    ["target", { guid: 2n, canvas: outputs[1] }],
  ]));
  assert.equal(view.render(0), 2);
  await Promise.resolve();
  assert.deepEqual(state.visiblePortraitGroups, [1, 1], "each readback must see only its active slot");

  const liveBone = new THREE.Bone();
  liveBone.position.x = 1.25;
  const posed = skinnedSource("posed", [liveBone]);
  const posedView = new PortraitRenderer(renderer, () => posed);
  const posedCanvas = canvas();
  posedView.setTargets(new Map([["target", { guid: 3n, canvas: posedCanvas }]]));
  assert.equal(posedView.needsPose(3n), true);
  assert.equal(posedView.render(0), 1);
  await Promise.resolve();
  assert.equal(posedView.needsPose(3n), false);
  assert.deepEqual(state.visibleBonePositions.at(-1), [1.25], "portrait must receive the world pose");
  liveBone.position.x = 9.5;
  assert.equal(posedView.render(100), 0, "a static portrait must not repaint as the world animation advances");
  await Promise.resolve();
  assert.deepEqual(state.visibleBonePositions.at(-1), [1.25], "portrait pose must remain frozen");
});

test("player and paperdoll sample Stand so a moving or dead world pose cannot break the player portrait", async () => {
  const { renderer, state } = fakeRenderer();
  const liveBone = new THREE.Bone();
  liveBone.position.x = 9;
  const neutral = skinnedSource("neutral-stand", [liveBone]);
  neutral.template.clips.set(0, new THREE.AnimationClip("Stand", 1, [
    new THREE.NumberKeyframeTrack("bone0.position[x]", [0, 1], [2, 2]),
  ]));
  neutral.template.animations.add(0);
  const view = new PortraitRenderer(renderer, () => neutral);
  view.setTargets(new Map([
    ["player", { guid: 31n, canvas: canvas() }],
    ["target", { guid: 31n, canvas: canvas() }],
    ["paperdoll", { guid: 31n, canvas: canvas() }],
  ]));

  assert.equal(view.render(0), 3);
  await Promise.resolve();
  assert.deepEqual(state.visibleBonePositions[0], [2], "player portrait must never freeze the head outside its bust camera");
  assert.deepEqual(state.visibleBonePositions[1], [9], "target portrait still copies the live skeleton");
  assert.deepEqual(state.visibleBonePositions[2], [2], "paperdoll uses one deterministic Stand sample");
  assert.equal(view.render(100), 0, "the isolated Stand action is not continuously animated");
  await Promise.resolve();
  view.dispose();
});

test("the player portrait shares the race-aware character light profile, while target stays HUD-lit", async () => {
  const player = portraitLightingProfile("player", "nightElf");
  const character = portraitLightingProfile("character", "nightElf");
  const target = portraitLightingProfile("target", "nightElf");
  assert.deepEqual(player, character, "the player and character context must use one race-aware profile");
  assert.equal(player.mode, "character");
  assert.equal(target.mode, "hud", "target/focus/party portraits retain the established HUD lighting");
  assert.notDeepEqual(target, player);
});

test("changing only the target GUID rebuilds the static pose even for a shared appearance", async () => {
  const { renderer, state } = fakeRenderer();
  const firstBone = new THREE.Bone();
  firstBone.position.x = 1;
  const secondBone = new THREE.Bone();
  secondBone.position.x = 2;
  const sources = new Map([
    [11n, skinnedSource("shared", [firstBone])],
    [12n, skinnedSource("shared", [secondBone])],
  ]);
  const output = canvas();
  const view = new PortraitRenderer(renderer, (guid) => sources.get(guid));
  view.setTargets(new Map([["target", { guid: 11n, canvas: output }]]));
  assert.equal(view.needsPose(11n), true);
  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.equal(view.needsPose(11n), false);
  assert.deepEqual(state.visibleBonePositions.at(-1), [1]);
  view.setTargets(new Map([["target", { guid: 12n, canvas: output }]]));
  assert.equal(view.needsPose(12n), true, "a GUID change invalidates the previous static snapshot");
  assert.equal(view.render(100), 1);
  await Promise.resolve();
  assert.equal(view.needsPose(12n), false);
  assert.deepEqual(state.visibleBonePositions.at(-1), [2], "same build key must still capture the new target pose");
});

test("source-key changes invalidate a static portrait for the same target GUID", async () => {
  const { renderer } = fakeRenderer();
  let current = source("atlas-generation-1");
  const output = canvas();
  const view = new PortraitRenderer(renderer, () => current);
  view.setTargets(new Map([["target", { guid: 21n, canvas: output }]]));
  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.equal(view.needsPose(21n), false);
  current = source("atlas-generation-2");
  assert.equal(view.needsPose(21n), true, "a changed source key must request one fresh world pose");
  assert.equal(view.render(100), 1);
  await Promise.resolve();
  assert.equal(view.needsPose(21n), false);
});

test("late model texture completion invalidates a frozen portrait", async () => {
  const { renderer, state } = fakeRenderer();
  const output = canvas();
  const map = new THREE.Texture();
  const current = source("texture-late");
  current.built.materials = [new THREE.MeshBasicMaterial({ map })];
  const view = new PortraitRenderer(renderer, () => current);
  view.setTargets(new Map([["target", { guid: 22n, canvas: output }]]));
  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.equal(view.needsPose(22n), false);
  map.needsUpdate = true;
  assert.equal(view.needsPose(22n), true, "a loader completion must invalidate the static readback");
  assert.equal(view.render(100), 1);
  await Promise.resolve();
  assert.equal(state.reads, 2);
});

test("changing a target invalidates the previous 3D canvas immediately", async () => {
  const { renderer } = fakeRenderer();
  const output = canvas();
  const view = new PortraitRenderer(renderer, () => source());
  view.setTargets(new Map([["target", { guid: 1n, canvas: output }]]));
  view.render(0);
  await Promise.resolve();
  assert.equal(output.dataset.portraitReady, "true");
  view.setTargets(new Map([["target", { guid: 2n, canvas: output }]]));
  assert.equal(output.dataset.portraitReady, "false");
});

test("integration wires shared portrait and paperdoll slots through one renderer", async () => {
  const [world, loop, frames, unitFrames, portraits, enterWorld, portraitRenderer] = await Promise.all([
    readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Frames.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/UnitFrames.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Portraits.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/PortraitRenderer.ts", import.meta.url), "utf8"),
  ]);
  assert.equal((world.match(/new THREE\.WebGLRenderer/g) ?? []).length, 1);
  for (const slot of ["player", "target", "focus", "tot", "pet", "paperdoll"])
    assert.match(portraits + world + portraitRenderer, new RegExp(`['\"]${slot}['\"]`));
  assert.match(world, /setPortraitTargets/);
  assert.match(world, /renderPortraits/);
  assert.match(world, /clearPortraits/);
  assert.match(world, /@atlas/);
  assert.match(world, /liveBones: unit\.skinned\?\.skeleton\.bones/);
  assert.doesNotMatch(world, /skeleton\.bones\.map/);
  assert.match(world, /needsPose\(object\.guid\)/);
  assert.match(await readFile(new URL("../src/browser/CharacterAtlas.ts", import.meta.url), "utf8"), /generation\(key: string\)/);
  assert.match(loop, /syncPortraitTargets/);
  assert.match(loop, /renderPortraits/);
  assert.match(frames, /setPlayerPortrait/);
  assert.match(frames, /setTargetPortrait/);
  assert.match(unitFrames, /portrait: true/);
  assert.match(portraits, /playerIcon\.hidden/);
  assert.match(portraits, /targetIcon\.hidden/);
  assert.match(enterWorld, /clearPortraitTargets/);
  assert.match(enterWorld, /clearPortraits/);
  assert.match(portraits, /setPortraitCanvasBackingStore/);
  assert.match(portraits, /adoptCharacterPortraitCanvas/);
  assert.match(portraitRenderer, /fullBodyCameraSpec/);
  assert.match(unitFrames, /portrait: true/);
  assert.match(portraitRenderer, /applyBillboardBones\(surface\.skinned, source\.template/);
  assert.match(portraitRenderer, /staticPoseCaptured/);
  assert.match(portraitRenderer, /sourceGuid/);
  assert.match(portraitRenderer, /needsPose\(guid: bigint\)/);
  assert.doesNotMatch(portraitRenderer, /mixer\.update/);
});

/** DOM minimum for testing the character canvas adoption without a browser dependency. */
function portraitDom() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], parentNode: null, parentElement: null,
      dataset: {}, attributes: new Map(), className: "", hidden: false, width: 0, height: 0,
      clientWidth: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 0,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...children) { for (const child of children) { child.parentNode?.removeChild?.(child); child.parentNode = node; child.parentElement = node; node.children.push(child); } },
      prepend(...children) { for (const child of children.reverse()) { child.parentNode?.removeChild?.(child); child.parentNode = node; child.parentElement = node; node.children.unshift(child); } },
      appendChild(child) { node.append(child); return child; },
      insertBefore(child, sibling) { const index = node.children.indexOf(sibling); child.parentNode?.removeChild?.(child); child.parentNode = node; child.parentElement = node; node.children.splice(index < 0 ? node.children.length : index, 0, child); return child; },
      removeChild(child) { const index = node.children.indexOf(child); if (index >= 0) node.children.splice(index, 1); child.parentNode = null; child.parentElement = null; return child; },
      remove() { node.parentNode?.removeChild?.(node); },
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { const text = String(value); node.attributes.set(name, text); if (name === "id") node.id = text; if (name.startsWith("data-")) node.dataset[name.slice(5).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase())] = text; },
      getAttribute(name) { return node.attributes.get(name) ?? null; }, removeAttribute(name) { node.attributes.delete(name); },
      querySelector() { return undefined; }, querySelectorAll() { return []; },
    };
    return node;
  };
  const document = {
    body: make("body"), documentElement: make("html"), head: make("head"),
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make(id.endsWith("-form") ? "form" : "div");
        node.id = id;
        if (id === "login-form" || id === "create-form") node.querySelector = () => make("button");
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return undefined; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  return { document, make };
}

test("character portrait adoption follows ResizeObserver geometry and disconnects on cleanup", async () => {
  const previous = {
    document: globalThis.document, location: globalThis.location, window: globalThis.window,
    localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame, HTMLElement: globalThis.HTMLElement,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const { document, make } = portraitDom();
  const observers = [];
  class ResizeObserverStub {
    constructor(callback) { this.callback = callback; this.target = undefined; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    trigger(width, height) {
      this.callback([{ target: this.target, contentBoxSize: { inlineSize: width, blockSize: height }, contentRect: { width, height } }]);
    }
  }
  globalThis.document = document;
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = () => 0;
  globalThis.HTMLElement = class {};
  globalThis.ResizeObserver = ResizeObserverStub;
  try {
    const { adoptCharacterPortraitCanvas, characterPortraitCanvas } = await import("../dist/code/browser/ui/Portraits.js");
    const target = make("div");
    target.setAttribute("data-portrait-model-placeholder", "true");
    target.clientWidth = 220; target.clientHeight = 300;
    const cleanup = adoptCharacterPortraitCanvas(target);
    assert.equal(typeof cleanup, "function");
    const canvas = characterPortraitCanvas();
    assert.ok(canvas);
    assert.deepEqual([canvas.width, canvas.height], [220, 300]);
    assert.equal(observers.length, 1);
    observers[0].trigger(320, 180);
    assert.deepEqual([canvas.width, canvas.height], [320, 180]);
    assert.equal(canvas.dataset.portraitReady, "false", "a resize invalidates the static readback");
    observers[0].trigger(320, 180);
    assert.deepEqual([canvas.width, canvas.height], [320, 180], "unchanged geometry is not rewritten");
    cleanup();
    assert.equal(observers[0].disconnected, true);
    assert.deepEqual([canvas.width, canvas.height], [0, 0], "cleanup restores the original canvas backing store");
    observers[0].trigger(640, 360);
    assert.deepEqual([canvas.width, canvas.height], [0, 0], "a disconnected observer cannot revive the adoption");
  } finally {
    globalThis.document = previous.document; globalThis.location = previous.location;
    globalThis.window = previous.window; globalThis.localStorage = previous.localStorage;
    globalThis.matchMedia = previous.matchMedia; globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.HTMLElement = previous.HTMLElement; globalThis.ResizeObserver = previous.ResizeObserver;
  }
});
