import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { readFile } from "node:fs/promises";
import { PortraitRenderer } from "../dist/code/browser/PortraitRenderer.js";

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
  };
  const renderer = {
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
      const groups = scene.children.filter((child) => child.name?.startsWith("portrait-") && child.visible);
      state.visiblePortraitGroups.push(groups.length);
      const bones = [];
      for (const group of groups) group.traverse((child) => {
        if (child.isBone) bones.push(child.position.x);
      });
      state.visibleBonePositions.push(bones);
    },
    readRenderTargetPixels(target, x, y, width, height, pixels) {
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

test("portrait renderer reuses per-slot target, paints static portraits once, flips rows, and restores state", () => {
  const { renderer, state } = fakeRenderer();
  let available = true;
  const output = canvas();
  const view = new PortraitRenderer(renderer, () => available ? source() : undefined);
  view.setTargets(new Map([["player", { guid: 1n, canvas: output }]]));
  assert.equal(view.targetGuids().has(1n), true);
  assert.equal(view.needsPose(1n), true, "a new target needs one world pose for the static snapshot");
  assert.deepEqual([...view.liveBuildKeys()], ["shared-build"]);
  assert.equal(view.render(0), 1);
  assert.equal(view.needsPose(1n), false, "a successfully painted portrait no longer needs animation time");
  assert.equal(state.reads, 1);
  assert.equal(output.dataset.portraitReady, "true");
  // WebGL's bottom row (4) is the first row in the DOM canvas after the explicit flip.
  assert.equal(output.image.data[0], 4);
  const target = state.targets[0];
  assert.equal(view.render(50), 0);
  assert.equal(view.needsPose(1n), false);
  assert.equal(state.reads, 1);
  assert.equal(view.render(100), 0);
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
  assert.equal(output.dataset.portraitReady, "false");
  assert.equal(view.needsPose(1n), true, "an unavailable portrait remains invalid until it can be snapshotted");
  view.clear();
  assert.equal(view.targetGuids().size, 0);
  assert.equal(view.needsPose(1n), false);
});

test("portrait target render target is resized in place and fallback is deterministic", () => {
  const { renderer, state } = fakeRenderer();
  const output = canvas(4, 4);
  const view = new PortraitRenderer(renderer, () => source("fallback"));
  view.setTargets(new Map([["target", { guid: 2n, canvas: output }]]));
  view.render(0);
  assert.equal(view.needsPose(2n), false);
  const target = state.targets[0];
  output.width = 8;
  output.height = 8;
  view.setTargets(new Map([["target", { guid: 2n, canvas: output }]]));
  assert.equal(view.needsPose(2n), true, "a backing-store resize invalidates the static pose snapshot");
  view.render(100);
  assert.equal(view.needsPose(2n), false);
  assert.equal(state.targets[1], target, "resize must use WebGLRenderTarget.setSize, not recreate per frame");
  view.clear();
});

test("portrait slots isolate their roots and freeze the live skeleton pose at first paint", () => {
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
  assert.deepEqual(state.visiblePortraitGroups, [1, 1], "each readback must see only its active slot");

  const liveBone = new THREE.Bone();
  liveBone.position.x = 1.25;
  const posed = skinnedSource("posed", [liveBone]);
  const posedView = new PortraitRenderer(renderer, () => posed);
  const posedCanvas = canvas();
  posedView.setTargets(new Map([["player", { guid: 3n, canvas: posedCanvas }]]));
  assert.equal(posedView.needsPose(3n), true);
  assert.equal(posedView.render(0), 1);
  assert.equal(posedView.needsPose(3n), false);
  assert.deepEqual(state.visibleBonePositions.at(-1), [1.25], "portrait must receive the world pose");
  liveBone.position.x = 9.5;
  assert.equal(posedView.render(100), 0, "a static portrait must not repaint as the world animation advances");
  assert.deepEqual(state.visibleBonePositions.at(-1), [1.25], "portrait pose must remain frozen");
});

test("changing only the target GUID rebuilds the static pose even for a shared appearance", () => {
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
  assert.equal(view.needsPose(11n), false);
  assert.deepEqual(state.visibleBonePositions.at(-1), [1]);
  view.setTargets(new Map([["target", { guid: 12n, canvas: output }]]));
  assert.equal(view.needsPose(12n), true, "a GUID change invalidates the previous static snapshot");
  assert.equal(view.render(100), 1);
  assert.equal(view.needsPose(12n), false);
  assert.deepEqual(state.visibleBonePositions.at(-1), [2], "same build key must still capture the new target pose");
});

test("source-key changes invalidate a static portrait for the same target GUID", () => {
  const { renderer } = fakeRenderer();
  let current = source("atlas-generation-1");
  const output = canvas();
  const view = new PortraitRenderer(renderer, () => current);
  view.setTargets(new Map([["target", { guid: 21n, canvas: output }]]));
  assert.equal(view.render(0), 1);
  assert.equal(view.needsPose(21n), false);
  current = source("atlas-generation-2");
  assert.equal(view.needsPose(21n), true, "a changed source key must request one fresh world pose");
  assert.equal(view.render(100), 1);
  assert.equal(view.needsPose(21n), false);
});

test("changing a target invalidates the previous 3D canvas immediately", () => {
  const { renderer } = fakeRenderer();
  const output = canvas();
  const view = new PortraitRenderer(renderer, () => source());
  view.setTargets(new Map([["target", { guid: 1n, canvas: output }]]));
  view.render(0);
  assert.equal(output.dataset.portraitReady, "true");
  view.setTargets(new Map([["target", { guid: 2n, canvas: output }]]));
  assert.equal(output.dataset.portraitReady, "false");
});

test("integration wires all five slots through one renderer and keeps the old image fallback", async () => {
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
  for (const slot of ["player", "target", "focus", "tot", "pet"]) assert.match(portraits + world, new RegExp(`['\"]${slot}['\"]`));
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
  assert.match(unitFrames, /portrait: true/);
  assert.match(portraitRenderer, /applyBillboardBones\(surface\.skinned, source\.template/);
  assert.match(portraitRenderer, /staticPoseCaptured/);
  assert.match(portraitRenderer, /sourceGuid/);
  assert.match(portraitRenderer, /needsPose\(guid: bigint\)/);
  assert.doesNotMatch(portraitRenderer, /mixer\.update/);
});
